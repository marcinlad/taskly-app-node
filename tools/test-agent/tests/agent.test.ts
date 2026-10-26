import type Anthropic from '@anthropic-ai/sdk';
import { expect, it, vi } from 'vitest';
import { MAX_TURNS, runSession } from '../src/agent.ts';
import { PACKAGES } from '../src/config.ts';
import { REPORT_REMINDER } from '../src/prompt.ts';
import type { SessionContext } from '../src/tools.ts';
import { tempRepo } from './helpers.ts';

type Step = (tools: Array<{ name: string; run: (input: unknown) => Promise<unknown> }>) => Promise<Record<string, unknown>>;

function message(stop_reason: string, content: unknown[] = []) {
  return { model: 'claude-opus-5-5', stop_reason, content, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 } };
}

function fakeClient(steps: Step[]) {
  const pushed: unknown[] = [];
  let params: Record<string, unknown> = {};
  const client = {
    beta: {
      messages: {
        toolRunner: (p: Record<string, unknown>) => {
          params = p;
          return {
            pushMessages: (...messages: unknown[]) => pushed.push(...messages),
            async *[Symbol.asyncIterator]() {
              for (const step of steps) {
                const result = await step(p.tools as never);
                yield { finalMessage: async () => result };
              }
            },
          };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, pushed, params: () => params };
}

async function context(): Promise<SessionContext> {
  return {
    repoRoot: await tempRepo({ 'backend/src/factory.ts': '' }),
    pkg: PACKAGES.backend,
    mode: 'coverage',
    targets: [{ path: 'backend/src/factory.ts', package: 'backend', reason: 'low coverage', existingTests: [] }],
    diffs: new Map(),
    skills: new Map([['backend-vitest', { name: 'backend-vitest', description: 'Backend conventions', body: 'Body' }]]),
    sandbox: { npx: vi.fn() },
  };
}

const settings = { model: 'claude-opus-5-5', effort: 'high' as const, maxTokens: 64_000 };

it('runs the tool loop to an accepted report and totals usage', async () => {
  const fake = fakeClient([
    async () => message('tool_use', [{ type: 'tool_use', id: 't1', name: 'submit_report', input: {} }]),
    async (tools) => {
      const submit = tools.find((t) => t.name === 'submit_report')!;
      await submit.run({ summary: 'Nothing to test.', files: [{ source: 'backend/src/factory.ts', decision: 'skip', reason: 'wiring', testFiles: [], status: 'not_run', suspectedBugs: [] }] });
      return message('end_turn', [{ type: 'text', text: 'Done.' }]);
    },
  ]);
  const result = await runSession(fake.client, await context(), settings, []);

  expect(result.error).toBeUndefined();
  expect(result.report?.files[0].decision).toBe('skip');
  expect(result.iterations).toBe(2);
  expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 40, cacheReadTokens: 100, cacheWriteTokens: 20 });
  expect(fake.pushed).toEqual([]);
  const params = fake.params();
  expect(params).toMatchObject({
    model: 'claude-opus-5-5', stream: true, thread: false, max_iterations: MAX_TURNS,
    output_config: { effort: 'high' }, fallbacks: 'default', cache_control: { type: 'ephemeral' },
  });
  expect(params.system).toContain('- backend-vitest: Backend conventions');
  expect((params.tools as Array<{ name: string }>).map((t) => t.name)).toEqual([
    'list_files', 'read_file', 'search_code', 'load_skill', 'write_test_file', 'run_tests', 'get_coverage', 'submit_report',
  ]);
  expect(result.transcript.filter((e) => e.type === 'assistant')).toHaveLength(2);
});

it('reminds the model once when it stops without a report', async () => {
  const fake = fakeClient([async () => message('end_turn', [{ type: 'text', text: 'All done!' }])]);
  const result = await runSession(fake.client, await context(), settings, []);
  expect(fake.pushed).toEqual([
    { role: 'assistant', content: [{ type: 'text', text: 'All done!' }] },
    { role: 'user', content: REPORT_REMINDER },
  ]);
  expect(result.error).toBe('The agent finished without an accepted report.');
});

it('stops on a refusal and on a truncated reply without running more turns', async () => {
  for (const [stop, expected] of [['refusal', 'declined'], ['max_tokens', 'max_tokens']]) {
    const second = vi.fn(async () => message('end_turn'));
    const fake = fakeClient([async () => message(stop), second]);
    const result = await runSession(fake.client, await context(), settings, []);
    expect(result.error).toContain(expected);
    expect(second).not.toHaveBeenCalled();
  }
});

it('turns API failures into a session error instead of throwing', async () => {
  const fake = fakeClient([async () => { throw new Error('socket hang up'); }]);
  const result = await runSession(fake.client, await context(), settings, []);
  expect(result.error).toBe('socket hang up');
  expect(result.report).toBeNull();
});
