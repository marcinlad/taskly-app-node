import Anthropic from '@anthropic-ai/sdk';
import { PACKAGES, SKILLS_DIR, type ModelSettings, type PackageName, type SandboxMode } from './config.ts';
import type { FileCoverage } from './coverage.ts';
import { addUsage, emptyUsage, runSession, type TranscriptEvent, type Usage } from './agent.ts';
import { changedFiles, fileDiff, isGitRepository } from './git.ts';
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
  only?: string[];
  threshold: number;
  packages: PackageName[];
  dryRun: boolean;
  maxTargets: number;
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
  usage: Usage;
  transcript: TranscriptEvent[];
}

export async function run(options: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const { repoRoot, maxTargets, log } = options;
  const sandbox = createSandbox(repoRoot, options.sandbox.mode, options.sandbox.image);
  const skills = await loadSkills(SKILLS_DIR);

  const coverageBefore = new Map<PackageName, Record<string, FileCoverage>>();
  async function measureBaseline(name: PackageName) {
    log(`Measuring baseline coverage of ${name}…`);
    const baseline = await runVitest(repoRoot, PACKAGES[name], sandbox, { files: [], coverage: true });
    if (baseline.coverage) coverageBefore.set(name, baseline.coverage);
    return baseline;
  }

  let plan: Plan;
  const diffs = new Map<string, string>();
  if (options.mode === 'pr') {
    if (!options.base || !(await isGitRepository(repoRoot))) throw new Error('PR mode needs a git repository and --base.');
    const head = options.head ?? 'HEAD';
    // Files outside the selected packages stay in the plan only to be reported as skipped.
    const changes = (await changedFiles(repoRoot, options.base, head)).filter((change) => {
      const name = packageOf(change.path);
      return name === null || options.packages.includes(name);
    });
    plan = await planFromChanges(repoRoot, changes, maxTargets);
    for (const file of [...plan.targets.map((t) => t.path), ...plan.changedTests]) {
      diffs.set(file, await fileDiff(repoRoot, options.base, head, file));
    }
    log(`Plan: ${plan.targets.length} target(s), ${plan.skipped.length} skipped of ${changes.length} changed file(s).`);
  } else {
    for (const name of options.packages) {
      const baseline = await measureBaseline(name);
      if (!baseline.coverage) throw new Error(`Could not measure ${name} coverage: ${baseline.error ?? 'no coverage report'}`);
    }
    plan = await planFromCoverage(repoRoot, coverageBefore, { threshold: options.threshold, maxTargetsPerPackage: maxTargets, only: options.only });
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
    if (!coverageBefore.has(name)) await measureBaseline(name);
    log(`Agent session: ${name} (${targets.length} target(s))`);
    const session = await runSession(
      client,
      { repoRoot, pkg, mode: options.mode, targets, diffs, skills, sandbox },
      options.model,
      plan.changedTests.filter((file) => file.startsWith(`${pkg.dir}/`)),
      log,
    );
    addUsage(result.usage, session.usage);
    result.transcript.push(...session.transcript);
    log(`Verifying ${session.state.writes.size} file(s) written by the agent…`);
    const verification = await verifyPackage(repoRoot, pkg, sandbox, session.state.writes, log);
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

  result.durationMs = Date.now() - started;
  return result;
}
