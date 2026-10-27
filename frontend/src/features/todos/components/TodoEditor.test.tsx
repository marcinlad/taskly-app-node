import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { todoFixture } from '../../../test/todoFixture'
import { useCreateTodoMutation } from '../hooks/useCreateTodoMutation'
import { useUpdateTodoMutation } from '../hooks/useUpdateTodoMutation'
import type { Todo, TodoInput } from '../types'
import { TodoEditor } from './TodoEditor'

vi.mock('../../../design-system', () => import('../../../design-system/mocks'))
vi.mock('../hooks/useCreateTodoMutation', () => ({
  useCreateTodoMutation: vi.fn(),
}))
vi.mock('../hooks/useUpdateTodoMutation', () => ({
  useUpdateTodoMutation: vi.fn(),
}))
vi.mock('./TodoForm', () => ({
  TodoForm: ({
    onSubmit,
    initial,
    busy,
    error,
  }: {
    onSubmit: (input: TodoInput) => Promise<void>
    initial?: Todo
    busy: boolean
    error: string | null
  }) => (
    <div>
      <p>Initial: {initial ? initial.title : 'none'}</p>
      <p>Busy: {String(busy)}</p>
      <p>Error: {error ?? 'none'}</p>
      <button onClick={() => void onSubmit(todoFixture)}>Submit form</button>
    </div>
  ),
}))

function mockMutations({
  create = vi.fn(),
  update = vi.fn(),
  createState = {},
  updateState = {},
}: {
  create?: ReturnType<typeof vi.fn>
  update?: ReturnType<typeof vi.fn>
  createState?: { isPending?: boolean; error?: Error | null }
  updateState?: { isPending?: boolean; error?: Error | null }
} = {}) {
  vi.mocked(useCreateTodoMutation).mockReturnValue({
    isPending: false,
    error: null,
    mutateAsync: create,
    ...createState,
  } as unknown as ReturnType<typeof useCreateTodoMutation>)
  vi.mocked(useUpdateTodoMutation).mockReturnValue({
    isPending: false,
    error: null,
    mutateAsync: update,
    ...updateState,
  } as unknown as ReturnType<typeof useUpdateTodoMutation>)
  return { create, update }
}

it('creates a new task and reports a successful save', async () => {
  const user = userEvent.setup()
  const create = vi.fn().mockResolvedValue(todoFixture)
  const update = vi.fn()
  vi.mocked(useCreateTodoMutation).mockReturnValue({
    isPending: false,
    error: null,
    mutateAsync: create,
  } as unknown as ReturnType<typeof useCreateTodoMutation>)
  vi.mocked(useUpdateTodoMutation).mockReturnValue({
    isPending: false,
    error: null,
    mutateAsync: update,
  } as unknown as ReturnType<typeof useUpdateTodoMutation>)
  const onSaved = vi.fn()
  render(
    <TodoEditor todo="new" busy={false} onClose={vi.fn()} onSaved={onSaved} />,
  )
  expect(screen.getByRole('dialog', { name: 'New task' })).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Submit form' }))
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith('New task added.'))
  expect(create).toHaveBeenCalledWith(todoFixture)
  expect(update).not.toHaveBeenCalled()
})

it('updates an existing task by id and reports saved changes', async () => {
  const user = userEvent.setup()
  const existing: Todo = { ...todoFixture, id: 12, title: 'Write report' }
  const { create, update } = mockMutations({
    update: vi.fn().mockResolvedValue(existing),
  })
  const onSaved = vi.fn()
  render(
    <TodoEditor
      todo={existing}
      busy={false}
      onClose={vi.fn()}
      onSaved={onSaved}
    />,
  )
  expect(screen.getByRole('dialog', { name: 'Edit task' })).toBeVisible()
  expect(screen.getByText('Initial: Write report')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Submit form' }))
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith('Changes saved.'))
  expect(update).toHaveBeenCalledWith({ id: 12, input: todoFixture })
  expect(create).not.toHaveBeenCalled()
})

it('passes no initial task to the form when creating', () => {
  mockMutations()
  render(
    <TodoEditor todo="new" busy={false} onClose={vi.fn()} onSaved={vi.fn()} />,
  )
  expect(screen.getByText('Initial: none')).toBeVisible()
  expect(screen.getByText('Error: none')).toBeVisible()
})

it('shows the update error, not the create error, when editing', () => {
  mockMutations({
    createState: { error: new Error('Create failed.') },
    updateState: { error: new Error('Update failed.') },
  })
  render(
    <TodoEditor
      todo={todoFixture}
      busy={false}
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />,
  )
  expect(screen.getByText('Error: Update failed.')).toBeVisible()
})

it('does not report success when saving fails', async () => {
  const user = userEvent.setup()
  const { update } = mockMutations({
    update: vi.fn().mockRejectedValue(new Error('Update failed.')),
  })
  const onSaved = vi.fn()
  render(
    <TodoEditor
      todo={todoFixture}
      busy={false}
      onClose={vi.fn()}
      onSaved={onSaved}
    />,
  )
  await user.click(screen.getByRole('button', { name: 'Submit form' }))
  await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
  expect(onSaved).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog', { name: 'Edit task' })).toBeVisible()
})

it('ignores submissions while another mutation is running', async () => {
  const user = userEvent.setup()
  const { create } = mockMutations()
  const onSaved = vi.fn()
  render(<TodoEditor todo="new" busy onClose={vi.fn()} onSaved={onSaved} />)
  expect(screen.getByText('Busy: true')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Submit form' }))
  expect(create).not.toHaveBeenCalled()
  expect(onSaved).not.toHaveBeenCalled()
})

it('treats a pending update as busy when editing', () => {
  mockMutations({ updateState: { isPending: true } })
  render(
    <TodoEditor
      todo={todoFixture}
      busy={false}
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />,
  )
  expect(screen.getByText('Busy: true')).toBeVisible()
})

it('closes from the drawer', async () => {
  const user = userEvent.setup()
  mockMutations()
  const onClose = vi.fn()
  render(
    <TodoEditor todo="new" busy={false} onClose={onClose} onSaved={vi.fn()} />,
  )
  await user.click(screen.getByRole('button', { name: 'Close' }))
  expect(onClose).toHaveBeenCalledTimes(1)
})
