import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { QueueChip } from '../QueueChip'
import AcpChatView from '../../AcpChatView'
import { installFakeWebSocket } from '../../../test/fakeWs'

// Ported from SessionInfoBar.queuemode.test (review 2026-07-28, F-OBS-LIVE): the
// visible queue control must be a CONTROLLED reflection of the backend-authoritative
// mode, never a local guess — an observer/reconnected tab showing 'Collect' while the
// backend is 'Interrupt' makes a send silently interrupt the running turn (I-6).
describe('QueueChip', () => {
  it('shows Collect and one tap calls onToggle once (§0.5.7-2: queue-mode switch = 1 tap)', () => {
    const onToggle = vi.fn()
    render(<QueueChip mode="collect" busy={false} onToggle={onToggle} />)
    const chip = screen.getByRole('button', { name: '队列模式 Collect' })
    expect(chip).toHaveTextContent('Collect')
    fireEvent.click(chip)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('is a CONTROLLED reflection of the mode prop: a tap does not locally override it', () => {
    const onToggle = vi.fn()
    const { rerender } = render(<QueueChip mode="collect" busy={false} onToggle={onToggle} />)
    fireEvent.click(screen.getByRole('button', { name: /队列模式/ }))
    // Not delivered yet (parent prop unchanged) → still the authoritative value.
    expect(screen.getByRole('button', { name: /队列模式/ })).toHaveTextContent('Collect')
    // Parent adopts the delivered mode → the chip follows.
    rerender(<QueueChip mode="interrupt" busy={false} onToggle={onToggle} />)
    expect(screen.getByRole('button', { name: /队列模式/ })).toHaveTextContent('Interrupt')
  })

  it('interrupt + busy: chip is hot and shows 将打断; idle interrupt is not hot', () => {
    const { rerender } = render(<QueueChip mode="interrupt" busy onToggle={() => {}} />)
    expect(screen.getByRole('button', { name: /队列模式/ })).toHaveAttribute('data-hot', '1')
    expect(screen.getByText('将打断')).toBeInTheDocument()
    rerender(<QueueChip mode="interrupt" busy={false} onToggle={() => {}} />)
    expect(screen.getByRole('button', { name: /队列模式/ })).not.toHaveAttribute('data-hot')
    expect(screen.queryByText('将打断')).toBeNull()
  })
})

describe('QueueChip in AcpChatView', () => {
  const origWs = (globalThis as unknown as { WebSocket?: unknown }).WebSocket
  let ws: ReturnType<typeof installFakeWebSocket>
  beforeEach(() => {
    vi.restoreAllMocks()
    ws = installFakeWebSocket()
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
  })
  afterEach(() => { (globalThis as unknown as { WebSocket?: unknown }).WebSocket = origWs })

  it('shows the queueMode prop (not a guess), flips through setQueueMode, and reports up only on delivery', () => {
    const onQueueModeChange = vi.fn()
    const { rerender } = render(<AcpChatView sessionId="s1" active agentType="claude" queueMode="interrupt" onQueueModeChange={onQueueModeChange} />)
    const sock = ws.latest()
    act(() => { sock.fireOpen() })
    fireEvent.click(screen.getByRole('button', { name: '队列模式 Interrupt' }))
    expect(sock.sent.map(s => JSON.parse(s))).toContainEqual({ type: 'set_queue_mode', mode: 'collect' })
    expect(onQueueModeChange).toHaveBeenCalledWith('s1', 'collect')
    // Until the shell feeds the adopted mode back, the chip keeps showing the prop.
    expect(screen.getByRole('button', { name: /队列模式/ })).toHaveTextContent('Interrupt')
    rerender(<AcpChatView sessionId="s1" active agentType="claude" queueMode="collect" onQueueModeChange={onQueueModeChange} />)
    expect(screen.getByRole('button', { name: /队列模式/ })).toHaveTextContent('Collect')
  })

  it('a flip on a closed socket is not delivered, so nothing is reported up', () => {
    const onQueueModeChange = vi.fn()
    render(<AcpChatView sessionId="s1" active agentType="claude" queueMode="collect" onQueueModeChange={onQueueModeChange} />)
    const sock = ws.latest()
    sock.readyState = 3
    fireEvent.click(screen.getByRole('button', { name: '队列模式 Collect' }))
    expect(sock.sent.some(s => s.includes('set_queue_mode'))).toBe(false)
    expect(onQueueModeChange).not.toHaveBeenCalledWith('s1', 'interrupt')
  })

  it('V9: the send button looks the same in collect and in busy interrupt mode', () => {
    const cls = (mode: string) => {
      const u = render(<AcpChatView sessionId="s1" active agentType="claude" queueMode={mode} />)
      const sock = ws.latest()
      act(() => { sock.fireOpen() })
      act(() => { sock.emit({ type: 'content_block', block_type: 'text', text: 'working', turn_id: 1 }) })
      expect(screen.getByRole('button', { name: /队列模式/ }).getAttribute('data-hot')).toBe(mode === 'interrupt' ? '1' : null)
      fireEvent.change(screen.getByPlaceholderText(/Send a message/), { target: { value: 'x' } })
      const c = screen.getByLabelText('send').className
      u.unmount()
      return c
    }
    const collect = cls('collect')
    const interrupt = cls('interrupt')
    expect(interrupt).toBe(collect)
  })

  it('send button is 36px (V8)', () => {
    render(<AcpChatView sessionId="s1" active agentType="claude" />)
    expect(screen.getByLabelText('send').className).toMatch(/\bw-9 h-9\b/)
  })
})
