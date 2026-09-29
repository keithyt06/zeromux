import type { SessionInfo } from './api'

/** SendToMenu candidates: agent sessions, same work_dir first, then most recently active.
 *  `sameDirOnly` drops every agent outside `workDir` (repo-scoped prompts, A2). */
export function sendTargets(sessions: SessionInfo[], workDir: string | null, excludeId?: string, sameDirOnly = false): SessionInfo[] {
  return sessions
    .filter(s => s.type !== 'tmux' && s.id !== excludeId && (!sameDirOnly || s.work_dir === workDir))
    .map((s, i) => ({ s, i, same: workDir != null && s.work_dir === workDir ? 0 : 1 }))
    .sort((a, b) => a.same - b.same || b.s.last_activity_ms - a.s.last_activity_ms || a.i - b.i)
    .map(x => x.s)
}
