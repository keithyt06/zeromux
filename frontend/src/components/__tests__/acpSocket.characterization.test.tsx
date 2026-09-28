import { render, screen, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import AcpChatView from '../AcpChatView'
import { installFakeWebSocket } from '../../test/fakeWs'
import type { SessionControls } from '../../lib/sessionControls'

describe('AcpChatView WS characterization (spec S3 §3.1)', () => {
  const origWs = (globalThis as unknown as { WebSocket?: unknown }).WebSocket
  let ws: ReturnType<typeof installFakeWebSocket>
  let controls: SessionControls | null = null
  const reg = (_: string, api: SessionControls | null) => { controls = api }
  const mount = (extra: Record<string, unknown> = {}) =>
    render(<AcpChatView sessionId="s1" active agentType="claude" onRegisterControls={reg} {...extra} />)

  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    ws = installFakeWebSocket({ startConnecting: true })
    controls = null
    globalThis.fetch = vi.fn(async () => new Response('{"runs":[],"lifetime":{"turns":0,"duration_ms":0,"cost_usd":0}}', { status: 200 })) as unknown as typeof fetch
  })
  afterEach(() => { vi.useRealTimers(); (globalThis as unknown as { WebSocket?: unknown }).WebSocket = origWs })

  it('1. onopen clears transcript, notices and busy (I-5)', () => {
    mount()
    const s = ws.latest()
    act(() => { s.fireOpen() })
    act(() => { s.emit({ type: 'content_block', block_type: 'text', text: 'old reply', turn_id: 1 }) })
    act(() => { s.emit({ type: 'error', message: 'boom' }) })
    expect(screen.getByText('old reply')).toBeInTheDocument()
    act(() => { s.fireOpen() })   // reconnect → server will replay
    expect(screen.queryByText('old reply')).toBeNull()
    expect(screen.queryByText('boom')).toBeNull()
    expect(screen.queryByText('中断')).toBeNull()
  })

  it('2. replay_done adopts backend running + queue_mode + silence baseline (I-5/I-6/I-7)', () => {
    const onQ = vi.fn()
    mount({ onQueueModeChange: onQ })
    const s = ws.latest()
    act(() => { s.fireOpen() })
    act(() => { s.emit({ type: 'replay_done', running: true, queue_mode: 'interrupt', last_activity_ms: Date.now() - 200_000 }) })
    expect(onQ).toHaveBeenCalledWith('s1', 'interrupt')
    expect(screen.getByText('中断')).toBeInTheDocument()
    expect(screen.getByText(/已静默 \d+s，可能卡住/)).toBeInTheDocument()
  })

  it('2b. brand-new session: no replay_done is ever sent (ws_handler.rs:120) — sending still works', () => {
    mount()
    const s = ws.latest()
    expect(s.readyState).toBe(0)
    let r = true
    act(() => { r = controls!.sendPrompt('early') })
    expect(r).toBe(false)                    // CONNECTING is not OPEN
    act(() => { s.fireOpen() })
    act(() => { r = controls!.sendPrompt('hi') })
    expect(r).toBe(true)
    expect(screen.getByText('中断')).toBeInTheDocument()
  })

  it('3. optimistic bubble is re-slotted by client_id on echo, not duplicated (I-10)', () => {
    mount()
    const s = ws.latest()
    act(() => { s.fireOpen() })
    act(() => { controls!.sendPrompt('hello there') })
    const sent = JSON.parse(s.sent.find(x => x.includes('"prompt"'))!)
    act(() => { s.emit({ type: 'user_prompt', text: 'hello there', turn_id: 7, client_id: sent.client_id }) })
    expect(screen.getAllByText('hello there')).toHaveLength(1)
  })

  it('4. reconnect backoff 1s,2s,4s,8s,10s,10s and resets after 3s stable (I-4)', async () => {
    // Pure fake clock: with shouldAdvanceTime real wall time leaks into the ±10ms
    // windows below and the case flakes under full-suite load. (useFakeTimers is a
    // no-op while already faking, so reinstall.)
    vi.useRealTimers()
    vi.useFakeTimers()
    mount()
    const delays = [1000, 2000, 4000, 8000, 10000, 10000]
    for (const d of delays) {
      const s = ws.latest()
      act(() => { s.fireClose() })
      const n = ws.all.length
      await act(async () => { vi.advanceTimersByTime(d - 10) })
      expect(ws.all.length).toBe(n)
      await act(async () => { vi.advanceTimersByTime(20) })
      expect(ws.all.length).toBe(n + 1)
    }
    act(() => { ws.latest().fireOpen() })
    await act(async () => { vi.advanceTimersByTime(3100) })
    act(() => { ws.latest().fireClose() })
    const n = ws.all.length
    await act(async () => { vi.advanceTimersByTime(1010) })
    expect(ws.all.length).toBe(n + 1)
  })

  it('5. sendPrompt returns false while disconnected and sends nothing', () => {
    mount()
    const s = ws.latest()
    act(() => { s.fireOpen() })
    act(() => { s.fireClose() })
    let r = true
    act(() => { r = controls!.sendPrompt('x') })
    expect(r).toBe(false)
    expect(s.sent.filter(x => x.includes('"prompt"'))).toHaveLength(0)
  })

  it('6. ConnectionBar since survives a failed retry', async () => {
    mount()
    const a = ws.latest()
    act(() => { a.fireOpen() })
    act(() => { a.fireClose() })
    await act(async () => { vi.advanceTimersByTime(1000) })
    act(() => { ws.latest().fireClose() })
    await act(async () => { vi.advanceTimersByTime(600) })
    expect(screen.getByText('连接断开,正在重连…')).toBeInTheDocument()
  })

  it('7. interrupt/resolveApproval return false when closed and leave state alone', () => {
    mount({ agentType: 'crew' })
    const s = ws.latest()
    act(() => { s.fireOpen() })
    act(() => { s.emit({ type: 'system', subtype: 'queued', count: 2 }) })
    act(() => { s.emit({ type: 'approval', approval_id: 'ap1', tool: 'rm -rf', tool_purpose: 'cleanup', turn_id: 1 }) })
    act(() => { s.fireClose() })
    let r1 = true, r2 = true
    act(() => { r1 = controls!.interrupt(); r2 = controls!.resolveApproval('ap1', 'approve') })
    expect(r1).toBe(false)
    expect(r2).toBe(false)
    expect(screen.getByText(/已排队 2 条/)).toBeInTheDocument()
    expect(screen.getByTestId('approval-approve')).toBeInTheDocument()
    expect(controls!.pendingApprovals()).toEqual([{ id: 'ap1', tool: 'rm -rf', purpose: 'cleanup' }])
  })

  it('8. open socket: interrupt/resolveApproval send and return true', () => {
    mount({ agentType: 'crew' })
    const s = ws.latest()
    act(() => { s.fireOpen() })
    act(() => { s.emit({ type: 'approval', approval_id: 'ap1', tool: 't', turn_id: 1 }) })
    let r = false
    act(() => { r = controls!.resolveApproval('ap1', 'reject') })
    expect(r).toBe(true)
    expect(s.sent.some(x => x.includes('"approval"') && x.includes('ap1'))).toBe(true)
    expect(controls!.pendingApprovals()).toEqual([])
    act(() => { r = controls!.interrupt() })
    expect(r).toBe(true)
    expect(s.sent.some(x => x.includes('"interrupt"'))).toBe(true)
  })

  it('9. pendingApprovals excludes approvals of a completed turn', () => {
    mount({ agentType: 'crew' })
    const s = ws.latest()
    act(() => { s.fireOpen() })
    act(() => { s.emit({ type: 'approval', approval_id: 'old', tool: 'rm', turn_id: 1 }) })
    act(() => { s.emit({ type: 'result', text: 'done', turn_id: 1 }) })
    act(() => { s.emit({ type: 'approval', approval_id: 'live', tool: 'ls', turn_id: 2 }) })
    expect(controls!.pendingApprovals()).toEqual([{ id: 'live', tool: 'ls' }])
  })
})
