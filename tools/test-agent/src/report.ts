import { totals, type Metric } from './coverage.ts';
import type { PackageResult, RunResult } from './orchestrator.ts';

/** Marks the agent's comment so the workflow updates it instead of adding a new one each push. */
export const COMMENT_MARKER = '<!-- taskly-test-agent -->';

/**
 * The pull request comment. What a reviewer acts on is visible: the outcome, a decision per file,
 * suspected bugs and the verification result. Everything else is folded into one details block.
 */
export function renderMarkdown(result: RunResult): string {
  const out = [COMMENT_MARKER, `## Unit test agent · ${result.mode === 'pr' ? 'pull request' : 'coverage'} run`, ''];
  const { plan } = result;

  if (plan.targets.length === 0) {
    out.push('No changed application source files need unit tests in this pull request.', '');
    return [...out, ...details([skippedSection(result)])].join('\n');
  }
  if (result.dryRun) {
    out.push('**Dry run:** planning only, no tests were written.', '', '| Target | Why | Existing tests |', '|---|---|---|');
    for (const t of plan.targets) out.push(`| ${code(t.path)} | ${t.reason} | ${t.existingTests.map(code).join(', ') || '—'} |`);
    return [...out, '', ...details([skippedSection(result)])].join('\n');
  }

  out.push(summaryLine(result), '');
  if (result.guard.violations.length) {
    out.push('> [!CAUTION]', "> Unexpected changes outside the agent's test files; nothing will be committed:", ...result.guard.violations.map((v) => `> - ${code(v)}`), '');
  }

  out.push('| Source file | Decision | Test files | Reason |', '|---|---|---|---|');
  for (const pkg of result.packages) {
    for (const target of pkg.targets) {
      const entry = pkg.agent?.report?.files.find((f) => f.source === target.path);
      const tests = entry?.testFiles.map((file) => `${code(file)} ${verificationMark(pkg, file)}`).join('<br>') || '—';
      out.push(`| ${code(target.path)} | ${entry?.decision ?? '—'} | ${tests} | ${cell(entry?.reason ?? 'no report entry')} |`);
    }
  }
  out.push('');

  const bugs = result.packages.flatMap((pkg) => pkg.agent?.report?.files.flatMap((f) => f.suspectedBugs.map((bug) => `- ${code(f.source)}: ${cell(bug)}`)) ?? []);
  if (bugs.length) out.push('### Suspected bugs', '', 'The agent believes this behavior is wrong and did not encode it in tests. Please check.', '', ...bugs, '');

  out.push('| Package | Test suite | Typecheck | Line coverage | Branch coverage |', '|---|---|---|---|---|');
  for (const pkg of result.packages) {
    const v = pkg.verification;
    if (!v) continue;
    const before = pkg.coverageBefore ? totals(Object.values(pkg.coverageBefore)) : undefined;
    const after = v.coverageAfter ? totals(Object.values(v.coverageAfter)) : undefined;
    const suite = v.suite.ok ? `✅ ${v.suite.passed} passed` : `❌ ${v.suite.failed} failed, ${v.suite.passed} passed`;
    const typecheck = v.typecheck.ok ? '✅' : v.typecheck.otherErrors ? `⚠️ ${v.typecheck.otherErrors} error(s) outside agent files` : '✅ (agent errors reverted)';
    out.push(`| ${pkg.package} | ${suite} | ${typecheck} | ${delta(before?.lines, after?.lines)} | ${delta(before?.branches, after?.branches)} |`);
  }
  out.push('');

  return [...out, ...details([revertedSection(result), coverageSection(result), skippedSection(result), agentSection(result)])].join('\n');
}

