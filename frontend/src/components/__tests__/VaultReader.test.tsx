import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import VaultReader from '../VaultReader'
import * as api from '../../lib/api'

vi.mock('../../lib/api', () => ({
  listVault: vi.fn(async () => ({ entries: [{ name: 'note.md', type: 'file', size: 1, mtime: 0, writable: false }], truncated: false })),
  getVaultFile: vi.fn(async () => ({ content: '<table><tr><td>Cell</td></tr></table>', truncated: false })),
  searchPaths: vi.fn(async () => ({ dirs: null, notes: { kind: 'notes', indexing: false, refreshing: false, truncated: false, items: [] } })),
  warmSearchIndex: vi.fn(async () => {}),
  resolveWikiLink: vi.fn(async () => null),
  vaultRawUrl: (p: string) => `/api/vault/file/raw?path=${p}`,
}))

describe('VaultReader', () => {
  beforeEach(() => localStorage.clear())
  it('renders directory tree and is read-only (no edit/upload/delete)', async () => {
    render(<VaultReader onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('note.md')).toBeInTheDocument())
    expect(screen.queryByText(/编辑|新建|上传|删除|保存|Edit|Upload|Delete|Save/i)).toBeNull()
  })

  it('renders inline HTML table (enableRawHtml) inside a light surface', async () => {
    render(<VaultReader onClose={() => {}} />)
    fireEvent.click(await screen.findByText('note.md'))
    await waitFor(() => expect(document.querySelector('table td')?.textContent).toBe('Cell'))
    // light reading surface marker class must be present on the read container
    expect(document.querySelector('.vault-reading-surface')).not.toBeNull()
  })

  it('renders embedded (no fixed/overlay wrapper) when onClose is omitted', async () => {
    const { container } = render(<VaultReader />)
    await waitFor(() => expect(screen.getByText('note.md')).toBeInTheDocument())
    // no full-screen overlay wrapper
    expect(container.querySelector('.z-50')).toBeNull()
    // embedded root fills height instead
    expect(container.querySelector('.h-full')).not.toBeNull()
    // no close button when onClose omitted (close = delete the tab at list level)
    expect(container.querySelector('button svg.lucide-x')).toBeNull()
  })

  it('a slow read of note A resolving after note B was opened cannot paint A (F3 stale-response guard)', async () => {
    // openNote used to write content/openPath unconditionally after the await —
    // the same stale-response class fixed in GitViewer/FileBrowser but never
    // ported here. Tap A (slow), then B (fast); if A resolves last it must NOT
    // overwrite B. The fix bumps a monotonic openReqRef and bails a superseded read.
    vi.mocked(api.listVault).mockResolvedValue({
      entries: [
        { name: 'A.md', type: 'file', size: 1, mtime: 0, writable: false },
        { name: 'B.md', type: 'file', size: 1, mtime: 0, writable: false },
      ],
      truncated: false,
    })
    let resolveA: (v: { content: string; truncated: boolean }) => void = () => {}
    let resolveB: (v: { content: string; truncated: boolean }) => void = () => {}
    vi.mocked(api.getVaultFile).mockImplementation((path: string) =>
      new Promise(r => { if (path === 'A.md') resolveA = r; else resolveB = r }),
    )
    render(<VaultReader onClose={() => {}} />)
    fireEvent.click(await screen.findByText('A.md')) // req 1 (slow)
    fireEvent.click(await screen.findByText('B.md')) // req 2 (fast) — supersedes
    // B resolves first and paints; then A (the superseded read) resolves.
    resolveB({ content: 'B-CONTENT', truncated: false })
    await waitFor(() => expect(screen.getByText('B-CONTENT')).toBeInTheDocument())
    resolveA({ content: 'A-CONTENT', truncated: false })
    // Flush microtasks so the stale setState (if any) would land, then assert absence.
    await new Promise(r => setTimeout(r, 0))
    expect(screen.queryByText('A-CONTENT')).toBeNull()
    expect(screen.getByText('B-CONTENT')).toBeInTheDocument()
  })

  it('target (note) opens the note; a new nonce re-triggers', async () => {
    const { rerender } = render(<VaultReader target={{ path: 'note.md', kind: 'note', nonce: 1 }} />)
    await waitFor(() => expect(api.getVaultFile).toHaveBeenCalledWith('note.md'))
    vi.mocked(api.getVaultFile).mockClear()
    rerender(<VaultReader target={{ path: 'note.md', kind: 'note', nonce: 1 }} />)
    expect(api.getVaultFile).not.toHaveBeenCalled()
    rerender(<VaultReader target={{ path: 'note.md', kind: 'note', nonce: 2 }} />)
    await waitFor(() => expect(api.getVaultFile).toHaveBeenCalledWith('note.md'))
  })

  it('target (folder) lists that folder', async () => {
    render(<VaultReader target={{ path: 'projects/x', kind: 'folder', nonce: 1 }} />)
    await waitFor(() => expect(api.listVault).toHaveBeenCalledWith('projects/x'))
  })

  it('search results include folders; tapping a folder navigates AND clears the query', async () => {
    vi.mocked(api.searchPaths).mockResolvedValue({ dirs: null, notes: { kind: 'notes', indexing: false, refreshing: false, truncated: false, items: [
      { path: 'projects/x', kind: 'folder', display: 'x', hint: 'projects', abs_dir: '/v/projects/x', score: 9 },
    ] } })
    render(<VaultReader />)
    const input = screen.getByPlaceholderText('搜索笔记名…') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'x' } })
    fireEvent.click(await screen.findByText('x'))
    await waitFor(() => expect(api.listVault).toHaveBeenCalledWith('projects/x'))
    expect(input.value).toBe('')
  })

  it('⚡ on a search result calls onAskAgent with the note context', async () => {
    vi.mocked(api.searchPaths).mockResolvedValue({ dirs: null, notes: { kind: 'notes', indexing: false, refreshing: false, truncated: false, items: [
      { path: 'a/n.md', kind: 'note', display: 'n', hint: 'a', abs_dir: '/v/a', score: 9 },
    ] } })
    const onAskAgent = vi.fn()
    render(<VaultReader onAskAgent={onAskAgent} />)
    fireEvent.change(screen.getByPlaceholderText('搜索笔记名…'), { target: { value: 'n' } })
    fireEvent.click(await screen.findByTestId('sr-ask'))
    expect(onAskAgent).toHaveBeenCalledWith({ absDir: '/v/a', relPath: 'a/n.md', kind: 'note' })
  })

  it('search failure shows retry instead of an endless 搜索中…', async () => {
    vi.mocked(api.searchPaths).mockRejectedValueOnce(new Error('offline'))
    render(<VaultReader />)
    fireEvent.change(screen.getByPlaceholderText('搜索笔记名…'), { target: { value: 'q' } })
    expect(await screen.findByText('重试')).toBeInTheDocument()
  })

  it('target (folder) also clears a pending query', async () => {
    const { rerender } = render(<VaultReader />)
    const input = screen.getByPlaceholderText('搜索笔记名…') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'zzz' } })
    rerender(<VaultReader target={{ path: 'projects/x', kind: 'folder', nonce: 7 }} />)
    await waitFor(() => expect(input.value).toBe(''))
  })

  it('shows the 50-item cap hint when a full page comes back (truncated is never set for notes)', async () => {
    const items = (n: number) => Array.from({ length: n }, (_, i) => (
      { path: `a/n${i}.md`, kind: 'note' as const, display: `note${i}`, hint: 'a', abs_dir: '/v/a', score: 9 }))
    vi.mocked(api.searchPaths).mockResolvedValue({ dirs: null, notes: { kind: 'notes', indexing: false, refreshing: false, truncated: false, items: items(50) } })
    const { unmount } = render(<VaultReader />)
    fireEvent.change(screen.getByPlaceholderText('搜索笔记名…'), { target: { value: 'n' } })
    await screen.findByText('note49')
    expect(screen.getByText(/仅显示前 50 条/)).toBeInTheDocument()
    unmount()

    vi.mocked(api.searchPaths).mockResolvedValue({ dirs: null, notes: { kind: 'notes', indexing: false, refreshing: false, truncated: false, items: items(3) } })
    render(<VaultReader />)
    fireEvent.change(screen.getByPlaceholderText('搜索笔记名…'), { target: { value: 'n' } })
    await screen.findByText('note2')
    expect(screen.queryByText(/仅显示前 50 条/)).toBeNull()
  })

  it('warms the notes index on mount', async () => {
    render(<VaultReader />)
    await waitFor(() => expect(api.warmSearchIndex).toHaveBeenCalledWith('notes'))
  })
})
