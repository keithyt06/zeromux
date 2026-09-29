import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setupApp, mkSession } from '../../../test/appHarness'
import { xtermInstances } from '../../../test/xtermMock'
import App from '../../../App'

vi.mock('@xterm/xterm', async () => (await import('../../../test/xtermMock')).xtermModule)
vi.mock('@xterm/addon-fit', async () => (await import('../../../test/xtermMock')).fitModule)
vi.mock('@xterm/addon-webgl', async () => (await import('../../../test/xtermMock')).webglModule)
vi.mock('@xterm/addon-search', async () => (await import('../../../test/xtermMock')).searchModule)
vi.mock('@xterm/addon-clipboard', async () => (await import('../../../test/xtermMock')).clipboardModule)
const cardRenders = { n: 0 }
vi.mock('../../turn/TurnSummaryCard', async () => {
  const actual = await vi.importActual<typeof import('../../turn/TurnSummaryCard')>('../../turn/TurnSummaryCard')
  return { TurnSummaryCard: (p: Parameters<typeof actual.TurnSummaryCard>[0]) => { cardRenders.n++; return actual.TurnSummaryCard(p) } }
})
const notGitIds = new Set<string>()
vi.mock('../lazyPanels', async () => {
  const actual = await vi.importActual<typeof import('../lazyPanels')>('../lazyPanels')
  const { useEffect } = await import('react')
  const Stub = (name: string) => () => <div>{name}</div>
  // Mirrors the real GitViewer: reports once when its session's dir is not a repo.
  const Git = ({ sessionId, onNotGit }: { sessionId: string; onNotGit?: () => void }) => {
    useEffect(() => { if (notGitIds.has(sessionId)) onNotGit?.() }, [sessionId, onNotGit])
    return <div>GIT</div>
  }
  return { ...actual, GitViewer: Git, FileBrowser: Stub('FILES'), RunMetricsPanel: Stub('RUNS'), AgentDashboard: Stub('EVENTS') }
})

const pane = (id: string) => document.querySelector(`[data-session-pane="${id}"]`)
const activePane = () => document.querySelector('[data-session-pane][data-active="1"]')?.getAttribute('data-session-pane')
const phone = () => vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('max-width'), addEventListener() {}, removeEventListener() {} }))
const desktop = (w = 1440) => vi.stubGlobal('matchMedia', (q: string) => {
  const m = /(min|max)-width:\s*(\d+)px/.exec(q)
  const matches = m ? (m[1] === 'min' ? w >= +m[2] : w <= +m[2]) : q.includes('hover')
  return { matches, addEventListener() {}, removeEventListener() {} }
})

const NOW = Date.now()
const sessions = () => [
  mkSession('a', { name: 'alpha' }),
  mkSession('e', { name: 'broken', last_outcome: 'errored', last_outcome_ms: NOW + 60_000 }),
  mkSession('t', { name: 'shell', type: 'tmux', tmux_name: 'zmx-t', tmux_origin: 'own' }),
]

async function boot(list = sessions()) {
  const h = setupApp({ sessions: list })
  render(<App />)
  await waitFor(() => expect(pane(list[0].id)).not.toBeNull())
  return h
}

