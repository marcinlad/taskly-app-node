import { execFile } from 'node:child_process';
import { beforeEach, expect, it, vi } from 'vitest';
import { cleanEnv, createSandbox } from '../src/process.ts';
import { tempRepo } from './helpers.ts';

vi.mock('node:child_process', () => ({
  // The callback is the last argument, whichever execFile signature the caller uses.
  execFile: vi.fn((...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback === 'function') callback(null, '', '');
  }),
}));

function dockerCall(index: number) {
  const [command, args] = vi.mocked(execFile).mock.calls[index] as unknown as [string, string[]];
  const after = (flag: string) => args.flatMap((arg, i) => (args[i - 1] === flag ? [arg] : []));
  return { command, args, after };
}

beforeEach(() => vi.mocked(execFile).mockClear());

it('mounts only the package directory, read-only, into the docker sandbox without network', async () => {
  const root = await tempRepo({ 'backend/package.json': '{}' });
  await createSandbox(root, 'docker', 'node:24').run('backend', ['vitest', 'run'], 'node_modules/.test-agent/run-1');
  const { command, args, after } = dockerCall(0);
  expect(command).toBe('docker');
  expect(after('--volume')).toEqual([`${root}/backend:/repo/backend:ro`, `${root}/backend/node_modules/.test-agent/run-1:/repo/backend/node_modules/.test-agent/run-1`]);
  expect(after('--tmpfs').map((arg) => arg.split(':')[0])).toEqual(['/repo/backend/node_modules/.vite-temp', '/repo/backend/node_modules/.vite']);
  expect(after('--name')[0]).toMatch(/^test-agent-[0-9a-f-]{36}$/);
  expect(args).toEqual(expect.arrayContaining(['--network', 'none', '--cap-drop', 'ALL', '--workdir', '/repo/backend']));
  expect(args.slice(-3)).toEqual(['node:24', 'node_modules/.bin/vitest', 'run']);
});

it('gives a run without a writable directory nothing to write to but tmpfs', async () => {
  const root = await tempRepo({ 'backend/package.json': '{}' });
  await createSandbox(root, 'docker', 'node:24').run('backend', ['tsc', '--noEmit']);
  expect(dockerCall(0).after('--volume')).toEqual([`${root}/backend:/repo/backend:ro`]);
});

it('force-removes the container when the run times out', async () => {
  const root = await tempRepo({ 'backend/package.json': '{}' });
  vi.mocked(execFile).mockImplementationOnce(((...args: unknown[]) => {
    (args.at(-1) as (error: unknown, stdout: string, stderr: string) => void)(Object.assign(new Error('killed'), { killed: true, code: null }), '', '');
  }) as never);
  const result = await createSandbox(root, 'docker', 'node:24').run('backend', ['vitest', 'run']);
  expect(result.timedOut).toBe(true);
  const name = dockerCall(0).after('--name')[0];
  expect(dockerCall(1).args).toEqual(['rm', '--force', name]);
});

it('builds the test environment without the agent secrets', () => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'secret');
  vi.stubEnv('GITHUB_TOKEN', 'secret');
  const env = cleanEnv();
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env.GITHUB_TOKEN).toBeUndefined();
  expect(env.CI).toBe('true');
  vi.unstubAllEnvs();
});
