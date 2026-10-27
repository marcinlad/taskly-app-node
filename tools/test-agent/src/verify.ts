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
}

export interface PackageVerification {
  files: FileVerification[];
  suite: { ok: boolean; passed: number; failed: number; files: number; failures: string[]; error?: string };
  typecheck: { ok: boolean; agentErrors: string[]; otherErrors: number; failure?: string };
  coverageAfter?: Record<string, FileCoverage>;
}

// The agent writes test files only and Vitest isolates them, so suite failures elsewhere are reported, not reverted.
// A step that could not run proves nothing, so it reverts every file still kept, unless it failed the same way before
// the agent's changes (`baseline`, the package suite run before the session).
export async function verifyPackage(
  repoRoot: string,
  pkg: PackageConfig,
  sandbox: Sandbox,
  writes: Map<string, WriteRecord>,
  baseline?: TestRunResult,
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
      const skippedBefore = baseline?.skippedByFile[file] ?? 0;
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
  if (suite.error && !baseline?.error) {
    for (const file of files.filter(isKept)) await reject(file, `the full package suite could not run: ${suite.error}`);
  }

  for (const file of files.filter(isKept)) {
    const { original } = writes.get(file)!;
    if (original !== null && !keepsOriginalLines(original, await readFile(path.join(repoRoot, file), 'utf8'))) {
      results.set(file, { ...results.get(file)!, changesExisting: true });
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

// True when every non-blank line of the original appears, in order, in the update: tests were added, none rewritten.
export function keepsOriginalLines(original: string, updated: string): boolean {
  const next = updated.split('\n').map((line) => line.trimEnd());
  let i = 0;
  for (const line of original.split('\n').map((l) => l.trimEnd())) {
    if (line === '') continue;
    while (i < next.length && next[i] !== line) i++;
    if (i === next.length) return false;
    i++;
  }
  return true;
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
