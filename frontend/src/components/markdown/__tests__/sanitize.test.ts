import { describe, it, expect } from 'vitest'
import { sanitizeStreamingMarkdown } from '../sanitize'

describe('sanitizeStreamingMarkdown', () => {
  it('closes an unclosed code fence', () => {
    const out = sanitizeStreamingMarkdown('text\n```rust\nfn main() {')
    expect((out.match(/```/g) || []).length % 2).toBe(0)
  })
  it('leaves balanced fences untouched', () => {
    const src = 'a\n```js\nx\n```\nb'
    expect(sanitizeStreamingMarkdown(src)).toBe(src)
  })
  it('demotes a half-written table row so it is not parsed as a table', () => {
    const out = sanitizeStreamingMarkdown('intro\n| col a | col')
    expect(out.split('\n').pop()!.startsWith('| col a')).toBe(false)
  })
  it('balances an unclosed $$ math block', () => {
    const out = sanitizeStreamingMarkdown('see $$x = 1')
    expect((out.match(/\$\$/g) || []).length % 2).toBe(0)
  })
  it('does not corrupt shell text with single $ (currency/var)', () => {
    const src = 'run `echo $HOME` costs $5'
    expect(sanitizeStreamingMarkdown(src)).toBe(src)
  })
})
