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
