import { api } from './core'
import type { DirListEntry } from './files'

// Duplicated from core.ts (not exported there, so not re-exported here either —
// keeps the module's public surface identical to pre-split api.ts).
function getToken(): string {
  return localStorage.getItem('zeromux_token') || ''
}

// Vault (Obsidian reader)
export async function getVaultMeta(): Promise<{ enabled: boolean; name: string }> {
  const res = await api('/api/vault/meta')
  if (!res.ok) return { enabled: false, name: '' }
  return res.json()
}
export async function listVault(path = ''): Promise<{ entries: DirListEntry[]; truncated: boolean }> {
  const params = new URLSearchParams()
  if (path) params.set('path', path)
  const qs = params.toString()
  const res = await api(`/api/vault/list${qs ? `?${qs}` : ''}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}
export async function getVaultFile(path: string): Promise<{ content: string; truncated: boolean }> {
  const res = await api(`/api/vault/file?path=${encodeURIComponent(path)}`)
  if (!res.ok) throw new Error(await res.text())
  const d = await res.json()
  return { content: d.content, truncated: d.truncated }
}
export type WikiResolve = { path: string } | { indexing: true } | null
/** 503 = the vault index is still building after a restart (~50s) — distinct from
 *  a genuinely missing note so the UI can say "try again shortly". */
export async function resolveWikiLink(name: string): Promise<WikiResolve> {
  const res = await api(`/api/vault/resolve?name=${encodeURIComponent(name)}`)
  if (res.status === 503) return { indexing: true }
  if (!res.ok) return null
  const d = await res.json()
  return d.path ? { path: d.path } : null
}

export function vaultRawUrl(path: string): string {
  const token = getToken()
  const jwt = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('zeromux_jwt='))?.split('=')[1] || ''
  const authToken = token || jwt
  const params = new URLSearchParams({ path })
  if (authToken) params.set('token', authToken)
  return `/api/vault/file/raw?${params}`
}
