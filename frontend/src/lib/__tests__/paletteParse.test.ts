import { describe, it, expect, beforeEach } from 'vitest'
import { parseNew, loadLastType, saveLastType } from '../paletteParse'

describe('parseNew', () => {
  it('type keyword, dir fragment, prompt', () => {
    expect(parseNew('codex zeromux fix the sidebar')).toEqual({ type: 'codex', dir: 'zeromux', prompt: 'fix the sidebar', literalPath: false })
  })
  it('no type keyword → type null (caller uses last type)', () => {
    expect(parseNew('zeromux')).toEqual({ type: null, dir: 'zeromux', prompt: '', literalPath: false })
  })
  it('term is an alias for tmux; vault takes no dir', () => {
    expect(parseNew('term docs').type).toBe('tmux')
    expect(parseNew('vault').type).toBe('vault')
  })
  it('literal path when the dir fragment starts with / or ~', () => {
    expect(parseNew('claude ~/s3-workspace/x do it')).toEqual({ type: 'claude', dir: '~/s3-workspace/x', prompt: 'do it', literalPath: true })
    expect(parseNew('/tmp').literalPath).toBe(true)
  })
  it('keyword is case-insensitive and only recognised as the first token', () => {
    expect(parseNew('Claude zeromux').type).toBe('claude')
    expect(parseNew('zeromux claude').type).toBeNull()
  })
  it('blank input', () => { expect(parseNew('   ')).toEqual({ type: null, dir: '', prompt: '', literalPath: false }) })
  it('crew:goal is a crew keyword carrying the 目标指挥 variant', () => {
    expect(parseNew('crew:goal ~/w 查一下 CI')).toEqual({ type: 'crew', dir: '~/w', prompt: '查一下 CI', literalPath: true, crewVariant: 'goal' })
    expect(parseNew('CREW:GOAL zeromux').crewVariant).toBe('goal')
    expect(parseNew('crew zeromux').crewVariant).toBeUndefined()
    expect(parseNew('crew:nope zeromux').type).toBeNull()      // unknown variant is not a keyword
  })
})

describe('last type', () => {
  beforeEach(() => localStorage.clear())
  it('defaults to claude, round-trips, rejects garbage', () => {
    expect(loadLastType()).toBe('claude')
    saveLastType('codex'); expect(loadLastType()).toBe('codex')
    localStorage.setItem('zmx_last_type', 'kiro'); expect(loadLastType()).toBe('claude')
  })
})
