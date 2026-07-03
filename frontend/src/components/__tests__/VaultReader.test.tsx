import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import VaultReader from '../VaultReader'

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
})
