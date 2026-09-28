import { describe, it, expect } from 'vitest'
import { sendTargets } from '../sendTargets'
import type { SessionInfo } from '../api'

const s = (id: string, type: SessionInfo['type'], work_dir: string, last: number): SessionInfo => ({
  id, name: id, type, cols: 80, rows: 24, work_dir, description: '', status: 'idle', running: true, turn_state: 'idle',
  turn_started_ms: null, last_activity_ms: last, turns_completed: 0, tmux_name: null, tmux_origin: null, other_clients: 0,
})

describe('sendTargets', () => {
  it('agents only; same work_dir first, then most recent; excludes self', () => {
    const list = [s('t', 'tmux', '/a', 99), s('x', 'codex', '/b', 50), s('y', 'claude', '/a', 10), s('z', 'crew', '/a', 30), s('me', 'claude', '/a', 100)]
    expect(sendTargets(list, '/a', 'me').map(t => t.id)).toEqual(['z', 'y', 'x'])
  })
  it('no work_dir: pure recency', () => {
    expect(sendTargets([s('a', 'claude', '/a', 1), s('b', 'codex', '/b', 2)], null).map(t => t.id)).toEqual(['b', 'a'])
  })
})
