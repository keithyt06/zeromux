import { vi } from 'vitest'

const fitSpy = vi.hoisted(() => ({ calls: 0 }))

vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 80; rows = 24; options: Record<string, unknown> = {}; modes = { bracketedPasteMode: false }
  buffer = { active: { viewportY: 0, baseY: 0, length: 0 } }
  open() {} loadAddon() {} write() {} reset() {} dispose() {} focus() {} scrollToBottom() {} scrollLines() {}
  onData() { return { dispose() {} } } onBinary() { return { dispose() {} } } onResize() { return { dispose() {} } }
  onScroll() { return { dispose() {} } } onSelectionChange() { return { dispose() {} } }
  attachCustomKeyEventHandler() {} hasSelection() { return false } getSelection() { return '' }
} }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() { fitSpy.calls++ } proposeDimensions() { return { cols: 80, rows: 24 } } dispose() {} } }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { onContextLoss() { return { dispose() {} } } dispose() {} } }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class { findNext() {} findPrevious() {} dispose() {} } }))
vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: class { dispose() {} } }))

import { render, screen, act, fireEvent } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import TerminalView from '../TerminalView'
import { installFakeWebSocket } from '../../test/fakeWs'

// Force touch environment: TerminalView decides isTouch via matchMedia('(any-pointer: coarse)')
// / maxTouchPoints (TerminalView.tsx:131-135).
function forceTouch() {
  Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true })
  window.matchMedia = ((q: string) => ({
    matches: q.includes('coarse'), media: q, addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

describe('TerminalView mobile bottom layout', () => {
  const origWs = (globalThis as unknown as { WebSocket?: unknown }).WebSocket
  beforeEach(() => {
    vi.restoreAllMocks()
    installFakeWebSocket()
    forceTouch()
    localStorage.removeItem('zmx_keytray')
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
  })
  afterEach(() => { (globalThis as unknown as { WebSocket?: unknown }).WebSocket = origWs })

  it('touch: status bar (work_dir/attach chip) is not rendered', () => {
    render(<TerminalView sessionId="s1" active theme="dark" tmuxName="zmx-abc" tmuxOrigin="own" />)
    expect(screen.queryByText(/⧉ zmx-abc/)).toBeNull()
  })

  it('touch: key bar and composer live in one bottom container', () => {
    render(<TerminalView sessionId="s1" active theme="dark" tmuxName="zmx-abc" tmuxOrigin="own" />)
    const bottom = screen.getByTestId('term-bottom')
    expect(bottom.contains(screen.getByLabelText('up'))).toBe(true)
    expect(bottom.contains(screen.getByPlaceholderText(/输入文字/))).toBe(true)
  })

  it('touch: soft keyboard crossing the 120px threshold triggers one refit (iOS sends no window.resize)', async () => {
    // handleResize skips 0x0 containers; happy-dom reports 0 for layout sizes.
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(390)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
    const listeners: Record<string, () => void> = {}
    const vv = { height: 844, offsetTop: 0,
      addEventListener: (t: string, f: () => void) => { listeners[t] = f },
      removeEventListener: () => {} }
    Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 844, configurable: true })
    render(<TerminalView sessionId="s1" active theme="dark" tmuxName="zmx-abc" tmuxOrigin="own" />)
    await act(async () => { await new Promise(r => setTimeout(r, 120)) })
    
    const before = fitSpy.calls
    vv.height = 500 // keyboard up: overlap 344 > 120
    act(() => { listeners.resize() })
    await act(async () => { await new Promise(r => setTimeout(r, 120)) })
    expect(fitSpy.calls).toBeGreaterThan(before)
    const afterOpen = fitSpy.calls
    vv.height = 480 // still open: no toggle, no extra refit
    act(() => { listeners.resize() })
    await act(async () => { await new Promise(r => setTimeout(r, 120)) })
    expect(fitSpy.calls).toBe(afterOpen)
  })
  it('refits after a close -> open cycle (ConnectionBar height change after onopen measured)', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(390)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
    const ws = installFakeWebSocket()
    render(<TerminalView sessionId="s1" active theme="dark" tmuxName="zmx-abc" tmuxOrigin="own" />)
    act(() => { ws.latest().fireOpen() })
    await act(async () => { await new Promise(r => setTimeout(r, 120)) })
    act(() => { ws.latest().fireClose() })
    await act(async () => { await new Promise(r => setTimeout(r, 1100)) })   // backoff 1s → reconnect
    const before = fitSpy.calls
    act(() => { ws.latest().fireOpen() })
    await act(async () => { await new Promise(r => setTimeout(r, 120)) })
    expect(fitSpy.calls).toBeGreaterThan(before)
  })

  describe('collapsible key tray', () => {
    const view = (extra: { historyRequest?: number } = {}) =>
      <TerminalView sessionId="s1" active theme="dark" tmuxName="zmx-abc" tmuxOrigin="own" {...extra} />
    const settle = () => act(async () => { await new Promise(r => setTimeout(r, 120)) })

    it('collapse hides the keys, shows 「⌃ 键栏」 in the composer row, persists across remount', () => {
      const { unmount } = render(view())
      fireEvent.click(screen.getByLabelText('收起键栏'))
      expect(screen.queryByLabelText('up')).toBeNull()
      const pill = screen.getByRole('button', { name: /键栏/ })
      expect(pill.getAttribute('aria-expanded')).toBe('false')
      expect(screen.getByTestId('term-composer-row').contains(pill)).toBe(true)
      expect(localStorage.getItem('zmx_keytray')).toBe('1')
      unmount()
      render(view())
      expect(screen.queryByLabelText('up')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: /键栏/ }))
      expect(screen.getByLabelText('up')).toBeInTheDocument()
      expect(screen.getByLabelText('收起键栏').getAttribute('aria-expanded')).toBe('true')
      expect(localStorage.getItem('zmx_keytray')).toBe('0')
    })

    it('collapse triggers exactly one refit and at most one resize frame', async () => {
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(390)
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
      const ws = installFakeWebSocket()
      render(view())
      act(() => { ws.latest().fireOpen() })
      await settle()
      const fits = fitSpy.calls
      const sent = ws.latest().sent.length
      fireEvent.click(screen.getByLabelText('收起键栏'))
      await settle()
      expect(fitSpy.calls - fits).toBe(1)
      const resizes = ws.latest().sent.slice(sent).filter(f => JSON.parse(f).type === 'resize')
      expect(resizes.length).toBeLessThanOrEqual(1)
    })

    it('soft keyboard opening while collapsed does not auto-expand', async () => {
      localStorage.setItem('zmx_keytray', '1')
      const listeners: Record<string, () => void> = {}
      const vv = { height: 844, offsetTop: 0,
        addEventListener: (t: string, f: () => void) => { listeners[t] = f },
        removeEventListener: () => {} }
      Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true })
      Object.defineProperty(window, 'innerHeight', { value: 844, configurable: true })
      render(view())
      vv.height = 500
      act(() => { listeners.resize() })
      await settle()
      expect(screen.queryByLabelText('up')).toBeNull()
      expect(screen.getByRole('button', { name: /键栏/ }).getAttribute('aria-expanded')).toBe('false')
    })

    it('opening then closing history keeps the tray collapsed', async () => {
      localStorage.setItem('zmx_keytray', '1')
      const { rerender } = render(view())
      rerender(view({ historyRequest: 1 }))
      await settle()
      fireEvent.click(screen.getByLabelText('关闭历史'))
      expect(screen.queryByLabelText('up')).toBeNull()
      expect(screen.getByRole('button', { name: /键栏/ }).getAttribute('aria-expanded')).toBe('false')
    })
  })
})

