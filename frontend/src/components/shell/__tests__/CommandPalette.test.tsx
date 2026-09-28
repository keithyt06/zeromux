import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CommandPalette, type CommandPaletteProps } from '../CommandPalette'
import { buildPaletteActions } from '../paletteActions'
import type { ShellState } from '../useShellState'
import * as api from '../../../lib/api'
import type { SearchResult, SessionInfo } from '../../../lib/api'
import { mkSession } from '../../../test/appHarness'
import { LAST_TYPE_KEY } from '../../../lib/paletteParse'
import type { SessionControls } from '../../../lib/sessionControls'

const sec = <T,>(kind: 'dirs' | 'notes', items: T[]) => ({ kind, indexing: false, refreshing: false, truncated: false, items })
const R = (dirs: SearchResult['dirs'], notes: SearchResult['notes']): SearchResult => ({ dirs, notes })
const NOW = 1_000_000

const SESSIONS = [
  mkSession('err', { name: 'api-refactor', last_activity_ms: 10 }),
  mkSession('b', { name: 'zeromux-fe', last_activity_ms: 30 }),
  mkSession('c', { name: 'docs-sync', last_activity_ms: 20 }),
]

function shell(over: Partial<ShellState> = {}): ShellState {
  return {
    sessions: SESSIONS, hostTmux: [], docTabs: [], activeId: null, select: vi.fn(), lastViewedMs: {},
    queueModes: {}, onQueueModeChange: vi.fn(), ctxUsage: {}, onCtxUsage: vi.fn(),
    confirmRuns: [], confirmsBySession: {}, orphanConfirms: 0, schedulerHealthy: true,
    controls: { current: {} }, registerControls: vi.fn(), create: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(), rename: vi.fn(), openVault: vi.fn(), docTargets: {}, closeDocTab: vi.fn(), updateDocTabTitle: vi.fn(),
    historyReq: null, openHistory: vi.fn(), context: {}, contextOf: () => ({ open: false, tab: 'git' }), setContext: vi.fn(),
    ...over,
  } as ShellState
}

function setup(p: Partial<CommandPaletteProps> & { sh?: ShellState } = {}) {
  const sh = p.sh ?? shell()
  const onClose = vi.fn()
  const props: CommandPaletteProps = { open: true, onClose, shell: sh, actions: [], now: NOW, ...p }
  const utils = render(<CommandPalette {...props} />)
  const input = () => screen.getByRole('combobox', { name: '命令' }) as HTMLInputElement
  const type = (v: string) => fireEvent.change(input(), { target: { value: v } })
  const key = (k: string, o: Record<string, unknown> = {}) => fireEvent.keyDown(input(), { key: k, ...o })
  return { sh, onClose, input, type, key, ...utils, props }
}

const flush = async (ms = 200) => { await act(async () => { vi.advanceTimersByTime(ms) }) }

