import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { TodosHeader } from './TodosHeader'

vi.mock('../../../design-system', () => import('../../../design-system/mocks'))

it('invokes creation when enabled and blocks it when disabled', async () => {
  const user = userEvent.setup()
  const onCreate = vi.fn()
  const { rerender } = render(
    <TodosHeader
      disabled={false}
      completedCount={0}
      onCreate={onCreate}
      onClearCompleted={vi.fn()}
    />,
  )
  expect(screen.getByRole('heading', { name: 'Tasks' })).toBeVisible()
  expect(
    screen.getByText('Create, organize, and complete tasks.'),
  ).toBeVisible()
  const button = screen.getByRole('button', { name: 'New task' })
  await user.click(button)
  expect(onCreate).toHaveBeenCalledTimes(1)
  rerender(
    <TodosHeader
      disabled
      completedCount={0}
      onCreate={onCreate}
      onClearCompleted={vi.fn()}
    />,
  )
  expect(button).toBeDisabled()
  await user.click(button)
  expect(onCreate).toHaveBeenCalledTimes(1)
})

it('hides the clear completed button when no task is completed', () => {
  render(
    <TodosHeader
      disabled={false}
      completedCount={0}
      onCreate={vi.fn()}
      onClearCompleted={vi.fn()}
    />,
  )
  expect(
    screen.queryByRole('button', { name: /Clear completed/ }),
  ).not.toBeInTheDocument()
  expect(screen.getAllByRole('button')).toHaveLength(1)
})

it.each([
  [1, 'Clear completed (1)'],
  [4, 'Clear completed (4)'],
])(
  'shows the clear completed button with a count of %s',
  (completedCount, name) => {
    render(
      <TodosHeader
        disabled={false}
        completedCount={completedCount}
        onCreate={vi.fn()}
        onClearCompleted={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name })).toBeVisible()
  },
)

it('invokes clearing without creating when the clear button is clicked', async () => {
  const user = userEvent.setup()
  const onCreate = vi.fn()
  const onClearCompleted = vi.fn()
  render(
    <TodosHeader
      disabled={false}
      completedCount={2}
      onCreate={onCreate}
      onClearCompleted={onClearCompleted}
    />,
  )
  await user.click(screen.getByRole('button', { name: 'Clear completed (2)' }))
  expect(onClearCompleted).toHaveBeenCalledTimes(1)
  expect(onCreate).not.toHaveBeenCalled()
})

it('disables the clear completed button when the header is disabled', async () => {
  const user = userEvent.setup()
  const onClearCompleted = vi.fn()
  render(
    <TodosHeader
      disabled
      completedCount={2}
      onCreate={vi.fn()}
      onClearCompleted={onClearCompleted}
    />,
  )
  const button = screen.getByRole('button', { name: 'Clear completed (2)' })
  expect(button).toBeDisabled()
  await user.click(button)
  expect(onClearCompleted).not.toHaveBeenCalled()
})
