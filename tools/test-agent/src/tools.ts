import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import type { PackageConfig } from './config.ts';
import { formatCoverage } from './coverage.ts';
import { walkFiles } from './files.ts';
import { isReadable, isTestFile, normalizeRepoPath, resolveInsideRoot } from './paths.ts';
import type { Target } from './planner.ts';
import { truncate, type Sandbox } from './process.ts';
import type { Skill } from './skills.ts';
import { runVitest, type TestRunResult } from './vitest.ts';

export interface ToolEvent {
  tool: string;
  input: Record<string, unknown>;
  ok: boolean;
  output: string;
  durationMs: number;
}

export interface SessionContext {
  repoRoot: string;
  pkg: PackageConfig;
  mode: 'pr' | 'coverage';
  targets: Target[];
  diffs: Map<string, string>;
  skills: Map<string, Skill>;
  sandbox: Sandbox;
  onEvent?: (event: ToolEvent) => void;
}

export interface WriteRecord {
  original: string | null;
}

export const ReportSchema = z.object({
  summary: z.string().describe('Two or three sentences: what you did and what reviewers should look at.'),
  files: z.array(
    z.object({
      source: z.string().describe('The target source file, exactly as listed in the task.'),
      decision: z.enum(['create', 'update', 'skip']),
      reason: z.string().describe('Why this decision; for skip, why no unit test is warranted.'),
      testFiles: z.array(z.string()).describe('Test files you created or updated for this source file.'),
      status: z.enum(['passing', 'failing', 'not_run']).describe('Result of the last run_tests call covering these test files.'),
      suspectedBugs: z.array(z.string()).describe('Behavior in the source that looks wrong, with file and line. Empty if none.'),
    }),
  ),
});

export type AgentReport = z.infer<typeof ReportSchema>;

export interface SessionState {
  writes: Map<string, WriteRecord>;
  skillsUsed: string[];
  testRuns: number;
  report: AgentReport | null;
}

export const MAX_TEST_RUNS = 30;
export const MAX_WRITES = 20;
export const MAX_WRITE_BYTES = 100_000;
const MAX_READ_BYTES = 200_000;
const MAX_OUTPUT_CHARS = 12_000;

export const TRIAGE_HINT =
  "Not sure whether the test or the code under test is wrong? Load the 'failure-triage' skill before changing assertions.";

