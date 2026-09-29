import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import GitViewer from '../GitViewer'
import * as api from '../../lib/api'
import type { SessionStatus } from '../../lib/api'
import { mkSession } from '../../test/appHarness'
import { DialogHost } from '../ui'
import { commitPrompt, discardPrompt } from '../../lib/gitviewer'

const COMMIT_PROMPT = commitPrompt('/w')
const DISCARD_PROMPT = discardPrompt('/w')

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

  // Task 13: with `sendTo`, 「让 agent 处理」 opens SendToMenu (no native confirm).
  const mount = () => {
    vi.spyOn(api, 'getSessionStatus').mockResolvedValue({ work_dir: '/w', git_branch: 'main', git_dirty: 1, is_git: true })
    vi.spyOn(api, 'getGitLog').mockResolvedValue({ total: 0, entries: [] })
    vi.spyOn(api, 'getGitWorktree').mockResolvedValue({
      is_git: true, truncated: false, diff: '',
      files: [{ path: 'a.rs', status: ' M', staged: false, old_path: undefined }],
    })
    const sendPrompt = vi.fn(() => true)
    const confirmSpy = vi.spyOn(window, 'confirm')
    const sendTo = {
      workDir: '/w', sessions: [mkSession('me', { name: 'this-agent', work_dir: '/w' }), mkSession('o', { name: 'other', work_dir: '/x', last_activity_ms: 50 })],
      controls: { current: { me: { sendPrompt } as never } }, queueModes: {}, onSelectSession: vi.fn(), onNew: vi.fn(),
    }
    render(<><GitViewer sessionId="me" sendTo={sendTo} /><DialogHost /></>)
    return { sendPrompt, confirmSpy, sendTo }
  }
  it('让 agent 提交 → SendToMenu; the current session is ★ first; picking it sends COMMIT_PROMPT', async () => {
    const { sendPrompt, confirmSpy } = mount()
    fireEvent.click(await screen.findByText('让 agent 提交'))
    const items = screen.getAllByRole('menuitem')
    expect(items[0]).toHaveTextContent('★ this-agent')
    fireEvent.click(items[0])
    expect(sendPrompt).toHaveBeenCalledWith(COMMIT_PROMPT, { withAttachments: false })
    expect(confirmSpy).not.toHaveBeenCalled()
  })
  it('让 agent 撤销改动 → SendToMenu (no native confirm); 新开 carries DISCARD_PROMPT', async () => {
    const { sendPrompt, confirmSpy, sendTo } = mount()
    fireEvent.click(await screen.findByText('让 agent 撤销改动'))
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(screen.getByText('发送前请确认内容不含密钥')).toBeInTheDocument()
    fireEvent.click(screen.getByText('＋ 新开…'))
    expect(sendTo.onNew).toHaveBeenCalledWith({ workDir: '/w', prompt: DISCARD_PROMPT })
    expect(sendPrompt).not.toHaveBeenCalled()
  })
  it('让 agent 撤销改动 → pick ★ → irreversibility confirm; cancel sends nothing, 发送 sends DISCARD_PROMPT', async () => {
    const { sendPrompt, confirmSpy } = mount()
    fireEvent.click(await screen.findByText('让 agent 撤销改动'))
    expect(screen.getByRole('menu', { name: '撤销改动 → 发给…' })).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('menuitem')[0])
    expect(await screen.findByText('让 agent 撤销当前工作区的全部未提交改动?此操作不可恢复。 → this-agent(/w)')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByText('取消')) })
    expect(sendPrompt).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('让 agent 撤销改动'))
    fireEvent.click(screen.getAllByRole('menuitem')[0])
    await act(async () => { fireEvent.click(await screen.findByText('发送')) })
    expect(sendPrompt).toHaveBeenCalledWith(DISCARD_PROMPT, { withAttachments: false })
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('A2: an agent in another repo is never offered for commit/discard', async () => {
    mount()
    fireEvent.click(await screen.findByText('让 agent 撤销改动'))
    expect(screen.queryByRole('menuitem', { name: '发给 other' })).toBeNull()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    fireEvent.click(screen.getByText('让 agent 提交'))
    expect(screen.queryByRole('menuitem', { name: '发给 other' })).toBeNull()
  })
})
