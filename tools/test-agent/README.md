# Taskly unit test agent

A custom agent built on the Anthropic Messages API and the SDK's Tool Runner (`@anthropic-ai/sdk`). It writes and updates Vitest unit tests for `backend/` and `frontend/`, verifies them independently, and reports the result as Markdown for a pull request comment.

The agent runs the packages' own Vitest and TypeScript, so install their dependencies first (`npm ci` in `backend/` and in `frontend/`).

```sh
cd tools/test-agent
npm ci
export ANTHROPIC_API_KEY=...

# Cover what a pull request changed (PR mode requires the Docker sandbox)
TEST_AGENT_SANDBOX=docker npm run agent -- --mode pr --base origin/main --head HEAD

# Raise coverage of the least-covered files (one package, a few files)
npm run agent -- --mode coverage --package backend --max-targets 3

# Plan only: no model calls and no API key needed; coverage mode still runs the test suites to measure coverage
npm run agent -- --mode coverage --dry-run
```

Output goes to `test-agent-output/`: `report.md` (PR comment), `report.json`, `transcript.jsonl` (every model turn and tool call; long inputs such as written test files are shortened), `kept-files.txt` (verified test files to commit) and `review-files.txt` (verified updates that change existing test lines, left for review).

| Path | Role |
|---|---|
| `src/orchestrator.ts` | Deterministic pipeline: plan → agent session per package → verification → report |
| `src/planner.ts` | Picks target files from a git diff or a coverage report, explains every skipped file |
| `src/agent.ts` | Tool Runner loop: streaming, prompt caching, refusal fallback, report reminder, limits |
| `src/tools.ts` | The agent's only capabilities, each with guards (read-only repo, writes limited to `*.test.*` files, clean-env test runs that also report type errors) |
| `src/verify.ts` | Runs each test file 3× on its own, type-checks, runs the full suite; reverts any agent file that fails a step and leaves updates that change existing test lines for review |
| `src/report.ts` | PR comment; model-written text is sanitized |
| `skills/*/SKILL.md` | Reusable skills, loaded on demand by the agent (Agent Skills format) |

Environment:

- `TEST_AGENT_MODEL` (default `claude-opus-5-5`), `TEST_AGENT_EFFORT` (default `high`).
- `TEST_AGENT_SANDBOX`: `local` (default) runs tests on this machine; `docker` runs them in a network-less container that mounts only the package directory, read-only (used in CI). The container uses the package's `node_modules`, so they must be installed for Linux; dependencies installed on macOS contain native binaries that do not run there.
- `TEST_AGENT_SANDBOX_IMAGE`: the image for the Docker sandbox (default: a pinned `node:24-bookworm-slim`).
- `TEST_AGENT_ALLOW_UNSANDBOXED=1`: lets PR mode run with the `local` sandbox. PR mode refuses otherwise, because the tests it writes come from untrusted changes.

Tests of the agent itself: `npm test` and `npm run typecheck`.
