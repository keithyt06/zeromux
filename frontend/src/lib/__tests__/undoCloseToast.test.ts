import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../api', () => ({ restoreSession: vi.fn() }))
import { restoreSession } from '../api'
import { toast } from '../../components/ui/toast'
import { undoCloseToast } from '../undoCloseToast'

describe('undoCloseToast (I-18 undo-close payload)', () => {
  beforeEach(() => { vi.mocked(restoreSession).mockReset() })

  it('keys by session, labels 撤销, passes durationMs through untouched', () => {
    const t = undoCloseToast('abc', 'api', 3217, async () => {})
    expect(t).toMatchObject({ key: 'undo-abc', message: '已关闭 api', durationMs: 3217, action: { label: '撤销' } })
  })

  it('clicking the action retries through restoreSession and runs onRestore on success', async () => {
    vi.mocked(restoreSession).mockResolvedValue(true)
    const onRestore = vi.fn(async () => {})
    const push = vi.spyOn(toast, 'push')
    await undoCloseToast('abc', 'api', 4500, onRestore).action.onClick()
    expect(restoreSession).toHaveBeenCalledWith('abc')
    expect(onRestore).toHaveBeenCalledTimes(1)
    expect(push).not.toHaveBeenCalled()
    push.mockRestore()
  })

  it('failed restore surfaces the failure message via toast', async () => {
    vi.mocked(restoreSession).mockResolvedValue(false)
    const onRestore = vi.fn(async () => {})
    const push = vi.spyOn(toast, 'push')
    await undoCloseToast('abc', 'api', 4500, onRestore).action.onClick()
    expect(onRestore).not.toHaveBeenCalled()
    expect(push).toHaveBeenCalledWith({ message: '撤销失败，会话已关闭' })
    push.mockRestore()
  })
})
