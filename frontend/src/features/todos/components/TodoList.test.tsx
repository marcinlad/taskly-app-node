import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { TodoList } from './TodoList'
import { todoFixture } from '../../../test/todoFixture'

vi.mock('../../../design-system', () => import('../../../design-system/mocks'))
vi.mock('./TodoEmptyState', () => ({
  TodoEmptyState: () => <p>Empty task list</p>,
}))
vi.mock('./TodoItem', () => ({ TodoItem: () => <li>Task</li> }))

it('shows loading feedback before showing an empty list', () => {
  const props = {
    todos: [],
    hasTodos: false,
    failed: false,
    busy: false,
    onCreate: vi.fn(),
    onToggle: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
  }
  const { rerender } = render(<TodoList {...props} loading />)
  expect(screen.getByRole('status')).toHaveTextContent('Loading your tasks…')
  expect(screen.queryByText('Empty task list')).not.toBeInTheDocument()
  rerender(<TodoList {...props} loading={false} />)
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(screen.getByText('Empty task list')).toBeVisible()
})

const baseProps = {
  todos: [],
  hasTodos: false,
  loading: false,
  failed: false,
  busy: false,
  onCreate: vi.fn(),
  onToggle: vi.fn(),
  onEdit: vi.fn(),
  onDelete: vi.fn(),
}

it('explains that the list is unavailable when loading failed without tasks', () => {
  render(<TodoList {...baseProps} failed />)
  expect(
    screen.getByRole('heading', {
      level: 3,
      name: 'The task list is temporarily unavailable',
    }),
  ).toBeVisible()
  expect(screen.getByText('Try again to load your tasks.')).toBeVisible()
  expect(screen.queryByText('Empty task list')).not.toBeInTheDocument()
})

it('keeps showing previously loaded tasks when a refetch failed', () => {
  render(
    <TodoList
      {...baseProps}
      todos={[todoFixture, { ...todoFixture, id: 8 }]}
      hasTodos
      failed
    />,
  )
  expect(screen.getAllByRole('listitem')).toHaveLength(2)
  expect(
    screen.queryByText('The task list is temporarily unavailable'),
  ).not.toBeInTheDocument()
})

it('shows the empty state when loading failed but filtered tasks are empty', () => {
  render(<TodoList {...baseProps} hasTodos failed />)
  expect(screen.getByText('Empty task list')).toBeVisible()
  expect(
    screen.queryByText('The task list is temporarily unavailable'),
  ).not.toBeInTheDocument()
})

it('renders one item per visible task inside the task list region', () => {
  render(
    <TodoList
      {...baseProps}
      todos={[
        todoFixture,
        { ...todoFixture, id: 8 },
        { ...todoFixture, id: 9 },
      ]}
      hasTodos
    />,
  )
  const region = screen.getByRole('region', { name: 'Task list' })
  expect(region).toContainElement(screen.getByRole('list'))
  expect(screen.getAllByRole('listitem')).toHaveLength(3)
  expect(screen.queryByText('Empty task list')).not.toBeInTheDocument()
})
