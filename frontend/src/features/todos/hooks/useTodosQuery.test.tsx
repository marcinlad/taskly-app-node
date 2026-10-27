import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { todoKeys } from '../api/queryKeys'
import { todosApi } from '../api/todos'
import { todoFixture } from '../../../test/todoFixture'
import type { Todo } from '../types'
import { useTodosQuery } from './useTodosQuery'

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
  const view = renderHook(() => useTodosQuery(), { wrapper })
  return { client, ...view }
}

it('loads the tasks from the API and exposes them as data', async () => {
  const other: Todo = { ...todoFixture, id: 3, title: 'Other task' }
  vi.mocked(todosApi.list).mockResolvedValue([todoFixture, other])
  const { result } = setup()
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(result.current.data).toEqual([todoFixture, other])
  expect(todosApi.list).toHaveBeenCalledTimes(1)
})

it('passes the query abort signal to the API call', async () => {
  vi.mocked(todosApi.list).mockResolvedValue([])
  const { result } = setup()
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  const [signal] = vi.mocked(todosApi.list).mock.calls[0]
  expect(signal).toBeInstanceOf(AbortSignal)
})

it('stores the tasks under the list query key', async () => {
  vi.mocked(todosApi.list).mockResolvedValue([todoFixture])
  const { client, result } = setup()
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(client.getQueryData(todoKeys.list)).toEqual([todoFixture])
})

it('returns tasks already cached under the list key without loading state', () => {
  vi.mocked(todosApi.list).mockReturnValue(new Promise(() => {}))
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  client.setQueryData(todoKeys.list, [todoFixture])
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const { result } = renderHook(() => useTodosQuery(), { wrapper })
  expect(result.current.isPending).toBe(false)
  expect(result.current.data).toEqual([todoFixture])
  expect(todosApi.list).not.toHaveBeenCalled()
})

it('exposes an API failure as the query error', async () => {
  vi.mocked(todosApi.list).mockRejectedValue(new Error('Server error'))
  const { result } = setup()
  await waitFor(() => expect(result.current.isError).toBe(true))
  expect(result.current.error).toEqual(new Error('Server error'))
  expect(result.current.data).toBeUndefined()
})