const SEARCHABLE = /\.(ts|tsx|js|mjs|cjs|json|md|prisma|css|html|ya?ml)$/;
const TEST_CASE = /\b(?:it|test)(?:\.each\s*(?:\([^)]*\)|`[^`]*`))?\s*\(/g;

export function countTestCases(source: string): number {
  return source.match(TEST_CASE)?.length ?? 0;
}

const SKIP_MARKER = /\b(?:it|test|describe)\.(?:skip|todo)\b/g;

export function countSkipMarkers(source: string): number {
  return source.match(SKIP_MARKER)?.length ?? 0;
}

export function createTools(ctx: SessionContext) {
  const { repoRoot, pkg } = ctx;
  const state: SessionState = { writes: new Map(), skillsUsed: [], testRuns: 0, report: null };

  // Extra fields (strict, eager_input_streaming) go to the API as given.
  function define<Schema extends z.ZodType>({ run, ...definition }: {
    name: string;
    description: string;
    inputSchema: Schema;
    strict?: boolean;
    eager_input_streaming?: boolean;
    run: (input: z.infer<Schema>) => Promise<string>;
  }) {
    return betaZodTool({
      ...definition,
      run: async (input) => {
        const started = Date.now();
        const report = (ok: boolean, output: string) =>
          ctx.onEvent?.({ tool: definition.name, input: loggable(input), ok, output, durationMs: Date.now() - started });
        try {
          const output = await run(input);
          report(true, output);
          return output;
        } catch (error) {
          report(false, error instanceof Error ? error.message : String(error));
          throw error;
        }
      },
    });
  }

  function readablePath(input: string): string {
    const rel = normalizeRepoPath(input);
    if (rel === null) throw new Error(`Invalid path "${input}". Use a path relative to the repository root, e.g. "${pkg.dir}/src/...".`);
    if (rel !== '.' && !isReadable(rel)) throw new Error(`"${rel}" is not readable: dependencies, build output, VCS data and secret files are off limits.`);
    return rel;
  }

  async function runTestsCounted(files: string[], coverage: boolean): Promise<TestRunResult> {
    if (state.testRuns >= MAX_TEST_RUNS) {
      throw new Error(`Test run limit (${MAX_TEST_RUNS}) reached. Stop iterating and call submit_report with the current status.`);
    }
    state.testRuns += 1;
    return runVitest(repoRoot, pkg, ctx.sandbox, { files, coverage });
  }

  const listFiles = define({
    name: 'list_files',
    description: 'List files under a directory of the repository (recursive, at most 300 entries). Dependencies and build output are hidden.',
    inputSchema: z.object({ dir: z.string().describe('Directory relative to the repository root, e.g. "frontend/src/features".') }),
    run: async ({ dir }) => {
      const rel = readablePath(dir);
      const files = await walkFiles(repoRoot, rel, 301);
      if (files.length === 0) return `No files under ${rel}.`;
      return files.length > 300 ? `${files.slice(0, 300).join('\n')}\n… more files omitted; list a narrower directory.` : files.join('\n');
    },
  });

  const readFileTool = define({
    name: 'read_file',
    description: 'Read a text file of the repository with line numbers. Use start_line/end_line for long files.',
    inputSchema: z.object({
      path: z.string().describe('File path relative to the repository root.'),
      start_line: z.number().int().optional(),
      end_line: z.number().int().optional(),
    }),
    run: async ({ path: file, start_line, end_line }) => {
      const rel = readablePath(file);
      const absolute = await resolveInsideRoot(repoRoot, rel);
      const info = await stat(absolute).catch(() => null);
      if (!info?.isFile()) throw new Error(`No such file: ${rel}`);
      if (info.size > MAX_READ_BYTES) throw new Error(`${rel} is too large (${info.size} bytes).`);
      const lines = (await readFile(absolute, 'utf8')).split('\n');
      const start = Math.max(1, start_line ?? 1);
      const end = Math.min(lines.length, end_line ?? lines.length);
      const width = String(end).length;
      return lines.slice(start - 1, end).map((line, i) => `${String(start + i).padStart(width)}| ${line}`).join('\n') || '(empty file)';
    },
  });

  const searchCode = define({
    name: 'search_code',
    description: 'Find a literal string (not a regex) in source, test and config files. Returns up to 60 matching lines as path:line: text.',
    inputSchema: z.object({
      query: z.string().min(2).describe('Literal text to find, e.g. "useTodosQuery(" or "vi.mock(".'),
      dir: z.string().optional().describe('Directory to search, relative to the repository root. Defaults to the whole repository.'),
    }),
    run: async ({ query, dir }) => {
      const rel = readablePath(dir ?? '.');
      const matches: string[] = [];
      for (const file of await walkFiles(repoRoot, rel)) {
        if (!SEARCHABLE.test(file)) continue;
        const absolute = path.join(repoRoot, file);
        const info = await stat(absolute);
        if (info.size > MAX_READ_BYTES) continue;
        const lines = (await readFile(absolute, 'utf8')).split('\n');
        lines.forEach((line, i) => {
          if (matches.length < 60 && line.includes(query)) matches.push(`${file}:${i + 1}: ${line.trim().slice(0, 200)}`);
        });
        if (matches.length >= 60) break;
      }
      return matches.length ? matches.join('\n') : `No matches for "${query}".`;
    },
  });

  const getDiff = define({
    name: 'get_diff',
    description: 'Show the pull request diff of a changed file (unified diff against the base branch).',
    inputSchema: z.object({ path: z.string().describe('A changed file, relative to the repository root.') }),
    run: async ({ path: file }) => {
      const rel = readablePath(file);
      const diff = ctx.diffs.get(rel);
      if (diff === undefined) return `${rel} is not changed in this pull request.`;
      return truncate(diff, MAX_OUTPUT_CHARS);
    },
  });

  const loadSkill = define({
    name: 'load_skill',
    description: 'Load the full instructions of a skill from the skill index in the system prompt. Load the skills relevant to your task before writing tests.',
    inputSchema: z.object({ name: z.string() }),
    run: async ({ name }) => {
      const skill = ctx.skills.get(name);
      if (!skill) throw new Error(`Unknown skill "${name}". Available: ${[...ctx.skills.keys()].join(', ')}.`);
      if (!state.skillsUsed.includes(name)) state.skillsUsed.push(name);
      return `# Skill: ${skill.name}\n\n${skill.body}`;
    },
  });

  const writeTestFile = define({
    name: 'write_test_file',
    description:
      `Create or overwrite a test file of the ${pkg.name} package with the complete file content. ` +
      `Only test files are writable (pattern: ${pkg.testFilePattern.source}); define test data inside the test file instead of adding fixture or helper files. ` +
      'When updating an existing test file, keep every existing test case; the tool rejects writes that remove test cases or add .skip/.todo tests.',
    inputSchema: z.object({
      path: z.string().describe('Test file path relative to the repository root.'),
      content: z.string().describe('The complete new content of the file.'),
    }),
    eager_input_streaming: true,
    run: async ({ path: file, content }) => {
      const rel = normalizeRepoPath(file);
      if (rel === null || !isTestFile(rel, pkg)) {
        throw new Error(`Refused: "${file}" is not a test file of the ${pkg.name} package. Source code, fixtures, configs and other packages are read-only. Allowed pattern: ${pkg.testFilePattern.source}`);
      }
      if (Buffer.byteLength(content) > MAX_WRITE_BYTES) throw new Error(`Refused: content exceeds ${MAX_WRITE_BYTES} bytes. Split the tests into smaller files.`);
      const record = state.writes.get(rel);
      if (!record && state.writes.size >= MAX_WRITES) throw new Error(`Refused: the limit of ${MAX_WRITES} written files is reached.`);
      const absolute = await resolveInsideRoot(repoRoot, rel);
      // The content before the first write of this session, so later rewrites are checked against it.
      const original = record ? record.original : await readFile(absolute, 'utf8').catch(() => null);
      if (original !== null && countTestCases(content) < countTestCases(original)) {
        throw new Error(
          `Refused: ${rel} had ${countTestCases(original)} test cases and the new content has ${countTestCases(content)}. ` +
            'Keep existing tests; if one no longer matches intended behavior, leave it and explain in the report.',
        );
      }
      if (countSkipMarkers(content) > countSkipMarkers(original ?? '')) {
        throw new Error(`Refused: the new content of ${rel} adds skipped or todo tests (.skip/.todo). Remove a test you cannot make pass instead, and explain it in the report.`);
      }
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, content, 'utf8');
      state.writes.set(rel, { original });
      return `Wrote ${rel} (${content.split('\n').length} lines, ${countTestCases(content)} test cases). Run it with run_tests.`;
    },
  });

  const runTests = define({
    name: 'run_tests',
    description: `Run specific test files of the ${pkg.name} package with Vitest and get pass/fail details. Limited to ${MAX_TEST_RUNS} runs per session (shared with get_coverage).`,
    inputSchema: z.object({ files: z.array(z.string()).min(1).describe('Test files relative to the repository root.') }),
    run: async ({ files }) => {
      const rels = files.map((file) => {
        const rel = normalizeRepoPath(file);
        if (rel === null || !isTestFile(rel, pkg)) throw new Error(`"${file}" is not a test file of the ${pkg.name} package.`);
        return rel;
      });
      const result = await runTestsCounted(rels, false);
      const output = formatTestRun(result, MAX_OUTPUT_CHARS);
      // Skills are loaded up front; this points to the triage skill at the moment it is needed.
      return result.ok || state.skillsUsed.includes('failure-triage') ? output : `${output}\n\n${TRIAGE_HINT}`;
    },
  });

  const getCoverage = define({
    name: 'get_coverage',
    description: `Run the whole ${pkg.name} test suite with coverage and report line, branch and function coverage with the uncovered lines of the given source files.`,
    inputSchema: z.object({ files: z.array(z.string()).min(1).describe('Source files relative to the repository root.') }),
    run: async ({ files }) => {
      const rels = files.map((file) => readablePath(file));
      const result = await runTestsCounted([], true);
      const sections = rels.map((rel) => {
        const c = result.coverage?.[rel];
        return c ? `## ${rel}\n${formatCoverage(c)}` : `## ${rel}\nNo coverage data (not a covered source file of this package).`;
      });
      const status = result.ok ? `Suite passed (${result.passed} tests).` : formatTestRun(result, 4_000);
      return truncate(`${status}\n\n${sections.join('\n\n')}`, MAX_OUTPUT_CHARS);
    },
  });

  const targetPaths = new Set(ctx.targets.map((t) => t.path));
  const submitReport = define({
    name: 'submit_report',
    description: 'Submit the final report. Call it exactly once, at the end, with one entry per target file. The session ends after it is accepted.',
    inputSchema: ReportSchema,
    strict: true,
    run: async (report) => {
      const problems: string[] = [];
      const reported = new Set(report.files.map((f) => f.source));
      for (const target of targetPaths) if (!reported.has(target)) problems.push(`missing entry for target ${target}`);
      for (const entry of report.files) {
        if (!targetPaths.has(entry.source)) problems.push(`${entry.source} is not a target of this session`);
        if (entry.decision !== 'skip' && entry.testFiles.length === 0) problems.push(`${entry.source}: decision "${entry.decision}" needs testFiles`);
        for (const testFile of entry.testFiles) {
          if (!state.writes.has(testFile)) problems.push(`${entry.source}: ${testFile} was not written in this session`);
        }
      }
      if (problems.length) throw new Error(`Report rejected:\n- ${problems.join('\n- ')}\nFix these and call submit_report again.`);
      state.report = report;
      return 'Report accepted. You are done; reply with a one-line summary and make no further tool calls.';
    },
  });

  const tools = [
    listFiles, readFileTool, searchCode, ...(ctx.mode === 'pr' ? [getDiff] : []),
    loadSkill, writeTestFile, runTests, getCoverage, submitReport,
  ];
  return { tools, state };
}

export function formatTestRun(result: TestRunResult, maxChars: number): string {
  if (result.error && result.files === 0) return `ERROR: ${result.error}`;
  const head = `${result.ok ? 'PASS' : 'FAIL'}: ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped in ${result.files} file(s).`;
  const failures = result.failures.map((f) => `### ${f.file} › ${f.test}\n${f.message}`);
  return truncate([head, ...failures, ...(result.error ? [result.error] : [])].join('\n\n'), maxChars);
}

function loggable(input: unknown): Record<string, unknown> {
  const entries = Object.entries((input ?? {}) as Record<string, unknown>).map(([key, value]) => {
    if (typeof value === 'string' && value.length > 200) return [key, `<${value.length} chars>`];
    if (key === 'files' && Array.isArray(value) && value.length && typeof value[0] === 'object') return [key, `<${value.length} entries>`];
    return [key, value];
  });
  return Object.fromEntries(entries);
}
