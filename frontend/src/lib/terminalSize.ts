// Mirrors src/session_manager.rs MIN_COLS/MIN_ROWS (server drops smaller resizes).
export const MIN_COLS = 20
export const MIN_ROWS = 5

/** Whether a TerminalView may send its fitted size to the PTY. A hidden
 *  (display:none) view has a 0x0 container and FitAddon falls back to ~10x5;
 *  with tmux `window-size latest` that tiny size would shrink the shared
 *  window, so only the active, visible view with sane dims may resize. */
export function shouldSendResize(o: {
  active: boolean
  containerWidth: number
  containerHeight: number
  cols: number
  rows: number
  last: { cols: number; rows: number }
}): boolean {
  return o.active
    && o.containerWidth > 0 && o.containerHeight > 0
    && o.cols >= MIN_COLS && o.rows >= MIN_ROWS
    && (o.cols !== o.last.cols || o.rows !== o.last.rows)
}
