import { expect, it } from 'vitest';
import { metric, type FileCoverage } from '../src/coverage.ts';
import type { RunResult } from '../src/orchestrator.ts';
import { COMMENT_MARKER, renderMarkdown, sanitize } from '../src/report.ts';

function coverage(lines: number): FileCoverage {
  return { lines: metric(lines, 10), branches: metric(lines, 10), functions: metric(1, 1), statements: metric(lines, 10), uncoveredLines: [], uncoveredBranches: [], uncoveredFunctions: [] };
}

function result(overrides: Partial<RunResult> = {}): RunResult {
  const target = { path: 'backend/src/factory.ts', package: 'backend' as const, reason: 'modified in the pull request', existingTests: [] };
  return {
    mode: 'pr', dryRun: false, startedAt: '2026-10-23T12:00:00Z', durationMs: 90_000, model: 'claude-opus-5-5', effort: 'high',
    plan: { mode: 'pr', targets: [target], skipped: [{ path: 'README.md', reason: 'outside frontend/ and backend/' }], changedTests: [] },
    packages: [{
      package: 'backend',
      targets: [target],
      agent: {
        report: {
          summary: 'Covered the error handler. @maintainer please look.',
          files: [{
            source: 'backend/src/factory.ts', decision: 'create', reason: 'New error handling | branches.',
            testFiles: ['backend/tests/factory.test.ts', 'backend/tests/extra.test.ts'], status: 'passing',
            suspectedBugs: ['Line 20 returns 500 for <script>alert(1)</script> [details](https://evil.example)'],
          }],
        },
        skillsUsed: ['unit-test-workflow', 'backend-vitest'], iterations: 12, toolCalls: 20, testRuns: 4,
      },
      verification: {
        files: [
          { path: 'backend/tests/factory.test.ts', kept: true, passedRuns: 3 },
          { path: 'backend/tests/extra.test.ts', kept: false, reason: 'failed: x' },
        ],
        suite: { ok: true, passed: 60, failed: 0, files: 5, failures: [] },
        typecheck: { ok: true, agentErrors: [], otherErrors: 0 },
        coverageAfter: { 'backend/src/factory.ts': coverage(9) },
      },
      coverageBefore: { 'backend/src/factory.ts': coverage(0) },
    }],
    keptFiles: ['backend/tests/factory.test.ts'],
    guard: { checked: true, violations: [] },
    usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 9000, cacheWriteTokens: 1000 },
    transcript: [],
    ...overrides,
  };
}

it('shows the outcome, decisions and verification, with the rest folded into details', () => {
  const markdown = renderMarkdown(result());
  expect(markdown.startsWith(COMMENT_MARKER)).toBe(true);
  expect(markdown).toContain('✅ **1** test file(s) verified · **1** reverted · all test suites pass');
  expect(markdown).toContain('| `backend/src/factory.ts` | create | `backend/tests/factory.test.ts` ✅ 3×<br>`backend/tests/extra.test.ts` ❌ reverted | New error handling \\| branches. |');
  expect(markdown).toContain('| backend | ✅ 60 passed | ✅ | 0% → **90%** (+90) | 0% → **90%** (+90) |');
  expect(markdown).toContain('### Suspected bugs');

  const [visible, folded] = markdown.split('<details><summary>Details</summary>');
  expect(visible).not.toContain('README.md');
  expect(folded).toContain('- `backend/tests/extra.test.ts`: failed: x');
  expect(folded).toContain('| `backend/src/factory.ts` | 0% → **90%** (+90) | 0% → **90%** (+90) |');
  expect(folded).toContain('- `README.md`: outside frontend/ and backend/');
  expect(folded).toContain('skills `unit-test-workflow`, `backend-vitest`');
  expect(folded).toContain('- Tokens: 1000 input, 500 output, 9000 cache read, 1000 cache write');
  expect(folded.trim().endsWith('</details>')).toBe(true);
});

it('renders model-written text inert', () => {
  const markdown = renderMarkdown(result());
  expect(markdown).not.toContain('<script>');
  expect(markdown).not.toContain('](https://evil.example)');
  expect(markdown).not.toContain('@maintainer');
  expect(sanitize('see [docs](https://x.y) ![img](https://x.y/a.png) @octocat <b>hi</b>')).toBe('see docs img @​octocat &lt;b&gt;hi&lt;/b&gt;');
  expect(sanitize('raw https://example.com/path')).toBe('raw `https://example.com/path`');
});

it('flags guard violations and session errors', () => {
  const base = result();
  base.packages[0].agent!.error = 'Session timed out after 20 minutes.';
  const markdown = renderMarkdown({ ...base, guard: { checked: true, violations: ['backend/src/factory.ts'] } });
  expect(markdown).toContain('⚠️');
  expect(markdown).toContain('> backend: Session timed out after 20 minutes.');
  expect(markdown).toContain("> - `backend/src/factory.ts`");
});

it('says so when nothing needs tests', () => {
  const markdown = renderMarkdown(result({ plan: { mode: 'pr', targets: [], skipped: [], changedTests: [] }, packages: [] }));
  expect(markdown).toContain('No changed application source files need unit tests in this pull request.');
});
