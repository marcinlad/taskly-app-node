import { execFile } from 'node:child_process';
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
  npx(packageDir: string, args: string[], extraEnv?: Record<string, string>): Promise<CommandResult>;
}

// docker: a throwaway container without network, so pull request code can't reach the agent or the internet.
export function createSandbox(repoRoot: string, mode: SandboxMode, image: string, timeoutMs: number): Sandbox {
  return {
    async npx(packageDir, args, extraEnv = {}) {
      const cwd = path.join(repoRoot, packageDir);
      if (mode === 'local') return runCommand('npx', ['--no-install', ...args], { cwd, timeoutMs, extraEnv });
      const user = typeof process.getuid === 'function' ? [`--user`, `${process.getuid()}:${process.getgid?.()}`] : [];
      const envArgs = Object.entries(cleanEnv(extraEnv))
        .filter(([name]) => !['PATH', 'HOME', 'TMPDIR'].includes(name))
        .flatMap(([name, value]) => ['--env', `${name}=${value}`]);
      return runCommand(
        'docker',
        [
          'run', '--rm', '--network', 'none',
          '--memory', '2g', '--cpus', '2', '--pids-limit', '512',
          '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
          ...user, '--env', 'HOME=/tmp',
          ...envArgs,
          '--volume', `${repoRoot}:/repo`, '--workdir', `/repo/${packageDir}`,
          image, 'npx', '--no-install', ...args,
        ],
        { cwd: repoRoot, timeoutMs },
      );
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
