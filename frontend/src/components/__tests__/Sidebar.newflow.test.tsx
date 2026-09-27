import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Sidebar from '../Sidebar'
import * as api from '../../lib/api'

function setup(over: Partial<React.ComponentProps<typeof Sidebar>> = {}) {
  const onCreate = over.onCreate ?? vi.fn().mockResolvedValue(undefined)
  const props = {
    sessions: [], docTabs: [], activeId: null, onSelect: vi.fn(), onCreate, onOpenVault: vi.fn(),
    onDelete: vi.fn(), onRename: vi.fn(), hasUnread: () => false, onLogout: vi.fn(),
    theme: 'dark' as const, onToggleTheme: vi.fn(), themePref: 'dark' as const, onSetThemePref: vi.fn(),
    user: { id: 'u', login: 'u', avatar: null, role: 'admin', status: 'active' } as api.UserInfo,
    open: true, onToggle: vi.fn(), mobile: false, hostTmux: [], ...over,
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
