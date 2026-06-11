import { describe, it, expect } from 'vitest'
import { sanitizeStreamingMarkdown, unwrapMarkdownFence } from '../sanitize'

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

describe('unwrapMarkdownFence', () => {
  it('unwraps a whole reply wrapped in ```markdown ... ``` (kiro habit)', () => {
    // kiro, when asked to "整理 markdown", wraps the entire reply in a
    // ```markdown fence that itself contains inner code blocks (nested fences).
    // Markdown does not support nested same-level fences, so react-markdown
    // mis-parses it. We strip the outer wrapper so the inner markdown renders.
    const inner = '# Title\n\nsome **bold**\n\n```bash\nls -la\n```\n\nmore text'
    const wrapped = '```markdown\n' + inner + '\n```'
    expect(unwrapMarkdownFence(wrapped)).toBe(inner)
  })

  it('unwraps ```md alias too', () => {
    const inner = '## Heading\n\ntext'
    expect(unwrapMarkdownFence('```md\n' + inner + '\n```')).toBe(inner)
  })

  it('keeps trailing prose that follows the closing fence (real kiro shape)', () => {
    // The real log had a concluding sentence AFTER the closing ```.
    const inner = '# H\n\n```\nflow\n```\n\nbody'
    const wrapped = '```markdown\n' + inner + '\n```\n\n这就是整理后的内容。'
    expect(unwrapMarkdownFence(wrapped)).toBe(inner + '\n\n这就是整理后的内容。')
  })

  it('keeps leading prose that precedes the opening fence', () => {
    const inner = '# H\n\ntext'
    const wrapped = '好的，这是整理后的：\n\n```markdown\n' + inner + '\n```'
    expect(unwrapMarkdownFence(wrapped)).toBe('好的，这是整理后的：\n\n' + inner)
  })

  it('leaves a normal ```bash code block untouched (not a markdown wrapper)', () => {
    const src = 'run this:\n\n```bash\nls -la\n```'
    expect(unwrapMarkdownFence(src)).toBe(src)
  })

  it('leaves plain markdown with no wrapper untouched', () => {
    const src = '# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |'
    expect(unwrapMarkdownFence(src)).toBe(src)
  })

  it('does not unwrap when there is no closing fence (still streaming)', () => {
    const src = '```markdown\n# Title\n\nincomplete...'
    expect(unwrapMarkdownFence(src)).toBe(src)
  })

  it('does not unwrap a fence that is not the markdown language', () => {
    const src = '```\njust a plain fence\n```'
    expect(unwrapMarkdownFence(src)).toBe(src)
  })

  it('handles inner code block ending adjacent to the outer close (double ```)', () => {
    // Highest-anxiety shape: the inner markdown ENDS with a code block, so the
    // inner close ``` and the outer wrapper close ``` are on adjacent lines.
    // The "last bare ```" closer must peel only the outer one, leaving the inner
    // code block balanced. Pins correct behavior against future refactors.
    const wrapped = '```markdown\n# H\n```\ncode\n```\n```'
    expect(unwrapMarkdownFence(wrapped)).toBe('# H\n```\ncode\n```')
  })
})
