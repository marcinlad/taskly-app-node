import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Limits, PackageConfig } from './config.ts';
import type { FileCoverage } from './coverage.ts';
import { stripAnsi, type Sandbox } from './process.ts';
import type { WriteRecord } from './tools.ts';
import { runVitest, type TestRunResult } from './vitest.ts';

export interface FileVerification {
  path: string;
  kept: boolean;
  reason?: string;
  passedRuns?: number;
}

export interface PackageVerification {
  files: FileVerification[];
  suite: { ok: boolean; passed: number; failed: number; files: number; failures: string[]; error?: string };
  typecheck: { ok: boolean; agentErrors: string[]; otherErrors: number };
  coverageAfter?: Record<string, FileCoverage>;
}

// The agent writes test files only and Vitest isolates them, so suite failures elsewhere are reported, not reverted.
export async function verifyPackage(
  repoRoot: string,
  pkg: PackageConfig,
  sandbox: Sandbox,
  writes: Map<string, WriteRecord>,
  limits: Limits,
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
  if (pkg.format && files.length) {
    await sandbox.npx(pkg.dir, [...pkg.format, ...files.map((file) => path.posix.relative(pkg.dir, file))]);
  }

  // 1. Each file must pass on its own, several runs in a row; passing and then failing means flaky.
  for (const file of files) {
    let passedRuns = 0;
    let failure: string | undefined;
    for (let run = 0; run < limits.verifyRepeats && !failure; run++) {
      const result = await runVitest(repoRoot, pkg, sandbox, { files: [file] });
      if (result.ok) passedRuns += 1;
      else failure = firstFailure(result, run);
    }
    results.set(file, { path: file, kept: true, passedRuns });
    if (failure) await reject(file, failure);
    else log(`  verify ${file}: ${passedRuns}/${limits.verifyRepeats} runs passed`);
  }

  // 2. Type-check: Vitest strips types without checking them.
  const typecheck = await runTypecheck(repoRoot, pkg, sandbox, limits);
  const agentErrors = typecheck.errors.filter((line) => writes.has(line.split('(')[0]));
  for (const file of files.filter(isKept)) {
    const errors = agentErrors.filter((line) => line.startsWith(`${file}(`));
    if (errors.length) await reject(file, `type errors:\n${errors.slice(0, 5).join('\n')}`);
  }

  // 3. The full suite, with coverage for the report.
  let suite = await runVitest(repoRoot, pkg, sandbox, { files: [], coverage: true });
  const failingInSuite = files.filter((file) => isKept(file) && suite.failures.some((f) => f.file === file));
  if (failingInSuite.length) {
    for (const file of failingInSuite) await reject(file, 'fails when the whole package suite runs');
    suite = await runVitest(repoRoot, pkg, sandbox, { files: [], coverage: true });
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
    typecheck: { ok: typecheck.errors.length === 0, agentErrors, otherErrors: typecheck.errors.length - agentErrors.length },
    coverageAfter: suite.coverage,
  };
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

export async function runTypecheck(repoRoot: string, pkg: PackageConfig, sandbox: Sandbox, limits: Limits): Promise<{ errors: string[] }> {
  const result = await sandbox.npx(pkg.dir, ['tsc', '--noEmit', '--pretty', 'false']);
  if (result.timedOut) return { errors: [`${pkg.dir}: typecheck timed out after ${limits.commandTimeoutMs} ms`] };
  return { errors: parseTscOutput(stripAnsi(result.stdout), pkg.dir) };
}

export function parseTscOutput(output: string, packageDir: string): string[] {
  return output
    .split('\n')
    .filter((line) => /^[^\s(][^(]*\(\d+,\d+\): error TS\d+/.test(line))
    .map((line) => `${path.posix.join(packageDir, line.trim())}`);
}
