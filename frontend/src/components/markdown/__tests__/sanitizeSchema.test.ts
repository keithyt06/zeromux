import { describe, it, expect } from 'vitest'
import { vaultSanitizeSchema } from '../sanitizeSchema'

describe('vaultSanitizeSchema', () => {
  it('allows math marker classes on code (else $math$ regresses)', () => {
    const codeAttrs = vaultSanitizeSchema.attributes!.code as unknown[]
    const cls = codeAttrs.find((a) => Array.isArray(a) && a[0] === 'className') as unknown[]
    expect(cls).toContain('math-inline')
    expect(cls).toContain('math-display')
    // language-* must still be allowed (mermaid/highlight)
    expect(cls.some((v) => v instanceof RegExp && (v as RegExp).test('language-rust'))).toBe(true)
  })
  it('allows style + table structural attrs', () => {
    const star = vaultSanitizeSchema.attributes!['*'] as unknown[]
    expect(star).toContain('style')
    const td = vaultSanitizeSchema.attributes!.td as unknown[]
    expect(td).toContain('colSpan')
  })
  it('allows table/details/span/img tags', () => {
    const tags = vaultSanitizeSchema.tagNames!
    for (const t of ['table','thead','tbody','tr','th','td','details','summary','span','div','br','img','sub','sup','kbd','mark']) {
      expect(tags).toContain(t)
    }
  })
  it('does NOT allow script/iframe', () => {
    expect(vaultSanitizeSchema.tagNames).not.toContain('script')
    expect(vaultSanitizeSchema.tagNames).not.toContain('iframe')
  })
  it('allows data: protocol for img src', () => {
    expect(vaultSanitizeSchema.protocols!.src).toContain('data')
  })
})
