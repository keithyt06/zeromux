import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import SearchResults from '../SearchResults'
import { orderSections, compactHint } from '../../lib/searchOrder'
import type { SearchResult, DirHit, NoteHit } from '../../lib/api'

const dir = (o: Partial<DirHit> = {}): DirHit => ({ path: '/h/zeromux', display: 'zeromux', hint: '~/s3', agent: 'claude', score: 80, ...o })
const note = (o: Partial<NoteHit> = {}): NoteHit => ({ path: 'p/_index.md', kind: 'note', display: '_index', hint: 'p', abs_dir: '/v/p', score: 60, ...o })
const res = (d: DirHit[], n: NoteHit[], extra: Partial<SearchResult['dirs']> = {}, extraN: Partial<SearchResult['notes']> = {}): SearchResult => ({
  dirs: { kind: 'dirs', indexing: false, refreshing: false, truncated: false, items: d, ...extra },
  notes: { kind: 'notes', indexing: false, refreshing: false, truncated: false, items: n, ...extraN },
})
const noop = () => {}
const base = { onPickDir: noop, onPickNote: noop, onAskAgent: noop }

describe('SearchResults', () => {
  it('orders sections by best score', () => {
    expect(orderSections(res([dir({ score: 50 })], [note({ score: 90 })]), true)).toEqual(['notes', 'dirs'])
    expect(orderSections(res([dir({ score: 90 })], [note({ score: 50 })]), true)).toEqual(['dirs', 'notes'])
    expect(orderSections(res([dir()], [note()]), false)).toEqual(['dirs'])
  })

  it('compactHint drops the shared vault prefix so the distinguishing tail survives truncation', () => {
    expect(compactHint('projects/long-term/考研英语/2019/英语二')).toBe('考研英语/2019/英语二')
    expect(compactHint('projects/short-term/web3')).toBe('web3')
    expect(compactHint('knowledge/aws')).toBe('knowledge/aws')
  })

  it('renders both sections with display + hint', () => {
    render(<SearchResults result={res([dir()], [note()])} showNotes {...base} />)
    expect(screen.getByText('目录')).toBeInTheDocument()
    expect(screen.getByText('笔记')).toBeInTheDocument()
    expect(screen.getByText('zeromux')).toBeInTheDocument()
    expect(screen.getByText('~/s3')).toBeInTheDocument()
    expect(screen.getByText('_index')).toBeInTheDocument()
  })

  it('hides the notes section entirely when showNotes is false', () => {
    render(<SearchResults result={res([dir()], [])} showNotes={false} {...base} />)
    expect(screen.queryByText('笔记')).toBeNull()
    expect(screen.queryByText('无匹配笔记')).toBeNull()
  })

  it('row tap vs ⚡ are distinct targets; ⚡ is not hover-only', () => {
    const onPickNote = vi.fn(), onAskAgent = vi.fn()
    render(<SearchResults result={res([], [note()])} showNotes {...base} onPickNote={onPickNote} onAskAgent={onAskAgent} />)
    const ask = screen.getByTestId('sr-ask')
    expect(ask.className).not.toMatch(/opacity-0|group-hover/)
    fireEvent.click(ask)
    expect(onAskAgent).toHaveBeenCalledWith(note())
    expect(onPickNote).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('_index'))
    expect(onPickNote).toHaveBeenCalledWith(note())
  })

  it('folder row ⋮ offers 在此开 agent', () => {
    const onOpenHere = vi.fn()
    const f = note({ kind: 'folder', path: 'p', display: 'p', hint: '', abs_dir: '/v/p' })
    render(<SearchResults result={res([], [f])} showNotes {...base} onOpenHere={onOpenHere} />)
    fireEvent.click(screen.getByTestId('sr-menu'))
    fireEvent.click(screen.getByText('在此开 agent'))
    expect(onOpenHere).toHaveBeenCalledWith(f)
  })

  it('edge states: indexing, refreshing+empty, empty', () => {
    const { rerender } = render(<SearchResults result={res([], [], { indexing: true }, { indexing: true })} showNotes {...base} />)
    expect(screen.getByText('正在建立目录索引…')).toBeInTheDocument()
    expect(screen.getByText('正在建立笔记索引…')).toBeInTheDocument()
    rerender(<SearchResults result={res([], [], { refreshing: true }, { refreshing: true })} showNotes {...base} />)
    expect(screen.getByText('索引刷新中…')).toBeInTheDocument()
    expect(screen.getAllByText('无匹配笔记').length).toBeGreaterThan(0)
    rerender(<SearchResults result={res([], [])} showNotes {...base} />)
    expect(screen.getByText(/未找到（仅索引 6 层内）/)).toBeInTheDocument()
    expect(screen.getByText('无匹配笔记')).toBeInTheDocument()
  })

  it('failed shows a retry and nothing else', () => {
    const onRetry = vi.fn()
    render(<SearchResults result={res([dir()], [])} showNotes failed onRetry={onRetry} {...base} />)
    expect(screen.queryByText('zeromux')).toBeNull()
    const retry = screen.getByText('重试')
    expect(retry.className).toMatch(/min-h-\[44px\]/)
    fireEvent.click(retry)
    expect(onRetry).toHaveBeenCalled()
  })
})
