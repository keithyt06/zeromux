// Bottom-stick is allowed ONLY inside the replay window and ONLY when the user
// has not scrolled up during it. Live output (replaying=false) never auto-sticks
// so reading scrollback / history is never yanked. Used by both TerminalView
// (self-armed window, no replay_done) and AcpChatView (replay_done marker).
export function shouldStickToBottom(state: { replaying: boolean; userScrolledUp: boolean }): boolean {
  return state.replaying && !state.userScrolledUp
}
