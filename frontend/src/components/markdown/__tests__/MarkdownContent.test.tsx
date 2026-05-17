import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import MarkdownContent from '../MarkdownContent'

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
