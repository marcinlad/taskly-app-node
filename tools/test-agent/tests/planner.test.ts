import { describe, expect, it } from 'vitest';
import { metric, type FileCoverage } from '../src/coverage.ts';
import { testedModules } from '../src/files.ts';
import { planFromChanges, planFromCoverage, targetsByPackage } from '../src/planner.ts';
import { tempRepo } from './helpers.ts';

const repoFiles = {
  'backend/src/features/todos/router.ts': '',
  'backend/tests/router.test.ts': "import { createTodosRouter } from '../src/features/todos/router.ts';",
  'frontend/src/lib/http.ts': '',
  'frontend/src/features/todos/api/todos.ts': '',
  'frontend/src/features/todos/api/todos.test.ts':
    "import { request } from '../../../lib/http'\nimport { todosApi } from './todos'\nvi.mock('../../../lib/http', () => ({ request: vi.fn() }))",
};

describe('testedModules', () => {
  it('counts imported modules but not mocked ones', () => {
    expect(testedModules('frontend/src/features/todos/api/todos.test.ts', repoFiles['frontend/src/features/todos/api/todos.test.ts']))
      .toEqual(['frontend/src/features/todos/api/todos']);
  });

  it('ignores package imports and resolves extensions', () => {
    expect(testedModules('backend/tests/a.test.ts', "import express from 'express';\nimport { x } from '../src/x.js';")).toEqual(['backend/src/x']);
  });
});

describe('planFromChanges', () => {
  it('targets changed source files and explains every skipped file', async () => {
    const root = await tempRepo(repoFiles);
    const plan = await planFromChanges(root, [
      { path: 'backend/src/features/todos/router.ts', status: 'modified' },
      { path: 'frontend/src/lib/http.ts', status: 'added' },
      { path: 'frontend/src/features/todos/api/todos.test.ts', status: 'modified' },
      { path: 'frontend/src/features/todos/types.ts', status: 'modified' },
      { path: 'frontend/src/styles.css', status: 'modified' },
      { path: 'backend/src/old.ts', status: 'deleted' },
      { path: 'README.md', status: 'modified' },
    ], 8);

    expect(plan.targets).toEqual([
      { path: 'backend/src/features/todos/router.ts', package: 'backend', reason: 'modified in the pull request', changeStatus: 'modified', existingTests: ['backend/tests/router.test.ts'] },
      { path: 'frontend/src/lib/http.ts', package: 'frontend', reason: 'added in the pull request', changeStatus: 'added', existingTests: [] },
    ]);
    expect(plan.changedTests).toEqual(['frontend/src/features/todos/api/todos.test.ts']);
    expect(Object.fromEntries(plan.skipped.map((s) => [s.path, s.reason]))).toEqual({
      'frontend/src/features/todos/api/todos.test.ts': 'test file changed in the pull request; used as context',
      'frontend/src/features/todos/types.ts': expect.stringContaining('excluded from unit-test coverage'),
      'frontend/src/styles.css': expect.stringContaining('not application source code'),
      'backend/src/old.ts': 'deleted',
      'README.md': 'outside frontend/ and backend/',
    });
    expect([...targetsByPackage(plan).keys()]).toEqual(['backend', 'frontend']);
  });

  it('caps targets per package', async () => {
    const root = await tempRepo();
    const changes = ['a', 'b', 'c'].map((name) => ({ path: `backend/src/${name}.ts`, status: 'added' as const }));
    const plan = await planFromChanges(root, changes, 2);
    expect(plan.targets.map((t) => t.path)).toEqual(['backend/src/a.ts', 'backend/src/b.ts']);
    expect(plan.skipped).toEqual([{ path: 'backend/src/c.ts', reason: 'over the limit of 2 files per package for one run' }]);
  });
});

describe('planFromCoverage', () => {
  function coverage(linesCovered: number, branchesCovered: number): FileCoverage {
    return {
      lines: metric(linesCovered, 10), branches: metric(branchesCovered, 4), functions: metric(1, 1), statements: metric(linesCovered, 10),
      uncoveredLines: [], uncoveredBranches: [], uncoveredFunctions: [],
    };
  }

  it('targets testable files below the threshold, least covered first', async () => {
    const root = await tempRepo(repoFiles);
    const plan = await planFromCoverage(root, new Map([['backend', {
      'backend/src/a.ts': coverage(7, 4),
      'backend/src/b.ts': coverage(0, 0),
      'backend/src/c.ts': coverage(10, 4),
      'backend/src/types.ts': coverage(0, 0),
      'backend/src/d.ts': coverage(10, 1),
    }]]), { threshold: 80, maxTargetsPerPackage: 8 });
    expect(plan.targets.map((t) => t.path)).toEqual(['backend/src/b.ts', 'backend/src/a.ts', 'backend/src/d.ts']);
    expect(plan.targets[0].reason).toBe('coverage below 80%: lines 0%, branches 0%');
    expect(plan.targets[0].baselineCoverage?.lines.pct).toBe(0);
  });

  it('restricts the plan to the requested files', async () => {
    const root = await tempRepo();
    const plan = await planFromCoverage(root, new Map([['backend', { 'backend/src/a.ts': coverage(0, 0), 'backend/src/b.ts': coverage(0, 0) }]]), {
      threshold: 80, maxTargetsPerPackage: 8, only: ['backend/src/b.ts'],
    });
    expect(plan.targets.map((t) => t.path)).toEqual(['backend/src/b.ts']);
  });
});
