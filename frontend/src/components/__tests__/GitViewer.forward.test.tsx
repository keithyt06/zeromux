import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import GitViewer from '../GitViewer'
import * as api from '../../lib/api'
import type { SessionStatus } from '../../lib/api'

describe('GitViewer forward feedback', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('a later successful forward clears the earlier 未连接,未发送', async () => {
    const status: SessionStatus = { work_dir: '/w', git_branch: 'main', git_dirty: 1, is_git: true }
    vi.spyOn(api, 'getSessionStatus').mockResolvedValue(status)
    vi.spyOn(api, 'getGitLog').mockResolvedValue({ total: 0, entries: [] })
    vi.spyOn(api, 'getGitWorktree').mockResolvedValue({
      is_git: true, truncated: false, diff: '',
      files: [{ path: 'a.rs', status: ' M', staged: false, old_path: undefined }],
    })
    const onForward = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
    render(<GitViewer sessionId="s1" onForward={onForward} />)
    fireEvent.click(await screen.findByText('让 agent 提交'))
    expect(screen.getByText('未连接,未发送')).toBeInTheDocument()
    fireEvent.click(screen.getByText('让 agent 提交'))
    expect(screen.getByText(/已发送给 agent/)).toBeInTheDocument()
    expect(screen.queryByText('未连接,未发送')).toBeNull()
  })
})
