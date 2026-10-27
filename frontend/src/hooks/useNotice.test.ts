import { renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import { useNotice } from './useNotice'
import { act } from '@testing-library/react'
import { afterEach, beforeEach, describe, vi } from 'vitest'

it('starts without a notice and exposes a notification callback', () => {
  const { result } = renderHook(() => useNotice())
  expect(result.current.message).toBe('')
  expect(result.current.notify).toEqual(expect.any(Function))
})

describe('with fake timers', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('shows a notified message until it expires after 4 seconds', () => {
    const { result } = renderHook(() => useNotice())
    act(() => result.current.notify('Task deleted.'))
    expect(result.current.message).toBe('Task deleted.')
    act(() => vi.advanceTimersByTime(3999))
    expect(result.current.message).toBe('Task deleted.')
    act(() => vi.advanceTimersByTime(1))
    expect(result.current.message).toBe('')
  })

  it('restarts the 4 second timer when a new notice arrives', () => {
    const { result } = renderHook(() => useNotice())
    act(() => result.current.notify('First notice'))
    act(() => vi.advanceTimersByTime(3000))
    act(() => result.current.notify('Second notice'))
    act(() => vi.advanceTimersByTime(3999))
    expect(result.current.message).toBe('Second notice')
    act(() => vi.advanceTimersByTime(1))
    expect(result.current.message).toBe('')
  })

  it('restarts the timer when the same message is notified again', () => {
    const { result } = renderHook(() => useNotice())
    act(() => result.current.notify('Task deleted.'))
    act(() => vi.advanceTimersByTime(3000))
    act(() => result.current.notify('Task deleted.'))
    act(() => vi.advanceTimersByTime(3000))
    expect(result.current.message).toBe('Task deleted.')
    act(() => vi.advanceTimersByTime(1000))
    expect(result.current.message).toBe('')
  })

  it('keeps the same notify callback across renders', () => {
    const { result, rerender } = renderHook(() => useNotice())
    const first = result.current.notify
    act(() => result.current.notify('Saved'))
    rerender()
    expect(result.current.notify).toBe(first)
  })

  it('cancels the pending expiry timer on unmount', () => {
    const { result, unmount } = renderHook(() => useNotice())
    act(() => result.current.notify('Saved'))
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
