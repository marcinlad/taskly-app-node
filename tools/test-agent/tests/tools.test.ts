import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PACKAGES } from '../src/config.ts';
import type { Sandbox } from '../src/process.ts';
import { countTestCases, createSessionState, createTools, MAX_TEST_RUNS, MAX_WRITE_BYTES, MAX_WRITES, TRIAGE_HINT, type SessionContext } from '../src/tools.ts';
import { tempRepo } from './helpers.ts';

const existingTest = "import { it } from 'vitest';\nit('one', () => {});\nit.each([1, 2])('two %s', () => {});\n";

async function setup(mode: 'pr' | 'coverage' = 'coverage') {
  const repoRoot = await tempRepo({
    'backend/src/factory.ts': 'export function createApp() {}\n',
    'backend/tests/router.test.ts': existingTest,
    'frontend/src/lib/http.ts': 'export {}\n',
    '.env': 'ANTHROPIC_API_KEY=secret\n',
  });
  const sandbox: Sandbox = { npx: vi.fn() };
  const ctx: SessionContext = {
    repoRoot, pkg: PACKAGES.backend, mode, sandbox,
    targets: [{ path: 'backend/src/factory.ts', package: 'backend', reason: 'test', existingTests: [] }],
    diffs: new Map([['backend/src/factory.ts', '+export function createApp() {}']]),
    skills: new Map([['backend-vitest', { name: 'backend-vitest', description: 'Backend conventions', body: 'Use supertest.' }]]),
    onEvent: vi.fn(),
  };
  const state = createSessionState();
  const tools = createTools(ctx, state);
  const call = (name: string, input: unknown) => { const tool = tools.find((t) => t.name === name) as any; return tool.run(tool.parse ? tool.parse(input) : input); };
  return { repoRoot, ctx, state, tools, call, sandbox };
}

it('offers get_diff only in pull request runs', async () => {
  expect((await setup('coverage')).tools.map((t) => t.name)).not.toContain('get_diff');
  const { tools, call } = await setup('pr');
  expect(tools.map((t) => t.name)).toContain('get_diff');
  expect(await call('get_diff', { path: 'backend/src/factory.ts' })).toContain('+export function createApp');
  expect(await call('get_diff', { path: 'backend/src/other.ts' })).toBe('backend/src/other.ts is not changed in this pull request.');
});

describe('reading', () => {
  it('reads files with line numbers and ranges', async () => {
    const { call } = await setup();
    expect(await call('read_file', { path: 'backend/tests/router.test.ts', start_line: 2, end_line: 2 })).toBe("2| it('one', () => {});");
  });

  it('refuses secrets and paths outside the repository', async () => {
    const { call } = await setup();
    await expect(call('read_file', { path: '.env' })).rejects.toThrow('not readable');
    await expect(call('read_file', { path: '../../etc/passwd' })).rejects.toThrow('Invalid path');
    await expect(call('list_files', { dir: '/' })).rejects.toThrow('Invalid path');
  });

  it('lists and searches without exposing hidden files', async () => {
    const { call } = await setup();
    expect((await call('list_files', { dir: '.' })).split('\n')).toEqual(['backend/src/factory.ts', 'backend/tests/router.test.ts', 'frontend/src/lib/http.ts']);
    expect(await call('search_code', { query: 'createApp' })).toBe('backend/src/factory.ts:1: export function createApp() {}');
    expect(await call('search_code', { query: 'ANTHROPIC_API_KEY' })).toBe('No matches for "ANTHROPIC_API_KEY".');
  });

  it('does not follow symlinks out of the repository when listing or searching', async () => {
    const { call, repoRoot } = await setup();
    const outside = await tempRepo({ 'runner.json': '{ "token": "secret" }' });
    await symlink(outside, path.join(repoRoot, 'backend/docs'));
    await mkdir(path.join(outside, 'sub'));
    await writeFile(path.join(outside, 'sub/more.json'), '{ "token": "secret" }');
    await expect(call('list_files', { dir: 'backend/docs' })).rejects.toThrow(/symlink|escapes the repository/);
    await expect(call('list_files', { dir: 'backend/docs/sub' })).rejects.toThrow(/symlink|escapes the repository/);
    await expect(call('search_code', { query: 'token', dir: 'backend/docs' })).rejects.toThrow(/symlink|escapes the repository/);
    expect(await call('search_code', { query: 'token', dir: 'backend' })).toBe('No matches for "token".');
    expect(await call('list_files', { dir: 'backend' })).not.toContain('docs');
  });

  it('loads skills and records their use once', async () => {
    const { call, state } = await setup();
    expect(await call('load_skill', { name: 'backend-vitest' })).toBe('# Skill: backend-vitest\n\nUse supertest.');
    await call('load_skill', { name: 'backend-vitest' });
    expect(state.skillsUsed).toEqual(['backend-vitest']);
    await expect(call('load_skill', { name: 'nope' })).rejects.toThrow('Unknown skill');
  });
});

