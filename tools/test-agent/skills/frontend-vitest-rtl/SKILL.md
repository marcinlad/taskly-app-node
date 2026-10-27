---
name: frontend-vitest-rtl
description: Conventions and mocking patterns for frontend unit tests - file layout and style, React Testing Library + user-event, the design-system mock, TanStack Query hooks, fetch stubbing. Load for any frontend target.
---

# Frontend unit tests (React + Vitest + Testing Library)

## Layout and style

- Tests sit next to the code: `Foo.tsx` → `Foo.test.tsx`, `useFoo.ts` → `useFoo.test.ts` (use `.tsx` when the test renders JSX).
- Prettier style: no semicolons, single quotes, trailing commas, 80 columns. Verification formats kept files with Prettier, but write it that way anyway.
- Imports: `import { expect, it, vi } from 'vitest'` explicitly, `render`, `screen`, `renderHook`, `waitFor`, `act` from `@testing-library/react`, `userEvent` from `@testing-library/user-event`.
- jest-dom matchers are set up globally (`toBeVisible`, `toHaveTextContent`, `toBeDisabled`, …). `src/test/setup.ts` runs `cleanup` after each test; do not edit it.
- Fixture: `todoFixture` from `src/test/todoFixture.ts` (relative path, e.g. `'../../../test/todoFixture'`). Spread for variants; files under `src/test/` are read-only for you.
- Tests are type-checked under `strict`. Cast partial hook results the way existing tests do: `{ ... } as unknown as ReturnType<typeof useTodosQuery>`.

## Components

- Mock the design system in every component test, with the path relative to the test file:

  ```ts
  vi.mock('../../../design-system', () => import('../../../design-system/mocks'))
  ```

  The mocks render plain HTML (headings, buttons, inputs with labels, `data-testid="alert"` for alerts) so queries by role and label work.
- Query like a user: `getByRole('button', { name: 'Save' })`, `getByLabelText`, `getByText`; `queryBy*` to assert absence; `findBy*` for async appearance.
- Interact with `const user = userEvent.setup()` and `await user.click(...)`, `await user.type(...)`.
- Assert callbacks with their arguments: `expect(onSave).toHaveBeenCalledWith({ ...expected })`.
- Child components can be replaced with `vi.mock('./TodoItem', () => ({ TodoItem: () => <li>Task</li> }))` when the test is about the parent.

## Hooks with TanStack Query

Give each test a fresh client with retries off and render the hook inside a provider:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  return { client, wrapper }
}
```

- Mock the feature's API module rather than `fetch`: `vi.mock('../api/todos', () => ({ todosApi: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() } }))`.
- Use the feature's query keys (`todoKeys` in `api/queryKeys.ts`) to seed and inspect the cache: `client.setQueryData(key, data)`, `client.getQueryData(key)`.
- Run mutations inside `act`: `await act(() => result.current.mutateAsync(input))`, then assert the cache; wait for queries with `await waitFor(() => expect(result.current.isSuccess).toBe(true))`.
- For hooks built on `useIsMutating` / `useIsFetching`, start a mutation or query whose promise you control (`new Promise((resolve) => { release = resolve })`) on the same client, assert, then release it.

## Code that calls `fetch` directly

Stub `fetch` globally and restore it:

```ts
const fetchMock = vi.fn()
beforeEach(() => vi.stubGlobal('fetch', fetchMock))
afterEach(() => { vi.unstubAllGlobals(); fetchMock.mockReset() })
fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }))
```

Build responses with the real `Response` class (status, headers, a non-JSON body when needed); simulate network failures with `mockRejectedValue(new TypeError('Failed to fetch'))` and cancellation with an `AbortController` aborted before the rejection.

## Out of scope

`src/design-system/**`, `*.stories.tsx`, `main.tsx`, barrels (`index.ts`), `types.ts` are excluded from coverage; do not write tests for them.
