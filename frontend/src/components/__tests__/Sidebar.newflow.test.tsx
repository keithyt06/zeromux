import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Sidebar from '../Sidebar'
import * as api from '../../lib/api'

function setup(over: Partial<React.ComponentProps<typeof Sidebar>> = {}) {
  const onCreate = over.onCreate ?? vi.fn().mockResolvedValue(undefined)
  const props = {
    sessions: [], docTabs: [], activeId: null, onSelect: vi.fn(), onCreate, onOpenVault: vi.fn(),
    onDelete: vi.fn(), onRename: vi.fn(), hasUnread: () => false, onLogout: vi.fn(),
    theme: 'dark' as const, onToggleTheme: vi.fn(), themePref: 'dark' as const, onSetThemePref: vi.fn(),
    user: { id: 'u', login: 'u', avatar: null, role: 'admin', status: 'active' } as api.UserInfo,
    open: true, onToggle: vi.fn(), mobile: false, hostTmux: [], onOpenPanel: vi.fn(), ...over,
  }
  render(<Sidebar {...props} />)
  return { onCreate }
}

describe('Sidebar new terminal flow', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(api, 'getSchedulerHealth').mockResolvedValue({ heartbeat_ms: 1, healthy: true })
    vi.spyOn(api, 'getVaultMeta').mockResolvedValue({ enabled: false, name: '' })
    vi.spyOn(api, 'listQuickTargets').mockResolvedValue({ top: [] })
    vi.spyOn(api, 'listPrompts').mockResolvedValue([])
    vi.spyOn(api, 'listDirectories').mockResolvedValue({ current: '/home/u', parent: null, home: '/home/u', entries: [] })
  })

  it('Terminal goes straight to the directory picker (no New Shell / Attach step)', async () => {
    setup()
    fireEvent.click(screen.getByText('New session'))
    fireEvent.click(await screen.findByText('其他目录…'))
    fireEvent.click(screen.getByText('Terminal', { selector: 'div' }))
    expect(screen.queryByText('New Shell')).toBeNull()
    expect(screen.queryByText('Attach tmux')).toBeNull()
    await waitFor(() => expect(api.listDirectories).toHaveBeenCalled())
  })

  it('host tmux group lists untracked sessions and attaches on click', () => {
    const { onCreate } = setup({ hostTmux: [
      { name: 'vscode-dev', windows: 3, attached: 1, created: 0, path: '/w' },
      { name: 'zmx-deadbeef', windows: 1, attached: 0, created: 0, path: '/w' },
    ] })
    expect(screen.getByText('本机 tmux')).toBeInTheDocument()
    expect(screen.getByText('3 win · 🖥1')).toBeInTheDocument()
    expect(screen.getByText('zeromux 遗留')).toBeInTheDocument()
    fireEvent.click(screen.getByText('vscode-dev'))
    expect(onCreate).toHaveBeenCalledWith('tmux', undefined, 'vscode-dev')
  })

  it('no host group when list is empty', () => {
    setup({ hostTmux: [] })
    expect(screen.queryByText('本机 tmux')).toBeNull()
  })

  it('create failure keeps the popover open and shows the error; retry success closes it', async () => {
    vi.spyOn(api, 'listQuickTargets').mockResolvedValue({ top: [
      { kind: 'dir', path: '/w/p', agent: 'claude', display: 'p', hint: '/w/p' },
    ] })
    const onCreate = vi.fn()
      .mockRejectedValueOnce(new Error('work_dir not allowed'))
      .mockResolvedValueOnce(undefined)
    setup({ onCreate })
    fireEvent.click(screen.getByText('New session'))
    fireEvent.click(await screen.findByText('p'))
    expect(await screen.findByText(/创建失败:work_dir not allowed/)).toBeInTheDocument()
    expect(screen.getByText('其他目录…')).toBeInTheDocument()     // popover still open
    fireEvent.click(screen.getByText('p'))
    await waitFor(() => expect(screen.queryByText('其他目录…')).toBeNull())
    expect(screen.queryByText(/创建失败/)).toBeNull()
  })

  it('reopening the popover via New session clears a stale create error', async () => {
    vi.spyOn(api, 'listQuickTargets').mockResolvedValue({ top: [
      { kind: 'dir', path: '/w/p', agent: 'claude', display: 'p', hint: '/w/p' },
    ] })
    const onCreate = vi.fn().mockRejectedValueOnce(new Error('work_dir not allowed'))
    setup({ onCreate })
    fireEvent.click(screen.getByText('New session'))
    fireEvent.click(await screen.findByText('p'))
    expect(await screen.findByText(/创建失败:work_dir not allowed/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('New session'))
    expect(screen.queryByText(/创建失败/)).toBeNull()
  })
  it('double tap on a quick target while create is in flight creates only one session', async () => {
    vi.spyOn(api, 'listQuickTargets').mockResolvedValue({ top: [
      { kind: 'dir', path: '/w/p', agent: 'claude', display: 'p', hint: '/w/p' },
    ] })
    const onCreate = vi.fn(() => new Promise<void>(() => {}))   // never resolves
    setup({ onCreate })
    fireEvent.click(screen.getByText('New session'))
    const row = await screen.findByText('p')
    fireEvent.click(row)
    fireEvent.click(row)
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('创建中…')).toBeInTheDocument()
  })
})

