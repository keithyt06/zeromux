import { vi } from 'vitest'
vi.mock('@xterm/xterm', async () => (await import('../../test/xtermMock')).xtermModule)
vi.mock('@xterm/addon-fit', async () => (await import('../../test/xtermMock')).fitModule)
vi.mock('@xterm/addon-webgl', async () => (await import('../../test/xtermMock')).webglModule)
vi.mock('@xterm/addon-search', async () => (await import('../../test/xtermMock')).searchModule)
vi.mock('@xterm/addon-clipboard', async () => (await import('../../test/xtermMock')).clipboardModule)

import { render, screen, act } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import TerminalView from '../TerminalView'
import { installFakeWebSocket } from '../../test/fakeWs'
import { lastTerminal, fitDims } from '../../test/xtermMock'

// Characterization of TerminalView's WS lifecycle as it is today (S4 Task 1).
// happy-dom reports 0×0 for every element; give only the xterm container a real
// size so the resize gate (shouldSendResize) is decided by `active` alone.
function sizeContainers(w = 800, h = 600) {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return this.classList?.contains('xterm-container') ? w : 0 } })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return this.classList?.contains('xterm-container') ? h : 0 } })
}
function unsizeContainers() {
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight
}
const msgs = (s: { sent: string[] }) => s.sent.map(x => JSON.parse(x))
const inputs = (s: { sent: string[] }) => msgs(s).filter(m => m.type === 'input')
const resizes = (s: { sent: string[] }) => msgs(s).filter(m => m.type === 'resize')

