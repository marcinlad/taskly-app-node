import { toRepoRelative } from './paths.ts';

export interface Metric {
  covered: number;
  total: number;
  pct: number;
}

export interface FileCoverage {
  lines: Metric;
  branches: Metric;
  functions: Metric;
  statements: Metric;
  /** Collapsed ranges, e.g. ["3-7", "12"]. */
  uncoveredLines: string[];
  /** e.g. "line 14 (if, path 2 of 2)". */
  uncoveredBranches: string[];
  uncoveredFunctions: string[];
}

/** The Istanbul file coverage format that Vitest's `json` coverage reporter writes. */
interface IstanbulFile {
  statementMap: Record<string, { start: { line: number } }>;
  fnMap: Record<string, { name: string; decl?: { start: { line: number } }; loc?: { start: { line: number } }; line?: number }>;
  branchMap: Record<string, { type: string; line?: number; loc?: { start: { line: number } }; locations: Array<{ start: { line: number } }> }>;
  s: Record<string, number>;
  f: Record<string, number>;
  b: Record<string, number[]>;
}

export function parseCoverage(report: Record<string, unknown>, repoRoot: string): Record<string, FileCoverage> {
  const result: Record<string, FileCoverage> = {};
  for (const [absolute, raw] of Object.entries(report)) {
    const file = raw as IstanbulFile;
    result[toRepoRelative(absolute, repoRoot)] = fileCoverage(file);
  }
  return result;
}

export function fileCoverage(file: IstanbulFile): FileCoverage {
  const statementIds = Object.keys(file.statementMap);
  const coveredStatements = statementIds.filter((id) => (file.s[id] ?? 0) > 0).length;

  // Istanbul's line coverage: a line counts as covered when any statement starting on it ran.
  const lineHits = new Map<number, number>();
  for (const id of statementIds) {
    const line = file.statementMap[id].start.line;
    lineHits.set(line, Math.max(lineHits.get(line) ?? 0, file.s[id] ?? 0));
  }
  const uncoveredLineNumbers = [...lineHits].filter(([, hits]) => hits === 0).map(([line]) => line).sort((a, b) => a - b);

  let branchTotal = 0;
  let branchCovered = 0;
  const uncoveredBranches: string[] = [];
  for (const [id, branch] of Object.entries(file.branchMap)) {
    const counts = file.b[id] ?? [];
    branch.locations.forEach((location, index) => {
      branchTotal += 1;
      if ((counts[index] ?? 0) > 0) {
        branchCovered += 1;
      } else {
        const line = location.start.line ?? branch.loc?.start.line ?? branch.line;
        uncoveredBranches.push(`line ${line} (${branch.type}, path ${index + 1} of ${branch.locations.length})`);
      }
    });
  }

  const fnIds = Object.keys(file.fnMap);
  const uncoveredFunctions = fnIds
    .filter((id) => (file.f[id] ?? 0) === 0)
    .map((id) => {
      const fn = file.fnMap[id];
      const line = fn.decl?.start.line ?? fn.loc?.start.line ?? fn.line;
      return `${fn.name || '(anonymous)'} (line ${line})`;
    });

  return {
    lines: metric(lineHits.size - uncoveredLineNumbers.length, lineHits.size),
    branches: metric(branchCovered, branchTotal),
    functions: metric(fnIds.length - uncoveredFunctions.length, fnIds.length),
    statements: metric(coveredStatements, statementIds.length),
    uncoveredLines: collapseRanges(uncoveredLineNumbers),
    uncoveredBranches,
    uncoveredFunctions,
  };
}

export function metric(covered: number, total: number): Metric {
  return { covered, total, pct: total === 0 ? 100 : Math.round((covered / total) * 10_000) / 100 };
}

export function collapseRanges(numbers: number[]): string[] {
  const ranges: string[] = [];
  let start: number | undefined;
  let previous: number | undefined;
  for (const n of numbers) {
    if (start === undefined) {
      start = previous = n;
    } else if (n === previous! + 1) {
      previous = n;
    } else {
      ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
      start = previous = n;
    }
  }
  if (start !== undefined) ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
  return ranges;
}

export function totals(files: FileCoverage[]): Pick<FileCoverage, 'lines' | 'branches' | 'functions' | 'statements'> {
  const sum = (key: 'lines' | 'branches' | 'functions' | 'statements') =>
    metric(files.reduce((acc, f) => acc + f[key].covered, 0), files.reduce((acc, f) => acc + f[key].total, 0));
  return { lines: sum('lines'), branches: sum('branches'), functions: sum('functions'), statements: sum('statements') };
}

export function formatCoverage(c: FileCoverage): string {
  const parts = [
    `lines ${c.lines.pct}% (${c.lines.covered}/${c.lines.total})`,
    `branches ${c.branches.pct}% (${c.branches.covered}/${c.branches.total})`,
    `functions ${c.functions.pct}% (${c.functions.covered}/${c.functions.total})`,
  ];
  const details = [
    c.uncoveredLines.length ? `uncovered lines: ${c.uncoveredLines.join(', ')}` : '',
    c.uncoveredBranches.length ? `uncovered branches: ${c.uncoveredBranches.slice(0, 15).join('; ')}` : '',
    c.uncoveredFunctions.length ? `uncovered functions: ${c.uncoveredFunctions.join(', ')}` : '',
  ].filter(Boolean);
  return [parts.join(', '), ...details].join('\n');
}
