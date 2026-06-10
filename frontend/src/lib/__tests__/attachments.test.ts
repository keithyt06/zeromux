import { describe, it, expect } from 'vitest'
import { buildPromptWithAttachments } from '../attachments'

describe('buildPromptWithAttachments', () => {
  it('no attachments returns text unchanged', () => {
    expect(buildPromptWithAttachments('hello', [])).toBe('hello')
  })

  it('text + multiple attachments appends instruction block', () => {
    const out = buildPromptWithAttachments('看下这个报错', ['a.png', 'log.txt'])
    expect(out).toContain('看下这个报错')
    expect(out).toContain('请先用 Read 工具读取后再回应')
    expect(out).toContain('./a.png')
    expect(out).toContain('./log.txt')
    expect(out).toMatch(/看下这个报错\n\n\[/)
  })

  it('empty text + single attachment: only attachment block, no leading blank', () => {
    const out = buildPromptWithAttachments('', ['shot.png'])
    expect(out.startsWith('[')).toBe(true)
    expect(out).toContain('./shot.png')
  })

  it('whitespace-only text treated as empty', () => {
    const out = buildPromptWithAttachments('   ', ['x.png'])
    expect(out.startsWith('[')).toBe(true)
  })
})
