// Mirror of Rust STUCK_SILENCE_MS (sidebar amber dot threshold). The push
// threshold is separate and higher (600s, backend-only) to suppress noise.
export const STUCK_SILENCE_MS = 180_000

export function isStuck(
  turnState: string | null,
  lastActivityMs: number | null,
  nowMs: number,
): boolean {
  if (turnState !== 'running' || lastActivityMs == null) return false
  return nowMs - lastActivityMs > STUCK_SILENCE_MS
}

// Whether a send should (re)seed the turn/elapsed/silence clocks.
//
// A send onto an already-running turn only skips (re)seeding in the default
// Collect mode, where it is merely enqueued server-side — re-seeding there would
// reset the silence baseline of the running turn, resetting the `stuck` heuristic
// and HIDING the interrupt button on a turn that may be wedged (review 2026-07-25).
//
// But in Interrupt mode a send while busy is NOT enqueued: the backend interrupts
// the running turn and starts a genuinely fresh one (turn_seq++/mark_turn Running,
// session_manager.rs). That fresh turn MUST reseed the clocks, or it inherits the
// interrupted turn's turnStartedMs/lastEventMs — painting an inflated elapsed and,
// if the old turn was silent past the threshold, a false "可能卡住" on a brand-new
// turn (F-FE-1, 2026-07-25). So: seed when starting a fresh turn (not busy) OR when
// the busy send is not collect-queued (any non-collect mode replaces the turn).
export function shouldSeedTurnClock(wasBusy: boolean, queueMode: string): boolean {
  return !wasBusy || queueMode !== 'collect'
}
