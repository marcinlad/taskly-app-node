import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PACKAGES } from '../src/config.ts';
import type { Sandbox } from '../src/process.ts';
import { keepsOriginalLines, verifyPackage } from '../src/verify.ts';
import type { TestRunResult } from '../src/vitest.ts';
import { tempRepo } from './helpers.ts';

interface Behavior {
  failing?: string[];
  skippedOnly?: string[];
  // Test files that also contain one skipped test next to a passing one.
  withSkipped?: string[];
  flaky?: Record<string, number>;
  tscOutput?: string;
}

function fakeSandbox(root: string, behavior: Behavior): Sandbox {
  const runs = new Map<string, number>();
  return {
    run: vi.fn(async (pkgDir: string, args: string[]) => {
      const ok = { exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 };
      if (args[0] === 'tsc') return { ...ok, exitCode: behavior.tscOutput ? 2 : 0, stdout: behavior.tscOutput ?? '' };
      if (args[0] !== 'vitest') return ok;
      const requested = args.slice(2).filter((arg) => !arg.startsWith('--'));
      const files = requested.length ? requested : (await readdir(path.join(root, pkgDir, 'tests'))).filter((f) => f.endsWith('.test.ts')).map((f) => `tests/${f}`);
      const testResults = files.map((file) => {
        const count = (runs.get(file) ?? 0) + 1;
        runs.set(file, count);
        const fails = behavior.failing?.includes(file) || (behavior.flaky?.[file] !== undefined && count > behavior.flaky[file]);
        const status = fails ? 'failed' : behavior.skippedOnly?.includes(file) ? 'skipped' : 'passed';
        return {
          name: path.join(root, pkgDir, file),
          status: status === 'failed' ? 'failed' : 'passed',
          assertionResults: [
            { fullName: `${file} works`, status, failureMessages: fails ? ['AssertionError: nope'] : [] },
            ...(behavior.withSkipped?.includes(file) ? [{ fullName: `${file} later`, status: 'skipped' }] : []),
          ],
        };
      });
      const failed = testResults.filter((r) => r.status === 'failed').length;
      const passed = testResults.filter((r) => r.assertionResults[0].status === 'passed').length;
      const out = args.find((arg) => arg.startsWith('--outputFile.json='))!.slice('--outputFile.json='.length);
      await mkdir(path.dirname(path.join(root, pkgDir, out)), { recursive: true });
      await writeFile(path.join(root, pkgDir, out), JSON.stringify({ numTotalTests: files.length, numPassedTests: passed, numFailedTests: failed, numPendingTests: files.length - passed - failed, testResults }));
      return ok;
    }),
  };
}

it('keeps passing files and reverts failing, flaky and ill-typed ones', async () => {
  const root = await tempRepo({
    'backend/tests/existing.test.ts': 'original',
    'backend/tests/good.test.ts': 'new',
    'backend/tests/bad.test.ts': 'new',
    'backend/tests/flaky.test.ts': 'new',
    'backend/tests/typed.test.ts': 'new',
  });
  const writes = new Map([
    ['backend/tests/existing.test.ts', { original: 'original' }],
    ['backend/tests/good.test.ts', { original: null }],
    ['backend/tests/bad.test.ts', { original: null }],
    ['backend/tests/flaky.test.ts', { original: null }],
    ['backend/tests/typed.test.ts', { original: null }],
  ]);
  await writeFile(path.join(root, 'backend/tests/existing.test.ts'), 'updated by agent');
  const sandbox = fakeSandbox(root, {
    failing: ['tests/bad.test.ts'],
    flaky: { 'tests/flaky.test.ts': 1 },
    tscOutput: "tests/typed.test.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.\n",
  });

  const result = await verifyPackage(root, PACKAGES.backend, sandbox, writes);

  const byPath = Object.fromEntries(result.files.map((f) => [f.path, f]));
  expect(byPath['backend/tests/good.test.ts']).toEqual({ path: 'backend/tests/good.test.ts', kept: true, passedRuns: 3, reason: undefined });
  expect(byPath['backend/tests/existing.test.ts'].kept).toBe(true);
  expect(byPath['backend/tests/bad.test.ts']).toMatchObject({ kept: false, reason: expect.stringMatching(/^failed: /) });
  expect(byPath['backend/tests/flaky.test.ts']).toMatchObject({ kept: false, passedRuns: 1, reason: expect.stringMatching(/^flaky: passed 1 time/) });
  expect(byPath['backend/tests/typed.test.ts']).toMatchObject({ kept: false, reason: expect.stringContaining('TS2322') });
  expect(result.typecheck).toEqual({ ok: false, agentErrors: [expect.stringContaining('backend/tests/typed.test.ts(1,1)')], otherErrors: 0 });

  const remaining = (await readdir(path.join(root, 'backend/tests'))).sort();
  expect(remaining).toEqual(['existing.test.ts', 'good.test.ts']);
  expect(await readFile(path.join(root, 'backend/tests/existing.test.ts'), 'utf8')).toBe('updated by agent');
  expect(result.suite).toMatchObject({ ok: true, failed: 0, files: 2 });
});

