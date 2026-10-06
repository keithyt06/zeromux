import { useCallback, useEffect, useState } from 'react'

// When this device last left the app (F3, spec D4). Local-only by design until
// S6 T0 brings a server-side read state.
export const LEFT_KEY = 'zmx_left_ms'

export function markLeft(now = Date.now()): void {
  try { localStorage.setItem(LEFT_KEY, String(now)) } catch { /* private mode */ }
}

export function readLeft(): number | null {
  try {
    const v = Number(localStorage.getItem(LEFT_KEY))
    return Number.isFinite(v) && v > 0 ? v : null
  } catch { return null }
}

let installed = false
/** Leave-time recorder. App-level and idempotent: TriageList is not rendered in
 *  the collapsed-rail layout, so it can't own these listeners (I3). */
export function installAwayClock(): void {
  if (installed) return
  installed = true
  window.addEventListener('pagehide', () => markLeft())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') markLeft()
  })
}

// Away start of the window the user dismissed. Module-level so a remount or a
// breakpoint change doesn't resurrect the card; a new away window has a new key.
let dismissedKey: string | null = null
function dismissWindow(key: string): void { dismissedKey = key }

interface AwayWindow { leftMs: number | null; backMs: number; dismissed: boolean }

/** The (left, back] window for the away card. Re-read on every resume: an iOS PWA
 *  comes back from the background without reloading, so a mount-time read alone
 *  would never show the card (Review Focus 2). Resuming also clears a dismissal. */
export function useAwayWindow(): AwayWindow & { dismiss(): void } {
  const [w, setW] = useState(() => ({ leftMs: readLeft(), backMs: Date.now() }))
  const [, rerender] = useState(0)
  useEffect(() => {
    installAwayClock()
    const onVis = () => {
      if (document.visibilityState !== 'hidden') setW({ leftMs: readLeft(), backMs: Date.now() })
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])
  const key = String(w.leftMs)
  const dismiss = useCallback(() => { dismissWindow(key); rerender(n => n + 1) }, [key])
  return { ...w, dismissed: dismissedKey === key, dismiss }
}
