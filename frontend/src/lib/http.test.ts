import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { request } from './http'

const fetchMock = vi.fn()

beforeEach(() => vi.stubGlobal('fetch', fetchMock))
afterEach(() => {
  vi.unstubAllGlobals()
  fetchMock.mockReset()
})

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

it('prefixes the path with /api and returns the parsed JSON body', async () => {
  fetchMock.mockResolvedValue(jsonResponse([{ id: 1 }]))
  await expect(request('/todos')).resolves.toEqual([{ id: 1 }])
  expect(fetchMock).toHaveBeenCalledWith('/api/todos', {
    headers: { 'Content-Type': 'application/json' },
  })
})

it('forwards request options and merges custom headers', async () => {
  fetchMock.mockResolvedValue(jsonResponse({ id: 2 }, 201))
  await request('/todos', {
    method: 'POST',
    body: '{"title":"A"}',
    headers: { 'X-Trace': 'abc' },
  })
  expect(fetchMock).toHaveBeenCalledWith('/api/todos', {
    method: 'POST',
    body: '{"title":"A"}',
    headers: { 'Content-Type': 'application/json', 'X-Trace': 'abc' },
  })
})

it('resolves to undefined for a 204 response', async () => {
  fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
  await expect(
    request('/todos/1', { method: 'DELETE' }),
  ).resolves.toBeUndefined()
})

it('replaces a network failure with a connection message', async () => {
  fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
  await expect(request('/todos')).rejects.toThrow(
    'Cannot connect to the server. Please try again.',
  )
})

it('rethrows the original error when the request was aborted', async () => {
  const controller = new AbortController()
  controller.abort()
  const abortError = new DOMException('Aborted', 'AbortError')
  fetchMock.mockRejectedValue(abortError)
  await expect(request('/todos', { signal: controller.signal })).rejects.toBe(
    abortError,
  )
})

it('explains the task constraints on a 422 response', async () => {
  fetchMock.mockResolvedValue(jsonResponse({ detail: 'ignored' }, 422))
  await expect(request('/todos')).rejects.toThrow(
    'Check the task details: title up to 120 characters, description up to 2000 characters, and a valid due date.',
  )
})

it('uses the server detail message on other errors', async () => {
  fetchMock.mockResolvedValue(jsonResponse({ detail: 'Task not found.' }, 404))
  await expect(request('/todos/9')).rejects.toThrow('Task not found.')
})

it('falls back to a generic message when the detail is not a string', async () => {
  fetchMock.mockResolvedValue(jsonResponse({ detail: [{ msg: 'x' }] }, 400))
  await expect(request('/todos')).rejects.toThrow(
    'The operation failed. Please try again.',
  )
})

it('falls back to a generic message when the error body is not JSON', async () => {
  fetchMock.mockResolvedValue(
    new Response('<h1>Bad gateway</h1>', { status: 502 }),
  )
  await expect(request('/todos')).rejects.toThrow(
    'The operation failed. Please try again.',
  )
})
