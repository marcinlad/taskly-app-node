---
name: failure-triage
description: How to diagnose a failing test run - read the failure, decide whether the test or the source is wrong, fix the test or report a suspected bug. Load when run_tests fails.
---

# Failure triage

Read the failure message and the first stack frame inside the repository. Then classify:

## 1. The test file does not load

`(test file failed to load)`: syntax error, wrong import path, wrong export name, or a module that needs a mock (`vi.mock` is hoisted; its factory cannot use variables declared in the file unless they come from `vi.hoisted`). Fix the import or the mock and rerun.

## 2. The test is wrong

Typical signs: a query that finds no element (wrong role or name; check the rendered markup in the error output), a mocked collaborator returning `undefined`, an async assertion without `await` / `waitFor` / `findBy*`, a wrong expectation about formatting or ordering that the source clearly defines. Fix the test and rerun.

## 3. The source looks wrong

If the test expresses the behavior that the code's name, documentation, types, validation rules, UI text or the pull request's purpose clearly intend, and the code does something else:

- do **not** change the assertion to match the current output;
- do **not** edit the source (you cannot, and you must not try);
- remove that one failing case from the file, keep the passing ones, and add an entry to `suspectedBugs` in the report: file, line, expected vs. actual, and the input that shows it.

Only call it a bug when you can point at the evidence. A behavior you merely would have designed differently is not a bug: test what the code intends.

## 4. The environment

Timeouts, missing jsdom APIs (e.g. `window.matchMedia`, `ResizeObserver`), or unhandled promise rejections from a previous test. Stub the missing API in the test file (not in the shared setup), await the pending work, or reset mocks. Do not raise test timeouts to hide slowness.

## Limits

At most 3 fix attempts per test file. If it still fails, remove the failing cases, rerun to confirm the rest pass, and explain in the report what you could not test and why.
