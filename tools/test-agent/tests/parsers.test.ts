import { describe, expect, it } from 'vitest';
import { collapseRanges, fileCoverage, parseCoverage, totals } from '../src/coverage.ts';
import { parseTscOutput } from '../src/verify.ts';
import { cleanMessage, runLevelError, summarize } from '../src/vitest.ts';

describe('coverage', () => {
  const file = {
    statementMap: { 0: { start: { line: 1 } }, 1: { start: { line: 2 } }, 2: { start: { line: 3 } }, 3: { start: { line: 3 } }, 4: { start: { line: 5 } } },
    s: { 0: 1, 1: 0, 2: 0, 3: 2, 4: 0 },
    fnMap: { 0: { name: 'covered', decl: { start: { line: 1 } } }, 1: { name: 'missed', decl: { start: { line: 5 } } } },
    f: { 0: 3, 1: 0 },
    branchMap: { 0: { type: 'if', loc: { start: { line: 3 } }, locations: [{ start: { line: 3 } }, { start: { line: 4 } }] } },
    b: { 0: [1, 0] },
  };

  it('computes Istanbul-style metrics and uncovered locations', () => {
    expect(fileCoverage(file)).toEqual({
      lines: { covered: 2, total: 4, pct: 50 },
      statements: { covered: 2, total: 5, pct: 40 },
      functions: { covered: 1, total: 2, pct: 50 },
      branches: { covered: 1, total: 2, pct: 50 },
      uncoveredLines: ['2', '5'],
      uncoveredBranches: ['line 4 (if, path 2 of 2)'],
      uncoveredFunctions: ['missed (line 5)'],
    });
  });

  it('keys files by repository path and sums totals', () => {
    const parsed = parseCoverage({ '/repo/backend/src/a.ts': file }, '/home/runner/work');
    expect(Object.keys(parsed)).toEqual(['backend/src/a.ts']);
    expect(totals([parsed['backend/src/a.ts'], parsed['backend/src/a.ts']]).lines).toEqual({ covered: 4, total: 8, pct: 50 });
  });

  it('treats a file without branches as fully covered on branches', () => {
    expect(fileCoverage({ ...file, branchMap: {}, b: {} }).branches.pct).toBe(100);
  });

  it('collapses line numbers into ranges', () => {
    expect(collapseRanges([1, 2, 3, 5, 7, 8])).toEqual(['1-3', '5', '7-8']);
    expect(collapseRanges([])).toEqual([]);
  });
});

describe('vitest report', () => {
  it('collects assertion failures and files that fail to load', () => {
    const result = summarize({
      numTotalTests: 3, numPassedTests: 1, numFailedTests: 1, numPendingTests: 1,
      testResults: [
        { name: '/repo/backend/tests/a.test.ts', status: 'failed', assertionResults: [
          { fullName: 'adds', status: 'passed' },
          { fullName: 'rejects', status: 'failed', failureMessages: ['AssertionError: expected 1 to be 2\n    at tests/a.test.ts:3:5\n    at node_modules/vitest/x.js:1:1'] },
        ] },
        { name: '/repo/backend/tests/b.test.ts', status: 'failed', message: 'SyntaxError: Unexpected token', assertionResults: [] },
      ],
    }, '/elsewhere');
    expect(result).toEqual({
      ok: false, error: undefined, files: 2, passed: 1, failed: 2, skipped: 1,
      failures: [
        { file: 'backend/tests/a.test.ts', test: 'rejects', message: 'AssertionError: expected 1 to be 2\n    at tests/a.test.ts:3:5' },
        { file: 'backend/tests/b.test.ts', test: '(test file failed to load)', message: 'SyntaxError: Unexpected token' },
      ],
    });
  });

  it('treats a run without test files as not ok', () => {
    const result = summarize({ numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, testResults: [] }, '/repo');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('No test files ran.');
  });

  it('strips colors and dependency stack frames from messages', () => {
    expect(cleanMessage('\u001b[31mError\u001b[39m\n    at a (src/a.ts:1:1)\n    at node:internal/x\n    at new Promise (<anonymous>)\n    at b (src/b.ts:1:1)\n    at c (src/c.ts:1:1)\n    at d (src/d.ts:1:1)'))
      .toBe('Error\n    at a (src/a.ts:1:1)\n    at b (src/b.ts:1:1)\n    at c (src/c.ts:1:1)');
  });
});

it('parses tsc errors into repository paths', () => {
  const output = "tests/a.test.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\n  Detail line\nsrc/b.ts(1,1): error TS1005: ';' expected.\nerror TS2688: Cannot find type definition file for 'node'.\nFound 3 errors.";
  expect(parseTscOutput(output, 'backend')).toEqual([
    "backend/tests/a.test.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    "backend/src/b.ts(1,1): error TS1005: ';' expected.",
    "backend: error TS2688: Cannot find type definition file for 'node'.",
  ]);
});

describe('run-level errors', () => {
  const run = (exitCode: number, stdout = '', timedOut = false) => ({ exitCode, stdout, stderr: '', timedOut, durationMs: 1 });
  const threshold = 'ERROR: Coverage for lines (83.33%) does not meet "src/x.ts" threshold (100%) for src/x.ts';

  it('accepts a clean exit', () => expect(runLevelError(run(0), false, false)).toBeUndefined());

  it('rejects a non-zero exit when no test failed', () => {
    expect(runLevelError(run(1, 'something'), false, false)).toMatch(/^Vitest exited with code 1 although no test failed/);
  });

  it('leaves a non-zero exit to the test failures that explain it', () => expect(runLevelError(run(1), false, true)).toBeUndefined());

  it('tolerates coverage threshold failures only in coverage runs', () => {
    expect(runLevelError(run(1, threshold), true, false)).toBeUndefined();
    expect(runLevelError(run(1, threshold), false, false)).toMatch(/exited with code 1/);
  });

  it('always rejects unhandled errors and timeouts', () => {
    expect(runLevelError(run(1, `${threshold}\nUnhandled Errors\nError: boom`), true, false)).toMatch(/^Unhandled errors during the run/);
    expect(runLevelError(run(0, 'Unhandled Error'), true, true)).toMatch(/^Unhandled errors/);
    expect(runLevelError(run(1, '', true), true, false)).toMatch(/timed out/);
  });
});

