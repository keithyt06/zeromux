import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { reloadOnceForStaleChunk, loadWithReload, markPageStable, __resetChunkReloadState } from '../lazyWithReload'

const KEY = 'zmx_chunk_reload'
const err = new Error('Failed to fetch dynamically imported module')
const tick = () => new Promise(r => setTimeout(r, 0))

describe('lazyWithReload (A1: stale chunk after deploy)', () => {
  beforeEach(() => { sessionStorage.clear(); __resetChunkReloadState() })
  afterEach(() => vi.restoreAllMocks())

  it('first failure reloads once (never settles) and stamps sessionStorage', async () => {
    const reload = vi.fn()
    let settled = false
    loadWithReload(() => Promise.reject(err), reload).then(() => { settled = true }, () => { settled = true })
    await tick()
    expect(reload).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)
    expect(sessionStorage.getItem(KEY)).not.toBeNull()
  })

  it('one-shot per tab session: a second failure much later, with no clean load between, does not reload', async () => {
    const reload = vi.fn()
    loadWithReload(() => Promise.reject(err), reload)
    await tick()
    // The reloaded page (same sessionStorage) fails again — however long after.
    __resetChunkReloadState()
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)
    await expect(loadWithReload(() => Promise.reject(err), reload)).rejects.toBe(err)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('offline: no reload; the error reaches the caller (ErrorBoundary)', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const reload = vi.fn()
    await expect(loadWithReload(() => Promise.reject(err), reload)).rejects.toBe(err)
    expect(reload).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(KEY)).toBeNull()
  })

  it('the stamp is cleared once the page is stable with nothing in flight → a later deploy can reload again', async () => {
    sessionStorage.setItem(KEY, '1')                 // this page is the result of a reload
    await loadWithReload(() => Promise.resolve({ default: 1 }))
    markPageStable()
    expect(sessionStorage.getItem(KEY)).toBeNull()
    expect(reloadOnceForStaleChunk(vi.fn())).toBe(true)
  })

  it('an import still in flight at the stable mark keeps the stamp until it succeeds', async () => {
    sessionStorage.setItem(KEY, '1')
    let resolve!: (v: unknown) => void
    const p = loadWithReload(() => new Promise(r => { resolve = r }))
    markPageStable()
    expect(sessionStorage.getItem(KEY)).toBe('1')
    resolve({ default: 1 })
    await p
    expect(sessionStorage.getItem(KEY)).toBeNull()
  })

  it('a failure on the reloaded page keeps the stamp for the rest of the session', async () => {
    sessionStorage.setItem(KEY, '1')
    await expect(loadWithReload(() => Promise.reject(err), vi.fn())).rejects.toBe(err)
    markPageStable()
    expect(sessionStorage.getItem(KEY)).toBe('1')
  })

  it('successful import passes through untouched', async () => {
    const reload = vi.fn()
    const mod = { default: () => null }
    await expect(loadWithReload(() => Promise.resolve(mod), reload)).resolves.toBe(mod)
    expect(reload).not.toHaveBeenCalled()
  })
})
