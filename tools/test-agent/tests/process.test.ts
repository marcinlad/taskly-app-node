import { execFile } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { cleanEnv, createSandbox } from '../src/process.ts';

vi.mock('node:child_process', () => ({
  execFile: vi.fn((_command, _args, _options, callback) => callback(null, '', '')),
}));

it('mounts only the package directory into the docker sandbox, without network', async () => {
  await createSandbox('/work/repo', 'docker', 'node:24').npx('backend', ['vitest', 'run']);
  const [command, args] = vi.mocked(execFile).mock.calls[0] as unknown as [string, string[]];
  expect(command).toBe('docker');
  const volumes = args.flatMap((arg, i) => (args[i - 1] === '--volume' ? [arg] : []));
  expect(volumes).toEqual(['/work/repo/backend:/repo/backend']);
  expect(args).toEqual(expect.arrayContaining(['--network', 'none', '--cap-drop', 'ALL', '--workdir', '/repo/backend']));
  expect(args.slice(-5)).toEqual(['node:24', 'npx', '--no-install', 'vitest', 'run']);
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
