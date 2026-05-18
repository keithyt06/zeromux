import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import MarkdownContent from '../MarkdownContent'
import { mermaidCache } from '../cache'

const renderMock = vi.fn()
const parseMock = vi.fn()
const initMock = vi.fn()

vi.mock('mermaid', () => ({
  default: { initialize: initMock, parse: parseMock, render: renderMock },
}))

beforeEach(() => {
  mermaidCache.clear()
  renderMock.mockReset()
  parseMock.mockReset()
  initMock.mockReset()
  parseMock.mockResolvedValue(true)
  renderMock.mockResolvedValue({ svg: '<svg id="test"/>' })
})

describe('MarkdownContent — codeblock dispatch', () => {
  it('renders empty string without crashing', () => {
    const { container } = render(<MarkdownContent text="" isComplete />)
    expect(container).toBeInTheDocument()
  })

  it('renders mermaid block as pending pre when isComplete=false', () => {
    const text = '```mermaid\ngraph TD; A-->B\n```'
    const { container } = render(<MarkdownContent text={text} isComplete={false} />)
    const pending = container.querySelector('pre.mermaid-pending')
    expect(pending).toBeInTheDocument()
    expect(pending?.textContent).toContain('graph TD; A-->B')
  })

  it('renders mermaid block as pending pre when isComplete=true (until Task 12)', () => {
    const text = '```mermaid\ngraph TD; A-->B\n```'
    const { container } = render(<MarkdownContent text={text} isComplete={true} />)
    expect(container.querySelector('pre.mermaid-pending')).toBeInTheDocument()
  })

  it('renders inline code with highlight border', () => {
    const text = 'use `npm test` to run tests'
    render(<MarkdownContent text={text} isComplete />)
    const code = screen.getByText('npm test')
    expect(code.tagName).toBe('CODE')
  })
})

describe('MarkdownContent — code highlighting', () => {
  it('applies hljs class to fenced rust code block', () => {
    const text = '```rust\nfn main() { println!("hi"); }\n```'
    const { container } = render(<MarkdownContent text={text} isComplete />)
    const code = container.querySelector('code.language-rust')
    expect(code).toBeInTheDocument()
    // rehype-highlight wraps tokens in spans
    expect(code?.querySelector('span.hljs-keyword')).toBeInTheDocument()
  })

  it('leaves non-subset language untouched (no hljs spans)', () => {
    const text = '```mermaid\ngraph TD; A-->B\n```'
    const { container } = render(<MarkdownContent text={text} isComplete={false} />)
    const pending = container.querySelector('pre.mermaid-pending')
    expect(pending?.querySelector('span.hljs-keyword')).toBeNull()
  })

  it('highlights dockerfile blocks (registered explicitly)', () => {
    const text = '```dockerfile\nFROM node:20\nRUN npm ci\n```'
    const { container } = render(<MarkdownContent text={text} isComplete />)
    const code = container.querySelector('code.language-dockerfile')
    expect(code).toBeInTheDocument()
    expect(code?.querySelector('span.hljs-keyword')).toBeInTheDocument()
  })
})

describe('MarkdownContent — KaTeX lazy', () => {
  it('renders inline math after lazy load', async () => {
    const { container } = render(<MarkdownContent text="$E=mc^2$" isComplete />)
    await waitFor(() => {
      expect(container.querySelector('.katex')).toBeInTheDocument()
    }, { timeout: 3000 })
  })

  it('renders display math after lazy load', async () => {
    // Block math requires $$ on its own line in remark-math v6
    const { container } = render(<MarkdownContent text={"$$\n\\sum x_i\n$$"} isComplete />)
    await waitFor(() => {
      expect(container.querySelector('.katex-display')).toBeInTheDocument()
    }, { timeout: 3000 })
  })

  it('does not crash on invalid latex (strict ignore)', async () => {
    const text = '$\\frac{$'
    const { container } = render(<MarkdownContent text={text} isComplete />)
    // Should not throw; KaTeX renders error inline in red. Wait for plugin.
    await waitFor(() => {
      expect(container.textContent).toContain('\\frac')
    }, { timeout: 3000 })
  })

  it('skips katex chunk when text has no $', () => {
    const { container } = render(<MarkdownContent text="just plain text" isComplete />)
    // Should render synchronously without loading katex (cannot directly assert
    // chunk fetch without mocking import; test that DOM doesn't have .katex)
    expect(container.querySelector('.katex')).toBeNull()
  })
})
