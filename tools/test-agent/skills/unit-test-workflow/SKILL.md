---
name: unit-test-workflow
description: The end-to-end procedure for one session - understand each target, decide, write tests, run them, iterate, report. Load first.
---

# Unit test workflow

Work through the targets one at a time. For each target:

1. **Understand the code.** Read the target file. In a pull request run, read its diff with `get_diff` first, so you know exactly which behavior is new or changed. Read the types and helpers it imports when the behavior depends on them.
2. **Read the existing tests.** Open the test files listed under "Existing tests" for the target. If there are none, open one or two tests of similar code in the same package to copy their conventions (imports, mocks, fixtures, naming, formatting). Load the package skill (`backend-vitest` or `frontend-vitest-rtl`).
3. **Decide** `create`, `update` or `skip` (see `pr-change-analysis` in a pull request run). Prefer updating the existing test file of a module over creating a second one for it. Skip when a unit test would add nothing (a pure re-export, a type-only change, bootstrap or wiring already exercised elsewhere) and say why.
4. **List the behaviors** worth a test before writing: each branch, each error path, each boundary value, each externally visible side effect (calls to collaborators, cache updates, rendered output). Use `get_coverage` to see uncovered lines and branches when coverage is the goal.
5. **Write the whole file** with `write_test_file`. When updating, keep every existing test and its style; add new `it` blocks next to related ones.
6. **Run it** with `run_tests` for just that file. On failure, follow `failure-triage`. At most 3 attempts per file; after that, remove the tests you cannot make pass for a legitimate reason and report why.
7. **Check coverage** with `get_coverage` for the target once the file passes. Cover what is still uncovered when it carries real behavior; do not chase lines that only a contrived test would reach.

When every target is done, call `submit_report` once:

- one entry per target, `source` exactly as listed in the task;
- `testFiles` lists only files you wrote in this session;
- `status` is the result of your last `run_tests` covering those files;
- `suspectedBugs` names file and line and the expected vs. actual behavior.

Budget: test runs are limited. Run a single file while iterating; use `get_coverage` (which runs the whole package suite) sparingly, ideally once per target at the end.
