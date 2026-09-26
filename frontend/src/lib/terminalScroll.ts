// Touch drag → tmux copy-mode scroll ops (sent over the terminal WS; the server
// runs the tmux commands). Pure helpers + a tiny batcher so a fast drag becomes
// one message per interval instead of one per touchmove.

export type ScrollMsg = { op: 'up' | 'down' | 'top' | 'bottom' | 'cancel'; n: number }

/** `lines` uses linesFromDrag's sign: positive = newer content (down). */
export function dragToScroll(lines: number): ScrollMsg | null {
  if (lines === 0) return null
  return lines < 0 ? { op: 'up', n: -lines } : { op: 'down', n: lines }
}

const MIN_FLICK = 0.5    // px/ms below which there is no inertia
const DECAY = 0.85       // per step
const STEP_MS = 16

/** Signed line deltas for a decaying flick; empty for slow releases. */
export function inertiaLines(velocityPxPerMs: number, rh: number): number[] {
  if (Math.abs(velocityPxPerMs) < MIN_FLICK || rh <= 0) return []
  const out: number[] = []
  let v = velocityPxPerMs
  let carry = 0
  while (Math.abs(v) >= MIN_FLICK / 2 && out.length < 120) {
    carry += (v * STEP_MS) / rh
    const whole = carry < 0 ? Math.ceil(carry) : Math.floor(carry)
    if (whole !== 0) { out.push(whole); carry -= whole }
    v *= DECAY
  }
  return out
}

/** Feed inertia steps to `add`, one per `stepMs`. Returns a cancel that stops
 *  any not-yet-fired steps (new touch, keystroke, unmount). */
export function scheduleInertia(steps: number[], add: (l: number) => void, stepMs = STEP_MS): () => void {
  const timers = steps.map((l, i) => setTimeout(() => add(l), i * stepMs))
  return () => timers.forEach(clearTimeout)
}

export class ScrollBatcher {
  private pending = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  // Explicit fields (not constructor parameter properties): tsconfig sets
  // erasableSyntaxOnly, which forbids `constructor(private send …)`.
  private send: (m: ScrollMsg) => void
  private intervalMs: number
  constructor(send: (m: ScrollMsg) => void, intervalMs = 50) {
    this.send = send
    this.intervalMs = intervalMs
  }

  add(lines: number) {
    if (lines === 0) return
    if (this.pending !== 0 && Math.sign(lines) !== Math.sign(this.pending)) this.flush()
    this.pending += lines
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.intervalMs)
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    const m = dragToScroll(this.pending)
    this.pending = 0
    if (m) this.send(m)
  }

  /** Drop pending lines without sending; the batcher stays usable. */
  cancel() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.pending = 0
  }

  dispose() {
    this.cancel()
  }
}

// Desktop mouse-wheel over a tmux pane (mouse on) goes straight to tmux and
// can enter copy-mode without ever calling sendScroll, so scrollingRef stays
// stale (false) even though the pane really is in copy-mode. On desktop tmux
// sessions, any wheel event since the last exitScroll must force a cancel on
// the next keystroke regardless of scrollingRef — safe because the
// server-side cancel is a no-op outside copy-mode (T2's in_mode guard).
export function shouldCancelBeforeInput(o: { scrolling: boolean; isTouch: boolean; hasTmux: boolean; wheelSinceInput: boolean }): boolean {
  if (o.scrolling) return true
  if (o.isTouch || !o.hasTmux) return false
  return o.wheelSinceInput
}

// Pill state from a server `scroll_state`. CopyMode replies follow `in_mode`.
// AppWheel replies (`app_scroll`: wheel events into a fullscreen app such as
// Claude Code) never have `in_mode`, so the pill is driven by the client's last
// op: up/top raise it, down keeps the current state (`wasUp`), bottom/cancel
// clear it — so a late reply can't reopen a pill the user just closed.
export function pillFromScrollState(
  m: { in_mode?: boolean; app_scroll?: boolean },
  lastOp: ScrollMsg['op'],
  wasUp: boolean,
): { scrolling: boolean; appScroll: boolean } {
  if (!m.app_scroll) return { scrolling: !!m.in_mode, appScroll: false }
  const reading = lastOp === 'up' || lastOp === 'top' ? true : lastOp === 'down' ? wasUp : false
  return { scrolling: reading, appScroll: reading }
}
