import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { useNotice } from '../../hooks/useNotice'
import { todoFixture } from '../../test/todoFixture'
import { useClearCompletedMutation } from './hooks/useClearCompletedMutation'
import { useTodoFilters } from './hooks/useTodoFilters'
import { useTodosBusy } from './hooks/useTodosBusy'
import { useTodosQuery } from './hooks/useTodosQuery'
import { useUpdateTodoMutation } from './hooks/useUpdateTodoMutation'
import type { Todo } from './types'
import { TodosPage } from './TodosPage'

// TodosPage.test.tsx stubs the children as static output; here the children
// are stubs that expose their callbacks as buttons so the page wiring
// (toggle, editor and delete dialog state, notices) can be exercised.
vi.mock('../../design-system', () => import('../../design-system/mocks'))
vi.mock('../../hooks/useNotice', () => ({ useNotice: vi.fn() }))
vi.mock('./hooks/useClearCompletedMutation', () => ({
  useClearCompletedMutation: vi.fn(),
}))
vi.mock('./hooks/useTodoFilters', () => ({ useTodoFilters: vi.fn() }))
vi.mock('./hooks/useTodosBusy', () => ({ useTodosBusy: vi.fn() }))
vi.mock('./hooks/useTodosQuery', () => ({ useTodosQuery: vi.fn() }))
vi.mock('./hooks/useUpdateTodoMutation', () => ({
  useUpdateTodoMutation: vi.fn(),
}))
vi.mock('./components/TodosHeader', () => ({
  TodosHeader: ({
    disabled,
    completedCount,
    onCreate,
    onClearCompleted,
  }: {
    disabled: boolean
    completedCount: number
    onCreate: () => void
    onClearCompleted: () => void
  }) => (
    <>
      <button disabled={disabled} onClick={onCreate}>
        New task
      </button>
      <button disabled={disabled} onClick={onClearCompleted}>
        Clear completed ({completedCount})
      </button>
    </>
  ),
}))
vi.mock('./components/TodoFilters', () => ({ TodoFilters: () => null }))
vi.mock('./components/TodoList', () => ({
  TodoList: ({
    todos,
    hasTodos,
    onCreate,
    onToggle,
    onEdit,
    onDelete,
  }: {
    todos: Todo[]
    hasTodos: boolean
    onCreate: () => void
    onToggle: (todo: Todo) => void
    onEdit: (todo: Todo) => void
    onDelete: (todo: Todo) => void
  }) => (
    <div>
      <p>{hasTodos ? 'Has tasks' : 'No tasks loaded'}</p>
      <button onClick={onCreate}>Add your first task</button>
      {todos.map((todo) => (
        <div key={todo.id}>
          <button onClick={() => onToggle(todo)}>Toggle {todo.title}</button>
          <button onClick={() => onEdit(todo)}>Edit {todo.title}</button>
          <button onClick={() => onDelete(todo)}>Delete {todo.title}</button>
        </div>
      ))}
    </div>
  ),
}))
vi.mock('./components/TodoEditor', () => ({
  TodoEditor: ({
    todo,
    onClose,
    onSaved,
  }: {
    todo: Todo | 'new'
    onClose: () => void
    onSaved: (message: string) => void
  }) => (
    <div
      role="dialog"
      aria-label={todo === 'new' ? 'New task' : `Edit ${todo.title}`}
    >
      <button onClick={onClose}>Close editor</button>
      <button onClick={() => onSaved('Changes saved.')}>Save editor</button>
    </div>
  ),
}))
vi.mock('./components/DeleteTodoDialog', () => ({
  DeleteTodoDialog: ({
    todo,
    onClose,
    onDeleted,
  }: {
    todo: Todo
    onClose: () => void
    onDeleted: () => void
  }) => (
    <div role="dialog" aria-label={`Delete ${todo.title}`}>
      <button onClick={onClose}>Cancel deletion</button>
      <button onClick={onDeleted}>Confirm deletion</button>
    </div>
  ),
}))
vi.mock('../../components/SuccessNotice', () => ({ SuccessNotice: () => null }))

beforeEach(() => vi.clearAllMocks())

