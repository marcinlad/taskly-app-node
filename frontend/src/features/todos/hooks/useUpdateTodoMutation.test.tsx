import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { todoKeys } from '../api/queryKeys'
import { todosApi } from '../api/todos'
import { todoFixture } from '../../../test/todoFixture'
import type { Todo } from '../types'
import { useUpdateTodoMutation } from './useUpdateTodoMutation'

vi.mock('../api/todos', () => ({
  todosApi: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
}))

beforeEach(() => vi.clearAllMocks())

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
  const { result } = renderHook(() => useUpdateTodoMutation(), { wrapper })
  return { client, result }
}

it('sends the id and partial input to the API', async () => {
  const saved: Todo = { ...todoFixture, completed: true }
  vi.mocked(todosApi.update).mockResolvedValue(saved)
  const { result } = setup()
  await expect(
    act(() =>
      result.current.mutateAsync({
        id: todoFixture.id,
        input: { completed: true },
      }),
    ),
  ).resolves.toEqual(saved)
  expect(todosApi.update).toHaveBeenCalledWith(todoFixture.id, {
    completed: true,
  })
})

it('replaces only the saved task in the cached list', async () => {
  const other: Todo = { ...todoFixture, id: 8, title: 'Other task' }
  const saved: Todo = { ...todoFixture, title: 'Renamed demo' }
  vi.mocked(todosApi.update).mockResolvedValue(saved)
  const { client, result } = setup()
  client.setQueryData(todoKeys.list, [todoFixture, other])
  await act(() =>
    result.current.mutateAsync({
      id: todoFixture.id,
      input: { title: 'Renamed demo' },
    }),
  )
  expect(client.getQueryData(todoKeys.list)).toEqual([saved, other])
})

it('leaves the cache empty when no list has been loaded', async () => {
  vi.mocked(todosApi.update).mockResolvedValue(todoFixture)
  const { client, result } = setup()
  await act(() => result.current.mutateAsync({ id: todoFixture.id, input: {} }))
  expect(client.getQueryData(todoKeys.list)).toBeUndefined()
})

it('registers the mutation under the update key', async () => {
  vi.mocked(todosApi.update).mockResolvedValue(todoFixture)
  const { client, result } = setup()
  await act(() => result.current.mutateAsync({ id: todoFixture.id, input: {} }))
  const [mutation] = client.getMutationCache().getAll()
  expect(mutation.options.mutationKey).toEqual(['todos', 'update'])
})

it('exposes an API failure without touching the cache', async () => {
  vi.mocked(todosApi.update).mockRejectedValue(new Error('Server error'))
  const { client, result } = setup()
  client.setQueryData(todoKeys.list, [todoFixture])
  await expect(
    act(() =>
      result.current.mutateAsync({
        id: todoFixture.id,
        input: { completed: true },
      }),
    ),
  ).rejects.toThrow('Server error')
  expect(client.getQueryData(todoKeys.list)).toEqual([todoFixture])
})
