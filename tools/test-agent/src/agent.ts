import Anthropic from '@anthropic-ai/sdk';
import { SHARED_SKILLS, type ModelSettings } from './config.ts';
import { REPORT_REMINDER, systemPrompt, taskMessage } from './prompt.ts';
import { createSessionState, createTools, type AgentReport, type SessionContext, type SessionState, type ToolEvent } from './tools.ts';

export const MAX_TURNS = 60;
const SESSION_TIMEOUT_MS = 20 * 60_000;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type TranscriptEvent =
  | { type: 'assistant'; package: string; iteration: number; model: string; stopReason: string | null; text: string; thinking: string; toolCalls: string[] }
  | ({ type: 'tool'; package: string } & ToolEvent);

export interface SessionResult {
  package: string;
  report: AgentReport | null;
  state: SessionState;
  transcript: TranscriptEvent[];
  usage: Usage;
  iterations: number;
  error?: string;
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

export function addUsage(total: Usage, usage: Anthropic.Beta.BetaUsage): void {
  total.inputTokens += usage.input_tokens;
  total.outputTokens += usage.output_tokens;
  total.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
  total.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
}

export async function runSession(
  client: Anthropic,
  ctx: SessionContext,
  settings: ModelSettings,
  changedTests: string[],
  log: (line: string) => void = () => {},
): Promise<SessionResult> {
  const state = createSessionState();
  const transcript: TranscriptEvent[] = [];
  const usage = emptyUsage();
  const tools = createTools(
    {
      ...ctx,
      onEvent: (event) => {
        transcript.push({ type: 'tool', package: ctx.pkg.name, ...event });
        log(`  ${event.ok ? '✓' : '✗'} ${event.tool} ${JSON.stringify(event.input)}`);
      },
    },
    state,
  );
  const recommended = [...SHARED_SKILLS, ...(ctx.mode === 'pr' ? ['pr-change-analysis'] : []), ...ctx.pkg.skills];

  const runner = client.beta.messages.toolRunner(
    {
      model: settings.model,
      max_tokens: settings.maxTokens,
      max_iterations: MAX_TURNS,
      stream: true,
      // Send the full history each turn (no server-held thread) and let automatic caching reuse it.
      thread: false,
      cache_control: { type: 'ephemeral' },
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: settings.effort },
      // On a safety decline, the API reruns the turn on a fallback model instead of failing the run.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: systemPrompt(ctx.pkg, ctx.mode, [...ctx.skills.values()], recommended),
      tools,
      messages: [{ role: 'user', content: taskMessage(ctx.mode, ctx.targets, changedTests) }],
    },
    { signal: AbortSignal.timeout(SESSION_TIMEOUT_MS) },
  );

  let iterations = 0;
  let reminded = false;
  let error: string | undefined;
  try {
    for await (const stream of runner) {
      const message = await stream.finalMessage();
      iterations += 1;
      addUsage(usage, message.usage);
      transcript.push(assistantEvent(ctx.pkg.name, iterations, message));
      const toolCalls = message.content.filter((block) => block.type === 'tool_use').map((block) => block.name);
      log(`[${ctx.pkg.name}] turn ${iterations}: ${message.stop_reason}${toolCalls.length ? ` → ${toolCalls.join(', ')}` : ''}`);

      if (message.stop_reason === 'refusal') {
        error = `The model declined to continue (${message.stop_details?.category ?? 'no category'}).`;
        break;
      }
      // A reply cut off at max_tokens may hold a truncated tool call; breaking here keeps it from running.
      if (message.stop_reason === 'max_tokens') {
        error = 'A reply hit max_tokens; its tool calls were not run.';
        break;
      }
      if (message.stop_reason === 'end_turn' && !state.report && !reminded) {
        reminded = true;
        runner.pushMessages({ role: 'assistant', content: message.content }, { role: 'user', content: REPORT_REMINDER });
      }
    }
    if (!error && iterations >= MAX_TURNS && !state.report) {
      error = `Stopped at the limit of ${MAX_TURNS} turns.`;
    }
  } catch (caught) {
    error = describeError(caught, SESSION_TIMEOUT_MS);
  }
  if (!error && !state.report) error = 'The agent finished without an accepted report.';
  return { package: ctx.pkg.name, report: state.report, state, transcript, usage, iterations, error };
}

function assistantEvent(pkg: string, iteration: number, message: Anthropic.Beta.BetaMessage): TranscriptEvent {
  let text = '';
  let thinking = '';
  const toolCalls: string[] = [];
  for (const block of message.content) {
    if (block.type === 'text') text += block.text;
    else if (block.type === 'thinking') thinking += block.thinking;
    else if (block.type === 'tool_use') toolCalls.push(block.name);
  }
  return { type: 'assistant', package: pkg, iteration, model: message.model, stopReason: message.stop_reason, text, thinking, toolCalls };
}

function describeError(error: unknown, timeoutMs: number): string {
  if (error instanceof Anthropic.APIUserAbortError || (error instanceof Error && error.name === 'TimeoutError')) {
    return `Session timed out after ${Math.round(timeoutMs / 60_000)} minutes.`;
  }
  if (error instanceof Anthropic.AuthenticationError) return 'Anthropic API authentication failed; check ANTHROPIC_API_KEY.';
  if (error instanceof Anthropic.RateLimitError) return 'Anthropic API rate limit hit after retries.';
  if (error instanceof Anthropic.APIError) return `Anthropic API error ${error.status ?? ''}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
