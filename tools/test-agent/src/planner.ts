import { PACKAGES, type PackageConfig, type PackageName } from './config.ts';
import type { FileCoverage } from './coverage.ts';
import { findRelatedTests, walkFiles } from './files.ts';
import type { ChangedFile, ChangeStatus } from './git.ts';
import { isTestableSource, isTestFile, packageOf } from './paths.ts';

export interface Target {
  path: string;
  package: PackageName;
  reason: string;
  changeStatus?: ChangeStatus;
  existingTests: string[];
  baselineCoverage?: FileCoverage;
}

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface Plan {
  mode: 'pr' | 'coverage';
  targets: Target[];
  skipped: SkippedFile[];
  changedTests: string[];
}

export function targetsByPackage(plan: Plan): Map<PackageName, Target[]> {
  const groups = new Map<PackageName, Target[]>();
  for (const target of plan.targets) {
    groups.set(target.package, [...(groups.get(target.package) ?? []), target]);
  }
  return groups;
}

export function skipReason(file: string, pkg: PackageConfig): string | null {
  if (isTestableSource(file, pkg)) return null;
  if (!pkg.sourcePattern.test(file)) return 'not application source code (config, styles, docs or assets)';
  return 'excluded from unit-test coverage by the package config (types, stories, barrels, design system or bootstrap code)';
}

export async function planFromChanges(repoRoot: string, changes: ChangedFile[], maxTargetsPerPackage: number): Promise<Plan> {
  const plan: Plan = { mode: 'pr', targets: [], skipped: [], changedTests: [] };
  const testFiles = await allTestFiles(repoRoot);
  for (const change of changes) {
    const name = packageOf(change.path);
    if (!name) {
      plan.skipped.push({ path: change.path, reason: 'outside frontend/ and backend/' });
      continue;
    }
    const pkg = PACKAGES[name];
    if (isTestFile(change.path, pkg)) {
      if (change.status !== 'deleted') plan.changedTests.push(change.path);
      plan.skipped.push({ path: change.path, reason: 'test file changed in the pull request; used as context' });
      continue;
    }
    if (change.status === 'deleted') {
      plan.skipped.push({ path: change.path, reason: 'deleted' });
      continue;
    }
    const reason = skipReason(change.path, pkg);
    if (reason) {
      plan.skipped.push({ path: change.path, reason });
      continue;
    }
    plan.targets.push({
      path: change.path,
      package: name,
      reason: `${change.status} in the pull request`,
      changeStatus: change.status,
      existingTests: await findRelatedTests(repoRoot, testFiles.get(name) ?? [], change.path),
    });
  }
  return capTargets(plan, maxTargetsPerPackage);
}

export interface CoveragePlanOptions {
  threshold: number;
  maxTargetsPerPackage: number;
  only?: string[];
}

export async function planFromCoverage(
  repoRoot: string,
  coverage: Map<PackageName, Record<string, FileCoverage>>,
  options: CoveragePlanOptions,
): Promise<Plan> {
  const plan: Plan = { mode: 'coverage', targets: [], skipped: [], changedTests: [] };
  const testFiles = await allTestFiles(repoRoot);
  for (const [name, files] of coverage) {
    const pkg = PACKAGES[name];
    const candidates = Object.entries(files)
      .filter(([file]) => isTestableSource(file, pkg))
      .filter(([file]) => !options.only || options.only.includes(file))
      .filter(([, c]) => c.lines.pct < options.threshold || c.branches.pct < options.threshold)
      // Most uncovered work first.
      .sort(([, a], [, b]) => b.lines.total - b.lines.covered + (b.branches.total - b.branches.covered) - (a.lines.total - a.lines.covered + (a.branches.total - a.branches.covered)));
    for (const [file, c] of candidates) {
      plan.targets.push({
        path: file,
        package: name,
        reason: `coverage below ${options.threshold}%: lines ${c.lines.pct}%, branches ${c.branches.pct}%`,
        existingTests: await findRelatedTests(repoRoot, testFiles.get(name) ?? [], file),
        baselineCoverage: c,
      });
    }
  }
  return capTargets(plan, options.maxTargetsPerPackage);
}

function capTargets(plan: Plan, max: number): Plan {
  const kept: Target[] = [];
  const counts = new Map<PackageName, number>();
  for (const target of plan.targets) {
    const count = counts.get(target.package) ?? 0;
    if (count >= max) {
      plan.skipped.push({ path: target.path, reason: `over the limit of ${max} files per package for one run` });
      continue;
    }
    counts.set(target.package, count + 1);
    kept.push(target);
  }
  return { ...plan, targets: kept };
}

async function allTestFiles(repoRoot: string): Promise<Map<PackageName, string[]>> {
  const result = new Map<PackageName, string[]>();
  for (const pkg of Object.values(PACKAGES)) {
    const files = await walkFiles(repoRoot, pkg.dir);
    result.set(pkg.name, files.filter((file) => isTestFile(file, pkg)));
  }
  return result;
}
