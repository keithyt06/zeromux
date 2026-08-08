import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import VaultReader from '../VaultReader'
import * as api from '../../lib/api'

vi.mock('../../lib/api', () => ({
  listVault: vi.fn(async () => ({ entries: [{ name: 'note.md', type: 'file', size: 1, mtime: 0, writable: false }], truncated: false })),
  getVaultFile: vi.fn(async () => ({ content: '<table><tr><td>Cell</td></tr></table>', truncated: false })),
  getVaultSearch: vi.fn(async () => ({ results: [] })),
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
})
