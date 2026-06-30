import { describe, it, expect } from 'vitest'
import { parseWikilinkInner } from '../remarkWikilink'

describe('parseWikilinkInner', () => {
  it('plain link: target = display = inner', () => {
    expect(parseWikilinkInner('EKS 网络模型')).toEqual({ target: 'EKS 网络模型', display: 'EKS 网络模型' })
  })
  it('alias: [[Target|Display]] resolves Target, shows Display', () => {
    expect(parseWikilinkInner('Note|看这里')).toEqual({ target: 'Note', display: '看这里' })
  })
  it('heading: [[Target#sec]] strips heading from resolve target, shows full text', () => {
    expect(parseWikilinkInner('Note#章节')).toEqual({ target: 'Note', display: 'Note#章节' })
  })
  it('alias + heading: strips heading from target, alias wins for display', () => {
    expect(parseWikilinkInner('Note#章节|别名')).toEqual({ target: 'Note', display: '别名' })
  })
  it('path: [[folder/Note]] keeps the folder-qualified target', () => {
    expect(parseWikilinkInner('knowledge/aws/Note')).toEqual({
      target: 'knowledge/aws/Note', display: 'knowledge/aws/Note',
    })
  })
  it('pure heading [[#sec]] falls back to left text as target (deterministic)', () => {
    expect(parseWikilinkInner('#章节')).toEqual({ target: '#章节', display: '#章节' })
  })
})