describe('TerminalView WS characterization', () => {
  const origWs = (globalThis as unknown as { WebSocket?: unknown }).WebSocket
  let ws: ReturnType<typeof installFakeWebSocket>
  beforeEach(() => {
    vi.restoreAllMocks()
    // Plain fake timers: shouldAdvanceTime leaks wall time into the ±10ms backoff
    // windows and flakes under a loaded full-suite run.
    vi.useFakeTimers()
    ws = installFakeWebSocket({ startConnecting: true })
    sizeContainers()
    fitDims.cols = 80; fitDims.rows = 24
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
  })
  afterEach(() => {
    vi.useRealTimers()
    unsizeContainers()
    ;(globalThis as unknown as { WebSocket?: unknown }).WebSocket = origWs
  })

  const mount = (p: Partial<React.ComponentProps<typeof TerminalView>> = {}) =>
    render(<TerminalView sessionId="t1" active theme="dark" tmuxName="zmx-t1" tmuxOrigin="own" {...p} />)

  it('I-5: every open resets the terminal before replay', async () => {
    mount()
    act(() => { ws.latest().fireOpen() })
    expect(lastTerminal().calls.reset).toBe(1)
    act(() => { ws.latest().fireClose() })
    await act(async () => { vi.advanceTimersByTime(1010) })
    act(() => { ws.latest().fireOpen() })
    expect(lastTerminal().calls.reset).toBe(2)
  })

  it('I-12: onopen sends exactly one resize when active; none when hidden', () => {
    mount()
    const s1 = ws.latest()
    act(() => { s1.fireOpen() })
    expect(resizes(s1)).toEqual([{ type: 'resize', cols: 80, rows: 24 }])
    const h = mount({ sessionId: 't2', active: false })
    const s2 = ws.latest()
    expect(s2).not.toBe(s1)
    act(() => { s2.fireOpen() })
    expect(resizes(s2)).toEqual([])
    h.unmount()
  })

  it('I-12: becoming active re-sends the real size even if unchanged', async () => {
    const r = mount({ active: false })
    const s = ws.latest()
    act(() => { s.fireOpen() })
    await act(async () => { vi.advanceTimersByTime(60) })
    expect(resizes(s)).toEqual([])
    r.rerender(<TerminalView sessionId="t1" active theme="dark" tmuxName="zmx-t1" tmuxOrigin="own" />)
    await act(async () => { vi.advanceTimersByTime(60) })
    expect(resizes(s)).toEqual([{ type: 'resize', cols: 80, rows: 24 }])
  })

  it('I-13: typed data is sent only while OPEN', () => {
    mount()
    const s = ws.latest()
    act(() => { lastTerminal().dataHandlers.forEach(h => h('a')) })
    expect(inputs(s)).toHaveLength(0)            // CONNECTING
    act(() => { s.fireOpen() })
    act(() => { lastTerminal().dataHandlers.forEach(h => h('b')) })
    expect(inputs(s)).toHaveLength(1)
    act(() => { s.fireClose() })
    act(() => { lastTerminal().dataHandlers.forEach(h => h('c')) })
    expect(inputs(s)).toHaveLength(1)            // CLOSED
  })

  it('I-4: backoff 1s,2s,4s,8s,10s,10s; resets after 3s stable', async () => {
    mount()
    for (const d of [1000, 2000, 4000, 8000, 10000, 10000]) {
      act(() => { ws.latest().fireClose() })
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

  it('I-4: an open that closes before 3s does not reset backoff (accept-then-close loop)', async () => {
    mount()
    act(() => { ws.latest().fireOpen() })
    await act(async () => { vi.advanceTimersByTime(100) })
    act(() => { ws.latest().fireClose() })          // attempt 0 → 1s
    await act(async () => { vi.advanceTimersByTime(1010) })
    act(() => { ws.latest().fireOpen() })
    await act(async () => { vi.advanceTimersByTime(100) })
    act(() => { ws.latest().fireClose() })          // not stable → still escalates to 2s
    const n = ws.all.length
    await act(async () => { vi.advanceTimersByTime(1990) })
    expect(ws.all.length).toBe(n)
    await act(async () => { vi.advanceTimersByTime(20) })
    expect(ws.all.length).toBe(n + 1)
  })

  it('tmux_ended: shows the ended overlay and never reconnects', async () => {
    mount()
    const s = ws.latest()
    act(() => { s.fireOpen() })
    act(() => { s.emit({ type: 'notice', kind: 'tmux_ended' }) })
    act(() => { s.fireClose() })
    expect(screen.getByText('tmux 会话已结束')).toBeInTheDocument()
    const n = ws.all.length
    await act(async () => { vi.advanceTimersByTime(20000) })
    expect(ws.all.length).toBe(n)
  })

  it('B14: a late onclose from the old socket must not orphan the new one', async () => {
    mount()
    const s1 = ws.latest()
    act(() => { s1.fireOpen() })
    // s1 drops; its onclose schedules a reconnect and nulls wsRef.
    act(() => { s1.fireClose() })
    await act(async () => { vi.advanceTimersByTime(1010) })
    const s2 = ws.latest()
    expect(s2).not.toBe(s1)
    act(() => { s2.fireOpen() })
    // A duplicate/late close event for s1 arrives after s2 is live (not
    // reachable under browser semantics — defensive).
    act(() => { s1.onclose?.() })
    act(() => { lastTerminal().dataHandlers.forEach(h => h('x')) })
    expect(inputs(s2)).toHaveLength(1)
  })

  it('connection bar appears after a drop', async () => {
    mount()
    const s = ws.latest()
    act(() => { s.fireOpen() })
    act(() => { s.fireClose() })
    await act(async () => { vi.advanceTimersByTime(1600) })
    expect(screen.getByText('连接断开,正在重连…')).toBeInTheDocument()
  })

  // S4 Task 1b: copy-mode / pill state machine across onBinary and reconnect.
  const scrollFrames = (s: { sent: string[] }) => msgs(s).filter(m => m.type === 'scroll' || m.type === 'input')

  it('onBinary while the copy-mode pill is shown sends scroll cancel before the input', () => {
    mount()
    const s = ws.latest()
    act(() => { s.fireOpen() })
    act(() => { s.emit({ type: 'scroll_state', in_mode: true }) })
    expect(screen.getByLabelText('scroll-bottom')).toBeInTheDocument()
    act(() => { lastTerminal().binaryHandlers.forEach(h => h('\x1b[M ')) })
    const f = scrollFrames(s)
    expect(f.map(m => m.type)).toEqual(['scroll', 'input'])
    expect(f[0]).toEqual({ type: 'scroll', op: 'cancel', n: 1 })
    expect(screen.queryByLabelText('scroll-bottom')).toBeNull()
  })

  it('reconnect while the pill is shown clears the pill and cancels copy-mode on the new socket', async () => {
    mount()
    const s1 = ws.latest()
    act(() => { s1.fireOpen() })
    act(() => { s1.emit({ type: 'scroll_state', in_mode: true, new_lines: 3 }) })
    expect(screen.getByLabelText('scroll-bottom')).toHaveTextContent('3 行新输出')
    act(() => { s1.fireClose() })
    await act(async () => { vi.advanceTimersByTime(1010) })
    const s2 = ws.latest()
    expect(s2).not.toBe(s1)
    act(() => { s2.fireOpen() })
    expect(screen.queryByLabelText('scroll-top')).toBeNull()
    expect(screen.queryByLabelText('scroll-bottom')).toBeNull()
    const m2 = msgs(s2)
    expect(m2.filter(m => m.type === 'scroll')).toEqual([{ type: 'scroll', op: 'cancel', n: 1 }])
    // The cancel follows the first resize on the new socket.
    expect(m2.findIndex(m => m.type === 'scroll')).toBeGreaterThan(m2.findIndex(m => m.type === 'resize'))
    expect(m2.filter(m => m.type === 'scroll_watch')).toEqual([{ type: 'scroll_watch', on: false }])
    // Next keystroke goes straight to input: no second cancel.
    act(() => { lastTerminal().dataHandlers.forEach(h => h('a')) })
    expect(scrollFrames(s2).map(m => m.type)).toEqual(['scroll', 'input'])
  })

  it('reconnect while not scrolling sends no scroll cancel', async () => {
    mount()
    const s1 = ws.latest()
    act(() => { s1.fireOpen() })
    act(() => { s1.fireClose() })
    await act(async () => { vi.advanceTimersByTime(1010) })
    const s2 = ws.latest()
    act(() => { s2.fireOpen() })
    expect(msgs(s2).filter(m => m.type === 'scroll' || m.type === 'scroll_watch')).toEqual([])
  })
})
