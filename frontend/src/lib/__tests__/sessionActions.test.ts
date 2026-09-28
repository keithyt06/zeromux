import { describe, it, expect, vi } from 'vitest'
import { sessionActions } from '../sessionActions'
import type { SessionInfo } from '../api'

const base = { id: 's', name: 'n', cols: 80, rows: 24, work_dir: '/w', description: '', status: 'idle', running: true,
  turn_state: 'idle', turn_started_ms: null, last_activity_ms: 0, turns_completed: 0, tmux_name: null, tmux_origin: null,
  other_clients: 0 } as const
const env = () => ({ rename: vi.fn(), close: vi.fn(), openHistory: vi.fn() })

describe('sessionActions', () => {
  it('tmux: copy attach, rename, history, close — in that order', () => {
    const ids = sessionActions({ ...base, type: 'tmux', tmux_name: 'zmx-1', tmux_origin: 'own' } as SessionInfo, env()).map(a => a.id)
    expect(ids).toEqual(['copy-attach', 'rename', 'history', 'close'])
  })
  it('claude with a peer name: rename, copy peer, close', () => {
    const ids = sessionActions({ ...base, type: 'claude', peer_name: 'zmx-ai-abc' } as SessionInfo, env()).map(a => a.id)
    expect(ids).toEqual(['rename', 'copy-peer', 'close'])
  })
  it('codex/crew: rename, close; close is danger and calls env.close', () => {
    const e = env()
    const acts = sessionActions({ ...base, type: 'codex' } as SessionInfo, e)
    expect(acts.map(a => a.id)).toEqual(['rename', 'close'])
    const close = acts.find(a => a.id === 'close')!
    expect(close.danger).toBe(true)
    close.run(); expect(e.close).toHaveBeenCalledWith('s')
  })
  it('labels: rename covers description', () => {
    expect(sessionActions({ ...base, type: 'crew' } as SessionInfo, env())[0].label).toBe('重命名 / 描述…')
  })

  // Ported from SessionRowMenu.test.tsx (Task 9 Step 4): menu-item set + copy toasts.
  // The narrow-screen rename-focus assertion (SessionRowMenu.test.tsx :36) is a UI
  // concern (Sheet close must not steal focus back) — stays for Task 11.
  it('copies the attach command with the correct tmux attach string', async () => {
    const acts = sessionActions({ ...base, type: 'tmux', tmux_name: 'zmx-3f2a9c1e', tmux_origin: 'own' } as SessionInfo, env())
    const copyAttach = acts.find(a => a.id === 'copy-attach')!
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await copyAttach.run()
    expect(writeText).toHaveBeenCalledWith("tmux attach -t '=zmx-3f2a9c1e'")
  })
  it('agent sessions (no tmux_name) have no attach item; close is always present', () => {
    const ids = sessionActions({ ...base, type: 'claude', tmux_name: null, tmux_origin: null } as SessionInfo, env()).map(a => a.id)
    expect(ids).not.toContain('copy-attach')
    expect(ids).toContain('close')
  })
})
