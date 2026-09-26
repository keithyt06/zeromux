import { describe, it, expect } from 'vitest'
import { connectionBarText, CONNECTION_BAR_DELAY_MS } from '../wsStatus'

describe('connectionBarText', () => {
  it('open → null', () => {
    expect(connectionBarText('open', 0, 10_000)).toBeNull()
  })
  it('reconnecting within delay → null (avoid flicker on fast reconnect)', () => {
    expect(connectionBarText('reconnecting', 1000, 1000 + CONNECTION_BAR_DELAY_MS - 1)).toBeNull()
  })
  it('reconnecting past delay → 重连中', () => {
    expect(connectionBarText('reconnecting', 1000, 1000 + CONNECTION_BAR_DELAY_MS)).toBe('连接断开,正在重连…')
  })
  it('connecting past delay → 连接中', () => {
    expect(connectionBarText('connecting', 0, CONNECTION_BAR_DELAY_MS)).toBe('正在连接…')
  })
  it('ended → shown immediately', () => {
    expect(connectionBarText('ended', 5000, 5000)).toBe('会话已结束')
  })
})