it('reverts agent files that fail only in the full suite and reports failures elsewhere', async () => {
  const root = await tempRepo({ 'backend/tests/other.test.ts': '', 'backend/tests/good.test.ts': '', 'backend/tests/suite-only.test.ts': '' });
  const writes = new Map([
    ['backend/tests/good.test.ts', { original: null }],
    ['backend/tests/suite-only.test.ts', { original: null }],
  ]);
  // Isolated runs pass; in full-suite runs suite-only.test.ts fails, and other.test.ts (not the agent's) is already broken.
  const isolated = fakeSandbox(root, {});
  const fullSuite = fakeSandbox(root, { failing: ['tests/other.test.ts', 'tests/suite-only.test.ts'] });
  const sandbox: Sandbox = {
    run: vi.fn((dir: string, args: string[]) =>
      (args[0] === 'vitest' && args.slice(2).every((a) => a.startsWith('--')) ? fullSuite : isolated).run(dir, args)),
  };

  const result = await verifyPackage(root, PACKAGES.backend, sandbox, writes);

  expect(result.files).toEqual([
    { path: 'backend/tests/good.test.ts', kept: true, passedRuns: 3 },
    { path: 'backend/tests/suite-only.test.ts', kept: false, passedRuns: 3, reason: 'fails when the whole package suite runs' },
  ]);
  expect((await readdir(path.join(root, 'backend/tests'))).sort()).toEqual(['good.test.ts', 'other.test.ts']);
  expect(result.suite).toMatchObject({ ok: false, failures: ['backend/tests/other.test.ts › tests/other.test.ts works'] });
});

describe('steps that cannot run revert every file still kept', () => {
  const crashed = { exitCode: 1, stdout: '', stderr: 'JavaScript heap out of memory', timedOut: false, durationMs: 1 };
  const isFullSuite = (args: string[]) => args[0] === 'vitest' && args.slice(2).every((a) => a.startsWith('--'));

  async function setup() {
    const root = await tempRepo({ 'backend/tests/a.test.ts': '', 'backend/tests/b.test.ts': '', 'backend/tests/other.test.ts': '' });
    const writes = new Map([
      ['backend/tests/a.test.ts', { original: null }],
      ['backend/tests/b.test.ts', { original: null }],
    ]);
    return { root, writes };
  }

  it('when the full suite produces no report', async () => {
    const { root, writes } = await setup();
    const base = fakeSandbox(root, {});
    const sandbox: Sandbox = { run: vi.fn((dir: string, args: string[]) => (isFullSuite(args) ? Promise.resolve(crashed) : base.run(dir, args))) };

    const result = await verifyPackage(root, PACKAGES.backend, sandbox, writes);

    expect(result.files.map((f) => [f.path, f.kept])).toEqual([['backend/tests/a.test.ts', false], ['backend/tests/b.test.ts', false]]);
    expect(result.files[0].reason).toMatch(/^the full package suite could not run: Vitest did not produce a report/);
    expect((await readdir(path.join(root, 'backend/tests'))).sort()).toEqual(['other.test.ts']);
    expect(result.suite).toMatchObject({ ok: false, error: expect.stringContaining('heap out of memory') });
  });

  it('when the rerun after rejecting a file produces no report', async () => {
    const { root, writes } = await setup();
    const firstSuite = fakeSandbox(root, { failing: ['tests/a.test.ts'] });
    const base = fakeSandbox(root, {});
    let suiteRuns = 0;
    const sandbox: Sandbox = {
      run: vi.fn((dir: string, args: string[]) => {
        if (!isFullSuite(args)) return base.run(dir, args);
        suiteRuns += 1;
        return suiteRuns === 1 ? firstSuite.run(dir, args) : Promise.resolve({ ...crashed, timedOut: true });
      }),
    };

    const result = await verifyPackage(root, PACKAGES.backend, sandbox, writes);

    expect(result.files).toEqual([
      { path: 'backend/tests/a.test.ts', kept: false, passedRuns: 3, reason: 'fails when the whole package suite runs' },
      { path: 'backend/tests/b.test.ts', kept: false, passedRuns: 3, reason: 'the full package suite could not run: Vitest timed out.' },
    ]);
  });

  it.each([
    ['times out', { exitCode: 1, stdout: '', stderr: '', timedOut: true, durationMs: 1 }, 'typecheck could not run: tsc timed out'],
    ['fails without per-file errors', { exitCode: 2, stdout: "error TS5083: Cannot read file 'tsconfig.json'.\n", stderr: '', timedOut: false, durationMs: 1 },
      "typecheck could not run: tsc exited with code 2: error TS5083: Cannot read file 'tsconfig.json'."],
  ])('when tsc %s', async (_, tscResult, reason) => {
    const { root, writes } = await setup();
    const base = fakeSandbox(root, {});
    const sandbox: Sandbox = { run: vi.fn((dir: string, args: string[]) => (args[0] === 'tsc' ? Promise.resolve(tscResult) : base.run(dir, args))) };

    const result = await verifyPackage(root, PACKAGES.backend, sandbox, writes);

    expect(result.files.map((f) => [f.kept, f.reason])).toEqual([[false, reason], [false, reason]]);
    expect(result.typecheck).toMatchObject({ ok: false, failure: reason.replace('typecheck could not run: ', '') });
  });
});

