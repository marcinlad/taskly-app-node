import { fileURLToPath } from 'node:url';
import path from 'node:path';

export type PackageName = 'backend' | 'frontend';

export interface PackageConfig {
  name: PackageName;
  /** Package directory, relative to the repository root. */
  dir: string;
  sourcePattern: RegExp;
  /**
   * Source files that are not worth unit testing. Mirrors `coverage.exclude` in the package's
   * Vitest config, so the agent and the coverage report agree on what counts.
   */
  sourceExclude: RegExp[];
  /**
   * Files Vitest picks up as test files. They are also the only files the agent may write:
   * no fixtures, helpers or setup files, so one test file can never break another.
   */
  testFilePattern: RegExp;
  skills: string[];
  /** Formatter applied to the agent's files before verification, as `npx` arguments. */
  format?: string[];
}

export const PACKAGES: Record<PackageName, PackageConfig> = {
  backend: {
    name: 'backend',
    dir: 'backend',
    sourcePattern: /^backend\/src\/.+\.ts$/,
    sourceExclude: [/\/types\.ts$/, /^backend\/src\/generated\//],
    testFilePattern: /^backend\/tests\/[\w./-]+\.test\.ts$/,
    skills: ['backend-vitest'],
  },
  frontend: {
    name: 'frontend',
    dir: 'frontend',
    sourcePattern: /^frontend\/src\/.+\.(ts|tsx)$/,
    sourceExclude: [
      /^frontend\/src\/main\.tsx$/,
      /^frontend\/src\/test\//,
      /\.test\.(ts|tsx)$/,
      /\.stories\.tsx$/,
      /^frontend\/src\/design-system\//,
      /\/types\.ts$/,
      /\.types\.ts$/,
      /\/index\.ts$/,
      /\/constants\.(ts|tsx)$/,
      /\.constants\.ts$/,
      /^frontend\/src\/features\/todos\/api\/queryKeys\.ts$/,
      /^frontend\/src\/lib\/queryClient\.ts$/,
      /\.d\.ts$/,
    ],
    testFilePattern: /^frontend\/src\/[\w./-]+\.test\.(ts|tsx)$/,
    skills: ['frontend-vitest-rtl'],
    format: ['prettier', '--write', '--log-level', 'warn'],
  },
};

/** Skills every session loads first. `failure-triage` is offered by run_tests when a run fails. */
export const SHARED_SKILLS = ['unit-test-workflow', 'test-quality'];

export const AGENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SKILLS_DIR = path.join(AGENT_ROOT, 'skills');

export interface Limits {
  /** Files handed to the agent per package session. */
  maxTargets: number;
  /** API requests per package session. */
  maxIterations: number;
  sessionTimeoutMs: number;
  /** Test or coverage runs the agent may start per session. */
  maxTestRuns: number;
  maxWrites: number;
  maxReadBytes: number;
  maxWriteBytes: number;
  /** Characters of command output returned to the model. */
  maxToolOutputChars: number;
  /** Timeout for one test, coverage or typecheck command. */
  commandTimeoutMs: number;
  /** How many times verification runs each new test file to catch flaky tests. */
  verifyRepeats: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxTargets: 8,
  maxIterations: 60,
  sessionTimeoutMs: 20 * 60_000,
  maxTestRuns: 30,
  maxWrites: 20,
  maxReadBytes: 200_000,
  maxWriteBytes: 100_000,
  maxToolOutputChars: 12_000,
  commandTimeoutMs: 5 * 60_000,
  verifyRepeats: 3,
};

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelSettings {
  model: string;
  effort: Effort;
  maxTokens: number;
}

export function modelSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): ModelSettings {
  const effort = (env.TEST_AGENT_EFFORT ?? 'high') as Effort;
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
    throw new Error(`Invalid TEST_AGENT_EFFORT: ${effort}`);
  }
  return {
    model: env.TEST_AGENT_MODEL ?? 'claude-opus-5-5',
    effort,
    maxTokens: 64_000,
  };
}

export type SandboxMode = 'local' | 'docker';

export function sandboxFromEnv(env: NodeJS.ProcessEnv = process.env): { mode: SandboxMode; image: string } {
  const mode = (env.TEST_AGENT_SANDBOX ?? 'local') as SandboxMode;
  if (mode !== 'local' && mode !== 'docker') throw new Error(`Invalid TEST_AGENT_SANDBOX: ${mode}`);
  return { mode, image: env.TEST_AGENT_SANDBOX_IMAGE ?? 'node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205' };
}
