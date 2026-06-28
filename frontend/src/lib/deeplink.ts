// After a turn_done deep-link opens a session, route to the worktree diff if the
// agent left uncommitted changes, else stay on the default (chat) view.
export function deepLinkView(dirty: number): 'git' | 'none' {
  return dirty > 0 ? 'git' : 'none'
}