describe('AppShell', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    xtermInstances.length = 0
    history.replaceState(null, '', '/')
    localStorage.clear()
    notGitIds.clear()
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('crossing the phone breakpoint (rotation / window drag) never remounts session views (I-1)', async () => {
    let w = 1440
    const mm = (q: string) => {
      const m = /(min|max)-width:\s*(\d+)px/.exec(q)
      const matches = m ? (m[1] === 'min' ? w >= +m[2] : w <= +m[2]) : q.includes('hover')
      return { matches, addEventListener: (_: string, f: () => void) => { subs.add(f) }, removeEventListener: (_: string, f: () => void) => { subs.delete(f) }, addListener: undefined }
    }
    const subs = new Set<() => void>()
    vi.stubGlobal('matchMedia', mm)
    const h = await boot()
    await waitFor(() => expect(activePane()).toBe('a'))
    const ws = h.ws.all.length, term = xtermInstances.length
    expect(term).toBeGreaterThan(0)
    for (const next of [390, 1440, 1100, 390]) {
      w = next
      await act(async () => { subs.forEach(f => (f as (e: { matches: boolean }) => void)({ matches: false })) })
    }
    await waitFor(() => expect(pane('t')).not.toBeNull())
    expect(xtermInstances.length).toBe(term)
    expect(h.ws.all.length).toBe(ws)
  })

  it('a finished turn does not re-render on AppShell ticks / polls (I-9)', async () => {
    desktop()
    const h = await boot()
    await waitFor(() => expect(activePane()).toBe('a'))
    const sock = h.ws.all.find(s => (s as unknown as { url: string }).url.includes('/ws/acp/a'))!
    await act(async () => {
      sock.emit({ type: 'user_prompt', text: 'fix it', turn_id: 1 })
      sock.emit({ type: 'content_block', block_type: 'tool_use', name: 'Edit', summary: 'x', input: { file_path: '/w/a/x.ts' }, turn_id: 1 })
      sock.emit({ type: 'content_block', block_type: 'text', text: 'Done.', turn_id: 1 })
      sock.emit({ type: 'result', turn_id: 1, text: 'Done.' })
    })
    await waitFor(() => expect(cardRenders.n).toBeGreaterThan(0))
    const n = cardRenders.n
    await act(async () => { vi.advanceTimersByTime(6100) })   // two 3s polls + now ticks
    expect(cardRenders.n).toBe(n)
  })

  it('first legacy login on an empty server lands on the bootstrapped terminal; a bootstrap failure is not a login error', async () => {
    desktop()
    const api = await import('../../../lib/api')
    for (const failBootstrap of [false, true]) {
      vi.restoreAllMocks(); localStorage.clear()
      const h = setupApp({ sessions: [] })
      vi.spyOn(api, 'checkAuth').mockResolvedValue(null)
      vi.spyOn(api, 'legacyLogin').mockResolvedValue({ id: 'u', login: 'u', avatar: null, role: 'admin', status: 'active' } as never)
      const created = mkSession('n', { name: 'first', type: 'tmux', tmux_name: 'zmx-n' })
      const create = vi.spyOn(api, 'createSession').mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 50))   // network latency: must finish BEFORE the shell loads
        if (failBootstrap) throw new Error('boom')
        h.setSessions([created]); return created
      })
      const { unmount } = render(<App />)
      const pw = await waitFor(() => { const el = document.querySelector('input[type="password"]'); expect(el).not.toBeNull(); return el as HTMLInputElement })
      fireEvent.change(pw, { target: { value: 'pw' } })
      fireEvent.submit(pw.closest('form')!)
      await waitFor(() => expect(create).toHaveBeenCalledWith('tmux'))
      if (failBootstrap) {
        await waitFor(() => expect(document.querySelector('input[type="password"]')).toBeNull())
        expect(screen.getByText('创建一个会话开始')).toBeInTheDocument()
      } else {
        await waitFor(() => expect(activePane()).toBe('n'))
      }
      unmount()
    }
  })

  it('phone: triage is home (nothing selected); tapping a row opens it, ‹ 分诊 goes back', async () => {
    phone()
    await boot()
    expect(activePane()).toBeUndefined()
    fireEvent.click(screen.getByText('alpha'))
    await waitFor(() => expect(activePane()).toBe('a'))
    fireEvent.click(screen.getByRole('button', { name: /返回分诊/ }))
    await waitFor(() => expect(activePane()).toBeUndefined())
    expect(pane('a')).not.toBeNull()   // still mounted (I-1)
  })

  it('phone: a focused session that vanished (closed elsewhere) offers 返回分诊, not a dead end', async () => {
    phone()
    const h = await boot()
    fireEvent.click(screen.getByText('alpha'))
    await waitFor(() => expect(activePane()).toBe('a'))
    h.setSessions(sessions().filter(s => s.id !== 'a'))
    await act(async () => { await vi.advanceTimersByTimeAsync(3100) })
    await waitFor(() => expect(pane('a')).toBeNull())
    expect(screen.getByText('该会话已不存在')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '返回分诊' }))
    await waitFor(() => expect(screen.getByText('broken').closest('.hidden')).toBeNull())   // triage shown
    expect(screen.queryByText('该会话已不存在')).toBeNull()
  })

  it('phone: a ?session= deep link shows no 该会话已不存在 before the first list load; a gone id then lands on triage', async () => {
    phone()
    history.replaceState(null, '', '/?session=x')
    setupApp({ sessions: sessions() })
    const api = await import('../../../lib/api')
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    vi.spyOn(api, 'listSessionsWithHost').mockImplementation(async () => { await gate; return { sessions: sessions(), host_tmux: [] } })
    render(<App />)
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    expect(api.listSessionsWithHost).toHaveBeenCalled()
    expect(screen.queryByText('该会话已不存在')).toBeNull()
    await act(async () => { release() })
    // The initial reload() drops an id that doesn't resolve (phone), so triage is home — no dead end, no false message.
    await waitFor(() => expect(screen.getByText('broken').closest('.hidden')).toBeNull())
    expect(screen.queryByText('该会话已不存在')).toBeNull()
  })

  it('?session= is consumed once: selected, then stripped from the URL (A11)', async () => {
    desktop()
    history.replaceState(null, '', '/?session=e')
    await boot()
    await waitFor(() => expect(activePane()).toBe('e'))
    expect(location.search).toBe('')
    expect(location.pathname).toBe('/')
  })

  it('phone: opening ⌘K closes the ContextPanel sheet — never two modals (R13)', async () => {
    phone()
    await boot()
    fireEvent.click(screen.getByText('alpha'))
    fireEvent.click(await screen.findByRole('button', { name: '面板' }))
    await waitFor(() => expect(document.querySelectorAll('dialog[open]').length).toBe(1))
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    await screen.findByRole('combobox', { name: '命令' })
    expect(document.querySelectorAll('dialog[open]').length).toBe(1)
  })

  it('phone: FAB 下一个需要你的 jumps to the needs-you session in one tap', async () => {
    phone()
    // localStorage baseline older than the outcome → error is unread.
    localStorage.setItem('zmx_read', JSON.stringify({ a: 1, e: 1, t: 1 }))
    await boot()
    fireEvent.click(screen.getByText('alpha'))
    fireEvent.click(await screen.findByRole('button', { name: '下一个需要你的' }))
    await waitFor(() => expect(activePane()).toBe('e'))
  })

  it('document.title carries the needs-you count; J jumps to next, then 都处理完了', async () => {
    desktop()
    localStorage.setItem('zmx_read', JSON.stringify({ a: 1, e: 1, t: 1 }))
    await boot()
    await waitFor(() => expect(document.title).toBe('(1) ZeroMux'))
    fireEvent.keyDown(document.body, { key: 'j' })
    await waitFor(() => expect(activePane()).toBe('e'))
    await waitFor(() => expect(document.title).toBe('ZeroMux'))   // viewing it clears error
    fireEvent.keyDown(document.body, { key: 'j' })
    expect(await screen.findByText('都处理完了')).toBeInTheDocument()
  })

  // A3: a scheduled run created + errored while the app was closed (its sid was never
  // baselined) must count as needs-you; on a first run history is not all unread.
  const offline = () => [mkSession('a', { name: 'alpha' }),
    mkSession('n', { name: 'nightly', last_outcome: 'errored', last_outcome_ms: NOW - 3_600_000 })]
  it('an unseen session that errored while the app was closed is needs-you (A3)', async () => {
    desktop()
    localStorage.setItem('zmx_read', JSON.stringify({ a: 1 }))
    await boot(offline())
    await waitFor(() => expect(document.title).toBe('(1) ZeroMux'))
  })
  it('first run (no zmx_read): past outcomes are baselined as seen (A3)', async () => {
    desktop()
    await boot(offline())
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    expect(document.title).toBe('ZeroMux')
  })

  it('desktop ≥1280: agent sessions open with the ContextPanel column; tmux starts closed; state is per session', async () => {
    desktop()
    await boot()
    await waitFor(() => expect(activePane()).toBe('a'))
    expect(screen.getByRole('button', { name: '面板' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('radio', { name: '文件' }))
    fireEvent.click(screen.getByText('shell'))
    await waitFor(() => expect(activePane()).toBe('t'))
    expect(screen.getByRole('button', { name: '面板' })).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(screen.getByText('alpha'))
    await waitFor(() => expect(activePane()).toBe('a'))
    expect(document.querySelector('[data-context-panel="a"] [role="radio"][aria-checked="true"]')?.textContent).toBe('文件')
  })

  it('a non-git session defaults its ContextPanel to 文件; an explicit Git pick sticks', async () => {
    desktop()
    notGitIds.add('a')
    await boot()
    await waitFor(() => expect(activePane()).toBe('a'))
    const checked = () => document.querySelector('[data-context-panel="a"] [role="radio"][aria-checked="true"]')?.textContent
    await waitFor(() => expect(checked()).toBe('文件'))
    fireEvent.click(screen.getByRole('radio', { name: 'Git' }))
    await waitFor(() => expect(checked()).toBe('Git'))
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(checked()).toBe('Git')
  })

  it('1024–1279: the ContextPanel is a bottom sheet, closed by default', async () => {
    desktop(1100)
    await boot()
    await waitFor(() => expect(activePane()).toBe('a'))
    expect(document.querySelectorAll('dialog[open]').length).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: '面板' }))
    await waitFor(() => expect(document.querySelector('dialog[open]')?.getAttribute('data-side')).toBe('bottom'))
  })

  it('md–lg: the triage column collapses to a 56px icon rail that still selects', async () => {
    desktop(900)
    await boot()
    fireEvent.click(screen.getByRole('button', { name: 'shell' }))
    await waitFor(() => expect(activePane()).toBe('t'))
    fireEvent.click(screen.getByRole('button', { name: '展开会话列表' }))
    expect(screen.getByText('alpha')).toBeInTheDocument()
  })

  it('⚙ settings menu routes every entry (push / prompts / scheduled / admin / theme / logout)', async () => {
    desktop()
    await boot()
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    expect(screen.getAllByRole('menuitem').map(m => m.textContent)).toEqual(
      ['推送设置', '常用 prompt', '定时任务', '用户管理', '主题:跟随系统', '主题:深色', '主题:浅色', '退出登录'])
    fireEvent.click(screen.getByRole('menuitem', { name: '退出登录' }))
    await waitFor(() => expect(document.querySelector('input[type="password"]')).not.toBeNull())
  })

  it('rename / 描述 from the row ⋯ saves both fields via updateSession', async () => {
    desktop()
    const api = await import('../../../lib/api')
    const upd = vi.spyOn(api, 'updateSession').mockResolvedValue()
    await boot()
    fireEvent.click(screen.getAllByRole('button', { name: '会话菜单' })[0])
    fireEvent.click(await screen.findByRole('menuitem', { name: '重命名 / 描述…' }))
    fireEvent.change(await screen.findByLabelText('描述'), { target: { value: '做点事' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(upd).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ description: '做点事' })))
  })

  it('orphan confirmations show a 定时待确认 row in the triage header', async () => {
    desktop()
    const h = setupApp({ sessions: sessions() })
    const api = await import('../../../lib/api')
    vi.spyOn(api, 'listConfirmations').mockResolvedValue({ runs: [{ id: 'r', task_id: 'x', session_id: null } as never], count: 1 })
    render(<App />)
    expect(await screen.findByText('定时待确认 (1)')).toBeInTheDocument()
    void h
  })

  it('a push deep link with git_dirty opens the Git panel (M26)', async () => {
    desktop()
    const listeners: ((e: MessageEvent) => void)[] = []
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true,
      value: { controller: null, addEventListener: (_: string, f: (e: MessageEvent) => void) => listeners.push(f), removeEventListener() {} } })
    const api = await import('../../../lib/api')
    await boot([mkSession('t', { name: 'shell', type: 'tmux', tmux_name: 'zmx-t' }), mkSession('a', { name: 'alpha' })])
    vi.spyOn(api, 'getSessionStatus').mockResolvedValue({ work_dir: '/w', git_branch: 'main', git_dirty: 2, is_git: true })
    await act(async () => { listeners.forEach(f => f(new MessageEvent('message', { data: { type: 'open_session', id: 't' } }))) })
    await waitFor(() => expect(activePane()).toBe('t'))
    await waitFor(() => expect(screen.getByRole('button', { name: '面板' })).toHaveAttribute('aria-pressed', 'true'))
    expect(await screen.findByText('GIT')).toBeInTheDocument()
    Reflect.deleteProperty(navigator, 'serviceWorker')
  })
})
