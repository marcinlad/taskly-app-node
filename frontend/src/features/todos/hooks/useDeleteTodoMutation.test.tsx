import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { todoKeys } from '../api/queryKeys'
import { todosApi } from '../api/todos'
import { todoFixture } from '../../../test/todoFixture'
import type { Todo } from '../types'
import { useDeleteTodoMutation } from './useDeleteTodoMutation'

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
  const { result } = renderHook(() => useDeleteTodoMutation(), { wrapper })
  return { client, result }
}

it('deletes the task by id through the API', async () => {
  vi.mocked(todosApi.remove).mockResolvedValue(undefined)
  const { result } = setup()
  await act(() => result.current.mutateAsync(todoFixture.id))
  expect(todosApi.remove).toHaveBeenCalledWith(7)
})

it('removes only the deleted task from the cached list', async () => {
  const other: Todo = { ...todoFixture, id: 8, title: 'Other task' }
  vi.mocked(todosApi.remove).mockResolvedValue(undefined)
  const { client, result } = setup()
  client.setQueryData(todoKeys.list, [todoFixture, other])
  await act(() => result.current.mutateAsync(todoFixture.id))
  expect(client.getQueryData(todoKeys.list)).toEqual([other])
})

it('leaves the cache empty when no list has been loaded', async () => {
  vi.mocked(todosApi.remove).mockResolvedValue(undefined)
  const { client, result } = setup()
  await act(() => result.current.mutateAsync(todoFixture.id))
  expect(client.getQueryData(todoKeys.list)).toBeUndefined()
})

it('registers the mutation under the delete key', async () => {
  vi.mocked(todosApi.remove).mockResolvedValue(undefined)
  const { client, result } = setup()
  await act(() => result.current.mutateAsync(todoFixture.id))
  const [mutation] = client.getMutationCache().getAll()
  expect(mutation.options.mutationKey).toEqual(['todos', 'delete'])
})

it('exposes an API failure without touching the cache', async () => {
  vi.mocked(todosApi.remove).mockRejectedValue(new Error('Server error'))
  const { client, result } = setup()
  client.setQueryData(todoKeys.list, [todoFixture])
  await expect(
    act(() => result.current.mutateAsync(todoFixture.id)),
  ).rejects.toThrow('Server error')
  expect(client.getQueryData(todoKeys.list)).toEqual([todoFixture])
})
