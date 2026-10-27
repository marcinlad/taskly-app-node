import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PACKAGES } from '../src/config.ts';
import type { Sandbox } from '../src/process.ts';
import { verifyPackage } from '../src/verify.ts';
import { tempRepo } from './helpers.ts';

interface Behavior {
  failing?: string[];
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
        return {
          name: path.join(root, pkgDir, file),
          status: fails ? 'failed' : 'passed',
          assertionResults: [{ fullName: `${file} works`, status: fails ? 'failed' : 'passed', failureMessages: fails ? ['AssertionError: nope'] : [] }],
        };
      });
      const failed = testResults.filter((r) => r.status === 'failed').length;
      const out = args.find((arg) => arg.startsWith('--outputFile='))!.slice('--outputFile='.length);
      await mkdir(path.dirname(path.join(root, pkgDir, out)), { recursive: true });
      await writeFile(path.join(root, pkgDir, out), JSON.stringify({ numTotalTests: files.length, numPassedTests: files.length - failed, numFailedTests: failed, testResults }));
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
    ['backend/tests/existing.test.ts', { original: 'original', writes: 1 }],
    ['backend/tests/good.test.ts', { original: null, writes: 1 }],
    ['backend/tests/bad.test.ts', { original: null, writes: 1 }],
    ['backend/tests/flaky.test.ts', { original: null, writes: 2 }],
    ['backend/tests/typed.test.ts', { original: null, writes: 1 }],
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
    ['backend/tests/good.test.ts', { original: null, writes: 1 }],
    ['backend/tests/suite-only.test.ts', { original: null, writes: 1 }],
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
      ['backend/tests/a.test.ts', { original: null, writes: 1 }],
      ['backend/tests/b.test.ts', { original: null, writes: 1 }],
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

  const result = await verifyPackage(root, PACKAGES.backend, sandbox, new Map([['backend/tests/a.test.ts', { original: null, writes: 1 }]]));

  expect(result.files).toEqual([{ path: 'backend/tests/a.test.ts', kept: true, passedRuns: 3 }]);
  expect(result.typecheck).toEqual({ ok: false, agentErrors: [], otherErrors: 2, failure: undefined });
});

it('keeps agent files when tsc reports errors only in other files', async () => {
  const root = await tempRepo({ 'backend/tests/a.test.ts': '' });
  const sandbox = fakeSandbox(root, { tscOutput: "src/legacy.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\n" });

  const result = await verifyPackage(root, PACKAGES.backend, sandbox, new Map([['backend/tests/a.test.ts', { original: null, writes: 1 }]]));

  expect(result.files).toEqual([{ path: 'backend/tests/a.test.ts', kept: true, passedRuns: 3 }]);
  expect(result.typecheck).toEqual({ ok: false, agentErrors: [], otherErrors: 1, failure: undefined });
});
