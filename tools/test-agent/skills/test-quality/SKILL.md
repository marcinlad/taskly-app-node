---
name: test-quality
description: Rules that make a unit test worth keeping - meaningful assertions, determinism, isolation, readable names - and the anti-patterns to avoid.
---

# Test quality

## Every test must be able to fail

- Assert on observable results: return values, thrown errors (`toThrow('message')`, `rejects.toThrow`), HTTP status and body, rendered text and accessible roles, the exact arguments of calls to collaborators.
- Avoid assertions that pass for almost anything: `toBeDefined()`, `toBeTruthy()` on objects, `expect.anything()` where the value matters, `toHaveBeenCalled()` without checking arguments when arguments carry the behavior.
- No snapshot tests (`toMatchSnapshot`, `toMatchInlineSnapshot`).
- Do not re-implement the code under test inside the test to compute the expected value; write the expected value literally.

## One behavior per test, named for it

- Name tests as a sentence about behavior: `it('rejects a title longer than 120 characters')`, not `it('works')` or `it('test validateTodo 3')`.
- Use `it.each` for the same behavior over several inputs (boundaries, invalid values), with `%s` / `%j` in the name.
- Cover the boundaries: empty, minimum, maximum, maximum + 1, null vs. undefined vs. missing.

## Deterministic and isolated

- No real network, database, timers or randomness. Mock at the boundary the package's skill describes.
- Control time with `vi.useFakeTimers()` and `vi.setSystemTime(new Date('2026-10-15T12:00:00Z'))`; restore with `vi.useRealTimers()` in `afterEach`.
- Reset mocks between tests (`beforeEach(() => vi.clearAllMocks())` or `afterEach(() => vi.restoreAllMocks())`) following the file's existing pattern; stub globals with `vi.stubGlobal` and undo with `vi.unstubAllGlobals()`.
- Tests must pass alone and in any order; verification runs each new file several times in isolation and then the whole suite.

## Keep the suite maintainable

- Reuse the package fixtures (`backend/tests/fixture.ts`, `frontend/src/test/todoFixture.ts`) by importing them and spreading overrides (`{ ...todoFixture, completed: true }`). You can only write `*.test.*` files: never edit a fixture or add helper files; put extra test data and helpers in the test file itself.
- Prefer a small local `setup()` helper over repeated arrange blocks, as the existing tests do.
- Do not weaken or delete existing tests. Do not add `.skip`, `.only` or `.todo`.
- Do not test third-party libraries or TypeScript types; test our code's use of them.
