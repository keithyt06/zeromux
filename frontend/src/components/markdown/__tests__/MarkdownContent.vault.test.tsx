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

  it('[[Target|alias]] shows alias but resolves Target', () => {
    const cb = vi.fn()
    render(<MarkdownContent text={'[[Note|看这里]]'} isComplete onWikiLink={cb} />)
    fireEvent.click(screen.getByText('看这里'))
    expect(cb).toHaveBeenCalledWith('Note')
  })
  it('[[Target#heading]] resolves bare Target (heading stripped)', () => {
    const cb = vi.fn()
    render(<MarkdownContent text={'[[Note#章节]]'} isComplete onWikiLink={cb} />)
    fireEvent.click(screen.getByText('Note#章节'))
    expect(cb).toHaveBeenCalledWith('Note')
  })
  it('[[folder/Note]] resolves the folder-qualified target', () => {
    const cb = vi.fn()
    render(<MarkdownContent text={'[[knowledge/aws/Note]]'} isComplete onWikiLink={cb} />)
    fireEvent.click(screen.getByText('knowledge/aws/Note'))
    expect(cb).toHaveBeenCalledWith('knowledge/aws/Note')
  })
  it('![[embed]] is NOT a wikilink and NOT an image (left literal in phase 1)', () => {
    const cb = vi.fn()
    render(<MarkdownContent text={'![[x.png]]'} isComplete onWikiLink={cb} resolveSrc={(s) => `RAW:${s}`} />)
    expect(document.body.textContent).toContain('![[x.png]]')
    expect(document.querySelector('img')).toBeNull()
  })
  it('[[...]] inside a fenced code block is NOT rewritten', () => {
    const cb = vi.fn()
    render(<MarkdownContent text={'```\nconst x = [[notalink]]\n```'} isComplete onWikiLink={cb} />)
    // text preserved verbatim, no link element created
    expect(document.body.textContent).toContain('[[notalink]]')
    expect(screen.queryByText('notalink')).toBeNull()
  })
  it('[[...]] inside inline code is NOT rewritten', () => {
    const cb = vi.fn()
    render(<MarkdownContent text={'use `arr[[0]]` here'} isComplete onWikiLink={cb} />)
    expect(document.body.textContent).toContain('arr[[0]]')
  })
  it('javascript: links in note content are sanitized (no urlTransform override)', () => {
    render(<MarkdownContent text={'[click](javascript:alert(1))'} isComplete onWikiLink={() => {}} />)
    const a = document.querySelector('a')
    // defaultUrlTransform blanks javascript:/data: — must NOT survive as an href
    expect(a?.getAttribute('href') || '').not.toContain('javascript:')
  })
})

describe('MarkdownContent enableRawHtml prop', () => {
  it('renders inline HTML table when enableRawHtml (not raw source)', () => {
    render(<MarkdownContent text={'<table><tr><td>Cell</td></tr></table>'} isComplete enableRawHtml />)
    expect(document.querySelector('table td')?.textContent).toBe('Cell')
  })
  it('strips <script> under enableRawHtml', () => {
    render(<MarkdownContent text={'<div>ok</div><script>window.__x=1</script>'} isComplete enableRawHtml />)
    expect(document.querySelector('script')).toBeNull()
    expect(document.body.textContent).toContain('ok')
  })
  it('without enableRawHtml, inline HTML stays as text (chat path unchanged)', () => {
    render(<MarkdownContent text={'<table><tr><td>Cell</td></tr></table>'} isComplete />)
    expect(document.querySelector('table')).toBeNull()
  })
  it('preserves table inline style under enableRawHtml', () => {
    render(<MarkdownContent text={'<table><tr><td style="background:#fff">x</td></tr></table>'} isComplete enableRawHtml />)
    const td = document.querySelector('td') as HTMLElement
    expect(td.getAttribute('style')).toContain('background')
  })

  it('preserves colspan on td under enableRawHtml (real vault tables use it)', () => {
    render(<MarkdownContent text={'<table><tr><td colspan="2">wide</td></tr></table>'} isComplete enableRawHtml />)
    const td = document.querySelector('td') as HTMLElement
    expect(td.getAttribute('colspan')).toBe('2')
  })
})
