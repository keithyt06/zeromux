import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import MarkdownContent from '../MarkdownContent'

describe('MarkdownContent vault props', () => {
  it('rewrites image src via resolveSrc', () => {
    render(<MarkdownContent text={'![](x.png)'} isComplete resolveSrc={(s) => `/api/vault/file/raw?path=${s}`} />)
    const img = document.querySelector('img')
    expect(img?.getAttribute('src')).toBe('/api/vault/file/raw?path=x.png')
  })
  it('renders [[wikilink]] clickable and fires onWikiLink', () => {
    const cb = vi.fn()
    render(<MarkdownContent text={'see [[EKS 网络模型]] here'} isComplete onWikiLink={cb} />)
    const link = screen.getByText('EKS 网络模型')
    fireEvent.click(link)
    expect(cb).toHaveBeenCalledWith('EKS 网络模型')
  })
  it('without onWikiLink, [[x]] stays plain text', () => {
    render(<MarkdownContent text={'see [[X]] here'} isComplete />)
    expect(document.body.textContent).toContain('[[X]]')
  })
})
