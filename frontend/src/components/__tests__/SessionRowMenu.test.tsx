import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import SessionRowMenu from '../SessionRowMenu'
import type { SessionInfo } from '../../lib/api'

const s = (over: Partial<SessionInfo> = {}) => ({
  id: 'i', name: 'api', type: 'tmux', cols: 80, rows: 24, work_dir: '/w', description: '', status: 'idle',
  running: true, turn_state: null, turn_started_ms: null, last_activity_ms: 0, turns_completed: 0,
  source_task_id: null, tmux_name: 'zmx-3f2a9c1e', tmux_origin: 'own', other_clients: 0, ...over,
}) as SessionInfo

describe('SessionRowMenu', () => {
  it('copies the attach command', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    // happy-dom's navigator.clipboard is a getter-only accessor; defineProperty
    // replaces it (see HistoryView.test.tsx for the same workaround).
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<SessionRowMenu session={s()} onRename={vi.fn()} onClose={vi.fn()} />)
    fireEvent.click(screen.getByLabelText('会话菜单'))
    fireEvent.click(screen.getByText('复制接续命令'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("tmux attach -t '=zmx-3f2a9c1e'"))
  })
  it('agent sessions have no attach item; close always present', () => {
    const onClose = vi.fn()
    render(<SessionRowMenu session={s({ type: 'claude', tmux_name: null, tmux_origin: null })} onRename={vi.fn()} onClose={onClose} />)
    fireEvent.click(screen.getByLabelText('会话菜单'))
    expect(screen.queryByText('复制接续命令')).toBeNull()
    fireEvent.click(screen.getByText('关闭'))
    expect(onClose).toHaveBeenCalled()
  })
})
