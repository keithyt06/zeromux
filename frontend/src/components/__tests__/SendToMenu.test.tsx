import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SendToMenu } from '../SendToMenu'
import { Toaster, toast } from '../ui'
import { mkSession } from '../../test/appHarness'
import type { SessionControls } from '../../lib/sessionControls'
import * as attach from '../../lib/attachCommand'

const ctl = (ok: boolean): SessionControls => ({
  setQueueMode: vi.fn(), sendPrompt: vi.fn(() => ok), interrupt: vi.fn(() => ok),
  resolveApproval: vi.fn(() => ok), pendingApprovals: () => [],
})

function setup(o: { sessions?: ReturnType<typeof mkSession>[]; controls?: Record<string, SessionControls>; queueModes?: Record<string, string>; workDir?: string | null } = {}) {
  const anchor = document.createElement('button'); document.body.appendChild(anchor)
  const onSelectSession = vi.fn(), onNew = vi.fn(), onClose = vi.fn()
  const sessions = o.sessions ?? [
    mkSession('far', { name: 'docs-sync', work_dir: '/other', last_activity_ms: 99 }),
    mkSession('near', { name: 'zeromux-fe', work_dir: '/w/repo', last_activity_ms: 10 }),
    mkSession('t', { name: 'shell', type: 'tmux', work_dir: '/w/repo', last_activity_ms: 200 }),
  ]
  const controls = { current: o.controls ?? { near: ctl(true), far: ctl(false) } }
  render(<>
    <SendToMenu open anchor={anchor} onClose={onClose} text="PROMPT" workDir={o.workDir === undefined ? '/w/repo' : o.workDir}
      sessions={sessions} controls={controls} queueModes={o.queueModes ?? {}} onSelectSession={onSelectSession} onNew={onNew} />
    <Toaster />
  </>)
  return { onSelectSession, onNew, onClose, controls }
}

describe('SendToMenu', () => {
  let confirmSpy: { mock: { calls: unknown[] } }
  beforeEach(() => { confirmSpy = vi.spyOn(window, 'confirm') })
  afterEach(() => {
    expect(confirmSpy).not.toHaveBeenCalled()
    vi.restoreAllMocks()
    act(() => { document.querySelectorAll('[data-toast-id]').forEach(el => toast.dismiss(el.getAttribute('data-toast-id')!)) })
  })

  it('candidates = sendTargets (agents only, same work_dir first); the first is ★ and focused; Enter sends to it', () => {
    const { controls, onSelectSession } = setup()
    const items = screen.getAllByRole('menuitem')
    expect(items.map(i => i.getAttribute('aria-label') ?? i.textContent)).toEqual(['发给 zeromux-fe', '发给 docs-sync', expect.stringContaining('新开')])
    expect(items[0]).toHaveTextContent('★ zeromux-fe')
    expect(items[1].textContent).not.toContain('★')
    expect(document.activeElement).toBe(items[0])
    fireEvent.keyDown(items[0], { key: 'Enter' })
    expect(controls.current.near.sendPrompt).toHaveBeenCalledWith('PROMPT')
    expect(onSelectSession).not.toHaveBeenCalled()   // no focus switch
  })

  it('success → toast 「已发给 〈名〉」; 「查看」 selects the session', async () => {
    const { onSelectSession } = setup()
    fireEvent.click(screen.getByRole('menuitem', { name: '发给 zeromux-fe' }))
    expect(screen.getByText('已发给 zeromux-fe')).toBeInTheDocument()
    expect(onSelectSession).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByText('查看')) })
    expect(onSelectSession).toHaveBeenCalledWith('near')
  })

  it('not connected → toast 「未连接,未发送」 with 「复制」', async () => {
    const copy = vi.spyOn(attach, 'copyText').mockResolvedValue(true)
    setup()
    fireEvent.click(screen.getByRole('menuitem', { name: '发给 docs-sync' }))
    expect(screen.getByText('未连接,未发送')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByText('复制')) })
    expect(copy).toHaveBeenCalledWith('PROMPT')
  })

  it('an unmounted target (no controls) is 未连接 too', () => {
    setup({ controls: {} })
    fireEvent.click(screen.getByRole('menuitem', { name: '发给 zeromux-fe' }))
    expect(screen.getByText('未连接,未发送')).toBeInTheDocument()
  })

  it('busy target shows 将排队 (collect) / 将打断 (interrupt)', () => {
    setup({
      sessions: [
        mkSession('a', { name: 'a', turn_state: 'running', work_dir: '/w/repo' }),
        mkSession('b', { name: 'b', turn_state: 'running' }),
        mkSession('c', { name: 'c' }),
      ],
      queueModes: { a: 'collect', b: 'interrupt', c: 'interrupt' },
    })
    expect(screen.getByRole('menuitem', { name: '发给 a' })).toHaveTextContent('将排队')
    expect(screen.getByRole('menuitem', { name: '发给 b' })).toHaveTextContent('将打断')
    const c = screen.getByRole('menuitem', { name: '发给 c' })
    expect(c.textContent).not.toMatch(/将排队|将打断/)
  })

  it('＋ 新开… calls onNew with the work dir and the text', () => {
    const { onNew } = setup()
    fireEvent.click(screen.getByText('＋ 新开…'))
    expect(onNew).toHaveBeenCalledWith({ workDir: '/w/repo', prompt: 'PROMPT' })
  })

  it('always shows the secret reminder line', () => {
    setup()
    expect(screen.getByText('发送前请确认内容不含密钥')).toBeInTheDocument()
  })

  it('no candidates → only ＋ 新开…', () => {
    setup({ sessions: [mkSession('t', { type: 'tmux' })] })
    const items = screen.getAllByRole('menuitem')
    expect(items).toHaveLength(1)
    expect(items[0]).toHaveTextContent('＋ 新开…')
  })
})
