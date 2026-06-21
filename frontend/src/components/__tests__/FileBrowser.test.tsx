import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FileBrowser } from '../FileBrowser'
import * as api from '../../lib/api'

describe('FileBrowser', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    localStorage.clear() // persisted browse root must not leak between tests
  })

  it('lists dir entries with breadcrumb root', async () => {
    vi.spyOn(api, 'listDir').mockResolvedValue({
      entries: [
        { name: 'sub', type: 'dir', size: 0, mtime: 0, writable: true },
        { name: 'pic.png', type: 'file', size: 10, mtime: 0, writable: true },
      ],
      truncated: false,
    })

    render(<FileBrowser sessionId="s1" />)

    expect(await screen.findByText('pic.png')).toBeInTheDocument()
    expect(screen.getByText('sub')).toBeInTheDocument()
    // breadcrumb root present
    await waitFor(() => expect(screen.getByText('根目录')).toBeInTheDocument())
  })

  it('drills into a directory on click (re-lists with new cwd, default base)', async () => {
    const spy = vi.spyOn(api, 'listDir').mockResolvedValue({
      entries: [{ name: 'sub', type: 'dir', size: 0, mtime: 0, writable: true }],
      truncated: false,
    })
    render(<FileBrowser sessionId="s1" />)
    const dir = await screen.findByText('sub')
    dir.click()
    // 3rd arg = base_dir, undefined at the default (work_dir) root.
    await waitFor(() => expect(spy).toHaveBeenCalledWith('s1', 'sub', undefined))
  })

  it('default root shows write controls (mkdir + upload)', async () => {
    vi.spyOn(api, 'listDir').mockResolvedValue({ entries: [], truncated: false })
    render(<FileBrowser sessionId="s1" />)
    await waitFor(() => expect(screen.getByTitle('刷新')).toBeInTheDocument())
    expect(screen.getByTitle('新建文件夹')).toBeInTheDocument()
    expect(screen.getByTitle('上传到当前目录')).toBeInTheDocument()
    expect(screen.getByTitle('选择根目录')).toBeInTheDocument()
  })

  it('re-roots via persisted localStorage: lists with base_dir and hides write controls (read-only)', async () => {
    // A persisted root makes the browser start re-rooted (read-only).
    localStorage.setItem('zeromux:fb-root:s1', '/home/ubuntu/other')
    const spy = vi.spyOn(api, 'listDir').mockResolvedValue({ entries: [], truncated: false })
    render(<FileBrowser sessionId="s1" />)
    // Lists the chosen root (base_dir threaded through).
    await waitFor(() => expect(spy).toHaveBeenCalledWith('s1', '', '/home/ubuntu/other'))
    // Read-only: write controls absent, root-picker still present.
    expect(screen.queryByTitle('新建文件夹')).not.toBeInTheDocument()
    expect(screen.queryByTitle('上传到当前目录')).not.toBeInTheDocument()
    expect(screen.getByTitle('选择根目录')).toBeInTheDocument()
    // Breadcrumb shows the chosen root basename + a reset affordance.
    expect(screen.getByText('other')).toBeInTheDocument()
    expect(screen.getByTitle('回到会话工作目录')).toBeInTheDocument()
  })

  it('reset returns to work_dir root (default base, write controls back)', async () => {
    localStorage.setItem('zeromux:fb-root:s1', '/home/ubuntu/other')
    const spy = vi.spyOn(api, 'listDir').mockResolvedValue({ entries: [], truncated: false })
    render(<FileBrowser sessionId="s1" />)
    await waitFor(() => expect(screen.getByTitle('回到会话工作目录')).toBeInTheDocument())
    screen.getByTitle('回到会话工作目录').click()
    // Re-lists with no base_dir (back to work_dir) and write controls reappear.
    await waitFor(() => expect(spy).toHaveBeenCalledWith('s1', '', undefined))
    await waitFor(() => expect(screen.getByTitle('新建文件夹')).toBeInTheDocument())
    expect(localStorage.getItem('zeromux:fb-root:s1')).toBeNull()
  })
})
