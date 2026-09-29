import { vi } from 'vitest'
vi.mock('@xterm/xterm', async () => (await import('../../test/xtermMock')).xtermModule)
vi.mock('@xterm/addon-fit', async () => (await import('../../test/xtermMock')).fitModule)
vi.mock('@xterm/addon-webgl', async () => (await import('../../test/xtermMock')).webglModule)
vi.mock('@xterm/addon-search', async () => (await import('../../test/xtermMock')).searchModule)
vi.mock('@xterm/addon-clipboard', async () => (await import('../../test/xtermMock')).clipboardModule)

import { render, act } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import TerminalView from '../TerminalView'
import { installFakeWebSocket } from '../../test/fakeWs'
import { fitDims } from '../../test/xtermMock'
import * as api from '../../lib/api'

// §4.6 (Task 6): a hidden (inactive) terminal must not poll status/health at
// all; an active one polls getSessionStatus every 10s. getTmuxHealth moves
// entirely to AppShell (one global 30s poll) — TerminalView must never call
// it itself.
function sizeContainers(w = 800, h = 600) {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return this.classList?.contains('xterm-container') ? w : 0 } })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return this.classList?.contains('xterm-container') ? h : 0 } })
}
function unsizeContainers() {
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight
}

describe('TerminalView status polling (§4.6)', () => {
  const origWs = (globalThis as unknown as { WebSocket?: unknown }).WebSocket
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useFakeTimers()
    installFakeWebSocket({ startConnecting: true })
    sizeContainers()
    fitDims.cols = 80; fitDims.rows = 24
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
  })
  afterEach(() => {
    vi.useRealTimers()
    unsizeContainers()
    ;(globalThis as unknown as { WebSocket?: unknown }).WebSocket = origWs
  })

  it('a hidden terminal never fetches status, and never calls getTmuxHealth itself', async () => {
    const status = vi.spyOn(api, 'getSessionStatus').mockResolvedValue({ work_dir: '/w', git_branch: 'main', git_dirty: 0, is_git: true })
    const health = vi.spyOn(api, 'getTmuxHealth').mockResolvedValue({ server: true, in_unit: true })
    render(<TerminalView sessionId="t1" active={false} theme="dark" tmuxName="zmx-t1" tmuxOrigin="own" />)
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(status).not.toHaveBeenCalled()
    expect(health).not.toHaveBeenCalled()
  })

  it('becoming active fetches status immediately, then every 10s; getTmuxHealth is never called by TerminalView', async () => {
    const status = vi.spyOn(api, 'getSessionStatus').mockResolvedValue({ work_dir: '/w', git_branch: 'main', git_dirty: 0, is_git: true })
    const health = vi.spyOn(api, 'getTmuxHealth').mockResolvedValue({ server: true, in_unit: true })
    const r = render(<TerminalView sessionId="t1" active={false} theme="dark" tmuxName="zmx-t1" tmuxOrigin="own" />)
    r.rerender(<TerminalView sessionId="t1" active theme="dark" tmuxName="zmx-t1" tmuxOrigin="own" />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(status).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(status).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(status).toHaveBeenCalledTimes(3)
    expect(health).not.toHaveBeenCalled()
  })

  it('an active terminal does not fetch status while the document is hidden', async () => {
    const status = vi.spyOn(api, 'getSessionStatus').mockResolvedValue({ work_dir: '/w', git_branch: 'main', git_dirty: 0, is_git: true })
    render(<TerminalView sessionId="t1" active theme="dark" tmuxName="zmx-t1" tmuxOrigin="own" />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(status).toHaveBeenCalledTimes(1)
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(status).toHaveBeenCalledTimes(1)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(status).toHaveBeenCalledTimes(2)
  })

  it('a tmuxHealth prop seeds the TmuxHealthBar, and a later unhealthy prop still shows it', async () => {
    vi.spyOn(api, 'getSessionStatus').mockResolvedValue({ work_dir: '/w', git_branch: 'main', git_dirty: 0, is_git: true })
    let r!: ReturnType<typeof render>
    await act(async () => { r = render(<TerminalView sessionId="t1" active theme="dark" tmuxName="zmx-t1" tmuxOrigin="own" tmuxHealth={{ server: true, in_unit: true }} />) })
    expect(r.container.querySelector('[role="alert"]')).toBeNull()
    act(() => { r.rerender(<TerminalView sessionId="t1" active theme="dark" tmuxName="zmx-t1" tmuxOrigin="own" tmuxHealth={{ server: false, in_unit: false }} />) })
    expect(r.container.querySelector('[role="alert"]')).not.toBeNull()
  })

  it('a tmux_down WS notice overrides a healthy tmuxHealth prop locally, between polls', async () => {
    vi.spyOn(api, 'getSessionStatus').mockResolvedValue({ work_dir: '/w', git_branch: 'main', git_dirty: 0, is_git: true })
    const ws = installFakeWebSocket({ startConnecting: true })
    let r!: ReturnType<typeof render>
    await act(async () => { r = render(<TerminalView sessionId="t1" active theme="dark" tmuxName="zmx-t1" tmuxOrigin="own" tmuxHealth={{ server: true, in_unit: true }} />) })
    act(() => { ws.latest().fireOpen() })
    expect(r.container.querySelector('[role="alert"]')).toBeNull()
    act(() => { ws.latest().emit({ type: 'notice', kind: 'tmux_down' }) })
    expect(r.container.querySelector('[role="alert"]')).not.toBeNull()
  })
})
