---
name: backend-vitest
description: Conventions and mocking patterns for backend unit tests - file layout and style, Supertest for Express, Prisma mocked at the client delegate, environment and process code. Load for any backend target.
---

# Backend unit tests (Express + Prisma + Vitest)

## Layout and style

- Tests live in `backend/tests/<module>.test.ts`, not next to the source: one file per source module, named after it (`src/core/config.ts` → `tests/config.test.ts`).
- Import source with the `.ts` extension: `import { createApp } from '../src/factory.ts';`.
- Style: single quotes, semicolons, top-level `it(...)` (a `describe` only when the file already groups), a small `setup()` helper returning what the tests need.
- Shared fixtures: `tests/fixture.ts` exports `record` (a Prisma `TodoRecord` with `Date` fields) and `todo` (the API shape with ISO strings). Import and spread them for variants; the fixture file is read-only for you.
- Tests are type-checked (`backend/tsconfig.json` includes `tests/`) under `strict`. Cast partial stubs explicitly: `{ todo: { findFirst: vi.fn() } } as unknown as Database`.
- Some files have 100% coverage thresholds in `backend/vitest.config.ts`; keep them there.

## HTTP code: Supertest

Mount the router or app under test on a real Express instance with its collaborators replaced, and drive it with Supertest:

```ts
import express from 'express';
import request from 'supertest';
import { it, expect, vi } from 'vitest';

function setup() {
  const repository = { list: vi.fn(), create: vi.fn(), get: vi.fn(), update: vi.fn(), delete: vi.fn() };
  const app = express();
  app.use(express.json());
  app.use('/api/todos', createTodosRouter(repository));
  return { app, repository };
}

const response = await request(app).post('/api/todos').send({ title: 'Task' });
```

- Assert the status, the body and the exact arguments the collaborator received; for invalid input, assert the collaborator was never called.
- Malformed JSON: `.set('Content-Type', 'application/json').send('{"title":')`.
- Code that logs errors with `console.error`: silence and assert it with `vi.spyOn(console, 'error').mockImplementation(() => {})`.
- Express 5 forwards rejected promises from handlers to the error handler; a test can make a collaborator reject to reach it.

## Data access: Prisma

Build a real Prisma client without connecting and spy on its delegate methods; no PostgreSQL is needed:

```ts
const database = createDatabase('postgresql://test:test@localhost:5432/test');
const findMany = vi.spyOn(database.todo, 'findMany').mockResolvedValue([record]);
```

Use `afterEach(() => vi.restoreAllMocks())`. Assert the exact query arguments (`where`, `orderBy`, `data`) and how the result is mapped. Raw SQL (`$executeRaw`) is a tagged template: stub it with `vi.fn()` and assert on `(call[0] as TemplateStringsArray).join('')`.

## Environment and process code

- Configuration code may load the repository's `.env` at import time, so a developer's local values leak into `process.env`. Stub every variable a test depends on with `vi.stubEnv(name, value)` (empty string to unset) and call `vi.unstubAllEnvs()` in `afterEach`.
- Replace a module's collaborators with `vi.mock('../src/<path>.ts', () => ({ ... }))`; the path is relative to the test file and the mock applies to every importer.
- Servers: listen on port `0` (an ephemeral port) and close every server a test starts.
- Signals and exit: capture handlers with `vi.spyOn(process, 'once')` instead of sending real signals; never let a test call the real `process.exit` (`vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)`).
- A module whose only job is to call another at import time (an entry point) is bootstrap code; skipping it is usually right.
