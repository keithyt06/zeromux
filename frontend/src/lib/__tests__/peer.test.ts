import { describe, it, expect } from 'vitest'
import { peerLabel } from '../peer'

describe('peerLabel (spec 2026-09-26 v2 §3d)', () => {
  const names = { 'zmx-ai-318698': '重构推送' }
  it('maps a known ZeroMux peer name to its session title', () => {
    expect(peerLabel('zmx-ai-318698', names)).toBe('重构推送')
  })
  it('falls back to the raw name for unknown or external senders', () => {
    expect(peerLabel('zmx-ai-ffffff', names)).toBe('zmx-ai-ffffff')
    expect(peerLabel('zmx-6c3596b8', names)).toBe('zmx-6c3596b8') // claude inside a tmux terminal
    expect(peerLabel('keith-laptop', names)).toBe('keith-laptop')
  })
})
