import { lazy } from 'react'

const KEY = 'zmx_chunk_reload'
const WINDOW_MS = 10_000

/** A deploy swapped the embedded chunks, so an old page's lazy import 404s.
 *  Reload once to pick up the new index.html; a second failure within 10s
 *  means reloading won't help, so report false (caller throws → ErrorBoundary). */
export function reloadOnceForStaleChunk(reload: () => void = () => location.reload(), now = Date.now()): boolean {
  const last = Number(sessionStorage.getItem(KEY) ?? 0)
  if (now - last <= WINDOW_MS) return false
  sessionStorage.setItem(KEY, String(now))
  reload()
  return true
}

export function loadWithReload<T>(factory: () => Promise<T>, reload?: () => void): Promise<T> {
  return factory().catch((err: unknown) => {
    if (reloadOnceForStaleChunk(reload)) return new Promise<T>(() => { /* page is reloading */ })
    throw err
  })
}

/** Drop-in for React.lazy (same signature). */
export const lazyWithReload: typeof lazy = (factory) => lazy(() => loadWithReload(factory))
