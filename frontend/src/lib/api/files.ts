import { api } from './core'
import { getToken } from '../apiToken'

export interface DirEntry {
  name: string
  path: string
  is_git: boolean
}

export interface DirListing {
  current: string
  home: string
  parent: string | null
  entries: DirEntry[]
}

export async function listDirectories(path?: string): Promise<DirListing> {
  const params = path ? `?path=${encodeURIComponent(path)}` : ''
  // 8s timeout: on flaky mobile networks a stalled fetch would otherwise leave
  // the picker stuck on "Loading…" forever. AbortController turns it into a
  // catchable error so the caller can show a retry.
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const res = await api(`/api/directories${params}`, { signal: ctrl.signal })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  } finally {
    clearTimeout(timer)
  }
}

// File browser
export interface FileEntry {
  path: string
  name: string
  size: number
  modified: number
}

export async function listSessionFiles(id: string, pattern?: string, baseDir?: string): Promise<FileEntry[]> {
  const params = new URLSearchParams()
  if (pattern) params.set('pattern', pattern)
  if (baseDir) params.set('base_dir', baseDir)
  const qs = params.toString()
  const res = await api(`/api/sessions/${id}/files${qs ? `?${qs}` : ''}`)
  if (!res.ok) throw new Error('Failed to list files')
  const data = await res.json()
  return data.files || []
}

export async function getSessionFile(id: string, path: string, baseDir?: string): Promise<string> {
  const params = new URLSearchParams({ path })
  if (baseDir) params.set('base_dir', baseDir)
  const res = await api(`/api/sessions/${id}/file?${params}`)
  if (!res.ok) throw new Error('Failed to read file')
  const data = await res.json()
  return data.content
}

// Single-level directory listing (FileBrowser). Backend caps at 2000 entries.
export interface DirListEntry {
  name: string
  type: 'dir' | 'file'
  size: number
  mtime: number
  writable: boolean
}

export async function listDir(id: string, path = '', baseDir?: string): Promise<{ entries: DirListEntry[]; truncated: boolean }> {
  const params = new URLSearchParams()
  if (path) params.set('path', path)
  if (baseDir) params.set('base_dir', baseDir)
  const qs = params.toString()
  const res = await api(`/api/sessions/${id}/dir/list${qs ? `?${qs}` : ''}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

// Authed raw-file URL for <img src>/<a href download>. These element loads carry
// no Authorization header, so we append ?token= the same way wsUrl does (the
// backend accepts ?token= for both JWT and legacy modes — see try_jwt_auth /
// try_legacy_auth). The cookie alone is unreliable for localStorage-only sessions.
export function fileRawUrl(id: string, path: string, baseDir?: string): string {
  const token = getToken()
  const jwt = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('zeromux_jwt='))?.split('=')[1] || ''
  const authToken = token || jwt
  const params = new URLSearchParams({ path })
  if (baseDir) params.set('base_dir', baseDir)
  if (authToken) params.set('token', authToken)
  return `/api/sessions/${id}/file/raw?${params}`
}

// File CRUD
export async function writeSessionFile(id: string, path: string, content: string): Promise<void> {
  const res = await api(`/api/sessions/${id}/file`, {
    method: 'POST',
    body: JSON.stringify({ path, content }),
  })
  if (!res.ok) throw new Error(await res.text())
}

export async function deleteSessionFile(id: string, path: string): Promise<void> {
  const res = await api(`/api/sessions/${id}/file?path=${encodeURIComponent(path)}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(await res.text())
}

export async function renameSessionFile(id: string, from: string, to: string): Promise<void> {
  const res = await api(`/api/sessions/${id}/file/rename`, {
    method: 'POST',
    body: JSON.stringify({ from, to }),
  })
  if (!res.ok) throw new Error(await res.text())
}

export async function uploadSessionFile(id: string, path: string, data: string): Promise<string> {
  const res = await api(`/api/sessions/${id}/upload`, {
    method: 'POST',
    body: JSON.stringify({ path, data }),
  })
  if (!res.ok) throw new Error(await res.text())
  const body = await res.json() as { path: string }
  return body.path
}

// Directory CRUD
export async function createSessionDir(id: string, path: string): Promise<void> {
  const res = await api(`/api/sessions/${id}/dir`, {
    method: 'POST',
    body: JSON.stringify({ path }),
  })
  if (!res.ok) throw new Error(await res.text())
}

export async function deleteSessionDir(id: string, path: string): Promise<void> {
  const res = await api(`/api/sessions/${id}/dir?path=${encodeURIComponent(path)}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(await res.text())
}

export async function renameSessionDir(id: string, from: string, to: string): Promise<void> {
  const res = await api(`/api/sessions/${id}/dir/rename`, {
    method: 'POST',
    body: JSON.stringify({ from, to }),
  })
  if (!res.ok) throw new Error(await res.text())
}
