import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import MarkdownViewer from '../MarkdownViewer'
import * as api from '../../lib/api'

// Render markdown as plain text so we can assert on content without pulling in
// the full markdown pipeline (KaTeX/mermaid/highlight).
vi.mock('../markdown/MarkdownContent', () => ({
  default: ({ text }: { text: string }) => <div data-testid="md">{text}</div>,
}))

vi.mock('../../lib/api', () => ({
  listSessionFiles: vi.fn(),
  getSessionFile: vi.fn(),
  writeSessionFile: vi.fn(),
  deleteSessionFile: vi.fn(),
  renameSessionFile: vi.fn(),
  uploadSessionFile: vi.fn(),
  createSessionDir: vi.fn(),
  deleteSessionDir: vi.fn(),
  renameSessionDir: vi.fn(),
}))

describe('MarkdownViewer stale-response guard', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('a slow read of A resolving after B was selected must NOT clobber B', async () => {
    // selectFile used to write content unconditionally after the await — the same
    // stale-response class fixed in VaultReader.openNote / FileBrowser.openFile but
    // never ported here. Tap A (slow), then B (fast); if A resolves last it must
    // not overwrite B. (review 2026-08-13)
    vi.mocked(api.listSessionFiles).mockResolvedValue([
      { name: 'A.md', path: 'A.md', type: 'file', size: 1, mtime: 0, writable: true },
      { name: 'B.md', path: 'B.md', type: 'file', size: 1, mtime: 0, writable: true },
    ] as any)

    let resolveA: (v: string) => void = () => {}
    let resolveB: (v: string) => void = () => {}
    vi.mocked(api.getSessionFile).mockImplementation((_id: string, path: string) =>
      new Promise<string>(r => { if (path === 'A.md') resolveA = r; else resolveB = r }),
    )

    render(<MarkdownViewer sessionId="s1" />)

    // The first file (A) auto-selects on load → req 1 (slow, still pending).
    // Then select B → req 2 (fast) supersedes. (getAllByText[0] = the list button;
    // the name also appears in the toolbar once selected.)
    fireEvent.click((await screen.findAllByText('B.md'))[0]) // fast — supersedes A

    resolveB('B-CONTENT')
    await waitFor(() => expect(screen.getByTestId('md').textContent).toBe('B-CONTENT'))

    resolveA('A-CONTENT')
    // Flush microtasks so a stale setState (if any) would land, then assert absence.
    await new Promise(r => setTimeout(r, 0))
    expect(screen.getByTestId('md').textContent).toBe('B-CONTENT')
  })
})
