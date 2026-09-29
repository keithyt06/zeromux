import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import HistoryView from '../HistoryView'
import { DialogHost, Toaster, toast } from '../ui'
import { UNDO_MS } from '../SendToMenu'
import { mkSession } from '../../test/appHarness'
import type { SessionControls } from '../../lib/sessionControls'
import { chunkLines } from '../../lib/historySearch'
import * as api from '../../lib/api'

describe('chunkLines', () => {
  it('splits into fixed-size line blocks', () => {
    const text = Array.from({ length: 1201 }, (_, i) => `${i + 1}`).join('\n')
    const c = chunkLines(text, 500)
    expect(c.length).toBe(3)
    expect(c[0].split('\n').length).toBe(500)
    expect(c[2].split('\n')[0]).toBe('1001')
    expect(c[2].split('\n').length).toBe(201)
  })
})

function renderSend(o: { ok?: boolean; sessions?: ReturnType<typeof mkSession>[] } = {}) {
  const sendPrompt = vi.fn(() => o.ok ?? true)
  const ctl = { setQueueMode: vi.fn(), sendPrompt, interrupt: vi.fn(), resolveApproval: vi.fn(), pendingApprovals: () => [] } as unknown as SessionControls
  const onNew = vi.fn(), onSelectSession = vi.fn()
  const sessions = o.sessions ?? [mkSession('a', { work_dir: '/w/a' }), mkSession('t', { type: 'tmux', work_dir: '/w/a' })]
  render(<>
    <HistoryView sessionId="s" title="t" onClose={() => {}} wrap={t => `W[${t}]`}
      sendTo={{ workDir: '/w/a', excludeId: 't', sessions, controls: { current: { a: ctl } }, queueModes: {}, onSelectSession, onNew }} />
    <Toaster /><DialogHost />
  </>)
  return { sendPrompt, onNew, onSelectSession }
}

