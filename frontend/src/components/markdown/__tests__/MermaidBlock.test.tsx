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
