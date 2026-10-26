import Anthropic from '@anthropic-ai/sdk';
import { PACKAGES, SKILLS_DIR, type Limits, type ModelSettings, type PackageName, type SandboxMode } from './config.ts';
import type { FileCoverage } from './coverage.ts';
import { emptyUsage, runSession, type SessionResult, type TranscriptEvent, type Usage } from './agent.ts';
import { changedFiles, dirtyPaths, fileDiff, isGitRepository } from './git.ts';
import { planFromChanges, planFromCoverage, targetsByPackage, type Plan, type Target } from './planner.ts';
import { packageOf } from './paths.ts';
import { createSandbox } from './process.ts';
import { loadSkills } from './skills.ts';
import type { AgentReport } from './tools.ts';
import { verifyPackage, type PackageVerification } from './verify.ts';
import { runVitest } from './vitest.ts';

export interface RunOptions {
  mode: 'pr' | 'coverage';
  repoRoot: string;
  base?: string;
  head?: string;
  /** Coverage mode: restrict to these files. */
  only?: string[];
  /** Coverage mode: target files below this line or branch coverage. */
  threshold: number;
  packages: PackageName[];
  /** Plan only; no model calls and no file changes. */
  dryRun: boolean;
  limits: Limits;
  model: ModelSettings;
  sandbox: { mode: SandboxMode; image: string };
  log: (line: string) => void;
}

export interface PackageResult {
  package: PackageName;
  targets: Target[];
  agent?: {
    report: AgentReport | null;
    skillsUsed: string[];
    iterations: number;
    toolCalls: number;
    testRuns: number;
    error?: string;
  };
  verification?: PackageVerification;
  coverageBefore?: Record<string, FileCoverage>;
}

export interface RunResult {
  mode: 'pr' | 'coverage';
  dryRun: boolean;
  startedAt: string;
  durationMs: number;
  model: string;
  effort: string;
  plan: Plan;
  packages: PackageResult[];
  keptFiles: string[];
  guard: { checked: boolean; violations: string[] };
  usage: Usage;
  transcript: TranscriptEvent[];
}

export async function run(options: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const { repoRoot, limits, log } = options;
  const sandbox = createSandbox(repoRoot, options.sandbox.mode, options.sandbox.image, limits.commandTimeoutMs);
  const skills = await loadSkills(SKILLS_DIR);
  const git = await isGitRepository(repoRoot);
  const dirtyBefore = new Set(git ? await dirtyPaths(repoRoot) : []);

  const coverageBefore = new Map<PackageName, Record<string, FileCoverage>>();
  let plan: Plan;
  const diffs = new Map<string, string>();
  if (options.mode === 'pr') {
    if (!git || !options.base) throw new Error('PR mode needs a git repository and --base.');
    const head = options.head ?? 'HEAD';
    // Files outside the selected packages stay in the plan only to be reported as skipped.
    const changes = (await changedFiles(repoRoot, options.base, head)).filter((change) => {
      const name = packageOf(change.path);
      return name === null || options.packages.includes(name);
    });
    plan = await planFromChanges(repoRoot, changes, limits.maxTargets);
    for (const file of [...plan.targets.map((t) => t.path), ...plan.changedTests]) {
      diffs.set(file, await fileDiff(repoRoot, options.base, head, file));
    }
    log(`Plan: ${plan.targets.length} target(s), ${plan.skipped.length} skipped of ${changes.length} changed file(s).`);
  } else {
    for (const name of options.packages) {
      log(`Measuring baseline coverage of ${name}…`);
      const result = await runVitest(repoRoot, PACKAGES[name], sandbox, { files: [], coverage: true });
      if (!result.coverage) throw new Error(`Could not measure ${name} coverage: ${result.error ?? 'no coverage report'}`);
      coverageBefore.set(name, result.coverage);
    }
    plan = await planFromCoverage(repoRoot, coverageBefore, { threshold: options.threshold, maxTargetsPerPackage: limits.maxTargets, only: options.only });
    log(`Plan: ${plan.targets.length} target(s) below ${options.threshold}% coverage.`);
  }

  const result: RunResult = {
    mode: options.mode,
    dryRun: options.dryRun,
    startedAt: new Date(started).toISOString(),
    durationMs: 0,
    model: options.model.model,
    effort: options.model.effort,
    plan,
    packages: [],
    keptFiles: [],
    guard: { checked: false, violations: [] },
    usage: emptyUsage(),
    transcript: [],
  };
  const groups = targetsByPackage(plan);
  if (options.dryRun || groups.size === 0) {
    for (const [name, targets] of groups) result.packages.push({ package: name, targets });
    result.durationMs = Date.now() - started;
    return result;
  }

  const client = new Anthropic({ maxRetries: 4 });
  for (const [name, targets] of groups) {
    const pkg = PACKAGES[name];
    if (!coverageBefore.has(name)) {
      log(`Measuring baseline coverage of ${name}…`);
      const baseline = await runVitest(repoRoot, pkg, sandbox, { files: [], coverage: true });
      if (baseline.coverage) coverageBefore.set(name, baseline.coverage);
    }
    log(`Agent session: ${name} (${targets.length} target(s))`);
    const session = await runSession(
      client,
      { repoRoot, pkg, mode: options.mode, targets, diffs, skills, sandbox, limits },
      options.model,
      plan.changedTests.filter((file) => file.startsWith(`${pkg.dir}/`)),
      log,
    );
    mergeSession(result, session);
    log(`Verifying ${session.state.writes.size} file(s) written by the agent…`);
    const verification = await verifyPackage(repoRoot, pkg, sandbox, session.state.writes, limits, log);
    result.keptFiles.push(...verification.files.filter((f) => f.kept).map((f) => f.path));
    result.packages.push({
      package: name,
      targets,
      agent: {
        report: session.report,
        skillsUsed: session.state.skillsUsed,
        iterations: session.iterations,
        toolCalls: session.transcript.filter((e) => e.type === 'tool').length,
        testRuns: session.state.testRuns,
        error: session.error,
      },
      verification,
      coverageBefore: coverageBefore.get(name),
    });
  }

  // Guard: the only changes in the working tree may be the kept test files.
  if (git) {
    const kept = new Set(result.keptFiles);
    const dirtyAfter = await dirtyPaths(repoRoot);
    result.guard = {
      checked: true,
      violations: dirtyAfter.filter((file) => !dirtyBefore.has(file) && !kept.has(file)),
    };
  }
  result.durationMs = Date.now() - started;
  return result;
}

function mergeSession(result: RunResult, session: SessionResult): void {
  result.usage.inputTokens += session.usage.inputTokens;
  result.usage.outputTokens += session.usage.outputTokens;
  result.usage.cacheReadTokens += session.usage.cacheReadTokens;
  result.usage.cacheWriteTokens += session.usage.cacheWriteTokens;
  result.transcript.push(...session.transcript);
}
