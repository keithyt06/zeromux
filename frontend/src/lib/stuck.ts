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

// Whether a send should (re)seed the turn/elapsed/silence clocks. A send that
// lands while a turn is already in flight is, in the default Collect queue mode,
// merely enqueued server-side — it does not start a new turn. Re-seeding the
// silence baseline in that case would reset the `stuck` heuristic and HIDE the
// interrupt button on a turn that may be wedged (review 2026-07-25). Only seed
// the clocks when starting a fresh turn (no turn currently busy).
export function shouldSeedTurnClock(wasBusy: boolean): boolean {
  return !wasBusy
}
