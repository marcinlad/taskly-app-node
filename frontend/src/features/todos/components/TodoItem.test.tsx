import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { todoFixture } from '../../../test/todoFixture'
import type { Todo } from '../types'
import { TodoItem } from './TodoItem'

vi.mock('../../../design-system', () => import('../../../design-system/mocks'))

afterEach(() => vi.useRealTimers())

function setup(todo: Todo, busy = false) {
  const user = userEvent.setup()
  const onEdit = vi.fn()
  const onToggle = vi.fn()
  const onDelete = vi.fn()
  render(
    <TodoItem
      todo={todo}
      busy={busy}
      onEdit={onEdit}
      onToggle={onToggle}
      onDelete={onDelete}
    />,
  )
  return { user, onEdit, onToggle, onDelete }
}

it('shows an active task and forwards edit requests', async () => {
  const user = userEvent.setup()
  const onEdit = vi.fn()
  const onToggle = vi.fn()
  const onDelete = vi.fn()
  render(
    <TodoItem
      todo={todoFixture}
      busy={false}
      onEdit={onEdit}
      onToggle={onToggle}
      onDelete={onDelete}
    />,
  )
  expect(screen.getByRole('heading', { name: todoFixture.title })).toBeVisible()
  expect(screen.getByText('To do')).toBeVisible()
  expect(screen.getByText('Medium')).toBeVisible()
  expect(screen.getByRole('checkbox')).not.toBeChecked()
  await user.click(
    screen.getByRole('button', { name: `Edit: ${todoFixture.title}` }),
  )
  expect(onEdit).toHaveBeenCalledTimes(1)
  expect(onToggle).not.toHaveBeenCalled()
  expect(onDelete).not.toHaveBeenCalled()
})

it('shows the id and the description when present', () => {
  setup({ ...todoFixture, description: 'Slides and live coding' })
  expect(screen.getByText('#7')).toBeVisible()
  expect(screen.getByText('Slides and live coding')).toBeVisible()
})

it('shows a completed task with a mark-as-active toggle', async () => {
  const todo = { ...todoFixture, completed: true, priority: 'high' as const }
  const { user, onToggle } = setup(todo)
  expect(screen.getByText('Completed')).toBeVisible()
  expect(screen.getByText('High')).toBeVisible()
  const checkbox = screen.getByRole('checkbox', {
    name: `Mark as active: ${todo.title}`,
  })
  expect(checkbox).toBeChecked()
  await user.click(checkbox)
  expect(onToggle).toHaveBeenCalledTimes(1)
})

it('completes an active task through the checkbox', async () => {
  const { user, onToggle } = setup(todoFixture)
  await user.click(
    screen.getByRole('checkbox', { name: `Complete: ${todoFixture.title}` }),
  )
  expect(onToggle).toHaveBeenCalledTimes(1)
})

it('forwards delete requests', async () => {
  const { user, onDelete, onEdit } = setup(todoFixture)
  await user.click(
    screen.getByRole('button', { name: `Delete: ${todoFixture.title}` }),
  )
  expect(onDelete).toHaveBeenCalledTimes(1)
  expect(onEdit).not.toHaveBeenCalled()
})

it('disables every action while busy', () => {
  setup(todoFixture, true)
  expect(screen.getByRole('checkbox')).toBeDisabled()
  expect(
    screen.getByRole('button', { name: `Edit: ${todoFixture.title}` }),
  ).toBeDisabled()
  expect(
    screen.getByRole('button', { name: `Delete: ${todoFixture.title}` }),
  ).toBeDisabled()
})

it('marks an active task with a past due date as overdue', () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 9, 15, 12))
  setup({ ...todoFixture, due_date: '2026-10-10' })
  expect(screen.getByText('10 Oct 2026 · overdue')).toBeVisible()
})

it('shows a future due date without the overdue marker', () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 9, 15, 12))
  setup({ ...todoFixture, due_date: '2026-10-20' })
  expect(screen.getByText('20 Oct 2026')).toBeVisible()
  expect(screen.queryByText(/overdue/)).not.toBeInTheDocument()
})

it('does not mark a completed task as overdue', () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 9, 15, 12))
  setup({ ...todoFixture, completed: true, due_date: '2026-10-10' })
  expect(screen.getByText('10 Oct 2026')).toBeVisible()
  expect(screen.queryByText(/overdue/)).not.toBeInTheDocument()
})