it('keeps agent files and reports global tsc errors when other files were checked', async () => {
  const root = await tempRepo({ 'backend/tests/a.test.ts': '' });
  const sandbox = fakeSandbox(root, {
    tscOutput: "error TS2688: Cannot find type definition file for 'node'.\nsrc/legacy.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\n",
  });

  const result = await verifyPackage(root, PACKAGES.backend, sandbox, new Map([['backend/tests/a.test.ts', { original: null }]]));

  expect(result.files).toEqual([{ path: 'backend/tests/a.test.ts', kept: true, passedRuns: 3 }]);
  expect(result.typecheck).toEqual({ ok: false, agentErrors: [], otherErrors: 2, failure: undefined });
});

it('keeps agent files when tsc reports errors only in other files', async () => {
  const root = await tempRepo({ 'backend/tests/a.test.ts': '' });
  const sandbox = fakeSandbox(root, { tscOutput: "src/legacy.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\n" });

  const result = await verifyPackage(root, PACKAGES.backend, sandbox, new Map([['backend/tests/a.test.ts', { original: null }]]));

  expect(result.files).toEqual([{ path: 'backend/tests/a.test.ts', kept: true, passedRuns: 3 }]);
  expect(result.typecheck).toEqual({ ok: false, agentErrors: [], otherErrors: 1, failure: undefined });
});

it('reverts a file whose run passes every test but fails on an unhandled rejection', async () => {
  const root = await tempRepo({ 'backend/tests/a.test.ts': '' });
  const base = fakeSandbox(root, {});
  const unhandled = '⎯⎯⎯ Unhandled Errors ⎯⎯⎯\n⎯⎯⎯ Unhandled Rejection ⎯⎯⎯\nError: boom\nVitest caught 1 unhandled error during the test run.\n';
  const sandbox: Sandbox = {
    run: vi.fn(async (dir: string, args: string[]) => {
      const result = await base.run(dir, args);
      return args[0] === 'vitest' ? { ...result, exitCode: 1, stdout: unhandled } : result;
    }),
  };

  const result = await verifyPackage(root, PACKAGES.backend, sandbox, new Map([['backend/tests/a.test.ts', { original: null }]]));

  expect(result.files[0]).toMatchObject({ kept: false, passedRuns: 0 });
  expect(result.files[0].reason).toMatch(/^failed: Unhandled errors during the run fail it even though the tests passed:\nUnhandled Errors/);
});

