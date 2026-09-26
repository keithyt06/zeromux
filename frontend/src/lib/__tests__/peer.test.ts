import { describe, it, expect } from 'vitest'
import { peerLabel, peerNamesKey, peerNamesFromKey } from '../peer'

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

describe('peerNamesKey / peerNamesFromKey (stable identity across polls)', () => {
  const a = [
    { peer_name: 'zmx-ai-318698', name: '重构推送' },
    { peer_name: null, name: 'term' },
    { name: 'codex' },
    { peer_name: 'zmx-ai-abcdef', name: 'other' },
  ]
  it('identical content in two different arrays gives an identical key', () => {
    expect(peerNamesKey(a.map(s => ({ ...s })))).toBe(peerNamesKey(a.map(s => ({ ...s }))))
  })
  it('a rename changes the key', () => {
    const renamed = a.map(s => (s.peer_name === 'zmx-ai-318698' ? { ...s, name: '推送重构' } : s))
    expect(peerNamesKey(renamed)).not.toBe(peerNamesKey(a))
  })
  it('ignores sessions without a peer_name', () => {
    expect(peerNamesKey(a)).toBe(peerNamesKey(a.filter(s => s.peer_name)))
  })
  it('round-trips key → map', () => {
    expect(peerNamesFromKey(peerNamesKey(a))).toEqual({ 'zmx-ai-318698': '重构推送', 'zmx-ai-abcdef': 'other' })
    expect(peerNamesFromKey(peerNamesKey([]))).toEqual({})
  })
})

describe('peerNamesKey is injective (no separator injection)', () => {
  it('a crafted session name cannot forge another peer\'s label', () => {
    const attacker = 'innocuous\u0002zmx-ai-bbbbbb\u0001SPOOFED-LABEL'
    const sessions = [
      { peer_name: 'zmx-ai-bbbbbb', name: 'real-b' },
      { peer_name: 'zmx-ai-aaaaaa', name: attacker },
    ]
    expect(peerNamesFromKey(peerNamesKey(sessions))).toEqual({
      'zmx-ai-aaaaaa': attacker,
      'zmx-ai-bbbbbb': 'real-b',
    })
  })
})
