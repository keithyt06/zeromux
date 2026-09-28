import { render, screen, act, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TurnStatusBar } from '../TurnStatusBar'

describe('TurnStatusBar', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  it('renders nothing when idle and no queue', () => {
    const { container } = render(<TurnStatusBar busy={false} turnStartedMs={null} lastEventMs={null} queuedCount={0} onInterrupt={() => {}} />)
    expect(container.firstChild).toBeNull()
  })
  it('ticks its own elapsed clock and offers 中断', () => {
    const now = Date.now()
    const onI = vi.fn()
    render(<TurnStatusBar busy turnStartedMs={now} lastEventMs={now} queuedCount={0} onInterrupt={onI} />)
    act(() => { vi.advanceTimersByTime(3000) })
    expect(screen.getByText(/运行中 3s/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '中断' }))
    expect(onI).toHaveBeenCalled()
  })
  it('stuck after 180s of silence uses the stuck tone (not danger)', () => {
    const now = Date.now()
    render(<TurnStatusBar busy turnStartedMs={now - 300_000} lastEventMs={now - 200_000} queuedCount={0} onInterrupt={() => {}} />)
    const msg = screen.getByText(/已静默 \d+s，可能卡住/)
    expect(msg.className).toMatch(/--stuck/)
  })
  it('shows the collect queue hint (I-19)', () => {
    render(<TurnStatusBar busy turnStartedMs={Date.now()} lastEventMs={Date.now()} queuedCount={2} onInterrupt={() => {}} />)
    expect(screen.getByText('已排队 2 条，本轮结束后合并发送')).toBeInTheDocument()
  })
})
