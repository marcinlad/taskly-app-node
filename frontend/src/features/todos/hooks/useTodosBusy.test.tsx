import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { expect, it } from 'vitest'
import { todoKeys } from '../api/queryKeys'
import { useTodosBusy } from './useTodosBusy'

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
  const { result } = renderHook(() => useTodosBusy(), { wrapper })

  function startMutation(mutationKey: readonly string[]) {
    let release: () => void = () => {}
    let fail: (error: Error) => void = () => {}
    const mutation = client.getMutationCache().build(client, {
      mutationKey,
      mutationFn: () =>
        new Promise<void>((resolve, reject) => {
          release = () => resolve()
          fail = reject
        }),
    })
    let done: Promise<unknown> = Promise.resolve()
    act(() => {
      done = mutation.execute(undefined).catch(() => undefined)
    })
    return {
      release: async () => {
        release()
        await act(() => done)
      },
      fail: async (error: Error) => {
        fail(error)
        await act(() => done)
      },
    }
  }

  return { result, startMutation }
}

it('is not busy when no mutation is running', () => {
  const { result } = setup()
  expect(result.current).toBe(false)
})

it.each([
  ['create', todoKeys.create],
  ['update', todoKeys.update],
  ['delete', todoKeys.delete],
])('is busy while a %s mutation is pending', async (_name, key) => {
  const { result, startMutation } = setup()
  const mutation = startMutation(key)
  await waitFor(() => expect(result.current).toBe(true))
  await mutation.release()
  await waitFor(() => expect(result.current).toBe(false))
})

it('stays busy until every running todo mutation has settled', async () => {
  const { result, startMutation } = setup()
  const create = startMutation(todoKeys.create)
  const remove = startMutation(todoKeys.delete)
  await waitFor(() => expect(result.current).toBe(true))
  await create.release()
  expect(result.current).toBe(true)
  await remove.release()
  await waitFor(() => expect(result.current).toBe(false))
})

it('is no longer busy after a todo mutation fails', async () => {
  const { result, startMutation } = setup()
  const mutation = startMutation(todoKeys.update)
  await waitFor(() => expect(result.current).toBe(true))
  await mutation.fail(new Error('Server error'))
  await waitFor(() => expect(result.current).toBe(false))
})

it('ignores pending mutations outside the todos key', async () => {
  const { result, startMutation } = setup()
  const mutation = startMutation(['profile', 'update'])
  await act(async () => {})
  expect(result.current).toBe(false)
  await mutation.release()
})
