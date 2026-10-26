import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { AGENT_ROOT, DEFAULT_MAX_TARGETS, modelSettingsFromEnv, sandboxFromEnv, type PackageName } from './config.ts';
import { run } from './orchestrator.ts';
import { renderMarkdown } from './report.ts';

const USAGE = `Usage: test-agent --mode <pr|coverage> [options]

  --mode pr          Cover the source files a pull request changes (needs --base).
  --mode coverage    Cover the source files with the lowest coverage.

Options:
  --base <ref>        PR mode: base commit or branch (e.g. origin/main).
  --head <ref>        PR mode: head commit (default HEAD).
  --package <name>    backend or frontend; repeatable (default both).
  --file <path>       Coverage mode: only this source file; repeatable.
  --threshold <pct>   Coverage mode: target files below this coverage (default 80).
  --max-targets <n>   Files per package per run (default ${DEFAULT_MAX_TARGETS}).
  --repo <dir>        Repository to work on (default: the one containing this agent). CI points this at
                      the pull request checkout while the agent itself runs from the base branch.
  --out <dir>         Where to write report.json, report.md and transcript.jsonl (default ./test-agent-output).
  --dry-run           Plan only: no model calls, no file changes.

Environment: ANTHROPIC_API_KEY, TEST_AGENT_MODEL (default claude-opus-5-5), TEST_AGENT_EFFORT (default high),
TEST_AGENT_SANDBOX (local | docker), TEST_AGENT_SANDBOX_IMAGE.`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      mode: { type: 'string' },
      base: { type: 'string' },
      head: { type: 'string' },
      package: { type: 'string', multiple: true },
      file: { type: 'string', multiple: true },
      threshold: { type: 'string', default: '80' },
      'max-targets': { type: 'string' },
      repo: { type: 'string' },
      out: { type: 'string', default: 'test-agent-output' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help || (values.mode !== 'pr' && values.mode !== 'coverage')) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  const packages = (values.package ?? ['backend', 'frontend']) as PackageName[];
  if (packages.some((name) => name !== 'backend' && name !== 'frontend')) throw new Error(`Unknown package in ${packages.join(', ')}`);
  const maxTargets = values['max-targets'] ? positiveInt(values['max-targets'], '--max-targets') : DEFAULT_MAX_TARGETS;

  const repoRoot = path.resolve(values.repo ?? path.join(AGENT_ROOT, '..', '..'));
  const outDir = path.resolve(values.out);
  const result = await run({
    mode: values.mode,
    repoRoot,
    base: values.base,
    head: values.head,
    only: values.file?.map((file) => file.replace(/^\.\//, '')),
    threshold: Number(values.threshold),
    packages,
    dryRun: values['dry-run'],
    maxTargets,
    model: modelSettingsFromEnv(),
    sandbox: sandboxFromEnv(),
    log: (line) => console.error(line),
  });

  await mkdir(outDir, { recursive: true });
  const { transcript, ...summary } = result;
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(summary, null, 2));
  await writeFile(path.join(outDir, 'report.md'), renderMarkdown(result));
  await writeFile(path.join(outDir, 'transcript.jsonl'), transcript.map((event) => JSON.stringify(event)).join('\n'));
  await writeFile(path.join(outDir, 'kept-files.txt'), result.keptFiles.join('\n'));
  console.error(`\nKept ${result.keptFiles.length} test file(s). Report: ${path.relative(process.cwd(), path.join(outDir, 'report.md'))}`);
  return 0;
}

function positiveInt(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer`);
  return n;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