function setup({
  todos = [todoFixture] as Todo[],
  loaded = true,
  busy = false,
  queryError = null as Error | null,
  mutationError = null as Error | null,
  mutateAsync = vi.fn(),
  clearError = null as Error | null,
  clearMutateAsync = vi.fn(),
} = {}) {
  const notify = vi.fn()
  vi.mocked(useTodosQuery).mockReturnValue({
    data: loaded ? todos : undefined,
    isPending: !loaded,
    isFetching: false,
    isError: queryError !== null,
    error: queryError,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useTodosQuery>)
  vi.mocked(useUpdateTodoMutation).mockReturnValue({
    error: mutationError,
    reset: vi.fn(),
    mutateAsync,
  } as unknown as ReturnType<typeof useUpdateTodoMutation>)
  vi.mocked(useClearCompletedMutation).mockReturnValue({
    error: clearError,
    reset: vi.fn(),
    mutateAsync: clearMutateAsync,
  } as unknown as ReturnType<typeof useClearCompletedMutation>)
  vi.mocked(useTodosBusy).mockReturnValue(busy)
  vi.mocked(useNotice).mockReturnValue({ message: '', notify })
  vi.mocked(useTodoFilters).mockReturnValue({
    filter: 'all',
    search: '',
    sort: 'newest',
    visible: loaded ? todos : [],
    setFilter: vi.fn(),
    setSearch: vi.fn(),
    setSort: vi.fn(),
  })
  render(<TodosPage />)
  return { user: userEvent.setup(), notify, mutateAsync, clearMutateAsync }
}

it('treats a list that has not loaded yet as having no tasks', () => {
  setup({ loaded: false })
  expect(useTodoFilters).toHaveBeenCalledWith([])
  expect(screen.getByText('No tasks loaded')).toBeVisible()
  expect(screen.getByRole('button', { name: 'New task' })).toBeDisabled()
})

it('marks an active task complete and congratulates the user', async () => {
  const { user, notify, mutateAsync } = setup({
    mutateAsync: vi.fn().mockResolvedValue({ ...todoFixture, completed: true }),
  })
  await user.click(
    screen.getByRole('button', { name: 'Toggle Prepare a demo' }),
  )
  await waitFor(() =>
    expect(notify).toHaveBeenCalledWith('Another task complete. Well done!'),
  )
  expect(mutateAsync).toHaveBeenCalledWith({
    id: 7,
    input: { completed: true },
  })
})

it('marks a completed task active and says so', async () => {
  const done: Todo = { ...todoFixture, completed: true }
  const { user, notify, mutateAsync } = setup({
    todos: [done],
    mutateAsync: vi.fn().mockResolvedValue({ ...done, completed: false }),
  })
  await user.click(
    screen.getByRole('button', { name: 'Toggle Prepare a demo' }),
  )
  await waitFor(() =>
    expect(notify).toHaveBeenCalledWith('Task marked as active.'),
  )
  expect(mutateAsync).toHaveBeenCalledWith({
    id: 7,
    input: { completed: false },
  })
})

it('ignores a toggle while another mutation is running', async () => {
  const { user, notify, mutateAsync } = setup({ busy: true })
  await user.click(
    screen.getByRole('button', { name: 'Toggle Prepare a demo' }),
  )
  expect(mutateAsync).not.toHaveBeenCalled()
  expect(notify).not.toHaveBeenCalled()
})

it('does not notify when toggling fails', async () => {
  const { user, notify, mutateAsync } = setup({
    mutateAsync: vi.fn().mockRejectedValue(new Error('Server error')),
  })
  await user.click(
    screen.getByRole('button', { name: 'Toggle Prepare a demo' }),
  )
  await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1))
  expect(notify).not.toHaveBeenCalled()
})

it('shows the toggle error in preference to the list error', () => {
  setup({
    queryError: new Error('The server is unavailable.'),
    mutationError: new Error('Could not save the task.'),
  })
  expect(screen.getByTestId('alert')).toHaveTextContent(
    'Could not save the task.',
  )
  expect(screen.getByTestId('alert')).not.toHaveTextContent(
    'The server is unavailable.',
  )
})

it('shows no alert without errors', () => {
  setup()
  expect(screen.queryByTestId('alert')).not.toBeInTheDocument()
})

it.each(['New task', 'Add your first task'])(
  'opens the new task editor from the %s button',
  async (name) => {
    const { user } = setup()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name }))
    expect(screen.getByRole('dialog', { name: 'New task' })).toBeVisible()
  },
)