describe('Sidebar panel entries route to App (T11)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(api, 'getSchedulerHealth').mockResolvedValue({ heartbeat_ms: 1, healthy: true })
    vi.spyOn(api, 'getVaultMeta').mockResolvedValue({ enabled: false, name: '' })
    vi.spyOn(api, 'listQuickTargets').mockResolvedValue({ top: [] })
    vi.spyOn(api, 'listPrompts').mockResolvedValue([])
  })
  it('Clock and Settings items call onOpenPanel instead of mounting panels inline', () => {
    const onOpenPanel = vi.fn()
    setup({ onOpenPanel })
    fireEvent.click(screen.getByTitle('定时任务'))
    expect(onOpenPanel).toHaveBeenLastCalledWith('scheduled')
    for (const [label, p] of [['推送通知', 'push'], ['常用 prompt 管理', 'prompts'], ['用户管理', 'admin']] as const) {
      fireEvent.click(screen.getByText('Settings'))
      fireEvent.click(screen.getByText(label))
      expect(onOpenPanel).toHaveBeenLastCalledWith(p)
    }
    expect(screen.queryByRole('dialog', { hidden: true })).toBeNull()
  })
})

describe('New session popover (T12)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(api, 'getSchedulerHealth').mockResolvedValue({ heartbeat_ms: 1, healthy: true })
    vi.spyOn(api, 'getVaultMeta').mockResolvedValue({ enabled: false, name: '' })
    vi.spyOn(api, 'listPrompts').mockResolvedValue([])
    vi.spyOn(api, 'listQuickTargets').mockResolvedValue({ top: [
      { kind: 'dir', path: '/w/p', agent: 'claude', display: 'p', hint: '/w/p' },
    ] })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('manage-prompts is a sub-view of the same popover (no second Sheet), back returns to pick-prompt', async () => {
    // Narrow: the popover itself is the bottom Sheet — a manager Sheet would nest.
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('max-width'), addEventListener() {}, removeEventListener() {} }))
    setup({ mobile: true })
    fireEvent.click(screen.getByText('New session'))
    fireEvent.click(await screen.findByTestId('qt-menu'))
    fireEvent.click(await screen.findByText('带 prompt 打开'))
    fireEvent.click(await screen.findByText('✎ 管理'))
    expect(await screen.findByText('还没有常用 prompt，点下面新建。')).toBeInTheDocument()
    expect(screen.getAllByRole('dialog', { hidden: true })).toHaveLength(1)
    expect(screen.queryByLabelText('close manager')).toBeNull()      // one close, not two
    fireEvent.click(screen.getByLabelText('返回'))
    expect(await screen.findByText('Initial prompt (optional)')).toBeInTheDocument()
  })

  it('theme is a segmented control, not a menu item', () => {
    const onSetThemePref = vi.fn()
    setup({ onSetThemePref })
    const g = screen.getByRole('radiogroup', { name: '主题' })
    expect(screen.getByRole('radio', { name: '深色' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('radio', { name: '浅色' }))
    expect(onSetThemePref).toHaveBeenCalledWith('light')
    fireEvent.click(screen.getByText('Settings'))
    expect(screen.getByRole('menu')).not.toContainElement(g)
  })

  it('as a bottom Sheet the quick step does not repeat the 新建会话 title', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('max-width'), addEventListener() {}, removeEventListener() {} }))
    setup({ mobile: true })
    fireEvent.click(screen.getByText('New session'))
    await screen.findByText('其他目录…')
    expect(screen.getAllByText('新建会话')).toHaveLength(1)
  })
})
