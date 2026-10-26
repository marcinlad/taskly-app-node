import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PackageConfig } from './config.ts';
import { parseCoverage, type FileCoverage } from './coverage.ts';
import { toRepoRelative } from './paths.ts';
import { stripAnsi, type CommandResult, type Sandbox } from './process.ts';

export interface TestFailure {
  file: string;
  test: string;
  message: string;
}

export interface TestRunResult {
  ok: boolean;
  /** Set when Vitest produced no report at all: a crash, a timeout or a config error. */
  error?: string;
  files: number;
  passed: number;
  failed: number;
  skipped: number;
  failures: TestFailure[];
  durationMs: number;
  /** Per source file, present when the run collected coverage. */
  coverage?: Record<string, FileCoverage>;
}

/** Shape of the parts of Vitest's JSON reporter output that we read. */
interface VitestJsonReport {
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests?: number;
  numTodoTests?: number;
  testResults: Array<{
    name: string;
    status: string;
    message?: string;
    assertionResults: Array<{ fullName: string; status: string; failureMessages?: string[] }>;
  }>;
}

export interface RunVitestOptions {
  /** Repository-relative test files. Empty runs the whole suite. */
  files: string[];
  coverage?: boolean;
}

/**
 * Runs Vitest in a package and reads its JSON report. Pass/fail comes from the report, not the exit
 * code: the backend's per-file coverage thresholds fail the process whenever only part of the
 * suite runs, which says nothing about the tests themselves.
 */
export async function runVitest(
  repoRoot: string,
  pkg: PackageConfig,
  sandbox: Sandbox,
  options: RunVitestOptions,
): Promise<TestRunResult> {
  // Inside node_modules: ignored by git, hidden from the agent, and visible to a container mount.
  const scratchRel = path.posix.join('node_modules', '.test-agent', randomUUID());
  const scratch = path.join(repoRoot, pkg.dir, scratchRel);
  await mkdir(scratch, { recursive: true });
  try {
    const args = [
      'vitest', 'run',
      ...options.files.map((file) => path.posix.relative(pkg.dir, file)),
      '--reporter=json', `--outputFile=${scratchRel}/report.json`,
      '--passWithNoTests=false',
    ];
    if (options.coverage) {
      args.push(
        '--coverage.enabled=true',
        '--coverage.reporter=json',
        `--coverage.reportsDirectory=${scratchRel}/coverage`,
      );
    }
    const result = await sandbox.npx(pkg.dir, args);
    const report = await readJson<VitestJsonReport>(path.join(scratch, 'report.json'));
    if (!report) return crashed(result);
    const coverageReport = options.coverage
      ? await readJson<Record<string, unknown>>(path.join(scratch, 'coverage', 'coverage-final.json'))
      : null;
    return {
      ...summarize(report, repoRoot),
      durationMs: result.durationMs,
      coverage: coverageReport ? parseCoverage(coverageReport, repoRoot) : undefined,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export function summarize(report: VitestJsonReport, repoRoot: string): Omit<TestRunResult, 'durationMs' | 'coverage'> {
  const failures: TestFailure[] = [];
  for (const file of report.testResults) {
    const rel = toRepoRelative(file.name, repoRoot);
    const failedAssertions = file.assertionResults.filter((a) => a.status === 'failed');
    for (const assertion of failedAssertions) {
      failures.push({ file: rel, test: assertion.fullName, message: cleanMessage((assertion.failureMessages ?? []).join('\n')) });
    }
    // A file that fails to load (syntax error, bad import) has a message but no assertions.
    if (file.status === 'failed' && failedAssertions.length === 0) {
      failures.push({ file: rel, test: '(test file failed to load)', message: cleanMessage(file.message ?? 'Unknown error') });
    }
  }
  const skipped = (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0);
  return {
    ok: failures.length === 0 && report.testResults.length > 0,
    error: report.testResults.length === 0 ? 'No test files ran.' : undefined,
    files: report.testResults.length,
    passed: report.numPassedTests,
    failed: Math.max(report.numFailedTests, failures.length),
    skipped,
    failures,
  };
}

function crashed(result: CommandResult): TestRunResult {
  const output = stripAnsi(`${result.stderr}\n${result.stdout}`).trim();
  return {
    ok: false,
    error: result.timedOut ? 'Vitest timed out.' : `Vitest did not produce a report (exit code ${result.exitCode}).\n${output.slice(-4000)}`,
    files: 0, passed: 0, failed: 0, skipped: 0, failures: [], durationMs: result.durationMs,
  };
}

/** Keeps the assertion and the first stack frames inside the repo; drops node_modules frames. */
export function cleanMessage(message: string): string {
  const lines = stripAnsi(message).split('\n');
  const kept: string[] = [];
  let frames = 0;
  for (const line of lines) {
    const isFrame = /^\s+at /.test(line);
    if (isFrame) {
      if (line.includes('node_modules') || line.includes('node:internal') || line.includes('<anonymous>') || frames >= 3) continue;
      frames += 1;
    }
    kept.push(line);
  }
  return kept.join('\n').trim().slice(0, 3000);
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}
