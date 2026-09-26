import { vi } from 'vitest'

vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 80; rows = 24; options: Record<string, unknown> = {}; modes = { bracketedPasteMode: false }
  buffer = { active: { viewportY: 0, baseY: 0, length: 0 } }
  open() {} loadAddon() {} write() {} reset() {} dispose() {} focus() {} scrollToBottom() {} scrollLines() {}
  onData() { return { dispose() {} } } onBinary() { return { dispose() {} } } onResize() { return { dispose() {} } }
  onScroll() { return { dispose() {} } } onSelectionChange() { return { dispose() {} } }
  attachCustomKeyEventHandler() {} hasSelection() { return false } getSelection() { return '' }
} }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} proposeDimensions() { return { cols: 80, rows: 24 } } dispose() {} } }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { onContextLoss() { return { dispose() {} } } dispose() {} } }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class { findNext() {} findPrevious() {} dispose() {} } }))
vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: class { dispose() {} } }))

import { render, screen } from '@testing-library/react'
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
})