describe('HistoryView', () => {
  beforeEach(() => { vi.restoreAllMocks() })
  afterEach(() => {
    vi.useRealTimers()
    act(() => { document.querySelectorAll('[data-toast-id]').forEach(el => toast.dismiss(el.getAttribute('data-toast-id')!)) })
  })
  it('loads history, shows truncation note, copy-all and close', async () => {
    vi.spyOn(api, 'getHistory').mockResolvedValue({ text: 'line-1\nline-2', truncated: true })
    const writeText = vi.fn().mockResolvedValue(undefined)
    // happy-dom's navigator.clipboard is a getter-only accessor (Clipboard API is
    // spec'd read-only), so a plain Object.assign throws in strict-mode ESM;
    // defineProperty replaces the accessor outright.
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const onClose = vi.fn()
    render(<HistoryView sessionId="s" title="api" onClose={onClose} />)
    await waitFor(() => expect(screen.getByText(/line-2/)).toBeInTheDocument())
    expect(screen.getByText(/仅显示最近/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('复制全部'))
    expect(writeText).toHaveBeenCalledWith('line-1\nline-2')
    fireEvent.click(screen.getByLabelText('关闭历史'))
    expect(onClose).toHaveBeenCalled()
  })
  it('fullscreen (alternate) capture shows the current-screen-only hint', async () => {
    vi.spyOn(api, 'getHistory').mockResolvedValue({ text: 'screen', truncated: false, alternate: true })
    render(<HistoryView sessionId="s" title="t" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(/screen/)).toBeInTheDocument())
    expect(screen.getByText(/当前程序处于全屏模式/)).toBeInTheDocument()
  })
  it('no fullscreen hint for a normal capture', async () => {
    vi.spyOn(api, 'getHistory').mockResolvedValue({ text: 'plain', truncated: false })
    render(<HistoryView sessionId="s" title="t" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(/plain/)).toBeInTheDocument())
    expect(screen.queryByText(/当前程序处于全屏模式/)).toBeNull()
  })
  it('shows error text when fetch fails', async () => {
    vi.spyOn(api, 'getHistory').mockRejectedValue(new Error('tmux 服务未运行'))
    render(<HistoryView sessionId="s" title="api" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(/tmux 服务未运行/)).toBeInTheDocument())
  })
  it('search box highlights and steps through matches', async () => {
    vi.spyOn(api, 'getHistory').mockResolvedValue({ text: 'foo\nbar foo\nbaz', truncated: false })
    render(<HistoryView sessionId="s" title="t" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(/baz/)).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('搜索历史'), { target: { value: 'foo' } })
    expect(screen.getByText('1/2')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('下一个'))
    expect(screen.getByText('2/2')).toBeInTheDocument()
  })
  it('nav/close buttons are icons, not emoji glyphs (V16)', async () => {
    vi.spyOn(api, 'getHistory').mockResolvedValue({ text: 'a', truncated: false })
    render(<HistoryView sessionId="s" title="t" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(/a/)).toBeInTheDocument())
    for (const label of ['上一个', '下一个', '关闭历史']) {
      const btn = screen.getByLabelText(label)
      expect(btn.textContent).toBe('')
      expect(btn.querySelector('svg')).not.toBeNull()
    }
  })
  it('color toggle refetches with ansi=1', async () => {
    const spy = vi.spyOn(api, 'getHistory').mockResolvedValue({ text: 'x', truncated: false })
    render(<HistoryView sessionId="s" title="t" onClose={() => {}} />)
    await waitFor(() => expect(spy).toHaveBeenCalledWith('s', false))
    fireEvent.click(screen.getByText('颜色'))
    await waitFor(() => expect(spy).toHaveBeenCalledWith('s', true))
  })
  // Task 5 (V5/§1.3 E): the old confirm() is replaced by a one-tap send to ★ with a
  // 3s undo; these two cases were rewritten to the new interaction (same payload).
  it('send to agent: one tap to ★, no confirmation, sends the tail after the 3s undo window', async () => {
    vi.spyOn(api, 'getHistory').mockResolvedValue({ text: 'a\nb', truncated: false })
    const { sendPrompt } = renderSend()
    await waitFor(() => expect(screen.getByText(/b/)).toBeInTheDocument())
    const btn = screen.getByRole('button', { name: '发给 s-a' })
    expect(btn).toHaveTextContent('发给 ★ s-a')
    vi.useFakeTimers()
    fireEvent.click(btn)
    expect(document.querySelector('dialog[open]')).toBeNull()
    expect(screen.getByText('已发给 s-a · 2 行')).toBeInTheDocument()
    expect(sendPrompt).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(UNDO_MS) })
    expect(sendPrompt).toHaveBeenCalledWith('W[a\nb]', { withAttachments: false })
    expect(screen.getByText('已发给 s-a')).toBeInTheDocument()
  })
  it('send to agent strips ANSI escapes in color mode', async () => {
    const spy = vi.spyOn(api, 'getHistory').mockResolvedValue({ text: 'a\x1b[31mb\x1b[0mc', truncated: false })
    const { sendPrompt } = renderSend()
    await waitFor(() => expect(spy).toHaveBeenCalledWith('s', false))
    fireEvent.click(screen.getByText('颜色'))
    await waitFor(() => expect(spy).toHaveBeenCalledWith('s', true))
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: '发给 s-a' }))
    act(() => { vi.advanceTimersByTime(UNDO_MS) })
    expect(sendPrompt).toHaveBeenCalledWith('W[abc]', { withAttachments: false })
    expect((sendPrompt.mock.calls[0] as unknown[])[0]).not.toContain('\x1b')
  })
  it('撤回 within 3s: nothing is sent', async () => {
    vi.spyOn(api, 'getHistory').mockResolvedValue({ text: 'x', truncated: false })
    const { sendPrompt } = renderSend()
    await waitFor(() => expect(screen.getByText('x')).toBeInTheDocument())
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: '发给 s-a' }))
    act(() => { vi.advanceTimersByTime(1000) })
    act(() => { fireEvent.click(screen.getByText('撤回')) })
    act(() => { vi.advanceTimersByTime(UNDO_MS * 2) })
    expect(sendPrompt).not.toHaveBeenCalled()
  })
  it('target socket not open when the window elapses → 未连接,未发送', async () => {
    vi.spyOn(api, 'getHistory').mockResolvedValue({ text: 'x', truncated: false })
    renderSend({ ok: false })
    await waitFor(() => expect(screen.getByText('x')).toBeInTheDocument())
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: '发给 s-a' }))
    act(() => { vi.advanceTimersByTime(UNDO_MS) })
    expect(screen.getByText('未连接,未发送')).toBeInTheDocument()
  })
  it('a text selection is sent instead of the tail', async () => {
    vi.spyOn(api, 'getHistory').mockResolvedValue({ text: 'a\nb', truncated: false })
    const { sendPrompt } = renderSend()
    await waitFor(() => expect(screen.getByText(/b/)).toBeInTheDocument())
    vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => 'picked' } as Selection)
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: '发给 s-a' }))
    act(() => { vi.advanceTimersByTime(UNDO_MS) })
    expect(sendPrompt).toHaveBeenCalledWith('W[picked]', { withAttachments: false })
  })
  it('the tail is the last 200 lines', async () => {
    const text = Array.from({ length: 250 }, (_, i) => `L${i}`).join('\n')
    vi.spyOn(api, 'getHistory').mockResolvedValue({ text, truncated: false })
    const { sendPrompt } = renderSend()
    await waitFor(() => expect(screen.getByText(/L249/)).toBeInTheDocument())
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: '发给 s-a' }))
    act(() => { vi.advanceTimersByTime(UNDO_MS) })
    expect(sendPrompt).toHaveBeenCalledWith(`W[${text.split('\n').slice(-200).join('\n')}]`, { withAttachments: false })
  })
  it('long press (500ms) opens SendToMenu and sends nothing by itself', async () => {
    vi.spyOn(api, 'getHistory').mockResolvedValue({ text: 'x', truncated: false })
    const { sendPrompt } = renderSend()
    await waitFor(() => expect(screen.getByText('x')).toBeInTheDocument())
    const btn = screen.getByRole('button', { name: '发给 s-a' })
    expect(btn.className).toContain('select-none')
    expect(btn.className).toContain('[-webkit-touch-callout:none]')
    vi.useFakeTimers()
    fireEvent.pointerDown(btn)
    act(() => { vi.advanceTimersByTime(500) })
    fireEvent.pointerUp(btn)
    fireEvent.click(btn)
    expect(screen.getByRole('menu')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(UNDO_MS) })
    expect(sendPrompt).not.toHaveBeenCalled()
    expect(screen.queryByText(/已发给/)).toBeNull()
  })
  it('▾ opens SendToMenu; picking sends the wrapped payload', async () => {
    vi.spyOn(api, 'getHistory').mockResolvedValue({ text: 'x', truncated: false })
    const { sendPrompt } = renderSend()
    await waitFor(() => expect(screen.getByText('x')).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText('选择发送目标'))
    fireEvent.click(screen.getByRole('menuitem', { name: '发给 s-a' }))
    expect(sendPrompt).toHaveBeenCalledWith('W[x]', { withAttachments: false })
  })
  it('no candidates → 「发给 agent…」 opens the menu (only ＋ 新开…)', async () => {
    vi.spyOn(api, 'getHistory').mockResolvedValue({ text: 'x', truncated: false })
    const { onNew } = renderSend({ sessions: [mkSession('t', { type: 'tmux' })] })
    await waitFor(() => expect(screen.getByText('x')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '发给 agent…' }))
    fireEvent.click(screen.getByText('＋ 新开…'))
    expect(onNew).toHaveBeenCalledWith({ workDir: '/w/a', prompt: 'W[x]' })
  })
  it('the secret reminder line sits by the send button; the content area stays selectable', async () => {
    vi.spyOn(api, 'getHistory').mockResolvedValue({ text: 'x', truncated: false })
    renderSend()
    await waitFor(() => expect(screen.getByText('x')).toBeInTheDocument())
    expect(screen.getByText('发送前请确认内容不含密钥')).toBeInTheDocument()
    const content = screen.getByText('x').closest('.select-text') as HTMLElement
    expect(content.className).not.toContain('touch-callout')
    expect(content.className).not.toContain('select-none')
  })
  it('fullscreen (alternate) capture: 「仅当前屏」 sub-label; aria names the target and the scope', async () => {
    vi.spyOn(api, 'getHistory').mockResolvedValue({ text: 'screen', truncated: false, alternate: true })
    renderSend()
    await waitFor(() => expect(screen.getByText(/screen/)).toBeInTheDocument())
    const btn = screen.getByRole('button', { name: '发给 s-a,仅当前屏' })
    expect(btn).toHaveTextContent('发给 ★ s-a')
    expect(screen.getByText('仅当前屏')).toBeInTheDocument()
  })
  it('no send button without sendTo', async () => {
    vi.spyOn(api, 'getHistory').mockResolvedValue({ text: 'x', truncated: false })
    render(<HistoryView sessionId="s" title="t" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('x')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /发给/ })).toBeNull()
  })
})
