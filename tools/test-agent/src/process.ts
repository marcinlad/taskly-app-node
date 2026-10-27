import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { SandboxMode } from './config.ts';

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface CommandOptions {
  cwd: string;
  timeoutMs: number;
  extraEnv?: Record<string, string>;
}

// Built from scratch so code from the pull request never sees API keys or the GitHub token.
export function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { CI: 'true', NODE_ENV: 'test', FORCE_COLOR: '0', NO_COLOR: '1' };
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ']) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return { ...env, ...extra };
}

export function runCommand(command: string, args: string[], options: CommandOptions): Promise<CommandResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env: cleanEnv(options.extraEnv),
        timeout: options.timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 20 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const timedOut = Boolean(error && (error as { killed?: boolean }).killed);
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ exitCode: code, stdout: String(stdout), stderr: String(stderr), timedOut, durationMs: Date.now() - started });
      },
    );
  });
}

export interface Sandbox {
  // writableDir: a directory inside the package, relative to it, that this one run may write to.
  run(packageDir: string, args: string[], writableDir?: string): Promise<CommandResult>;
}

const COMMAND_TIMEOUT_MS = 5 * 60_000;
// Vite's bundled config and cache, writable as tmpfs and gone with the container.
const TMPFS_DIRS = ['node_modules/.vite-temp', 'node_modules/.vite'];

// docker: a throwaway container without network that mounts only the package directory, read-only, so pull request
// code can't reach the internet, the agent's process, files the host runs later (.git config, the agent itself),
// or the source the tests are verified against. local mode has none of these protections; it is for development.
export function createSandbox(repoRoot: string, mode: SandboxMode, image: string): Sandbox {
  return {
    async run(packageDir, [bin, ...args], writableDir) {
      const hostDir = path.join(repoRoot, packageDir);
      if (mode === 'local') {
        return runCommand(path.join(hostDir, 'node_modules', '.bin', bin), args, { cwd: hostDir, timeoutMs: COMMAND_TIMEOUT_MS });
      }
      // Mount points inside a read-only mount must already exist.
      for (const dir of TMPFS_DIRS) await mkdir(path.join(hostDir, dir), { recursive: true });
      const boxDir = `/repo/${packageDir}`;
      const ids = typeof process.getuid === 'function' ? { uid: process.getuid(), gid: process.getgid?.() ?? 0 } : undefined;
      const envArgs = Object.entries(cleanEnv())
        .filter(([name]) => !['PATH', 'HOME', 'TMPDIR'].includes(name))
        .flatMap(([name, value]) => ['--env', `${name}=${value}`]);
      const name = `test-agent-${randomUUID()}`;
      const result = await runCommand(
        'docker',
        [
          'run', '--rm', '--name', name, '--network', 'none',
          '--memory', '2g', '--cpus', '2', '--pids-limit', '512',
          '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
          ...(ids ? ['--user', `${ids.uid}:${ids.gid}`] : []), '--env', 'HOME=/tmp',
          ...envArgs,
          '--volume', `${hostDir}:${boxDir}:ro`,
          ...(writableDir ? ['--volume', `${path.join(hostDir, writableDir)}:${boxDir}/${writableDir}`] : []),
          ...TMPFS_DIRS.flatMap((dir) => ['--tmpfs', `${boxDir}/${dir}${ids ? `:uid=${ids.uid},gid=${ids.gid}` : ''}`]),
          '--workdir', boxDir, '--entrypoint', '',
          image, `node_modules/.bin/${bin}`, ...args,
        ],
        { cwd: repoRoot, timeoutMs: COMMAND_TIMEOUT_MS },
      );
      // Killing the docker client leaves the container running; remove it before anything else runs.
      if (result.timedOut) await runCommand('docker', ['rm', '--force', name], { cwd: repoRoot, timeoutMs: 60_000 });
      return result;
    },
  };
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n… [${text.length - maxChars} characters omitted] …\n${text.slice(-tail)}`;
}

export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}