describe('CommandPalette', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    localStorage.clear()
    vi.spyOn(api, 'listQuickTargets').mockResolvedValue({ top: [] })
    vi.spyOn(api, 'warmSearchIndex').mockResolvedValue()
    vi.spyOn(api, 'searchPaths').mockResolvedValue(R(sec('dirs', []), sec('notes', [])))
  })
  afterEach(() => { vi.useRealTimers() })

  // 1 — ported from crewSessionType ③b (quick target carries its agent) and the
  // Sidebar.newflow quick-target one-tap path.
  it('empty state lists quick targets and the 5 most recent sessions; a quick target creates with its agent', async () => {
    vi.spyOn(api, 'listQuickTargets').mockResolvedValue({ top: [{ kind: 'dir', path: '/w/a', agent: 'crew', display: 'a', hint: '~' }] })
    const { sh } = setup()
    fireEvent.click(await screen.findByText('a'))
    await waitFor(() => expect(sh.create).toHaveBeenCalledWith('crew', '/w/a'))
    const recent = [...document.querySelectorAll('[data-palette-item]')].map(e => e.getAttribute('data-palette-item'))
    expect(recent).toEqual(['s:b', 's:c', 's:err'])
  })

  // 2
  it('typing ranks sessions by rankBy; Enter selects and closes', () => {
    const { sh, onClose, type, key } = setup()
    type('api')
    expect(screen.getByText('api-refactor')).toBeInTheDocument()
    key('Enter')
    expect(sh.select).toHaveBeenCalledWith('err')
    expect(onClose).toHaveBeenCalled()
  })

  // 3 — the IME guard is ported from Sidebar's search input (B7).
  it('↑/↓ move the highlight; Enter while an IME is composing does nothing', async () => {
    const { sh, key } = setup()
    key('ArrowDown')
    expect(document.querySelector('[aria-selected="true"]')?.getAttribute('data-palette-item')).toBe('s:c')
    key('ArrowUp')
    expect(document.querySelector('[aria-selected="true"]')?.getAttribute('data-palette-item')).toBe('s:b')
    key('Enter', { isComposing: true })
    expect(sh.select).not.toHaveBeenCalled()
    await flush(0)   // let QuickTargets' mount fetch settle inside act
  })

  // 4
  it('results stable across sessions prop change: the highlight follows the id, not the index', async () => {
    const { key, rerender, props } = setup()
    key('ArrowDown')   // → s:c (2nd)
    const next: SessionInfo[] = [mkSession('z', { name: 'new-one', last_activity_ms: 99 }), ...SESSIONS.map(s => ({ ...s }))]
    rerender(<CommandPalette {...props} shell={shell({ sessions: next })} />)
    expect(document.querySelector('[aria-selected="true"]')?.getAttribute('data-palette-item')).toBe('s:c')
    await flush(0)
  })

  // 5
  it('new mode: "codex zeromux 修 bug" previews the first dir hit; Enter creates and remembers the type', async () => {
    vi.spyOn(api, 'searchPaths').mockResolvedValue(R(sec('dirs', [{ path: '/w/zeromux', display: 'zeromux', hint: '~', agent: null, score: 9 }]), null))
    const { sh, onClose, type, key } = setup()
    type('codex zeromux 修 bug')
    await flush()
    await waitFor(() => expect(screen.getByTestId('palette-preview')).toHaveTextContent('Codex · /w/zeromux · "修 bug"'))
    key('Enter')
    await waitFor(() => expect(sh.create).toHaveBeenCalledWith('codex', '/w/zeromux', undefined, '修 bug'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(localStorage.getItem(LAST_TYPE_KEY)).toBe('codex')
    expect(api.searchPaths).toHaveBeenCalledWith('zeromux', 'dirs', undefined)
  })

  // 6
  it('no type keyword in new mode → uses the last used type', async () => {
    localStorage.setItem(LAST_TYPE_KEY, 'crew')
    vi.spyOn(api, 'searchPaths').mockResolvedValue(R(sec('dirs', [{ path: '/w/p', display: 'p', hint: '~', agent: null, score: 9 }]), null))
    const { type } = setup({ initial: { mode: 'new' } })
    type('p hello')
    await flush()
    await waitFor(() => expect(screen.getByTestId('palette-preview')).toHaveTextContent('Crew · /w/p · "hello"'))
  })

  // 7
  it('a literal ~/ path is used as-is and never searched', async () => {
    const spy = vi.spyOn(api, 'searchPaths')
    const { sh, type, key } = setup()
    type('tmux ~/x')
    await flush()
    expect(screen.getByTestId('palette-preview')).toHaveTextContent('终端 · ~/x')
    expect(spy.mock.calls.some(c => c[0] === '~/x')).toBe(false)
    key('Enter')
    await waitFor(() => expect(sh.create).toHaveBeenCalledWith('tmux', '~/x', undefined, undefined))
  })

  // 8 — ported from Sidebar.newflow:57 (B3 failure keeps it open) and :85 (creatingRef double tap).
  it('create failure keeps the palette open with the error in the preview; retry success closes', async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error('work_dir not allowed')).mockResolvedValueOnce(undefined)
    const { onClose, type, key } = setup({ sh: shell({ create }) })
    type('claude ~/p')
    key('Enter')
    expect(await screen.findByText(/创建失败:work_dir not allowed/)).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    key('Enter')
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })
  it('a second Enter while create is in flight does not create again', async () => {
    const create = vi.fn(() => new Promise<void>(() => {}))   // never resolves
    const { type, key } = setup({ sh: shell({ create }) })
    type('claude ~/p')
    key('Enter')
    key('Enter')
    expect(create).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('创建中…')).toBeInTheDocument()
  })
  it('a double tap on a quick target creates only one session (Sidebar.newflow:85)', async () => {
    vi.spyOn(api, 'listQuickTargets').mockResolvedValue({ top: [{ kind: 'dir', path: '/w/p', agent: 'claude', display: 'p', hint: '/w/p' }] })
    const create = vi.fn(() => new Promise<void>(() => {}))
    setup({ sh: shell({ create }) })
    const row = await screen.findByText('p')
    fireEvent.click(row); fireEvent.click(row)
    expect(create).toHaveBeenCalledTimes(1)
  })

  // 9
  it('action section: 主题 / 笔记 / tmux attach', () => {
    const actions = buildPaletteActions({
      isAdmin: false, vaultEnabled: true, active: null, activeActions: [], queueMode: undefined, setQueueMode: vi.fn(),
      next: vi.fn(), toggleTheme: vi.fn(), openPanel: vi.fn(), openVault: vi.fn(), openContext: vi.fn(), openMemory: vi.fn(), logout: vi.fn(),
    })
    const { type } = setup({ actions, sh: shell({ hostTmux: [{ name: 'vscode-dev', windows: 1, attached: 0, created: 0, path: '/w' }] }) })
    type('主题')
    expect(screen.getByText('切换主题')).toBeInTheDocument()
    type('笔记')
    expect(screen.getByText('打开笔记库')).toBeInTheDocument()
    type('vscode')
    expect(screen.getByText('接入 tmux:vscode-dev')).toBeInTheDocument()
  })
  it('attaching a host tmux from the palette calls create(tmux, undefined, name) (Sidebar.newflow:39)', async () => {
    const { sh, type } = setup({ sh: shell({ hostTmux: [{ name: 'vscode-dev', windows: 1, attached: 0, created: 0, path: '/w' }] }) })
    type('vscode')
    fireEvent.click(screen.getByText('接入 tmux:vscode-dev'))
    await waitFor(() => expect(sh.create).toHaveBeenCalledWith('tmux', undefined, 'vscode-dev'))
  })

  // 10 — ported from Sidebar.search (dir one-tap, note opens vault, ⚡ prefill, folder 在此开).
  it('dir hit with a known agent creates in one tap (Sidebar.search:49)', async () => {
    vi.spyOn(api, 'searchPaths').mockResolvedValue(R(sec('dirs', [{ path: '/h/zeromux', display: 'zeromux', hint: '~', agent: 'claude', score: 80 }]), sec('notes', [])))
    const { sh, type } = setup()
    type('zmx')
    await flush()
    fireEvent.click(await screen.findByText('zeromux'))
    await waitFor(() => expect(sh.create).toHaveBeenCalledWith('claude', '/h/zeromux'))
  })
  it('dir hit without agent → new mode prefilled with that dir (replaces Sidebar.search:58 pick-type step)', async () => {
    localStorage.setItem(LAST_TYPE_KEY, 'codex')
    vi.spyOn(api, 'searchPaths').mockResolvedValue(R(sec('dirs', [{ path: '/h/new-repo', display: 'new-repo', hint: '~', agent: null, score: 80 }]), null))
    const { input, type } = setup()
    type('new')
    await flush()
    fireEvent.click(await screen.findByText('new-repo'))
    expect(input().value).toBe('codex /h/new-repo ')
    expect(screen.getByTestId('palette-preview')).toHaveTextContent('Codex · /h/new-repo')
  })
  it('note row opens the vault; ⚡ pre-fills new mode with the note context (Sidebar.search:68)', async () => {
    const hit = { path: '考研英语/2019/英语二/阅读理解/Text3.md', kind: 'note' as const, display: 'Text3', hint: '考研英语/2019', abs_dir: '/v/考研英语/2019/英语二/阅读理解', score: 90 }
    vi.spyOn(api, 'searchPaths').mockResolvedValue(R(sec('dirs', []), sec('notes', [hit])))
    const { sh, input, type, onClose, unmount } = setup({ vaultEnabled: true })
    type('19t3')
    await flush()
    fireEvent.click(await screen.findByText('Text3'))
    expect(sh.openVault).toHaveBeenCalledWith({ path: hit.path, kind: 'note' })
    expect(onClose).toHaveBeenCalled()
    fireEvent.click(await screen.findByTestId('sr-ask'))
    expect(input().value.startsWith(`claude ${hit.abs_dir} 当前笔记：`)).toBe(true)
    // tmux would drop the note context, so ⚡ never pre-selects it.
    unmount()
    localStorage.setItem(LAST_TYPE_KEY, 'tmux')
    const again = setup({ vaultEnabled: true })
    again.type('19t3')
    await flush()
    fireEvent.click(await screen.findByTestId('sr-ask'))
    expect(again.input().value.startsWith('claude ')).toBe(true)
  })
  it('folder ⋯ 在此开 agent → new mode in that folder (Sidebar.search:130)', async () => {
    const f = { path: 'p/x', kind: 'folder' as const, display: 'x', hint: 'p', abs_dir: '/v/p/x', score: 5 }
    vi.spyOn(api, 'searchPaths').mockResolvedValue(R(sec('dirs', []), sec('notes', [f])))
    const { input, type } = setup({ vaultEnabled: true })
    type('x')
    await flush()
    fireEvent.click(await screen.findByTestId('sr-menu'))
    fireEvent.click(screen.getByText('在此开 agent'))
    expect(input().value).toBe('claude /v/p/x ')
  })
  it('warms the index on open; without vault only dirs are searched (Sidebar.search:42,141)', async () => {
    const spy = vi.spyOn(api, 'searchPaths').mockResolvedValue(R(sec('dirs', []), null))
    const { type } = setup()
    expect(api.warmSearchIndex).toHaveBeenCalledWith('dirs')
    type('abc')
    await flush()
    await waitFor(() => expect(spy).toHaveBeenCalled())
    expect(spy.mock.calls[0][1]).toBe('dirs')
  })
  it('stale search responses are dropped (Sidebar.search:83)', async () => {
    let resolveSlow!: (r: SearchResult) => void
    vi.spyOn(api, 'searchPaths')
      .mockImplementationOnce(() => new Promise(r => { resolveSlow = r }))
      .mockResolvedValueOnce(R(sec('dirs', [{ path: '/h/fast', display: 'fast', hint: '~', agent: null, score: 1 }]), null))
    const { type } = setup()
    type('s')
    await flush()
    type('fa')
    await flush()
    await screen.findByText('fast')
    await act(async () => { resolveSlow(R(sec('dirs', [{ path: '/h/slow', display: 'slow', hint: '~', agent: null, score: 1 }]), null)) })
    expect(screen.queryByText('slow')).toBeNull()
  })
  it('indexing sections are re-queried automatically (Sidebar.search:109,160)', async () => {
    const spy = vi.spyOn(api, 'searchPaths')
      .mockResolvedValueOnce(R(sec('dirs', [{ path: '/h/repo', display: 'repo', hint: '~', agent: null, score: 1 }]), { ...sec('notes', []), indexing: true }))
      .mockResolvedValue(R(sec('dirs', []), sec('notes', [{ path: 'n.md', kind: 'note', display: 'ready', hint: '', abs_dir: '/v', score: 1 }])))
    const { type } = setup({ vaultEnabled: true })
    type('rea')
    await flush()
    await screen.findByText('正在建立笔记索引…')
    await flush(4100)
    await screen.findByText('ready')
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
  it('the input is 16px so iOS Safari does not zoom (Sidebar.search:150)', async () => {
    const { input } = setup()
    expect(input().className).toContain('text-ui-input')
    await flush(0)
  })
  // Sidebar.search:176/181 askAgentRequest opened the flow once per nonce: the new
  // shell reopens ⌘K with initial new-mode text instead (VaultReader ⚡).
  it('initial new-mode text (VaultReader ⚡) opens straight into the preview', () => {
    setup({ initial: { mode: 'new', text: 'claude /v/a 当前笔记：/v/a/n.md' } })
    expect(screen.getByTestId('palette-preview')).toHaveTextContent('Claude · /v/a · "当前笔记：/v/a/n.md"')
  })
  // Not ported (old IA only): 'Terminal goes straight to the directory picker',
  // 'back from pick-type keeps the query', 'manage-prompts is a sub-view',
  // 'theme is a segmented control', 'as a bottom Sheet the quick step does not
  // repeat the title', 'reopening the popover clears a stale error' (the palette
  // unmounts on close, so every open starts clean), 'session rename input is 16px'
  // (→ RenameDialog.test), 'Clock and Settings items call onOpenPanel' (→ TriageHeader
  // ⚙ menu, AppShell.test). The new IA has no such steps.

  // 11 — crewSessionType ② ported to source checks in crewSessionType.test.tsx.
  it('type chips are exactly claude / codex / crew / tmux (+ vault when enabled)', () => {
    setup({ initial: { mode: 'new' }, vaultEnabled: true })
    expect(screen.getAllByRole('radio').map(r => r.textContent)).toEqual(['Claude Code' + 'Claude', 'Codex' + 'Codex', 'Kiro Crew' + 'Crew', '终端', '笔记库'])
  })

  // Step 8.2 — temporary queue-mode action until the composer chip (Task 12).
  it('queue-mode action shows the backend-authoritative mode and flips it through controls', () => {
    const c = { setQueueMode: vi.fn() } as unknown as SessionControls
    const active = mkSession('a1', { name: 'agent' })
    const actions = buildPaletteActions({
      isAdmin: false, vaultEnabled: false, active, activeActions: [], queueMode: 'interrupt', setQueueMode: (id: string, m: string) => ({ a1: c } as Record<string, SessionControls>)[id]?.setQueueMode(m),
      next: vi.fn(), toggleTheme: vi.fn(), openPanel: vi.fn(), openVault: vi.fn(), openContext: vi.fn(), openMemory: vi.fn(), logout: vi.fn(),
    })
    const { type, key } = setup({ actions })
    type('队列')
    expect(screen.getByText('切换队列模式(当前:Interrupt)')).toBeInTheDocument()
    key('Enter')
    expect(c.setQueueMode).toHaveBeenCalledWith('collect')
  })
  it('queue-mode label is never overridden locally: it shows the prop until the backend reports a change (I-6)', () => {
    const setQueueMode = vi.fn()
    const active = mkSession('a1', { name: 'agent' })
    const mk = (queueMode: string) => buildPaletteActions({
      isAdmin: false, vaultEnabled: false, active, activeActions: [], queueMode, setQueueMode,
      next: vi.fn(), toggleTheme: vi.fn(), openPanel: vi.fn(), openVault: vi.fn(), openContext: vi.fn(), openMemory: vi.fn(), logout: vi.fn(),
    })
    const { type, key } = setup({ actions: mk('interrupt') })
    type('队列')
    key('Enter')
    expect(setQueueMode).toHaveBeenCalledWith('a1', 'collect')
    // The flip is not delivered yet (prop unchanged) → the label still shows the backend value.
    expect(screen.getByText('切换队列模式(当前:Interrupt)')).toBeInTheDocument()
  })
})
