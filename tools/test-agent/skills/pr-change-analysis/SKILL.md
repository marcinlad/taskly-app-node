---
name: pr-change-analysis
description: How to read a pull request diff and decide per changed file whether to create tests, update existing tests, or skip - with the criteria to justify the decision.
---

# Pull request change analysis

For each target, read the diff with `get_diff`, then the full file, and classify the change.

## Decide

| Change | Existing tests | Decision |
|---|---|---|
| New module with logic (branches, transformations, validation, side effects) | none | **create** |
| New or changed behavior in a module | exist | **update**: add cases for the new behavior; adjust only the expectations the intended change makes obsolete. Changed or removed existing lines are left for a reviewer, so say in the reason why each one had to change. Exceptions, committed automatically: adding names to an existing import, and repairing a test file the pull request broke (it failed before your changes) without changing any assertion; keep such repairs to setup, mocks, imports and props |
| New behavior in a module | none | **create**, covering the changed behavior first, then the rest of the module if cheap |
| Rename, formatting, comments, import reordering, type-only change | any | **skip**: behavior did not change |
| Pure re-export, constant table, wiring with no logic that other tests already exercise | any | **skip** |
| Deleted behavior | exist | **update** only if existing tests now fail because the behavior was removed on purpose; say so in the reason |

Read the pull request's own test changes (listed in the task) before deciding: if the author already covered the change, **skip** with that reason or add only the missing cases.

## What "changed behavior" means

Look at what a caller can observe: return values, thrown errors, HTTP status and body, rendered text and roles, callbacks invoked, calls to collaborators (API client, repository, query cache). A refactor that keeps all of these the same needs no new tests; existing tests passing is the evidence.

## Writing the reason

One or two sentences a reviewer can check against the diff, e.g.:

- "create: new `overdue` filter in selectTodos has date-dependent branches; added cases for past, today and future due dates with a fixed system time."
- "update: PATCH now rejects `completed: null`; added a 422 case and kept the existing ones."
- "skip: only renamed a local variable; behavior is unchanged and covered by TodoForm.test.tsx."

## Intent vs. implementation

The diff tells you what the code does now, not whether it is right. When the new code contradicts its own naming, the surrounding code, validation rules on the other side of the API, or the pull request's evident purpose, treat it as a possible bug (see `failure-triage`) rather than encoding it in a test.
