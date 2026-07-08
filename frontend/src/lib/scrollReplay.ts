// Bottom-stick is allowed ONLY inside the replay window and ONLY when the user
// has not scrolled up during it. Live output (replaying=false) never auto-sticks
// so reading scrollback / history is never yanked. Used by both TerminalView
// (self-armed window, no replay_done) and AcpChatView (replay_done marker).
export function shouldStickToBottom(state: { replaying: boolean; userScrolledUp: boolean }): boolean {
  return state.replaying && !state.userScrolledUp
}

// Live-output auto-scroll gate for the chat view. A new event only pulls the view
// to the bottom if the user was already near it (standard "stick unless reading
// history" chat behavior) — measured synchronously BEFORE the new content commits,
// so `distanceFromBottom` reflects the pre-append layout. `force` bypasses the gate
// for the user's own just-sent prompt. Honors the same invariant TerminalView follows:
// output must never yank a reader who scrolled up. NEAR_BOTTOM_PX absorbs last-chunk
// height jitter; a zero-height (hidden / jsdom) container reads as near-bottom.
const NEAR_BOTTOM_PX = 80
export function shouldAutoScrollOnAppend(state: { force: boolean; distanceFromBottom: number }): boolean {
  return state.force || state.distanceFromBottom < NEAR_BOTTOM_PX
}
