import { vi } from 'vitest'
vi.mock('@xterm/xterm', async () => (await import('../../test/xtermMock')).xtermModule)
vi.mock('@xterm/addon-fit', async () => (await import('../../test/xtermMock')).fitModule)
vi.mock('@xterm/addon-webgl', async () => (await import('../../test/xtermMock')).webglModule)
vi.mock('@xterm/addon-search', async () => (await import('../../test/xtermMock')).searchModule)
vi.mock('@xterm/addon-clipboard', async () => (await import('../../test/xtermMock')).clipboardModule)

import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import TerminalView from '../TerminalView'
import { Toaster, DialogHost, toast } from '../ui'
import { installFakeWebSocket } from '../../test/fakeWs'
import { lastTerminal, selection } from '../../test/xtermMock'
import { mkSession } from '../../test/appHarness'
import { historyPrompt } from '../../lib/historyToAgent'
import type { SessionControls } from '../../lib/sessionControls'
import type { SendToProps } from '../SendToMenu'
import * as api from '../../lib/api'

// Task 5 (M25/V6): terminal output reaches an agent only through SendToMenu.
// Desktop: an xterm selection shows a floating 「发给…」 button → menu → ★ Enter.
describe('TerminalView → SendToMenu', () => {
  const origWs = (globalThis as unknown as { WebSocket?: unknown }).WebSocket
  beforeEach(() => {
    vi.restoreAllMocks()
    installFakeWebSocket({ startConnecting: true })
    selection.has = false; selection.text = ''
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
    vi.spyOn(api, 'getSessionStatus').mockResolvedValue({ work_dir: '/status/dir', git_branch: 'main', git_dirty: 0, is_git: true })
  })
  afterEach(() => {
    ;(globalThis as unknown as { WebSocket?: unknown }).WebSocket = origWs
    selection.has = false; selection.text = ''
    act(() => { document.querySelectorAll('[data-toast-id]').forEach(el => toast.dismiss(el.getAttribute('data-toast-id')!)) })
  })

  async function setup() {
    const sendPrompt = vi.fn(() => true)
    const ctl = { setQueueMode: vi.fn(), sendPrompt, interrupt: vi.fn(), resolveApproval: vi.fn(), pendingApprovals: () => [] } as unknown as SessionControls
    const sendTo: SendToProps = {
      workDir: '/w/repo', excludeId: 't1', sessions: [mkSession('a', { name: 'fe', work_dir: '/w/repo' })],
      controls: { current: { a: ctl } }, queueModes: {}, onSelectSession: vi.fn(), onNew: vi.fn(),
    }
    render(<><TerminalView sessionId="t1" active theme="dark" tmuxName="zmx-t1" tmuxOrigin="own" sendTo={sendTo} /><Toaster /><DialogHost /></>)
    await act(async () => {})   // settle the mount-time status fetch
    const select = (has: boolean, text = '') => act(() => {
      selection.has = has; selection.text = text
      lastTerminal().selectionHandlers.forEach(h => h())
    })
    return { sendPrompt, sendTo, select }
  }
  const floatBtn = () => screen.queryByRole('button', { name: '发给…' })

  it('a selection shows the floating 「发给…」 button; clearing it hides the button', async () => {
    const { select } = await setup()
    expect(floatBtn()).toBeNull()
    select(true, 'err line')
    expect(floatBtn()).toBeInTheDocument()
    expect(floatBtn()!.className).toContain('min-h-[var(--hit)]')
    select(false)
    expect(floatBtn()).toBeNull()
  })

  it('whitespace-only selection shows nothing', async () => {
    const { select } = await setup()
    select(true, '   ')
    expect(floatBtn()).toBeNull()
  })

  it('click → menu, ★ Enter → sendPrompt(historyPrompt(selection)) with SessionInfo.work_dir', async () => {
    const { select, sendPrompt } = await setup()
    select(true, 'err line')
    fireEvent.click(floatBtn()!)
    const items = screen.getAllByRole('menuitem')
    expect(items[0]).toHaveTextContent('★ fe')
    fireEvent.keyDown(items[0], { key: 'Enter' })
    expect(sendPrompt).toHaveBeenCalledWith(historyPrompt({ name: 'zmx-t1', workDir: '/w/repo', text: 'err line' }), { withAttachments: false })
  })

  it('the menu text is captured at click time, not re-read from a later selection', async () => {
    const { select, sendPrompt } = await setup()
    select(true, 'first')
    fireEvent.click(floatBtn()!)
    selection.text = 'second'
    fireEvent.click(screen.getByRole('menuitem', { name: '发给 fe' }))
    expect(sendPrompt).toHaveBeenCalledWith(historyPrompt({ name: 'zmx-t1', workDir: '/w/repo', text: 'first' }), { withAttachments: false })
  })

  it('＋ 新开… hands the full multi-line prompt to onNew', async () => {
    const { select, sendTo } = await setup()
    select(true, 'a\nb\n  c')
    fireEvent.click(floatBtn()!)
    fireEvent.click(screen.getByText('＋ 新开…'))
    expect(sendTo.onNew).toHaveBeenCalledWith({ workDir: '/w/repo', prompt: historyPrompt({ name: 'zmx-t1', workDir: '/w/repo', text: 'a\nb\n  c' }) })
  })

  it('history drawer wraps with SessionInfo.work_dir (not the polled status)', async () => {
    vi.spyOn(api, 'getHistory').mockResolvedValue({ text: 'h1', truncated: false })
    const { sendTo } = await setup()
    expect(api.getSessionStatus).toHaveBeenCalled()
    fireEvent.click(screen.getByText('历史'))
    await waitFor(() => expect(screen.getByText('h1')).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText('选择发送目标'))
    fireEvent.click(screen.getByText('＋ 新开…'))
    expect(sendTo.onNew).toHaveBeenCalledWith({ workDir: '/w/repo', prompt: historyPrompt({ name: 'zmx-t1', workDir: '/w/repo', text: 'h1' }) })
  })

  it('touch devices never get the floating selection button (phones use the history drawer)', async () => {
    const mt = Object.getOwnPropertyDescriptor(Navigator.prototype, 'maxTouchPoints') ?? Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints')
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, get: () => 5 })
    try {
      const { select } = await setup()
      select(true, 'err line')
      expect(floatBtn()).toBeNull()
    } finally {
      if (mt) Object.defineProperty(navigator, 'maxTouchPoints', mt)
      else delete (navigator as unknown as Record<string, unknown>).maxTouchPoints
    }
  })

  it('without sendTo there is no floating button', async () => {
    render(<TerminalView sessionId="t1" active theme="dark" tmuxName="zmx-t1" tmuxOrigin="own" />)
    await act(async () => {})
    act(() => { selection.has = true; selection.text = 'x'; lastTerminal().selectionHandlers.forEach(h => h()) })
    expect(floatBtn()).toBeNull()
  })
})
