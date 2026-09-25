import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Sidebar from '../Sidebar'
import * as api from '../../lib/api'
import type { SearchResult } from '../../lib/api'

const sec = <T,>(kind: 'dirs' | 'notes', items: T[]) => ({ kind, indexing: false, refreshing: false, truncated: false, items })
const R = (dirs: SearchResult['dirs'], notes: SearchResult['notes']): SearchResult => ({ dirs, notes })

function setup(over: Partial<React.ComponentProps<typeof Sidebar>> = {}) {
  const onCreate = vi.fn(), onOpenVault = vi.fn(), onToggle = vi.fn()
  const props = {
    sessions: [], docTabs: [], activeId: null, onSelect: vi.fn(), onCreate, onOpenVault,
    onDelete: vi.fn(), onRename: vi.fn(), hasUnread: () => false, onLogout: vi.fn(),
    theme: 'dark' as const, onToggleTheme: vi.fn(), user: { id: 'u', login: 'u', avatar: null, role: 'admin', status: 'active' } as api.UserInfo,
    open: true, onToggle, mobile: false, ...over,
  }
  render(<Sidebar {...props} />)
  return { onCreate, onOpenVault, onToggle }
}

// BrandIcons' SVGs carry <title>Claude Code</title> / <title>Codex</title>, so a bare
// text query matches both the icon and the label — target the label <div>.
const LABEL = { selector: 'div' }

async function openAndType(q: string, placeholder = '搜索目录或笔记…') {
  fireEvent.click(screen.getByText('New session'))
  const input = await screen.findByPlaceholderText(placeholder)
  fireEvent.change(input, { target: { value: q } })
  return input
}

