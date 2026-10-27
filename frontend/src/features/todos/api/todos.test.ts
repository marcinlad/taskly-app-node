import { beforeEach, expect, it, vi } from 'vitest'
import { request } from '../../../lib/http'
import { todoFixture } from '../../../test/todoFixture'
import { todosApi } from './todos'

vi.mock('../../../lib/http', () => ({ request: vi.fn() }))
beforeEach(() => vi.clearAllMocks())

it('passes the abort signal when fetching tasks', async () => {
  const signal = new AbortController().signal
  vi.mocked(request).mockResolvedValue([todoFixture])
  await expect(todosApi.list(signal)).resolves.toEqual([todoFixture])
  expect(request).toHaveBeenCalledWith('/todos', { signal })
})

it('sends only writable task fields on creation', async () => {
  vi.mocked(request).mockResolvedValue(todoFixture)
  await expect(todosApi.create(todoFixture)).resolves.toEqual(todoFixture)
  expect(request).toHaveBeenCalledWith('/todos', {
    method: 'POST',
    body: JSON.stringify({
      title: todoFixture.title,
      description: '',
      priority: 'medium',
      due_date: null,
      completed: false,
    }),
  })
})

it('patches a task by id with only the writable fields', async () => {
  const saved = { ...todoFixture, title: 'Renamed demo' }
  vi.mocked(request).mockResolvedValue(saved)
  await expect(
    todosApi.update(7, { ...todoFixture, title: 'Renamed demo' }),
  ).resolves.toEqual(saved)
  expect(request).toHaveBeenCalledWith('/todos/7', {
    method: 'PATCH',
    body: '{"title":"Renamed demo","description":"","priority":"medium","due_date":null,"completed":false}',
  })
})

it('sends only the provided fields of a partial update', async () => {
  vi.mocked(request).mockResolvedValue({ ...todoFixture, completed: true })
  await todosApi.update(12, { completed: true })
  expect(request).toHaveBeenCalledWith('/todos/12', {
    method: 'PATCH',
    body: '{"completed":true}',
  })
})

it('keeps a null due date in a partial update so it can be cleared', async () => {
  vi.mocked(request).mockResolvedValue(todoFixture)
  await todosApi.update(7, { due_date: null })
  expect(request).toHaveBeenCalledWith('/todos/7', {
    method: 'PATCH',
    body: '{"due_date":null}',
  })
})

it('deletes a task by id', async () => {
  vi.mocked(request).mockResolvedValue(undefined)
  await expect(todosApi.remove(7)).resolves.toBeUndefined()
  expect(request).toHaveBeenCalledWith('/todos/7', { method: 'DELETE' })
})

it('clears completed tasks with a filtered DELETE and returns the count', async () => {
  vi.mocked(request).mockResolvedValue({ deleted: 3 })
  await expect(todosApi.clearCompleted()).resolves.toEqual({ deleted: 3 })
  expect(request).toHaveBeenCalledWith('/todos?completed=true', {
    method: 'DELETE',
  })
})

it('propagates a failure to clear completed tasks', async () => {
  vi.mocked(request).mockRejectedValue(new Error('Server error'))
  await expect(todosApi.clearCompleted()).rejects.toThrow('Server error')
})
