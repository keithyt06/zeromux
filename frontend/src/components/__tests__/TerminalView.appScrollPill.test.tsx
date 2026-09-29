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

// S4 Task 4b: the fullscreen-CLI (AppWheel) pill is a client estimate — it
// collapses when the gesture's net scroll returns to ≤ 0 and degrades to an
// icon-only button after 3s idle. Copy-mode (server-confirmed) is unchanged.
// Row height falls back to FONT_SIZE*1.2 = 16.8px (mock element is 0×0), so a
// drag of 84px = 5 lines.
const RH = 16.8
function touch(el: Element, type: string, y?: number) {
  const ev = new Event(type, { bubbles: true, cancelable: true })
  const touches = y === undefined ? [] : [{ identifier: 0, clientY: y }]
  Object.defineProperty(ev, 'touches', { value: touches })
  act(() => { el.dispatchEvent(ev) })
}
const msgs = (s: { sent: string[] }) => s.sent.map(x => JSON.parse(x))
const scrolls = (s: { sent: string[] }) => msgs(s).filter(m => m.type === 'scroll')

describe('TerminalView fullscreen-CLI scroll pill', () => {
  const origWs = (globalThis as unknown as { WebSocket?: unknown }).WebSocket
  let ws: ReturnType<typeof installFakeWebSocket>
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useFakeTimers()
    ws = installFakeWebSocket({ startConnecting: true })
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
  })
  afterEach(() => {
    vi.useRealTimers()
    ;(globalThis as unknown as { WebSocket?: unknown }).WebSocket = origWs
  })

  function setup() {
    const r = render(<TerminalView sessionId="t1" active theme="dark" tmuxName="zmx-t1" tmuxOrigin="own" />)
    const s = ws.latest()
    act(() => { s.fireOpen() })
    const el = r.container.querySelector('.xterm-container')!
    // Drag `lines` rows: positive = up into history (finger moves down).
    const drag = (lines: number) => {
      touch(el, 'touchstart', 100)
      // Slow drag (no flick inertia): fake timers also drive performance.now.
      act(() => { vi.advanceTimersByTime(1000) })
      touch(el, 'touchmove', 100 + lines * RH)
      touch(el, 'touchend')
      act(() => { vi.advanceTimersByTime(60) })
    }
    const reply = () => act(() => { s.emit({ type: 'scroll_state', in_mode: false, app_scroll: true }) })
    return { s, drag, reply }
  }
  const pill = () => screen.queryByTestId('scroll-pill')

  it('up 5 then down 5 collapses the app pill without sending cancel', () => {
    const { s, drag, reply } = setup()
    drag(5); reply()
    expect(pill()).toHaveAttribute('data-variant', 'app')
    expect(pill()).toHaveAttribute('data-degraded', 'false')
    drag(-5); reply()
    expect(screen.queryByLabelText('scroll-bottom')).toBeNull()
    expect(scrolls(s)).toEqual([{ type: 'scroll', op: 'up', n: 5 }, { type: 'scroll', op: 'down', n: 5 }])
  })

  it('up 5 then down 3 keeps the app pill', () => {
    const { drag, reply } = setup()
    drag(5); reply()
    drag(-3); reply()
    expect(pill()).toHaveAttribute('data-variant', 'app')
  })

  it('a late reply after the net scroll returned to 0 does not reopen the pill', () => {
    const { drag, reply } = setup()
    drag(5)
    drag(-5)
    reply(); reply()
    expect(screen.queryByLabelText('scroll-bottom')).toBeNull()
  })

  it('3s idle degrades to an icon-only ⤓; a new up restores the full pill', () => {
    const { drag, reply } = setup()
    drag(5); reply()
    act(() => { vi.advanceTimersByTime(3000) })
    expect(pill()).toHaveAttribute('data-degraded', 'true')
    expect(screen.getByLabelText('scroll-bottom')).toHaveTextContent('')
    expect(screen.queryByLabelText('scroll-top')).toBeNull()
    drag(2); reply()
    expect(pill()).toHaveAttribute('data-degraded', 'false')
    expect(screen.getByLabelText('scroll-bottom')).toHaveTextContent('回到底部')
  })

  it('copy-mode pill is the solid variant and never degrades or collapses on net scroll', () => {
    const { s, drag } = setup()
    drag(5)
    act(() => { s.emit({ type: 'scroll_state', in_mode: true }) })
    expect(pill()).toHaveAttribute('data-variant', 'copy')
    drag(-5)
    act(() => { s.emit({ type: 'scroll_state', in_mode: true }) })
    act(() => { vi.advanceTimersByTime(5000) })
    expect(pill()).toHaveAttribute('data-variant', 'copy')
    expect(pill()).toHaveAttribute('data-degraded', 'false')
    expect(screen.getByLabelText('scroll-bottom')).toHaveTextContent('回到底部')
  })
})
