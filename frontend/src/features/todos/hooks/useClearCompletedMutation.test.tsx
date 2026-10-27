import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { todoKeys } from '../api/queryKeys'
import { todosApi } from '../api/todos'
import { todoFixture } from '../../../test/todoFixture'
import type { Todo } from '../types'
import { useClearCompletedMutation } from './useClearCompletedMutation'

vi.mock('../api/todos', () => ({
  todosApi: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    clearCompleted: vi.fn(),
  },
}))

beforeEach(() => vi.clearAllMocks())

const active: Todo = { ...todoFixture, id: 8, title: 'Active task' }
const done: Todo = {
  ...todoFixture,
  id: 9,
  title: 'Done task',
  completed: true,
}
const alsoDone: Todo = {
  ...todoFixture,
  id: 10,
  title: 'Also done',
  completed: true,
}

function setup() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const { result } = renderHook(() => useClearCompletedMutation(), {
    wrapper,
  })
  return { client, result }
}

it('clears completed tasks through the API and resolves with the count', async () => {
  vi.mocked(todosApi.clearCompleted).mockResolvedValue({ deleted: 2 })
  const { result } = setup()
  await expect(act(() => result.current.mutateAsync())).resolves.toEqual({
    deleted: 2,
  })
  expect(todosApi.clearCompleted).toHaveBeenCalledTimes(1)
  expect(todosApi.clearCompleted).toHaveBeenCalledWith()
})

it('removes only the completed tasks from the cached list', async () => {
  vi.mocked(todosApi.clearCompleted).mockResolvedValue({ deleted: 2 })
  const { client, result } = setup()
  client.setQueryData(todoKeys.list, [done, active, alsoDone, todoFixture])
  await act(() => result.current.mutateAsync())
  expect(client.getQueryData(todoKeys.list)).toEqual([active, todoFixture])
})

it('leaves the cache empty when no list has been loaded', async () => {
  vi.mocked(todosApi.clearCompleted).mockResolvedValue({ deleted: 0 })
  const { client, result } = setup()
  await act(() => result.current.mutateAsync())
  expect(client.getQueryData(todoKeys.list)).toBeUndefined()
})

it('keeps a stale in-flight list fetch from restoring cleared tasks', async () => {
  vi.mocked(todosApi.clearCompleted).mockResolvedValue({ deleted: 1 })
  const { client, result } = setup()
  client.setQueryData(todoKeys.list, [active, done])
  let release: (todos: Todo[]) => void = () => {}
  void client.prefetchQuery({
    queryKey: todoKeys.list,
    queryFn: () =>
      new Promise<Todo[]>((resolve) => {
        release = resolve
      }),
  })
  await act(() => result.current.mutateAsync())
  await act(async () => {
    release([active, done])
    await Promise.resolve()
  })
  expect(client.getQueryData(todoKeys.list)).toEqual([active])
})

it('registers the mutation under the clearCompleted key', async () => {
  vi.mocked(todosApi.clearCompleted).mockResolvedValue({ deleted: 0 })
  const { client, result } = setup()
  await act(() => result.current.mutateAsync())
  const [mutation] = client.getMutationCache().getAll()
  expect(mutation.options.mutationKey).toEqual(['todos', 'clearCompleted'])
})

it('exposes an API failure without touching the cache', async () => {
  vi.mocked(todosApi.clearCompleted).mockRejectedValue(
    new Error('Server error'),
  )
  const { client, result } = setup()
  client.setQueryData(todoKeys.list, [active, done])
  await expect(act(() => result.current.mutateAsync())).rejects.toThrow(
    'Server error',
  )
  expect(client.getQueryData(todoKeys.list)).toEqual([active, done])
})
