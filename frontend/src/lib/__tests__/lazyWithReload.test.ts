import { describe, it, expect, beforeEach, vi } from 'vitest'
import { reloadOnceForStaleChunk, loadWithReload } from '../lazyWithReload'

const KEY = 'zmx_chunk_reload'

describe('lazyWithReload (A1: stale chunk after deploy)', () => {
  beforeEach(() => sessionStorage.clear())

  it('first failure reloads once and stamps sessionStorage', () => {
    const reload = vi.fn()
    expect(reloadOnceForStaleChunk(reload, 100_000)).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem(KEY)).toBe('100000')
  })

  it('a second failure within 10s does not reload again (no loop)', () => {
    const reload = vi.fn()
    reloadOnceForStaleChunk(reload, 100_000)
    expect(reloadOnceForStaleChunk(reload, 105_000)).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('reloads again once the 10s window has passed', () => {
    const reload = vi.fn()
    reloadOnceForStaleChunk(reload, 100_000)
    expect(reloadOnceForStaleChunk(reload, 110_001)).toBe(true)
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('import failure → reload (never settles); second failure within 10s → throws', async () => {
    const reload = vi.fn()
    const err = new Error('Failed to fetch dynamically imported module')
    const p1 = loadWithReload(() => Promise.reject(err), reload)
    let settled = false
    p1.then(() => { settled = true }, () => { settled = true })
    await new Promise(r => setTimeout(r, 0))
    expect(reload).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)
    await expect(loadWithReload(() => Promise.reject(err), reload)).rejects.toBe(err)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('successful import passes through untouched', async () => {
    const reload = vi.fn()
    const mod = { default: () => null }
    await expect(loadWithReload(() => Promise.resolve(mod), reload)).resolves.toBe(mod)
    expect(reload).not.toHaveBeenCalled()
  })
})