function summaryLine(result: RunResult): string {
  const reverted = result.packages.reduce((n, p) => n + (p.verification?.files.filter((f) => !f.kept).length ?? 0), 0);
  const errors = result.packages.filter((p) => p.agent?.error).map((p) => `> ${p.package}: ${p.agent!.error}`);
  const suitesPass = result.packages.every((p) => p.verification?.suite.ok !== false);
  const parts = [
    `**${result.keptFiles.length}** test file(s) verified`,
    reverted ? `**${reverted}** reverted` : '',
    suitesPass ? 'all test suites pass' : 'a test suite fails',
  ].filter(Boolean);
  const line = `${suitesPass && !errors.length ? '✅' : '⚠️'} ${parts.join(' · ')}`;
  return errors.length ? `${line}\n\n> [!WARNING]\n${errors.join('\n')}` : line;
}

function verificationMark(pkg: PackageResult, file: string): string {
  const v = pkg.verification?.files.find((f) => f.path === file);
  if (!v) return '(not written)';
  return v.kept ? `✅ ${v.passedRuns}×` : '❌ reverted';
}

function revertedSection(result: RunResult): string[] {
  const reverted = result.packages.flatMap((pkg) => pkg.verification?.files.filter((f) => !f.kept) ?? []);
  return reverted.length ? ['**Reverted test files**', '', ...reverted.map((f) => `- ${code(f.path)}: ${cell(f.reason ?? 'failed verification')}`)] : [];
}

function coverageSection(result: RunResult): string[] {
  const rows = result.packages.flatMap((pkg) =>
    pkg.targets.map((t) => {
      const before = pkg.coverageBefore?.[t.path];
      const after = pkg.verification?.coverageAfter?.[t.path];
      return `| ${code(t.path)} | ${delta(before?.lines, after?.lines)} | ${delta(before?.branches, after?.branches)} |`;
    }),
  );
  return ['**Coverage of target files**', '', '| File | Lines | Branches |', '|---|---|---|', ...rows];
}

function skippedSection(result: RunResult): string[] {
  const { skipped } = result.plan;
  return skipped.length ? ['**Files not targeted**', '', ...skipped.map((s) => `- ${code(s.path)}: ${s.reason}`)] : [];
}

function agentSection(result: RunResult): string[] {
  const lines = ['**Agent run**', '', `- Model ${code(result.model)}, effort ${result.effort}, ${Math.round(result.durationMs / 1000)} s`];
  for (const pkg of result.packages) {
    if (!pkg.agent) continue;
    const skills = pkg.agent.skillsUsed.map(code).join(', ') || 'none';
    lines.push(`- ${pkg.package}: ${pkg.agent.iterations} turns, ${pkg.agent.toolCalls} tool calls, ${pkg.agent.testRuns} test runs; skills ${skills}`);
    if (pkg.agent.report?.summary) lines.push(`  - ${cell(pkg.agent.report.summary)}`);
  }
  const u = result.usage;
  lines.push(`- Tokens: ${u.inputTokens} input, ${u.outputTokens} output, ${u.cacheReadTokens} cache read, ${u.cacheWriteTokens} cache write`);
  return lines;
}

function details(sections: string[][]): string[] {
  const content = sections.filter((s) => s.length).flatMap((s) => [...s, '']);
  return content.length ? ['<details><summary>Details</summary>', '', ...content, '</details>', ''] : [];
}

function delta(before?: Metric, after?: Metric): string {
  if (!before || !after) return before || after ? `${(before ?? after)!.pct}%` : '—';
  const diff = Math.round((after.pct - before.pct) * 100) / 100;
  return `${before.pct}% → **${after.pct}%**${diff ? ` (${diff > 0 ? '+' : ''}${diff})` : ''}`;
}

function code(text: string): string {
  return `\`${text.replace(/`/g, '')}\``;
}

/**
 * Model-written text is shaped by pull request content, so it is rendered inert: no HTML, links,
 * images or @mentions, and nothing that breaks out of a table cell.
 */
export function sanitize(text: string): string {
  return text
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, '$1')
    .replace(/https?:\/\/\S+/g, (url) => `\`${url.replace(/`/g, '')}\``)
    .replace(/@(?=[\w-])/g, '@​');
}

function cell(text: string): string {
  return sanitize(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, 400);
}
