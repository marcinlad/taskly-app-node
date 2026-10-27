import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { todoKeys } from '../api/queryKeys'
import { todosApi } from '../api/todos'
import { todoFixture } from '../../../test/todoFixture'
import type { Todo, TodoInput } from '../types'
import { useCreateTodoMutation } from './useCreateTodoMutation'

vi.mock('../api/todos', () => ({
  todosApi: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
}))

beforeEach(() => vi.clearAllMocks())

const input: TodoInput = {
  title: 'Prepare a demo',
  description: '',
  priority: 'medium',
  due_date: null,
  completed: false,
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
  const { result } = renderHook(() => useCreateTodoMutation(), { wrapper })
  return { client, result }
}

it('sends the input to the API and resolves with the saved task', async () => {
  vi.mocked(todosApi.create).mockResolvedValue(todoFixture)
  const { result } = setup()
  await expect(act(() => result.current.mutateAsync(input))).resolves.toEqual(
    todoFixture,
  )
  expect(todosApi.create).toHaveBeenCalledWith(input)
})

it('puts the saved task at the top of the cached list', async () => {
  const other: Todo = { ...todoFixture, id: 3, title: 'Other task' }
  vi.mocked(todosApi.create).mockResolvedValue(todoFixture)
  const { client, result } = setup()
  client.setQueryData(todoKeys.list, [other])
  await act(() => result.current.mutateAsync(input))
  expect(client.getQueryData(todoKeys.list)).toEqual([todoFixture, other])
})

it('does not duplicate a task already present in the cached list', async () => {
  const other: Todo = { ...todoFixture, id: 3, title: 'Other task' }
  const stale: Todo = { ...todoFixture, title: 'Stale copy' }
  vi.mocked(todosApi.create).mockResolvedValue(todoFixture)
  const { client, result } = setup()
  client.setQueryData(todoKeys.list, [other, stale])
  await act(() => result.current.mutateAsync(input))
  expect(client.getQueryData(todoKeys.list)).toEqual([todoFixture, other])
})

it('starts a list with the saved task when none has been loaded', async () => {
  vi.mocked(todosApi.create).mockResolvedValue(todoFixture)
  const { client, result } = setup()
  await act(() => result.current.mutateAsync(input))
  expect(client.getQueryData(todoKeys.list)).toEqual([todoFixture])
})

it('keeps the saved task when an older list refetch finishes afterwards', async () => {
  const other: Todo = { ...todoFixture, id: 3, title: 'Other task' }
  let release: (todos: Todo[]) => void = () => {}
  vi.mocked(todosApi.create).mockResolvedValue(todoFixture)
  const { client, result } = setup()
  client.setQueryData(todoKeys.list, [other])
  void client
    .fetchQuery({
      queryKey: todoKeys.list,
      queryFn: () =>
        new Promise<Todo[]>((resolve) => {
          release = resolve
        }),
      staleTime: 0,
    })
    .catch(() => undefined)
  await act(() => result.current.mutateAsync(input))
  await act(async () => release([other]))
  expect(client.getQueryData(todoKeys.list)).toEqual([todoFixture, other])
})

it('registers the mutation under the create key', async () => {
  vi.mocked(todosApi.create).mockResolvedValue(todoFixture)
  const { client, result } = setup()
  await act(() => result.current.mutateAsync(input))
  const [mutation] = client.getMutationCache().getAll()
  expect(mutation.options.mutationKey).toEqual(['todos', 'create'])
})

it('exposes an API failure without touching the cache', async () => {
  vi.mocked(todosApi.create).mockRejectedValue(new Error('Server error'))
  const { client, result } = setup()
  client.setQueryData(todoKeys.list, [todoFixture])
  await expect(act(() => result.current.mutateAsync(input))).rejects.toThrow(
    'Server error',
  )
  expect(client.getQueryData(todoKeys.list)).toEqual([todoFixture])
})
