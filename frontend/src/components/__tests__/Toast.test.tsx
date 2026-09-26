import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import Toast from '../Toast'

describe('Toast', () => {
  it('action fires and auto-dismisses after duration', () => {
    vi.useFakeTimers()
    const onAction = vi.fn(), onDone = vi.fn()
    render(<Toast message="已关闭 api" actionLabel="撤销" onAction={onAction} durationMs={5000} onDone={onDone} />)
    fireEvent.click(screen.getByText('撤销'))
    expect(onAction).toHaveBeenCalled()
    expect(onDone).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
  it('times out', () => {
    vi.useFakeTimers()
    const onDone = vi.fn()
    render(<Toast message="m" durationMs={5000} onDone={onDone} />)
    act(() => { vi.advanceTimersByTime(5000) })
    expect(onDone).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
})
