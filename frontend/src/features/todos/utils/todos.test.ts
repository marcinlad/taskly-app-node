import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatDate, isOverdue, selectTodos, validateTodo } from './todos'
import type { Todo, TodoInput } from '../types'

const base: Todo = {
  id: 1,
  title: 'Sprint plan',
  description: '',
  priority: 'medium',
  completed: false,
  due_date: null,
  created_at: '2026-10-01T12:00:00Z',
  updated_at: '2026-10-01T12:00:00Z',
}

const validInput: TodoInput = {
  title: 'Sprint plan',
  description: '',
  priority: 'medium',
  due_date: null,
  completed: false,
}

describe('selectTodos', () => {
  it('combines status with a case-insensitive search in the description', () => {
    const matching = { ...base, description: 'Discuss the API' }
    const todos = [
      matching,
      { ...matching, id: 2, completed: true },
      { ...base, id: 3 },
    ]
    expect(selectTodos(todos, 'active', ' api ', 'newest')).toEqual([matching])
  })

  it('sorts by priority without changing the source array', () => {
    const high: Todo = { ...base, id: 2, priority: 'high' }
    const todos = [base, high]
    expect(selectTodos(todos, 'all', '', 'priority')).toEqual([high, base])
    expect(todos).toEqual([base, high])
  })

  it('keeps only completed tasks with the completed filter', () => {
    const done: Todo = { ...base, id: 2, completed: true }
    expect(selectTodos([base, done], 'completed', '', 'newest')).toEqual([done])
  })

  it('searches the title case-insensitively', () => {
    const other: Todo = { ...base, id: 2, title: 'Release notes' }
    expect(selectTodos([base, other], 'all', 'SPRINT', 'newest')).toEqual([
      base,
    ])
  })

  it('breaks priority ties by the higher id first', () => {
    const low: Todo = { ...base, id: 5, priority: 'low' }
    const mediumOld: Todo = { ...base, id: 2 }
    const mediumNew: Todo = { ...base, id: 3 }
    expect(
      selectTodos([low, mediumOld, mediumNew], 'all', '', 'priority'),
    ).toEqual([mediumNew, mediumOld, low])
  })

  it('sorts by due date with undated tasks last and ties by higher id', () => {
    const undated: Todo = { ...base, id: 9 }
    const late: Todo = { ...base, id: 2, due_date: '2026-12-01' }
    const earlyA: Todo = { ...base, id: 3, due_date: '2026-10-20' }
    const earlyB: Todo = { ...base, id: 4, due_date: '2026-10-20' }
    expect(
      selectTodos([undated, late, earlyA, earlyB], 'all', '', 'due'),
    ).toEqual([earlyB, earlyA, late, undated])
  })

  it('orders undated tasks by higher id when sorting by due date', () => {
    const dated: Todo = { ...base, id: 1, due_date: '2026-10-20' }
    const undatedOld: Todo = { ...base, id: 2 }
    const undatedNew: Todo = { ...base, id: 3 }
    expect(
      selectTodos([undatedOld, dated, undatedNew], 'all', '', 'due'),
    ).toEqual([dated, undatedNew, undatedOld])
  })

  it('sorts newest first by creation time and ties by higher id', () => {
    const older: Todo = { ...base, id: 8, created_at: '2026-09-01T12:00:00Z' }
    const newer: Todo = { ...base, id: 2, created_at: '2026-10-05T12:00:00Z' }
    const sameAsBase: Todo = { ...base, id: 3 }
    expect(
      selectTodos([older, base, newer, sameAsBase], 'all', '', 'newest'),
    ).toEqual([newer, sameAsBase, base, older])
  })
})

describe('validateTodo', () => {
  it('accepts a valid task without a due date', () => {
    expect(validateTodo(validInput)).toEqual({})
  })

  it.each(['', '   '])('requires a title (%j)', (title) => {
    expect(validateTodo({ ...validInput, title })).toEqual({
      title: 'Enter a task title.',
    })
  })

  it('accepts a title of exactly 120 characters after trimming', () => {
    expect(
      validateTodo({ ...validInput, title: ` ${'a'.repeat(120)} ` }),
    ).toEqual({})
  })

  it('rejects a title longer than 120 characters', () => {
    expect(validateTodo({ ...validInput, title: 'a'.repeat(121) })).toEqual({
      title: 'The title must be at most 120 characters.',
    })
  })

  it('accepts a description of exactly 2000 characters', () => {
    expect(
      validateTodo({ ...validInput, description: 'd'.repeat(2000) }),
    ).toEqual({})
  })

  it('rejects a description longer than 2000 characters', () => {
    expect(
      validateTodo({ ...validInput, description: 'd'.repeat(2001) }),
    ).toEqual({
      description: 'The description must be at most 2000 characters.',
    })
  })

  it.each(['2026-10-15', '2028-02-29'])('accepts the due date %s', (date) => {
    expect(validateTodo({ ...validInput, due_date: date })).toEqual({})
  })

  it.each([
    '2026-1-05',
    '15/10/2026',
    '2026-13-01',
    '2026-02-30',
    '2027-02-29',
  ])('rejects the invalid due date %s', (date) => {
    expect(validateTodo({ ...validInput, due_date: date })).toEqual({
      due_date: 'Enter a valid date.',
    })
  })

  it('reports every invalid field at once', () => {
    expect(
      validateTodo({
        ...validInput,
        title: ' ',
        description: 'd'.repeat(2001),
        due_date: 'tomorrow',
      }),
    ).toEqual({
      title: 'Enter a task title.',
      description: 'The description must be at most 2000 characters.',
      due_date: 'Enter a valid date.',
    })
  })
})

describe('isOverdue', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 15, 12, 0, 0))
  })
  afterEach(() => vi.useRealTimers())

  it('flags an active task due before today', () => {
    expect(isOverdue({ ...base, due_date: '2026-10-14' })).toBe(true)
  })

  it('does not flag an active task due today', () => {
    expect(isOverdue({ ...base, due_date: '2026-10-15' })).toBe(false)
  })

  it('does not flag a completed task due in the past', () => {
    expect(
      isOverdue({ ...base, completed: true, due_date: '2026-10-01' }),
    ).toBe(false)
  })

  it('does not flag a task without a due date', () => {
    expect(isOverdue(base)).toBe(false)
  })
})

describe('formatDate', () => {
  it('formats an ISO date as day, short month and year', () => {
    expect(formatDate('2026-10-05')).toBe('5 Oct 2026')
  })
})
