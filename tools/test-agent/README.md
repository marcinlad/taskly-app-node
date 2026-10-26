# Taskly unit test agent

A custom agent built on the Anthropic Messages API and the SDK's Tool Runner (`@anthropic-ai/sdk`). It writes and updates Vitest unit tests for `backend/` and `frontend/`, verifies them independently, and reports the result as Markdown for a pull request comment.

```sh
cd tools/test-agent
npm ci
export ANTHROPIC_API_KEY=...

# Cover what a pull request changed
npm run agent -- --mode pr --base origin/main --head HEAD

# Raise coverage of the least-covered files (one package, a few files)
npm run agent -- --mode coverage --package backend --max-targets 3

# Plan only: no model calls, no file changes
npm run agent -- --mode coverage --dry-run
```

Output goes to `test-agent-output/`: `report.md` (PR comment), `report.json`, `transcript.jsonl` (every model turn and tool call), `kept-files.txt`.

| Path | Role |
|---|---|
| `src/orchestrator.ts` | Deterministic pipeline: plan → agent session per package → verification → report |
| `src/planner.ts` | Picks target files from a git diff or a coverage report, explains every skipped file |
| `src/agent.ts` | Tool Runner loop: streaming, prompt caching, refusal fallback, report reminder, limits |
| `src/tools.ts` | The agent's only capabilities, each with guards (read-only repo, writes limited to `*.test.*` files, clean-env test runs) |
| `src/verify.ts` | Runs each test file 3× on its own, type-checks, runs the full suite; reverts any agent file that fails a step |
| `src/report.ts` | PR comment; model-written text is sanitized |
| `skills/*/SKILL.md` | Reusable skills, loaded on demand by the agent (Agent Skills format) |

Environment: `TEST_AGENT_MODEL` (default `claude-opus-5-5`), `TEST_AGENT_EFFORT` (default `high`), `TEST_AGENT_SANDBOX=docker` to run tests in a network-less container (used in CI).

Tests of the agent itself: `npm test` and `npm run typecheck`.
