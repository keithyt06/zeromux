import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FileBrowser } from '../FileBrowser'
import * as api from '../../lib/api'

describe('FileBrowser', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('lists dir entries with breadcrumb root', async () => {
    vi.spyOn(api, 'listDir').mockResolvedValue({
      entries: [
        { name: 'sub', type: 'dir', size: 0, mtime: 0, writable: true },
        { name: 'pic.png', type: 'file', size: 10, mtime: 0, writable: true },
      ],
      truncated: false,
    })

    render(<FileBrowser sessionId="s1" />)

    expect(await screen.findByText('pic.png')).toBeInTheDocument()
    expect(screen.getByText('sub')).toBeInTheDocument()
    // breadcrumb root present
    await waitFor(() => expect(screen.getByText('根目录')).toBeInTheDocument())
  })

  it('drills into a directory on click (re-lists with new cwd)', async () => {
    const spy = vi.spyOn(api, 'listDir').mockResolvedValue({
      entries: [{ name: 'sub', type: 'dir', size: 0, mtime: 0, writable: true }],
      truncated: false,
    })
    render(<FileBrowser sessionId="s1" />)
    const dir = await screen.findByText('sub')
    dir.click()
    await waitFor(() => expect(spy).toHaveBeenCalledWith('s1', 'sub'))
  })
})
