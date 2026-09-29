import { lazy } from 'react'

const KEY = 'zmx_chunk_reload'
export const STABLE_AFTER_MS = 10_000

// Page-lifetime state. The sessionStorage stamp survives the reload it triggers and
// is cleared only once the reloaded page has proven stable (STABLE_AFTER_MS up, no
// lazy import in flight, none failed) — so a chunk that keeps failing, however slowly,
// gets at most ONE automatic reload per tab session.
let pending = 0
let failed = false
let stable = false

function clearIfStable() {
  if (stable && pending === 0 && !failed) {
    try { sessionStorage.removeItem(KEY) } catch { /* private mode */ }
  }
}

/** main.tsx calls this STABLE_AFTER_MS after mount. */
export function markPageStable(): void { stable = true; clearIfStable() }

/** A deploy swapped the embedded chunks, so an old page's lazy import 404s. Reload
 *  once to pick up the new index.html. Refuses (returns false → caller throws → the
 *  ErrorBoundary) when offline (reloading can't help and would wipe terminal /
 *  composer state) or when this tab already reloaded and has not yet loaded cleanly. */
export function reloadOnceForStaleChunk(reload: () => void = () => location.reload()): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false
  try {
    if (sessionStorage.getItem(KEY) != null) return false
    sessionStorage.setItem(KEY, String(Date.now()))
  } catch { return false }
  reload()
  return true
}

export function loadWithReload<T>(factory: () => Promise<T>, reload?: () => void): Promise<T> {
  pending++
  return factory().then(
    m => { pending--; clearIfStable(); return m },
    (err: unknown) => {
      pending--
      failed = true
      if (reloadOnceForStaleChunk(reload)) return new Promise<T>(() => { /* page is reloading */ })
      throw err
    },
  )
}

/** Drop-in for React.lazy (same signature). */
export const lazyWithReload: typeof lazy = (factory) => lazy(() => loadWithReload(factory))

/** Test-only: reset page-lifetime state. */
export function __resetChunkReloadState(): void { pending = 0; failed = false; stable = false }
