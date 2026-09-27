import { api, ApiError } from './core'
import type { SessionType } from './sessions'

// ── Quick targets（常用目录/笔记 frecency）──

export interface QuickTarget {
  kind: 'dir' | 'note'
  path: string
  /** dir: claude|crew|codex|tmux；note: 空串 */
  agent: string
  display: string
  hint: string
}

export async function listQuickTargets(kind: 'dir' | 'note'): Promise<{ top: QuickTarget[] }> {
  const res = await api(`/api/quick-targets?kind=${kind}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function forgetQuickTarget(kind: 'dir' | 'note', path: string, agent: string): Promise<void> {
  const params = new URLSearchParams({ kind, path, agent })
  const res = await api(`/api/quick-targets?${params}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(await res.text())
}

export interface DirHit { path: string; display: string; hint: string; agent: SessionType | null; score: number }
export interface NoteHit { path: string; kind: 'note' | 'folder'; display: string; hint: string; abs_dir: string; score: number }
export interface SearchSection<T> { kind: 'dirs' | 'notes'; indexing: boolean; refreshing: boolean; truncated: boolean; items: T[] }
export interface SearchResult { dirs: SearchSection<DirHit> | null; notes: SearchSection<NoteHit> | null }

const SEARCH_AGENTS: readonly SessionType[] = ['tmux', 'claude', 'crew', 'codex']

export async function searchPaths(q: string, scope: string, limit = 6): Promise<SearchResult> {
  const params = new URLSearchParams({ q, scope, limit: String(limit) })
  const res = await api(`/api/search?${params}`)
  if (!res.ok) throw new ApiError(res.status, await res.text())
  const d = await res.json() as { sections: Array<SearchSection<unknown> & { kind: string }> }
  const out: SearchResult = { dirs: null, notes: null }
  for (const s of d.sections ?? []) {
    if (s.kind === 'dirs') {
      out.dirs = { ...s, kind: 'dirs', items: (s.items as DirHit[]).map(it => ({
        ...it, agent: SEARCH_AGENTS.includes(it.agent as SessionType) ? it.agent : null,
      })) }
    } else if (s.kind === 'notes') {
      out.notes = { ...s, kind: 'notes', items: s.items as NoteHit[] }
    } // unknown kinds: ignored (forward compatible)
  }
  return out
}

/** Fire-and-forget: ask the server to refresh stale indexes while the user types. */
export async function warmSearchIndex(scope: string): Promise<void> {
  try { await api(`/api/search/warm?scope=${encodeURIComponent(scope)}`) } catch { /* best effort */ }
}
