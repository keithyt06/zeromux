import { describe, it, expect, vi } from 'vitest'
import { vapidKeyToUint8Array, levelAllows, shouldSuppress, pickApplicationServerKey, shouldResyncNow, enablePush } from '../push'

describe('push pure fns', () => {
  it('vapidKeyToUint8Array decodes base64url to 65-byte P-256 point', () => {
    // 65 字节 uncompressed point 的 base64url(0x04 + 32 + 32),用一个已知长度向量
    const b64url = 'B' + 'A'.repeat(86)  // 87 chars ≈ 65 bytes
    const arr = vapidKeyToUint8Array(b64url)
    expect(arr).toBeInstanceOf(Uint8Array)
    expect(arr.length).toBe(65)
  })
  it('levelAllows: routine off blocks turn_done, important always on', () => {
    expect(levelAllows('turn_done', { important: true, routine: false })).toBe(false)
    expect(levelAllows('turn_done', { important: true, routine: true })).toBe(true)
    expect(levelAllows('run_failed', { important: true, routine: false })).toBe(true)
    expect(levelAllows('confirm', { important: false, routine: false })).toBe(false) // important 控 confirm
  })
  it('levelAllows: test always allowed regardless of levels', () => {
    // test push must always display so iOS never counts it as a silent push
    expect(levelAllows('test', { important: false, routine: false })).toBe(true)
    expect(levelAllows('turn_done', { important: false, routine: false })).toBe(false)
    expect(levelAllows('run_failed', { important: false, routine: false })).toBe(false)
  })
  it('shouldSuppress: visible client on same session suppresses', () => {
    expect(shouldSuppress(['s1','s2'], 's1')).toBe(true)
    expect(shouldSuppress(['s2'], 's1')).toBe(false)
    expect(shouldSuppress([], 's1')).toBe(false)
  })
})

describe('shouldResyncNow', () => {
  it('allows first resync and after 1h, blocks within 1h', () => {
    expect(shouldResyncNow(null, 1_000_000)).toBe(true)
    expect(shouldResyncNow(1_000_000, 1_000_000 + 59*60_000)).toBe(false)
    expect(shouldResyncNow(1_000_000, 1_000_000 + 61*60_000)).toBe(true)
  })
})

describe('pickApplicationServerKey', () => {
  it('prefers oldSubscription key when present', () => {
    const old = new Uint8Array([1,2,3]).buffer
    const out = pickApplicationServerKey(old, 'BQ') // fetched ignored
    expect(Array.from(out)).toEqual([1,2,3])
  })
  it('falls back to fetched base64url when old key absent', () => {
    const out = pickApplicationServerKey(null, 'AQID') // base64url AQID = [1,2,3]
    expect(Array.from(out)).toEqual([1,2,3])
  })
})

describe('enablePush', () => {
  it('enablePush does not mark enabled when subscribe fails', async () => {
    localStorage.removeItem('zmx_push_enabled')
    vi.stubGlobal('Notification', { requestPermission: async () => 'granted', permission: 'granted' })
    const sub = { toJSON: () => ({ endpoint: 'https://p.example/x', keys: { p256dh: 'a', auth: 'b' } }), unsubscribe: vi.fn(async () => true) }
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: Promise.resolve({ pushManager: { subscribe: async () => sub } }) } })
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{"key":"AAAA"}', { status: 200 }))
      .mockResolvedValueOnce(new Response('nope', { status: 500 }))
    await expect(enablePush()).rejects.toMatchObject({ status: 500 })
    expect(localStorage.getItem('zmx_push_enabled')).toBeNull()
    expect(sub.unsubscribe).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
