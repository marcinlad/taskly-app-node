# Solution: unit test agent

A custom agent that writes and updates Vitest unit tests for the frontend and the backend. It runs automatically on every pull request and reports its results on the pull request. The same agent and skills also added the missing tests for the existing code.

| Path | What it is |
|---|---|
| `tools/test-agent/src/` | The agent (TypeScript, Anthropic Messages API + the SDK's Tool Runner) |
| `tools/test-agent/skills/` | Six reusable skills in the Agent Skills format (`<name>/SKILL.md`) |
| `.github/workflows/test-agent.yml` | The pull request workflow |
| `.github/workflows/ci.yml` | Typecheck and tests for backend, frontend and the agent |

## Main technical decisions

- **A custom agent on the Messages API with the SDK's Tool Runner**, not an off-the-shelf coding agent. The agent can only act through nine purpose-built tools, so every safety rule is enforced in code, not in a prompt. Owning the loop also gives exact control over limits, logging and the report.
- **A deterministic pipeline with the model in one step.** Code picks the target files (plan), checks the result (verify) and writes the report. The model decides what to test and writes the tests. This keeps runs cheap, predictable and checkable.
- **Narrow tools with guards.** The repository is read-only except `*.test.*` files of the package being worked on. Secret files, `node_modules` and `.git` are hidden. Writes cannot follow symlinks out of the repository or remove existing test cases. Tests run without a shell and with an environment built from scratch, so no API key or token is visible to them.
- **Independent verification.** The agent's own report is never trusted. Each test file must pass three isolated runs (catching flaky tests), type-check (Vitest strips types without checking them) and pass in the full package suite. Anything else is reverted.
- **Skills loaded on demand.** The system prompt holds only hard rules and a skill index. The agent loads the workflow and quality skills first and the package conventions for its package. `run_tests` points it to `failure-triage` when a run fails. Skills describe *how to test in this repository*, not *what to test in a given file*, so they work for code they have never seen.
- **One agent, two modes.** `--mode pr` targets the source files a pull request changed. `--mode coverage` targets the least-covered files of the existing code. Only target selection differs.
- **A two-job workflow.** The `agent` job runs pull request code with read-only permissions. The `publish` job has write permissions, never runs pull request code, validates the patch and then commits it and comments.
- **Model:** `claude-opus-5-5` at effort `high`. Prompt caching covers the growing conversation, and on a safety refusal the API falls back to another model (`fallbacks: "default"`).

## Running the PR workflow

Prerequisites:

1. A repository secret `ANTHROPIC_API_KEY`.
2. Optional repository variables: `TEST_AGENT_MODEL` (default `claude-opus-5-5`) and `TEST_AGENT_EFFORT` (default `high`).

The workflow runs on every non-draft pull request from a branch of the same repository that changes `backend/**` or `frontend/**`. Each run:

1. checks out the pull request, including its version of the agent, so a pull request that changes the agent and application code is reviewed by the changed agent;
2. installs the pull request's dependencies in a container without secrets;
3. runs the agent with tests in a network-less container;
4. commits the verified tests to the pull request branch;
5. posts or updates one comment with the report.

Both containers mount only the package directory, so code from the pull request can't change `.git` or the agent, which later run on the host. Tests run with that directory read-only, so they can't change the source they are verified against; the install step needs write access, so the workflow stops if installing changed any tracked file.

The run's artifacts hold the report, the full transcript of model turns and tool calls, and the patch.

Locally, from `tools/test-agent` with `ANTHROPIC_API_KEY` set:

```sh
npm ci
npm run agent -- --mode pr --base origin/main          # cover a branch's changes
npm run agent -- --mode coverage --package frontend    # raise coverage of existing code
npm run agent -- --mode coverage --dry-run             # plan only, no model calls
```

## Where the agent and skills are defined, and how they are used

| File | Role |
|---|---|
| `src/planner.ts` | Picks the target files from a git diff or a coverage report; gives a reason for every skipped file |
| `src/agent.ts`, `src/prompt.ts` | One Tool Runner session per package: system prompt with hard rules and the skill index, task message with targets, limits on turns and time |
| `src/tools.ts` | The tools: `list_files`, `read_file`, `search_code`, `get_diff`, `load_skill`, `write_test_file`, `run_tests`, `get_coverage`, `submit_report` |
| `src/verify.ts` | Independent verification and reverting |
| `src/report.ts` | The pull request comment |
| `skills/unit-test-workflow` | The procedure for one session |
| `skills/test-quality` | What makes a test worth keeping |
| `skills/pr-change-analysis` | Deciding `create`, `update` or `skip` for a pull request change |
| `skills/failure-triage` | Telling a wrong test from a bug in the code; bugs go to the report, never into assertions |
| `skills/backend-vitest`, `skills/frontend-vitest-rtl` | Conventions and mocking patterns of each package |

During a run the agent calls `load_skill`. Every call is recorded, and the skills used appear in the report and the transcript.

## Example run

> Draft: this run is the coverage mode, run locally. It will be replaced by the run on the example feature pull request.

`npm run agent -- --mode coverage --package frontend --max-targets 4`: 104 s, 9 turns, 22 tool calls, 2 test runs. Skills loaded: `unit-test-workflow`, `test-quality`, `frontend-vitest-rtl`.

| Source file | Decision | Agent's reason (shortened) | Verification | Lines | Branches |
|---|---|---|---|---|---|
| `components/DeleteTodoDialog.tsx` | update | success, failure and busy states; left out a guard that can't be reached through the UI | ✅ 3× | 37.5% → 100% | 62.5% → 87.5% |
| `hooks/useUpdateTodoMutation.ts` | create | API call, cache replacement, empty cache, cache unchanged on failure | ✅ 3× | 0% → 100% | 0% → 100% |
| `components/TodoEditor.tsx` | update | edit mode, error per mode, submits ignored while busy | ✅ 3× | 90% → 100% | 62.5% → 100% |
| `components/TodoEmptyState.tsx` | create | first-task and no-match states | ✅ 3× | 0% → 100% | 0% → 100% |

The frontend suite passed (92 tests) and so did the typecheck. Frontend coverage went from 70.9% to 79.5% of lines and from 80.3% to 92.0% of branches.

On the backend, one first draft expected `console.error(null)` for a `null` rejection. The run showed that Express 5 wraps it in `Error('Rejected promise')`. The agent recognized framework behavior rather than a bug in our code, dropped that case and kept the rest.

Coverage over all coverage-mode runs:

| Package | Lines | Branches |
|---|---|---|
| Backend | 33% → 66% | 33% → 81% |
| Frontend | 48% → 79% | 44% → 92% |

## Assumptions

- Pull requests come from branches of the same repository, by collaborators with write access. Fork pull requests are skipped.
- "Testable" means what the packages' Vitest coverage configs count; files they exclude (design system, stories, barrels, types) are not targets.
- Unit tests only: no database, network or browser. The existing test conventions of each package are the standard.
- Committing tests to the pull request branch is acceptable; reviewers see them as a normal commit.
- Runners can run Docker (true for GitHub-hosted Ubuntu runners).

## Limitations

- A commit pushed with `GITHUB_TOKEN` does not trigger workflows, so CI does not rerun on the agent's commit. The agent has already run those tests itself, but CI only runs again on the next push.
- Forks are not supported.
- At most 8 files per package per run; the rest of a large pull request is listed as not targeted.
- Verification proves the tests pass, type-check and are stable. It does not prove they would catch a regression, so a weak but passing test can get through.
- The agent and the workflow run from the pull request, so a collaborator with push access could change them. That is inherent to the `pull_request` trigger and why forks are excluded; protecting `.github/` and `tools/test-agent/` with required code-owner review is listed below.
- A pull request that changes only the agent runs its unit tests in CI, not a full agent run; the full run happens on the next pull request that changes application code.
- The coverage mode runs locally, not in a workflow.
- No hard cost cap per run beyond turn, test-run and time limits.

## For production

- **A GitHub App instead of `GITHUB_TOKEN`.** CI would rerun on the agent's commits, fork pull requests could be supported via a `workflow_run` split, and a "suggestions only" mode could post review suggestions instead of committing.
- **Mutation testing** (e.g. Stryker) on the generated tests, to check that they catch real changes.
- **An evaluation set** of past pull requests, to measure decision quality and cost when changing the model, prompt or skills.
- **Budgets and observability:** a per-run token budget, cost and outcome metrics, and alerts.
- **Protection of the agent itself:** `CODEOWNERS` with required review on `.github/` and `tools/test-agent/`, and the API key in a protected environment.
- **A scheduled coverage backfill** that opens a pull request with tests for the least-covered files.
- **Package config read from the repository** instead of hard-coded, so the agent works in other repositories.
