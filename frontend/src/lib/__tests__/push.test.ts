import { describe, it, expect } from 'vitest'
import { vapidKeyToUint8Array, levelAllows, shouldSuppress } from '../push'

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
  it('shouldSuppress: visible client on same session suppresses', () => {
    expect(shouldSuppress(['s1','s2'], 's1')).toBe(true)
    expect(shouldSuppress(['s2'], 's1')).toBe(false)
    expect(shouldSuppress([], 's1')).toBe(false)
  })
})