describe('Sidebar New Session search', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.spyOn(api, 'getSchedulerHealth').mockResolvedValue({ heartbeat_ms: 1, healthy: true })
    vi.spyOn(api, 'getVaultMeta').mockResolvedValue({ enabled: true, name: 'obsidian' })
    vi.spyOn(api, 'listQuickTargets').mockResolvedValue({ top: [] })
    vi.spyOn(api, 'listPrompts').mockResolvedValue([])
  })

  it('warms the index when the popover opens', async () => {
    const warm = vi.spyOn(api, 'warmSearchIndex').mockResolvedValue()
    setup()
    fireEvent.click(screen.getByText('New session'))
    await waitFor(() => expect(warm).toHaveBeenCalledWith('dirs,notes'))
  })

  it('dir hit with a known agent creates in one tap', async () => {
    vi.spyOn(api, 'warmSearchIndex').mockResolvedValue()
    vi.spyOn(api, 'searchPaths').mockResolvedValue(R(sec('dirs', [{ path: '/h/zeromux', display: 'zeromux', hint: '~', agent: 'claude', score: 80 }]), sec('notes', [])))
    const { onCreate } = setup()
    await openAndType('zmx')
    fireEvent.click(await screen.findByText('zeromux'))
    expect(onCreate).toHaveBeenCalledWith('claude', '/h/zeromux')
  })

  it('dir hit without agent → pick-type → creates directly (no prompt page)', async () => {
    vi.spyOn(api, 'warmSearchIndex').mockResolvedValue()
    vi.spyOn(api, 'searchPaths').mockResolvedValue(R(sec('dirs', [{ path: '/h/new-repo', display: 'new-repo', hint: '~', agent: null, score: 80 }]), sec('notes', [])))
    const { onCreate } = setup()
    await openAndType('new')
    fireEvent.click(await screen.findByText('new-repo'))
    fireEvent.click(await screen.findByText('Claude Code', LABEL))
    expect(onCreate).toHaveBeenCalledWith('claude', '/h/new-repo')
    expect(screen.queryByPlaceholderText('给 agent 的第一条指令，留空则只创建会话')).toBeNull()
  })

  it('note row opens the vault; ⚡ goes to pick-type without Terminal then a prefilled prompt', async () => {
    vi.spyOn(api, 'warmSearchIndex').mockResolvedValue()
    const hit = { path: '考研英语/2019/英语二/阅读理解/Text3.md', kind: 'note' as const, display: 'Text3', hint: '考研英语/2019/英语二/阅读理解', abs_dir: '/v/考研英语/2019/英语二/阅读理解', score: 90 }
    vi.spyOn(api, 'searchPaths').mockResolvedValue(R(sec('dirs', []), sec('notes', [hit])))
    const { onCreate, onOpenVault } = setup()
    await openAndType('19t3')
    fireEvent.click(await screen.findByText('Text3'))
    expect(onOpenVault).toHaveBeenCalledWith({ path: hit.path, kind: 'note' })

    await openAndType('19t3')
    fireEvent.click(await screen.findByTestId('sr-ask'))
    expect(await screen.findByText('Claude Code', LABEL)).toBeInTheDocument()
    expect(screen.queryByText('Terminal')).toBeNull()   // tmux would drop the context
    fireEvent.click(screen.getByText('Claude Code', LABEL))
    const ta = await screen.findByPlaceholderText('给 agent 的第一条指令，留空则只创建会话') as HTMLTextAreaElement
    expect(ta.value.startsWith(`当前笔记：${hit.abs_dir}/Text3.md`)).toBe(true)
    fireEvent.click(screen.getByText('Create & send'))
    expect(onCreate).toHaveBeenCalledWith('claude', hit.abs_dir, undefined, ta.value)
  })

  it('stale search responses are dropped', async () => {
    vi.spyOn(api, 'warmSearchIndex').mockResolvedValue()
    let resolveSlow!: (r: SearchResult) => void
    vi.spyOn(api, 'searchPaths')
      .mockImplementationOnce(() => new Promise(r => { resolveSlow = r }))
      .mockResolvedValueOnce(R(sec('dirs', [{ path: '/h/fast', display: 'fast', hint: '~', agent: null, score: 1 }]), sec('notes', [])))
    setup()
    const input = await openAndType('s')
    await act(async () => { vi.advanceTimersByTime(200) })
    fireEvent.change(input, { target: { value: 'fa' } })
    await act(async () => { vi.advanceTimersByTime(200) })
    await screen.findByText('fast')
    await act(async () => { resolveSlow(R(sec('dirs', [{ path: '/h/slow', display: 'slow', hint: '~', agent: null, score: 1 }]), sec('notes', []))) })
    expect(screen.queryByText('slow')).toBeNull()
    expect(screen.getByText('fast')).toBeInTheDocument()
  })

  it('back from pick-type keeps the query', async () => {
    vi.spyOn(api, 'warmSearchIndex').mockResolvedValue()
    vi.spyOn(api, 'searchPaths').mockResolvedValue(R(sec('dirs', [{ path: '/h/x', display: 'x-repo', hint: '~', agent: null, score: 1 }]), sec('notes', [])))
    setup()
    await openAndType('xr')
    fireEvent.click(await screen.findByText('x-repo'))
    fireEvent.click(await screen.findByTitle('返回'))
    expect((screen.getByPlaceholderText('搜索目录或笔记…') as HTMLInputElement).value).toBe('xr')
  })

  it('indexing sections are re-queried automatically (no retyping needed after a restart)', async () => {
    vi.spyOn(api, 'warmSearchIndex').mockResolvedValue()
    const spy = vi.spyOn(api, 'searchPaths')
      .mockResolvedValueOnce(R({ ...sec('dirs', []), indexing: true }, { ...sec('notes', []), indexing: true }))
      .mockResolvedValue(R(sec('dirs', []), sec('notes', [{ path: 'n.md', kind: 'note', display: 'ready', hint: '', abs_dir: '/v', score: 1 }])))
    setup()
    await openAndType('rea')
    await act(async () => { vi.advanceTimersByTime(200) })
    await screen.findByText('正在建立笔记索引…')
    await act(async () => { vi.advanceTimersByTime(4100) })
    await screen.findByText('ready')
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('folder ⋮ 在此开 agent → pick type → creates directly in that folder', async () => {
    vi.spyOn(api, 'warmSearchIndex').mockResolvedValue()
    const f = { path: 'p/x', kind: 'folder' as const, display: 'x', hint: 'p', abs_dir: '/v/p/x', score: 5 }
    vi.spyOn(api, 'searchPaths').mockResolvedValue(R(sec('dirs', []), sec('notes', [f])))
    const { onCreate } = setup()
    await openAndType('x')
    fireEvent.click(await screen.findByTestId('sr-menu'))
    fireEvent.click(screen.getByText('在此开 agent'))
    fireEvent.click(await screen.findByText('Codex', LABEL))
    expect(onCreate).toHaveBeenCalledWith('codex', '/v/p/x')
  })

  it('without vault only dirs are requested', async () => {
    vi.spyOn(api, 'getVaultMeta').mockResolvedValue({ enabled: false, name: '' })
    vi.spyOn(api, 'warmSearchIndex').mockResolvedValue()
    const spy = vi.spyOn(api, 'searchPaths').mockResolvedValue(R(sec('dirs', []), null))
    setup()
    await openAndType('abc', '搜索目录…')
    await act(async () => { vi.advanceTimersByTime(200) })
    await waitFor(() => expect(spy).toHaveBeenCalled())
    expect(spy.mock.calls[0][1]).toBe('dirs')
    expect(screen.getByPlaceholderText('搜索目录…')).toBeInTheDocument()
  })

  it('search input is ≥16px so iOS Safari does not zoom on focus', async () => {
    vi.spyOn(api, 'warmSearchIndex').mockResolvedValue()
    setup()
    const input = await openAndType('')
    expect(input.className).toContain('text-base')
    expect(input.className).not.toMatch(/\btext-xs\b/)
  })

  it('askAgentRequest opens the popover even when the desktop sidebar is collapsed', async () => {
    vi.spyOn(api, 'warmSearchIndex').mockResolvedValue()
    const { onToggle } = setup({ open: false, mobile: false, askAgentRequest: { absDir: '/v/a', relPath: 'a/n.md', kind: 'note', nonce: 1 } })
    expect(onToggle).toHaveBeenCalled()
  })

  it('askAgentRequest from VaultReader opens the flow once per nonce', async () => {
    vi.spyOn(api, 'warmSearchIndex').mockResolvedValue()
    setup({ askAgentRequest: { absDir: '/v/a', relPath: 'a/n.md', kind: 'note', nonce: 1 } })
    expect(await screen.findByText('Claude Code', LABEL)).toBeInTheDocument()
    expect(screen.queryByText('Terminal')).toBeNull()
  })
})
