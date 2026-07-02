import type { DirListEntry } from './api'
import { vaultRawUrl } from './api'

export function shouldShowVault(meta: { enabled: boolean; name: string } | null): boolean {
  return !!meta && meta.enabled
}

// Reader tree shows directories and .md only; hide dot-dirs (.obsidian/.trash).
export function filterVaultEntries(entries: DirListEntry[]): DirListEntry[] {
  return entries.filter(e => {
    if (e.name.startsWith('.')) return false
    if (e.type === 'dir') return true
    return e.name.toLowerCase().endsWith('.md')
  })
}

// Rewrite a relative image src (relative to the note's dir) to the vault raw URL.
// Absolute URLs (http/https/data) pass through untouched.
export function resolveVaultImageSrc(src: string, noteRelPath: string): string {
  if (/^(https?:|data:|\/)/.test(src)) return src
  const noteDir = noteRelPath.includes('/') ? noteRelPath.slice(0, noteRelPath.lastIndexOf('/')) : ''
  const joined = noteDir ? `${noteDir}/${src}` : src
  // normalize ./ and ../ minimally
  const parts: string[] = []
  for (const seg of joined.split('/')) {
    if (seg === '.' || seg === '') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return vaultRawUrl(parts.join('/'))
}

const RECENT_KEY = 'zmx-vault-recent'
export function getRecentNotes(): string[] {
  // Guard both parse errors AND a valid-JSON non-array (e.g. tampered "5"/{}), which
  // would otherwise blow up the .filter in pushRecentNote/removeRecentNote.
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]')
    return Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : []
  } catch { return [] }
}
export function pushRecentNote(path: string): void {
  const cur = getRecentNotes().filter(p => p !== path)
  cur.unshift(path)
  localStorage.setItem(RECENT_KEY, JSON.stringify(cur.slice(0, 10)))
}
// Drop a stale entry (e.g. a note deleted/renamed in Obsidian that 404s on open).
export function removeRecentNote(path: string): void {
  localStorage.setItem(RECENT_KEY, JSON.stringify(getRecentNotes().filter(p => p !== path)))
}
