import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { mermaidCache } from '../cache'
import { fnv1a } from '../hash'

const renderMock = vi.fn()
const parseMock = vi.fn()
const initMock = vi.fn()

vi.mock('mermaid', () => ({
  default: {
    initialize: initMock,
    parse: parseMock,
    render: renderMock,
  },
}))

beforeEach(() => {
  mermaidCache.clear()
  renderMock.mockReset()
  parseMock.mockReset()
  initMock.mockReset()
})

describe('MermaidBlock', () => {
  it('imports mermaid, renders, and caches SVG on cache miss', async () => {
    parseMock.mockResolvedValue(true)
    renderMock.mockResolvedValue({ svg: '<svg id="ok"/>' })
    const { default: MermaidBlock } = await import('../MermaidBlock')
    const code = 'graph TD; A-->B'

    const { container } = render(<MermaidBlock code={code} />)
    await waitFor(() => {
      expect(container.querySelector('.mermaid-rendered')).toBeInTheDocument()
    })
    expect(parseMock).toHaveBeenCalledWith(code)
    expect(renderMock).toHaveBeenCalled()
    expect(mermaidCache.get(fnv1a(code))).toBe('<svg id="ok"/>')
  })

  it('skips render when cache already has the svg (keyed by hash)', async () => {
    mermaidCache.set(fnv1a('cached-code'), '<svg id="cached"/>')
    const { default: MermaidBlock } = await import('../MermaidBlock')

    const { container } = render(<MermaidBlock code="cached-code" />)
    expect(container.querySelector('.mermaid-rendered')).toBeInTheDocument()
    expect(renderMock).not.toHaveBeenCalled()
    expect(parseMock).not.toHaveBeenCalled()
  })

  it('does not cache on render error', async () => {
    mermaidCache.clear()
    parseMock.mockRejectedValue(new Error('boom'))
    const { default: MermaidBlock } = await import('../MermaidBlock')
    const code = '!!!invalid!!!'

    const { container } = render(<MermaidBlock code={code} />)
    await waitFor(() => {
      expect(container.querySelector('.mermaid-err')).toBeInTheDocument()
    })
    expect(mermaidCache.has(fnv1a(code))).toBe(false)
    expect(mermaidCache.size).toBe(0)
  })

  it('re-renders when code changes on a reused instance (no stale diagram)', async () => {
    // review 2026-08-05: the useState initializer runs once at mount, so when React
    // reuses this instance at the same position with a DIFFERENT code, the effect used
    // to early-return on state.kind==='svg' and keep painting the PREVIOUS diagram
    // (e.g. FileBrowser previewing file B after file A). rerender() reuses the instance
    // (no key), reproducing that path.
    parseMock.mockResolvedValue(true)
    renderMock.mockResolvedValue({ svg: '<svg id="first"/>' })
    const { default: MermaidBlock } = await import('../MermaidBlock')

    const { container, rerender } = render(<MermaidBlock code="graph TD; A-->B" />)
    await waitFor(() => {
      expect(container.querySelector('.mermaid-rendered')?.innerHTML).toContain('id="first"')
    })

    // Same position, different source → must re-render the NEW diagram, not the stale one.
    renderMock.mockResolvedValue({ svg: '<svg id="second"/>' })
    rerender(<MermaidBlock code="graph LR; X-->Y" />)
    await waitFor(() => {
      expect(container.querySelector('.mermaid-rendered')?.innerHTML).toContain('id="second"')
    })
    expect(mermaidCache.get(fnv1a('graph LR; X-->Y'))).toBe('<svg id="second"/>')
  })

  it('adopts a cached svg when code changes on a reused instance (no re-render call)', async () => {
    // The cross-key change must also work when the new code is already cached: adopt
    // the cache hit instead of leaving the old SVG on screen (and without calling render).
    parseMock.mockResolvedValue(true)
    renderMock.mockResolvedValue({ svg: '<svg id="A"/>' })
    mermaidCache.set(fnv1a('cached-B'), '<svg id="B-cached"/>')
    const { default: MermaidBlock } = await import('../MermaidBlock')

    const { container, rerender } = render(<MermaidBlock code="code-A" />)
    await waitFor(() => {
      expect(container.querySelector('.mermaid-rendered')?.innerHTML).toContain('id="A"')
    })
    const rendersAfterFirst = renderMock.mock.calls.length

    rerender(<MermaidBlock code="cached-B" />)
    await waitFor(() => {
      expect(container.querySelector('.mermaid-rendered')?.innerHTML).toContain('id="B-cached"')
    })
    // Cache hit → no extra mermaid.render for the second code.
    expect(renderMock.mock.calls.length).toBe(rendersAfterFirst)
  })

  it('renders raw + error message when parse throws', async () => {
    parseMock.mockRejectedValue(new Error('Syntax error in line 1'))
    const { default: MermaidBlock } = await import('../MermaidBlock')

    const { container } = render(<MermaidBlock code="this is not mermaid" />)
    await waitFor(() => {
      expect(container.querySelector('.mermaid-err')).toBeInTheDocument()
    })
    expect(container.textContent).toContain('this is not mermaid')
    expect(container.textContent).toContain('Syntax error')
  })
})