describe('write_test_file', () => {
  it('writes new test files and remembers that they did not exist', async () => {
    const { call, state, repoRoot } = await setup();
    expect(await call('write_test_file', { path: 'backend/tests/factory.test.ts', content: existingTest })).toContain('2 test cases');
    expect(await readFile(path.join(repoRoot, 'backend/tests/factory.test.ts'), 'utf8')).toBe(existingTest);
    expect(state.writes.get('backend/tests/factory.test.ts')).toEqual({ original: null, writes: 1 });
  });

  it.each([
    'backend/src/factory.ts', 'backend/vitest.config.ts', 'backend/package.json', 'frontend/src/lib/http.test.ts',
    '.github/workflows/ci.yml', 'backend/tests/../src/factory.ts', '/tmp/x.test.ts',
    'backend/tests/fixture.ts', 'backend/tests/helpers/db.ts', 'frontend/src/test/setup.ts',
  ])('refuses to write %s', async (file) => {
    const { call } = await setup();
    await expect(call('write_test_file', { path: file, content: '' })).rejects.toThrow('Refused');
  });

  it('keeps the original content across repeated writes and refuses to drop test cases', async () => {
    const { call, state } = await setup();
    const extended = `${existingTest}it('three', () => {});\n`;
    await call('write_test_file', { path: 'backend/tests/router.test.ts', content: extended });
    await call('write_test_file', { path: 'backend/tests/router.test.ts', content: extended });
    expect(state.writes.get('backend/tests/router.test.ts')).toEqual({ original: existingTest, writes: 2 });
    await expect(call('write_test_file', { path: 'backend/tests/router.test.ts', content: "it('one', () => {});" }))
      .rejects.toThrow('had 2 test cases and the new content has 1');
  });

  it('enforces the write limits', async () => {
    const { call } = await setup();
    await expect(call('write_test_file', { path: 'backend/tests/a.test.ts', content: 'x'.repeat(MAX_WRITE_BYTES + 1) })).rejects.toThrow('exceeds');
    for (let i = 0; i < MAX_WRITES; i++) await call('write_test_file', { path: `backend/tests/f${i}.test.ts`, content: '' });
    await call('write_test_file', { path: 'backend/tests/f0.test.ts', content: '' });
    await expect(call('write_test_file', { path: 'backend/tests/extra.test.ts', content: '' })).rejects.toThrow(`limit of ${MAX_WRITES} written files`);
  });
});

describe('run_tests', () => {
  it('accepts only test files of the package and enforces the run limit', async () => {
    const { call, sandbox } = await setup();
    await expect(call('run_tests', { files: ['backend/src/factory.ts'] })).rejects.toThrow('not a test file');
    vi.mocked(sandbox.npx).mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'boom', timedOut: false, durationMs: 1 });
    const output = await call('run_tests', { files: ['backend/tests/router.test.ts'] });
    expect(output).toContain('ERROR: Vitest did not produce a report');
    expect(output.endsWith(TRIAGE_HINT)).toBe(true);
    expect(vi.mocked(sandbox.npx).mock.calls[0][1]).toEqual(expect.arrayContaining(['vitest', 'run', 'tests/router.test.ts', '--reporter=json']));
    for (let i = 1; i < MAX_TEST_RUNS; i++) await call('run_tests', { files: ['backend/tests/router.test.ts'] });
    await expect(call('run_tests', { files: ['backend/tests/router.test.ts'] })).rejects.toThrow(`Test run limit (${MAX_TEST_RUNS}) reached`);
  });
});

describe('submit_report', () => {
  const entry = { source: 'backend/src/factory.ts', decision: 'create', reason: 'new', testFiles: ['backend/tests/factory.test.ts'], status: 'passing', suspectedBugs: [] };

  it('accepts a complete report that matches the session', async () => {
    const { call, state } = await setup();
    await call('write_test_file', { path: 'backend/tests/factory.test.ts', content: '' });
    expect(await call('submit_report', { summary: 'Done.', files: [entry] })).toContain('Report accepted');
    expect(state.report?.files).toEqual([entry]);
  });

  it('rejects missing targets, unknown files and unwritten test files', async () => {
    const { call, state } = await setup();
    await expect(call('submit_report', { summary: '', files: [] })).rejects.toThrow('missing entry for target backend/src/factory.ts');
    await expect(call('submit_report', { summary: '', files: [entry, { ...entry, source: 'backend/src/other.ts' }] }))
      .rejects.toThrow(/was not written in this session[\s\S]*is not a target/);
    await expect(call('submit_report', { summary: '', files: [{ ...entry, testFiles: [] }] })).rejects.toThrow('needs testFiles');
    expect(state.report).toBeNull();
  });
});

it('stops pointing to failure-triage once it is loaded', async () => {
  const { call, sandbox, ctx } = await setup();
  ctx.skills.set('failure-triage', { name: 'failure-triage', description: 'Triage', body: 'Steps.' });
  vi.mocked(sandbox.npx).mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'boom', timedOut: false, durationMs: 1 });
  await call('load_skill', { name: 'failure-triage' });
  expect(await call('run_tests', { files: ['backend/tests/router.test.ts'] })).not.toContain(TRIAGE_HINT);
});

it('counts test cases including it.each and test()', () => {
  expect(countTestCases("it('a', f)\ntest('b', f)\nit.each([1])('c', f)\nit.each`\n a\n`('d', f)\n// it is fine\n")).toBe(4);
});
