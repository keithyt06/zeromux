import { render, screen, act, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import AcpChatView from '../AcpChatView'
import { installFakeWebSocket } from '../../test/fakeWs'

describe('AcpChatView — send while disconnected (B8)', () => {
  const origWs = (globalThis as unknown as { WebSocket?: unknown }).WebSocket
  let ws: ReturnType<typeof installFakeWebSocket>
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    ws = installFakeWebSocket()
    globalThis.fetch = vi.fn(async () => new Response('[]', { status: 200 })) as unknown as typeof fetch
  })
  afterEach(() => {
    vi.useRealTimers()
    ;(globalThis as unknown as { WebSocket?: unknown }).WebSocket = origWs
  })

  it('keeps the typed text, sends nothing, and shows the reconnect bar', async () => {
    render(<AcpChatView sessionId="s1" active agentType="claude" />)
    const sock = ws.latest()
    act(() => { sock.fireOpen() })
    act(() => { sock.fireClose() })       // drop → component schedules a reconnect
    const box = screen.getByPlaceholderText(/Send a message/)
    fireEvent.change(box, { target: { value: 'hello' } })
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 13 })
    expect(sock.sent.filter(s => s.includes('"prompt"'))).toHaveLength(0)
    expect((box as HTMLTextAreaElement).value).toBe('hello')
    expect(screen.queryByText('You')).toBeNull()        // no optimistic user bubble (label at AcpChatView.tsx:1107)
    await act(async () => { vi.advanceTimersByTime(1600) })
    expect(screen.getByText('连接断开,正在重连…')).toBeInTheDocument()
  })

  it('open socket: send clears the box and emits one prompt frame', () => {
    render(<AcpChatView sessionId="s1" active agentType="claude" />)
    const sock = ws.latest()
    act(() => { sock.fireOpen() })
    const box = screen.getByPlaceholderText(/Send a message/)
    fireEvent.change(box, { target: { value: 'hi' } })
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 13 })
    expect(sock.sent.filter(s => s.includes('"prompt"'))).toHaveLength(1)
    expect((box as HTMLTextAreaElement).value).toBe('')
    expect(screen.getByText('You')).toBeInTheDocument()
  })
})
