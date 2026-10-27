import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PackageConfig } from './config.ts';
import type { FileCoverage } from './coverage.ts';
import { stripAnsi, type Sandbox } from './process.ts';
import type { WriteRecord } from './tools.ts';
import { runVitest, type TestRunResult } from './vitest.ts';

export const VERIFY_REPEATS = 3;

export interface FileVerification {
  path: string;
  kept: boolean;
  reason?: string;
  passedRuns?: number;
  // A kept update that changes or removes lines of the original test file: verified, but left for a human to apply.
  changesExisting?: boolean;
  // A kept update that changes lines of a test file that failed before the agent's changes, but no assertion: committed.
  repairsExisting?: boolean;
  // The original file failed (tests or type errors) before the agent's changes, so it still fails wherever this update is not applied.
  failedBefore?: boolean;
}

export interface Baseline {
  tests: TestRunResult;
  typeErrors: string[];
}

export interface PackageVerification {
  files: FileVerification[];
  suite: { ok: boolean; passed: number; failed: number; files: number; failures: string[]; error?: string };
  typecheck: { ok: boolean; agentErrors: string[]; otherErrors: number; failure?: string };
  coverageAfter?: Record<string, FileCoverage>;
}

// The agent writes test files only and Vitest isolates them, so suite failures elsewhere are reported, not reverted.
// A step that could not run proves nothing, so it reverts every file still kept, unless it failed the same way before
// the agent's changes (`baseline`, the package suite and typecheck run before the session).
export async function verifyPackage(
  repoRoot: string,
  pkg: PackageConfig,
  sandbox: Sandbox,
  writes: Map<string, WriteRecord>,
  baseline?: Baseline,
  log: (line: string) => void = () => {},
): Promise<PackageVerification> {
  const files = [...writes.keys()];
  const results = new Map<string, FileVerification>();
  const isKept = (file: string) => results.get(file)?.kept === true;
  async function reject(file: string, reason: string): Promise<void> {
    results.set(file, { ...results.get(file), path: file, kept: false, reason });
    await revert(repoRoot, file, writes.get(file)!);
    log(`  verify ${file}: reverted (${reason.split('\n')[0]})`);
  }

  // 0. Format first, so what gets verified is exactly what gets committed.
  // The formatter prints the formatted file and the host writes it: the sandbox stays read-only.
  for (const file of pkg.format ? files : []) {
    const formatted = await sandbox.run(pkg.dir, [...pkg.format!, path.posix.relative(pkg.dir, file)]);
    if (formatted.exitCode === 0 && formatted.stdout) await writeFile(path.join(repoRoot, file), formatted.stdout, 'utf8');
  }

  // 1. Each file must pass on its own, several runs in a row; passing and then failing means flaky.
  for (const file of files) {
    let passedRuns = 0;
    let failure: string | undefined;
    for (let run = 0; run < VERIFY_REPEATS && !failure; run++) {
      const result = await runVitest(repoRoot, pkg, sandbox, { files: [file] });
      const skipped = result.skippedByFile[file] ?? 0;
      const skippedBefore = baseline?.tests.skippedByFile[file] ?? 0;
      if (!result.ok) failure = firstFailure(result, run);
      else if (result.passed === 0) failure = 'no test passed: the file has only skipped or todo tests';
      else if (skipped > skippedBefore) failure = `adds skipped or todo tests: ${skipped} in the file, ${skippedBefore} before`;
      else passedRuns += 1;
    }
    results.set(file, { path: file, kept: true, passedRuns });
    if (failure) await reject(file, failure);
    else log(`  verify ${file}: ${passedRuns}/${VERIFY_REPEATS} runs passed`);
  }

  // 2. Type-check: Vitest strips types without checking them.
  const typecheck = await runTypecheck(repoRoot, pkg, sandbox);
  const agentErrors = typecheck.errors.filter((line) => writes.has(line.split('(')[0]));
  for (const file of files.filter(isKept)) {
    const errors = agentErrors.filter((line) => line.startsWith(`${file}(`));
    if (typecheck.failure) await reject(file, `typecheck could not run: ${typecheck.failure}`);
    else if (errors.length) await reject(file, `type errors:\n${errors.slice(0, 5).join('\n')}`);
  }

  // 3. The full suite, with coverage for the report.
  let suite = await runVitest(repoRoot, pkg, sandbox, { files: [], coverage: true });
  const failingInSuite = files.filter((file) => isKept(file) && suite.failures.some((f) => f.file === file));
  if (failingInSuite.length) {
    for (const file of failingInSuite) await reject(file, 'fails when the whole package suite runs');
    suite = await runVitest(repoRoot, pkg, sandbox, { files: [], coverage: true });
  }
  if (suite.error && !baseline?.tests.error) {
    for (const file of files.filter(isKept)) await reject(file, `the full package suite could not run: ${suite.error}`);
  }

  // Changing existing lines could make a test agree with a bug, so such an update is left for review, unless it repairs a
  // file that already failed before the agent's changes (typically broken by the pull request) without touching an assertion.
  for (const file of files.filter(isKept)) {
    const { original } = writes.get(file)!;
    if (original === null) continue;
    const changed = changedOriginalLines(original, await readFile(path.join(repoRoot, file), 'utf8'));
    if (changed.length === 0) continue;
    const failedBefore = failedBeforeAgent(file, baseline);
    if (failedBefore && !changed.some((line) => ASSERTION.test(line))) {
      results.set(file, { ...results.get(file)!, repairsExisting: true, failedBefore });
      log(`  verify ${file}: repairs a test file that failed before, no assertion changed`);
    } else {
      results.set(file, { ...results.get(file)!, changesExisting: true, ...(failedBefore && { failedBefore }) });
      log(`  verify ${file}: changes existing tests, left for review`);
    }
  }

  return {
    files: [...results.values()],
    suite: {
      ok: suite.ok,
      passed: suite.passed,
      failed: suite.failed,
      files: suite.files,
      failures: suite.failures.map((f) => `${f.file} › ${f.test}`),
      error: suite.error,
    },
    typecheck: {
      ok: typecheck.errors.length === 0 && !typecheck.failure,
      agentErrors,
      otherErrors: typecheck.errors.length - agentErrors.length,
      failure: typecheck.failure,
    },
    coverageAfter: suite.coverage,
  };
}

