import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { todoFixture } from '../../../test/todoFixture'
import { useDeleteTodoMutation } from '../hooks/useDeleteTodoMutation'
import { DeleteTodoDialog } from './DeleteTodoDialog'

vi.mock('../../../design-system', () => import('../../../design-system/mocks'))
vi.mock('../hooks/useDeleteTodoMutation', () => ({
  useDeleteTodoMutation: vi.fn(),
}))

beforeEach(() => vi.clearAllMocks())

function setup({
  busy = false,
  isPending = false,
  mutateAsync = vi.fn(),
}: {
  busy?: boolean
  isPending?: boolean
  mutateAsync?: ReturnType<typeof vi.fn>
} = {}) {
  const user = userEvent.setup()
  vi.mocked(useDeleteTodoMutation).mockReturnValue({
    isPending,
    error: null,
    mutateAsync,
  } as unknown as ReturnType<typeof useDeleteTodoMutation>)
  const onClose = vi.fn()
  const onDeleted = vi.fn()
  render(
    <DeleteTodoDialog
      todo={todoFixture}
      busy={busy}
      onClose={onClose}
      onDeleted={onDeleted}
    />,
  )
  return { user, onClose, onDeleted, mutateAsync }
}

it('shows a deletion error and allows cancelling without deleting', async () => {
  const user = userEvent.setup()
  const mutateAsync = vi.fn()
  vi.mocked(useDeleteTodoMutation).mockReturnValue({
    isPending: false,
    error: new Error('Could not delete.'),
    mutateAsync,
  } as unknown as ReturnType<typeof useDeleteTodoMutation>)
  const onClose = vi.fn()
  const onDeleted = vi.fn()
  render(
    <DeleteTodoDialog
      todo={todoFixture}
      busy={false}
      onClose={onClose}
      onDeleted={onDeleted}
    />,
  )
  expect(screen.getByRole('dialog', { name: 'Delete task?' })).toBeVisible()
  expect(
    screen.getByText(
      `The task “${todoFixture.title}” will be permanently deleted.`,
    ),
  ).toBeVisible()
  expect(screen.getByTestId('alert')).toHaveTextContent('Could not delete.')
  await user.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(onClose).toHaveBeenCalledTimes(1)
  expect(mutateAsync).not.toHaveBeenCalled()
  expect(onDeleted).not.toHaveBeenCalled()
})

it('deletes the task by id and reports success', async () => {
  const { user, onDeleted, onClose, mutateAsync } = setup({
    mutateAsync: vi.fn().mockResolvedValue(undefined),
  })
  expect(screen.queryByTestId('alert')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Delete task' }))
  await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1))
  expect(mutateAsync).toHaveBeenCalledWith(todoFixture.id)
  expect(onClose).not.toHaveBeenCalled()
})

it('stays open without reporting success when deletion fails', async () => {
  const { user, onDeleted, mutateAsync } = setup({
    mutateAsync: vi.fn().mockRejectedValue(new Error('Could not delete.')),
  })
  await user.click(screen.getByRole('button', { name: 'Delete task' }))
  await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1))
  expect(onDeleted).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog', { name: 'Delete task?' })).toBeVisible()
})

it('shows a pending state and disables actions while deleting', () => {
  setup({ isPending: true })
  expect(screen.getByRole('button', { name: 'Deleting…' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled()
})

it('disables actions while another task mutation is running', () => {
  setup({ busy: true })
  expect(screen.getByRole('button', { name: 'Deleting…' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
})
