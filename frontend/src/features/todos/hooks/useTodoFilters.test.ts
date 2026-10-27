import { act, renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import { todoFixture } from '../../../test/todoFixture'
import type { Todo } from '../types'
import { useTodoFilters } from './useTodoFilters'

const older: Todo = {
  ...todoFixture,
  id: 1,
  title: 'Book flights',
  priority: 'low',
  completed: true,
  created_at: '2026-09-01T12:00:00Z',
}
const newer: Todo = {
  ...todoFixture,
  id: 2,
  title: 'Write report',
  description: 'Quarterly numbers',
  priority: 'medium',
  created_at: '2026-10-05T12:00:00Z',
}
const middle: Todo = {
  ...todoFixture,
  id: 3,
  title: 'Call the bank',
  priority: 'high',
  created_at: '2026-09-20T12:00:00Z',
}
const todos = [older, newer, middle]

function setup(list: Todo[] = todos) {
  return renderHook(() => useTodoFilters(list))
}

it('starts with all tasks, no search and newest first', () => {
  const { result } = setup()
  expect(result.current.filter).toBe('all')
  expect(result.current.search).toBe('')
  expect(result.current.sort).toBe('newest')
  expect(result.current.visible.map((todo) => todo.id)).toEqual([2, 3, 1])
})

it('returns no visible tasks for an empty list', () => {
  const { result } = setup([])
  expect(result.current.visible).toEqual([])
})

it.each([
  ['completed', [1]],
  ['active', [2, 3]],
  ['all', [2, 3, 1]],
] as const)('shows only %s tasks after changing the filter', (filter, ids) => {
  const { result } = setup()
  act(() => result.current.setFilter(filter))
  expect(result.current.filter).toBe(filter)
  expect(result.current.visible.map((todo) => todo.id)).toEqual(ids)
})

it('narrows the visible tasks by search in title or description', () => {
  const { result } = setup()
  act(() => result.current.setSearch('quarterly'))
  expect(result.current.search).toBe('quarterly')
  expect(result.current.visible).toEqual([newer])
})

it('orders the visible tasks by priority after changing the sort', () => {
  const { result } = setup()
  act(() => result.current.setSort('priority'))
  expect(result.current.sort).toBe('priority')
  expect(result.current.visible.map((todo) => todo.id)).toEqual([3, 2, 1])
})

it('combines filter and sort', () => {
  const { result } = setup()
  act(() => result.current.setSort('priority'))
  act(() => result.current.setFilter('active'))
  expect(result.current.visible.map((todo) => todo.id)).toEqual([3, 2])
})

it('recomputes the visible tasks when the input list changes', () => {
  const { result, rerender } = renderHook(
    ({ list }: { list: Todo[] }) => useTodoFilters(list),
    { initialProps: { list: [older] } },
  )
  act(() => result.current.setFilter('active'))
  expect(result.current.visible).toEqual([])
  rerender({ list: [older, middle] })
  expect(result.current.visible).toEqual([middle])
})