it('opens the editor for the task being edited and closes it', async () => {
  const { user, notify } = setup()
  await user.click(screen.getByRole('button', { name: 'Edit Prepare a demo' }))
  expect(
    screen.getByRole('dialog', { name: 'Edit Prepare a demo' }),
  ).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Close editor' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(notify).not.toHaveBeenCalled()
})

it('closes the editor and shows its notice after saving', async () => {
  const { user, notify } = setup()
  await user.click(screen.getByRole('button', { name: 'New task' }))
  await user.click(screen.getByRole('button', { name: 'Save editor' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(notify).toHaveBeenCalledWith('Changes saved.')
})

it('opens the delete confirmation for the task and cancels it', async () => {
  const { user, notify } = setup()
  await user.click(
    screen.getByRole('button', { name: 'Delete Prepare a demo' }),
  )
  expect(
    screen.getByRole('dialog', { name: 'Delete Prepare a demo' }),
  ).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Cancel deletion' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(notify).not.toHaveBeenCalled()
})

it('closes the delete confirmation and notifies after deleting', async () => {
  const { user, notify } = setup()
  await user.click(
    screen.getByRole('button', { name: 'Delete Prepare a demo' }),
  )
  await user.click(screen.getByRole('button', { name: 'Confirm deletion' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(notify).toHaveBeenCalledWith('Task deleted.')
})

it('passes the number of completed tasks to the header', () => {
  setup({
    todos: [
      { ...todoFixture, id: 1, title: 'One', completed: true },
      { ...todoFixture, id: 2, title: 'Two' },
      { ...todoFixture, id: 3, title: 'Three', completed: true },
    ],
  })
  expect(
    screen.getByRole('button', { name: 'Clear completed (2)' }),
  ).toBeVisible()
})

it('counts no completed tasks while the list is loading', () => {
  setup({ loaded: false })
  expect(
    screen.getByRole('button', { name: 'Clear completed (0)' }),
  ).toBeDisabled()
})

it.each([
  [1, 'Cleared 1 completed task.'],
  [0, 'Cleared 0 completed tasks.'],
  [3, 'Cleared 3 completed tasks.'],
])(
  'clears completed tasks and notifies when %s were deleted',
  async (deleted, notice) => {
    const { user, notify, clearMutateAsync } = setup({
      todos: [{ ...todoFixture, completed: true }],
      clearMutateAsync: vi.fn().mockResolvedValue({ deleted }),
    })
    await user.click(
      screen.getByRole('button', { name: 'Clear completed (1)' }),
    )
    await waitFor(() => expect(notify).toHaveBeenCalledWith(notice))
    expect(clearMutateAsync).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledTimes(1)
  },
)

it('ignores clearing while another mutation is running', async () => {
  const { user, notify, clearMutateAsync } = setup({
    todos: [{ ...todoFixture, completed: true }],
    busy: true,
  })
  const button = screen.getByRole('button', { name: 'Clear completed (1)' })
  expect(button).toBeDisabled()
  await user.click(button)
  expect(clearMutateAsync).not.toHaveBeenCalled()
  expect(notify).not.toHaveBeenCalled()
})

it('does not notify when clearing fails', async () => {
  const { user, notify, clearMutateAsync } = setup({
    todos: [{ ...todoFixture, completed: true }],
    clearMutateAsync: vi.fn().mockRejectedValue(new Error('Server error')),
  })
  await user.click(screen.getByRole('button', { name: 'Clear completed (1)' }))
  await waitFor(() => expect(clearMutateAsync).toHaveBeenCalledTimes(1))
  expect(notify).not.toHaveBeenCalled()
})

it('shows the clear error in preference to the list error', () => {
  setup({
    queryError: new Error('The server is unavailable.'),
    clearError: new Error('Could not clear completed tasks.'),
  })
  expect(screen.getByTestId('alert')).toHaveTextContent(
    'Could not clear completed tasks.',
  )
  expect(screen.getByTestId('alert')).not.toHaveTextContent(
    'The server is unavailable.',
  )
})

it('shows the toggle error in preference to the clear error', () => {
  setup({
    mutationError: new Error('Could not save the task.'),
    clearError: new Error('Could not clear completed tasks.'),
  })
  expect(screen.getByTestId('alert')).toHaveTextContent(
    'Could not save the task.',
  )
  expect(screen.getByTestId('alert')).not.toHaveTextContent(
    'Could not clear completed tasks.',
  )
})