// True when every non-blank line of the original survives in the update: tests were added, none rewritten.
export function keepsOriginalLines(original: string, updated: string): boolean {
  return changedOriginalLines(original, updated).length === 0;
}

// The non-blank lines of the original that do not appear, in order, in the update. A named import whose names all
// still appear in an import from the same module (typically one that gained a name) is not a change.
export function changedOriginalLines(original: string, updated: string): string[] {
  const next = updated.split('\n').map((line) => line.trimEnd());
  const imports = namedImports(updated);
  const changed: string[] = [];
  let i = 0;
  for (const line of original.split('\n').map((l) => l.trimEnd())) {
    if (line === '') continue;
    const found = next.indexOf(line, i);
    if (found !== -1) i = found + 1;
    else if (!keepsImport(line, imports)) changed.push(line);
  }
  return changed;
}

// An expect() or assert call, or a matcher on a line of its own (prettier splits long expect chains).
const ASSERTION = /\b(?:expect|assert)\b|\.(?:not\.)?to[A-Z]\w*\(|\.(?:resolves|rejects)\b/;
const NAMED_IMPORT = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*(['"][^'"]+['"])/g;

function namedImports(source: string): Map<string, Set<string>> {
  const imports = new Map<string, Set<string>>();
  for (const [, type, names, module] of source.matchAll(NAMED_IMPORT)) {
    const key = `${type ? 'type ' : ''}${module}`;
    imports.set(key, new Set([...(imports.get(key) ?? []), ...importNames(names)]));
  }
  return imports;
}

function keepsImport(line: string, imports: Map<string, Set<string>>): boolean {
  const [match] = [...line.trim().matchAll(NAMED_IMPORT)];
  if (!match || match.index !== 0) return false;
  const kept = imports.get(`${match[1] ? 'type ' : ''}${match[3]}`);
  return kept !== undefined && importNames(match[2]).every((name) => kept.has(name));
}

function importNames(list: string): string[] {
  return list.split(',').map((name) => name.trim().replace(/\s+/g, ' ')).filter(Boolean);
}

function failedBeforeAgent(file: string, baseline?: Baseline): boolean {
  if (!baseline) return false;
  return baseline.tests.failures.some((f) => f.file === file) || baseline.typeErrors.some((line) => line.startsWith(`${file}(`));
}

function firstFailure(result: TestRunResult, run: number): string {
  const prefix = run > 0 ? `flaky: passed ${run} time(s), then failed` : 'failed';
  if (result.error && result.failures.length === 0) return `${prefix}: ${result.error.slice(0, 500)}`;
  const failure = result.failures[0];
  return `${prefix}: ${failure.test}\n${failure.message.slice(0, 500)}`;
}

export async function revert(repoRoot: string, file: string, record: WriteRecord): Promise<void> {
  const absolute = path.join(repoRoot, file);
  if (record.original === null) await rm(absolute, { force: true });
  else await writeFile(absolute, record.original, 'utf8');
}

export async function runTypecheck(repoRoot: string, pkg: PackageConfig, sandbox: Sandbox): Promise<{ errors: string[]; failure?: string }> {
  const result = await sandbox.run(pkg.dir, ['tsc', '--noEmit', '--pretty', 'false']);
  if (result.timedOut) return { errors: [], failure: 'tsc timed out' };
  const errors = parseTscOutput(stripAnsi(result.stdout), pkg.dir);
  // A failing tsc without per-file errors (a crash, a config error) may have checked nothing.
  if (result.exitCode !== 0 && !errors.some((line) => FILE_DIAGNOSTIC.test(line))) {
    const output = stripAnsi(`${result.stdout}\n${result.stderr}`).trim().split('\n').filter(Boolean);
    return { errors, failure: `tsc exited with code ${result.exitCode}${output.length ? `: ${output.at(-1)!.slice(0, 300)}` : ''}` };
  }
  return { errors };
}

const FILE_DIAGNOSTIC = /^[^\s(][^(]*\(\d+,\d+\): error TS\d+/;
const GLOBAL_DIAGNOSTIC = /^error TS\d+:/;

// File diagnostics become `<package>/<file>(line,col): …`; global ones (e.g. a missing type library) `<package>: error …`.
export function parseTscOutput(output: string, packageDir: string): string[] {
  return output.split('\n').flatMap((raw) => {
    const line = raw.trim();
    if (FILE_DIAGNOSTIC.test(line)) return [path.posix.join(packageDir, line)];
    if (GLOBAL_DIAGNOSTIC.test(line)) return [`${packageDir}: ${line}`];
    return [];
  });
}