it('reverts a file in which no test passed because all are skipped or todo', async () => {
  const root = await tempRepo({ 'backend/tests/a.test.ts': '', 'backend/tests/b.test.ts': '' });
  const sandbox = fakeSandbox(root, { skippedOnly: ['tests/a.test.ts'] });

  const result = await verifyPackage(root, PACKAGES.backend, sandbox, new Map([
    ['backend/tests/a.test.ts', { original: null }],
    ['backend/tests/b.test.ts', { original: null }],
  ]));

  expect(result.files).toEqual([
    { path: 'backend/tests/a.test.ts', kept: false, passedRuns: 0, reason: 'no test passed: the file has only skipped or todo tests' },
    { path: 'backend/tests/b.test.ts', kept: true, passedRuns: 3 },
  ]);
});

function baselineRun(overrides: Partial<TestRunResult> = {}): TestRunResult {
  return { ok: true, files: 1, passed: 1, failed: 0, skipped: 0, skippedByFile: {}, failures: [], ...overrides };
}

it('reverts a file that adds skipped tests, but allows the skips a file already had', async () => {
  const root = await tempRepo({ 'backend/tests/new.test.ts': '', 'backend/tests/old.test.ts': 'it.skip(1)\n' });
  const sandbox = fakeSandbox(root, { withSkipped: ['tests/new.test.ts', 'tests/old.test.ts'] });
  const writes = new Map([
    ['backend/tests/new.test.ts', { original: null }],
    ['backend/tests/old.test.ts', { original: 'it.skip(1)\n' }],
  ]);

  const result = await verifyPackage(root, PACKAGES.backend, sandbox, writes, baselineRun({ skippedByFile: { 'backend/tests/old.test.ts': 1 } }));

  expect(result.files.map((f) => [f.path, f.kept, f.reason])).toEqual([
    ['backend/tests/new.test.ts', false, 'adds skipped or todo tests: 1 in the file, 0 before'],
    ['backend/tests/old.test.ts', true, undefined],
  ]);
});

it('keeps verified files when the suite already failed at run level before the agent', async () => {
  const root = await tempRepo({ 'backend/tests/a.test.ts': '' });
  const base = fakeSandbox(root, {});
  const crashed = { exitCode: 1, stdout: '', stderr: 'boom', timedOut: false, durationMs: 1 };
  const sandbox: Sandbox = {
    run: vi.fn((dir: string, args: string[]) => (args[0] === 'vitest' && args.slice(2).every((a) => a.startsWith('--')) ? Promise.resolve(crashed) : base.run(dir, args))),
  };
  const writes = new Map([['backend/tests/a.test.ts', { original: null }]]);

  const result = await verifyPackage(root, PACKAGES.backend, sandbox, writes, baselineRun({ ok: false, error: 'Unhandled errors during the run' }));

  expect(result.files).toEqual([{ path: 'backend/tests/a.test.ts', kept: true, passedRuns: 3 }]);
  expect(result.suite.ok).toBe(false);
});

it('flags kept updates that change existing test lines', async () => {
  const original = "import { it } from 'vitest';\n\nit('one', () => {\n  expect(f()).toBe(422);\n});\n";
  const root = await tempRepo({
    'backend/tests/added.test.ts': `${original}\nit('two', () => {\n  expect(g()).toBe(1);\n});\n`,
    'backend/tests/changed.test.ts': original.replace('toBe(422)', 'toBe(200)'),
  });
  const writes = new Map([
    ['backend/tests/added.test.ts', { original }],
    ['backend/tests/changed.test.ts', { original }],
  ]);

  const result = await verifyPackage(root, PACKAGES.backend, fakeSandbox(root, {}), writes);

  expect(result.files.map((f) => [f.path, f.kept, f.changesExisting])).toEqual([
    ['backend/tests/added.test.ts', true, undefined],
    ['backend/tests/changed.test.ts', true, true],
  ]);
});

it('treats an update as additive only when every original line survives in order', () => {
  expect(keepsOriginalLines('a\n\nb\n', 'import x\na\nnew\n\nb\nmore\n')).toBe(true);
  expect(keepsOriginalLines('a\nb\n', 'b\na\n')).toBe(false);
  expect(keepsOriginalLines('a\nb\n', 'a\n')).toBe(false);
  expect(keepsOriginalLines('a  \n', 'a\n')).toBe(true);
});

