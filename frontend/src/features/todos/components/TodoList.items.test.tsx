import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { todoFixture } from '../../../test/todoFixture'
import type { Todo } from '../types'
import { TodoList } from './TodoList'

// TodoList.test.tsx replaces TodoItem with a static stub; this file renders the
// real items to check that each item's actions are wired to its own task.
vi.mock('../../../design-system', () => import('../../../design-system/mocks'))

beforeEach(() => vi.clearAllMocks())

const first: Todo = { ...todoFixture, id: 7, title: 'Prepare a demo' }
const second: Todo = {
  ...todoFixture,
  id: 8,
  title: 'Write report',
  completed: true,
}

function setup(busy = false) {
  const props = {
    todos: [first, second],
    hasTodos: true,
    loading: false,
    failed: false,
    busy,
    onCreate: vi.fn(),
    onToggle: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
  }
  render(<TodoList {...props} />)
  return { ...props, user: userEvent.setup() }
}

it('toggles the task whose checkbox was clicked', async () => {
  const { user, onToggle, onEdit, onDelete } = setup()
  await user.click(
    screen.getByRole('checkbox', { name: 'Mark as active: Write report' }),
  )
  expect(onToggle).toHaveBeenCalledTimes(1)
  expect(onToggle).toHaveBeenCalledWith(second)
  expect(onEdit).not.toHaveBeenCalled()
  expect(onDelete).not.toHaveBeenCalled()
})

it('edits the task whose edit button was clicked', async () => {
  const { user, onEdit, onToggle } = setup()
  await user.click(screen.getByRole('button', { name: 'Edit: Prepare a demo' }))
  expect(onEdit).toHaveBeenCalledTimes(1)
  expect(onEdit).toHaveBeenCalledWith(first)
  expect(onToggle).not.toHaveBeenCalled()
})

it('deletes the task whose delete button was clicked', async () => {
  const { user, onDelete, onEdit } = setup()
  await user.click(screen.getByRole('button', { name: 'Delete: Write report' }))
  expect(onDelete).toHaveBeenCalledTimes(1)
  expect(onDelete).toHaveBeenCalledWith(second)
  expect(onEdit).not.toHaveBeenCalled()
})

it('disables every item action while busy', () => {
  setup(true)
  expect(
    screen.getByRole('checkbox', { name: 'Complete: Prepare a demo' }),
  ).toBeDisabled()
  expect(
    screen.getByRole('button', { name: 'Edit: Write report' }),
  ).toBeDisabled()
  expect(
    screen.getByRole('button', { name: 'Delete: Prepare a demo' }),
  ).toBeDisabled()
})
