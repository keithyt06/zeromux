import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import GitViewer from '../GitViewer'
import * as api from '../../lib/api'

// Live 2026-09-28: an agent session in /home/ubuntu (not a repo) showed the raw
// `git log error: fatal: not a git repository …` stderr in 历史提交.
const NOT_REPO = 'git log error: fatal: not a git repository (or any parent up to mount point /home/ubuntu)'
const status = (is_git: boolean) => ({ work_dir: '/home/ubuntu', git_branch: is_git ? 'main' : null, git_dirty: 0, is_git })

describe('GitViewer outside a git repo', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('a not-a-repo log error shows the friendly empty state, never the raw stderr', async () => {
    vi.spyOn(api, 'getSessionStatus').mockResolvedValue(status(true))   // log error alone must suffice
    vi.spyOn(api, 'getGitLog').mockRejectedValue(new Error(NOT_REPO))
    render(<GitViewer sessionId="s1" />)
    expect(await screen.findByText('当前目录不是 git 仓库')).toBeInTheDocument()
    expect(screen.queryByText(/fatal/)).not.toBeInTheDocument()
  })

  it('status is_git=false: both tabs show the empty state and onNotGit fires', async () => {
    vi.spyOn(api, 'getSessionStatus').mockResolvedValue(status(false))
    vi.spyOn(api, 'getGitLog').mockResolvedValue({ entries: [], total: 0 })
    vi.spyOn(api, 'getGitWorktree').mockResolvedValue({ is_git: false, files: [], diff: '', truncated: false })
    const onNotGit = vi.fn()
    render(<GitViewer sessionId="s1" onNotGit={onNotGit} />)
    await waitFor(() => expect(onNotGit).toHaveBeenCalled())
    expect(screen.getByText('当前目录不是 git 仓库')).toBeInTheDocument()
    expect(screen.queryByText('No commits')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('工作区改动'))
    expect(await screen.findByText('当前目录不是 git 仓库')).toBeInTheDocument()
    expect(screen.queryByText('非 git 仓库')).not.toBeInTheDocument()
  })

  it('other log errors are still shown', async () => {
    vi.spyOn(api, 'getSessionStatus').mockResolvedValue(status(true))
    vi.spyOn(api, 'getGitLog').mockRejectedValue(new Error('git log error: permission denied'))
    const onNotGit = vi.fn()
    render(<GitViewer sessionId="s1" onNotGit={onNotGit} />)
    expect(await screen.findByText('git log error: permission denied')).toBeInTheDocument()
    expect(screen.queryByText('当前目录不是 git 仓库')).not.toBeInTheDocument()
    expect(onNotGit).not.toHaveBeenCalled()
  })
})
