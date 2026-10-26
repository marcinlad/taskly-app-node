import { fileURLToPath } from 'node:url';
import path from 'node:path';

export type PackageName = 'backend' | 'frontend';

export interface PackageConfig {
  name: PackageName;
  dir: string;
  sourcePattern: RegExp;
  // Mirrors coverage.exclude in the package's Vitest config.
  sourceExclude: RegExp[];
  // Also the only files the agent may write, so one test file can never break another.
  testFilePattern: RegExp;
  skills: string[];
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

export const SHARED_SKILLS = ['unit-test-workflow', 'test-quality'];

export const AGENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SKILLS_DIR = path.join(AGENT_ROOT, 'skills');

export interface Limits {
  maxTargets: number;
  maxIterations: number;
  sessionTimeoutMs: number;
  maxTestRuns: number;
  maxWrites: number;
  maxReadBytes: number;
  maxWriteBytes: number;
  maxToolOutputChars: number;
  commandTimeoutMs: number;
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
