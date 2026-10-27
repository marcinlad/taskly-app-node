# Solution: unit test agent

A custom agent that writes and updates Vitest unit tests for the frontend and the backend. It runs automatically on every pull request and reports its results on the pull request. A second mode targets the least-covered files of the existing code.

| Path | What it is |
|---|---|
| `tools/test-agent/src/` | The agent (TypeScript, Anthropic Messages API + the SDK's Tool Runner) |
| `tools/test-agent/skills/` | Six reusable skills in the Agent Skills format (`<name>/SKILL.md`) |
| `.github/workflows/test-agent.yml` | The pull request workflow |
| `.github/workflows/ci.yml` | Typecheck and tests for backend, frontend and the agent; lint of the workflows |

## Main technical decisions

- **A custom agent on the Messages API with the SDK's Tool Runner**, not an off-the-shelf coding agent. The agent can only act through nine purpose-built tools (eight in coverage mode, which has no diff to read), so every safety rule is enforced in code, not in a prompt. Owning the loop also gives exact control over limits, logging and the report.
- **A deterministic pipeline with the model in one step.** Code picks the target files (plan), checks the result (verify) and writes the report. The model decides what to test and writes the tests. This keeps runs cheap, predictable and checkable.
- **Narrow tools with guards.** The repository is read-only except `*.test.*` files of the package being worked on. Secret files, `node_modules` and `.git` are hidden. Writes cannot follow symlinks out of the repository, remove existing test cases or add skipped, conditional or inverted tests. Tests run without a shell and with an environment built from scratch, so no API key or token is visible to them.
- **Independent verification.** The agent's own report is never trusted. Each test file must pass three isolated runs (catching flaky tests) with at least one passing test, no more skipped tests than before and no run-level errors such as unhandled rejections; it must also type-check (Vitest strips types without checking them) and pass in the full package suite. Anything else is reverted. So that a type error does not first show up here, `run_tests` also type-checks the package and reports the errors in the files it ran, while the agent can still fix them. A typecheck that cannot run at all reverts every file the agent wrote. So does a full suite that cannot run, unless it could not run before the agent's changes either.
- **Only additive changes are committed.** An update that changes or removes lines of an existing test could quietly make that test agree with a bug. Such files are verified but not committed; the comment lists them and the run artifacts include `review.patch`.
- **Skills loaded on demand.** The system prompt holds only hard rules and a skill index, and tells the agent to load the workflow and quality skills and its package's conventions first. `run_tests` points it to `failure-triage` when a run fails. Skills describe *how to test in this repository*, not *what to test in a given file*, so they work for code they have never seen.
- **One agent, two modes.** `--mode pr` targets the source files a pull request changed. `--mode coverage` targets the least-covered files of the existing code. Both share the tools, skills and verification; PR mode adds `get_diff`, the `pr-change-analysis` skill and a goal of deciding per changed file.
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

Both containers mount only the package directory, so code from the pull request can't change `.git` or the agent, which later run on the host. Tests run with that directory read-only, so they can't change the source they are verified against; the install step needs write access, so the workflow stops if installing changed a tracked file or added a file that is not ignored.

The run's artifacts hold the report, the transcript of model turns and tool calls (long inputs, such as the content of a written test file, are shortened) and the patches.

Locally, install the dependencies of `backend/` and `frontend/` (`npm ci` in each), then run from `tools/test-agent` with `ANTHROPIC_API_KEY` set. With `TEST_AGENT_SANDBOX=docker` the tests run in a Linux container against those `node_modules`, so they must be installed for Linux; dependencies installed on macOS contain native binaries that do not run there.

```sh
npm ci
TEST_AGENT_SANDBOX=docker npm run agent -- --mode pr --base origin/main   # cover a branch's changes
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
- Every push to a pull request re-analyses its whole diff, and the agent's commit means the author has to pull before pushing again.
- The additive-change check compares lines. Extending an existing import (for example adding `beforeEach` to the `vitest` import) counts as a change, so an update that needs a new import goes to review rather than being committed. A line inserted inside an existing test (for example an early `return`) keeps every original line and is committed; the diff is visible in the pull request.
- PR mode refuses to run without Docker unless `TEST_AGENT_ALLOW_UNSANDBOXED=1` is set, because the tests it writes come from untrusted changes.
- Verification proves the tests pass, type-check and are stable. It does not prove they would catch a regression, so a weak but passing test can get through.
- The agent and the workflow run from the pull request, so a collaborator with push access could change them. That is inherent to the `pull_request` trigger and why forks are excluded; protecting `.github/` and `tools/test-agent/` with required code-owner review is listed below.
- A pull request that changes only the agent runs its unit tests in CI, not a full agent run; the full run happens on the next pull request that changes application code.
- The coverage mode runs locally, not in a workflow.
- No hard cost cap per run beyond turn, test-run and time limits.

## For production

- **Incremental runs:** analyse only what changed since the agent's last commit on the branch, falling back to the full diff after a rebase.
- **A GitHub App instead of `GITHUB_TOKEN`.** CI would rerun on the agent's commits, fork pull requests could be supported via a `workflow_run` split, and a "suggestions only" mode could post review suggestions instead of committing.
- **Mutation testing** (e.g. Stryker) on the generated tests, to check that they catch real changes.
- **An evaluation set** of past pull requests, to measure decision quality and cost when changing the model, prompt or skills.
- **Budgets and observability:** a per-run token budget, cost and outcome metrics, and alerts.
- **Protection of the agent itself:** `CODEOWNERS` with required review on `.github/` and `tools/test-agent/`, and the API key in a protected environment.
- **A scheduled coverage backfill** that opens a pull request with tests for the least-covered files.
- **Package config read from the repository** instead of hard-coded, so the agent works in other repositories.
