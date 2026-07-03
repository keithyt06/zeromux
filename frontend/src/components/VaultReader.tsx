import { useState, useEffect, useCallback } from 'react'
import { X, ChevronLeft, Search, FileText, Folder } from 'lucide-react'
import { listVault, getVaultFile, getVaultSearch, resolveWikiLink } from '../lib/api'
import { filterVaultEntries, resolveVaultImageSrc, getRecentNotes, pushRecentNote, removeRecentNote } from '../lib/vault'
import MarkdownContent from './markdown/MarkdownContent'
import type { DirListEntry } from '../lib/api'

export default function VaultReader({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<'list' | 'read'>('list')
  const [cwd, setCwd] = useState('')
  const [entries, setEntries] = useState<DirListEntry[]>([])
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ path: string; name: string }[]>([])
  const [searchTruncated, setSearchTruncated] = useState(false)
  const [openPath, setOpenPath] = useState('')
  const [content, setContent] = useState('')
  const [truncated, setTruncated] = useState(false)
  const [recent, setRecent] = useState<string[]>(() => getRecentNotes())

  const loadDir = useCallback((path: string) => {
    listVault(path).then(r => setEntries(filterVaultEntries(r.entries))).catch(() => setEntries([]))
  }, [])
  useEffect(() => { loadDir(cwd) }, [cwd, loadDir])

  useEffect(() => {
    const t = setTimeout(() => {
      if (!query.trim()) { setResults([]); setSearchTruncated(false); return }
      getVaultSearch(query)
        .then(r => { setResults(r.results); setSearchTruncated(!!r.truncated) })
        .catch(() => { setResults([]); setSearchTruncated(false) })
    }, 200)
    return () => clearTimeout(t)
  }, [query])

  const openNote = useCallback((path: string) => {
    getVaultFile(path).then(r => {
      setContent(r.content); setTruncated(r.truncated); setOpenPath(path); setMode('read')
      pushRecentNote(path); setRecent(getRecentNotes())
    }).catch(() => {
      // A stale "最近打开" entry (note deleted/renamed in Obsidian) 404s here. Don't
      // swallow it silently — tell the user and prune the dead entry, matching the
      // onWikiLink sibling which already alerts on a missing target.
      alert('无法打开笔记(可能已被删除或移动):' + path)
      removeRecentNote(path); setRecent(getRecentNotes())
    })
  }, [])

  const onWikiLink = useCallback((name: string) => {
    resolveWikiLink(name).then(p => { if (p) openNote(p); else alert('未找到对应笔记:' + name) })
  }, [openNote])

  // READ MODE
  if (mode === 'read') {
    return (
      <div className="absolute inset-0 bg-[var(--bg-primary)] z-50 flex flex-col">
        <div className="flex items-center gap-2 p-2 border-b border-[var(--border)]">
          <button onClick={() => setMode('list')} className="p-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"><ChevronLeft size={18} /></button>
          <span className="text-sm truncate flex-1">{openPath}</span>
          <button onClick={onClose} className="p-1.5 text-[var(--text-secondary)] hover:text-[var(--accent-red)]"><X size={18} /></button>
        </div>
        {/* vault-reading-surface keeps the app's dark theme (per user preference). The class is
            retained for `contain: paint` (clickjacking containment). Notes carry their own inline
            cell backgrounds; cells that set a light background without an explicit text color will
            have low contrast on the dark page — an accepted trade-off for a dark reading surface. */}
        <div className="flex-1 overflow-auto">
          <div className="vault-reading-surface min-h-full">
            <article className="mx-auto max-w-[72ch] px-4 py-6 leading-relaxed text-[15px]">
              {truncated && <div className="mb-3 px-3 py-2 text-xs rounded bg-[var(--bg-tertiary)] text-[var(--accent-yellow)]">内容过长,仅显示前 1MB</div>}
              <MarkdownContent text={content} isComplete enableRawHtml
                resolveSrc={(s) => resolveVaultImageSrc(s, openPath)}
                onWikiLink={onWikiLink} />
            </article>
          </div>
        </div>
      </div>
    )
  }

  // LIST MODE
  const crumbs = cwd ? cwd.split('/') : []
  return (
    <div className="absolute inset-0 bg-[var(--bg-primary)] z-50 flex flex-col">
      <div className="flex items-center gap-2 p-2 border-b border-[var(--border)]">
        <span className="text-sm font-bold flex-1">📓 Obsidian</span>
        <button onClick={onClose} className="p-1.5 text-[var(--text-secondary)] hover:text-[var(--accent-red)]"><X size={18} /></button>
      </div>
      <div className="p-2 border-b border-[var(--border)]">
        <div className="flex items-center gap-2 px-2 py-1 rounded bg-[var(--bg-tertiary)]">
          <Search size={14} className="text-[var(--text-secondary)]" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索笔记名…"
            className="flex-1 bg-transparent text-sm outline-none text-[var(--text-primary)]" />
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        {query.trim() ? (
          <ul>{results.map(r => (
            <li key={r.path}><button onClick={() => openNote(r.path)} className="flex items-center gap-2 w-full px-3 py-2 text-sm text-left hover:bg-[var(--bg-tertiary)]"><FileText size={14} />{r.name}<span className="text-xs text-[var(--text-secondary)] truncate">{r.path}</span></button></li>
          ))}{results.length === 0 && <li className="px-3 py-2 text-xs text-[var(--text-secondary)]">无匹配</li>}{searchTruncated && <li className="px-3 py-2 text-xs text-[var(--accent-yellow)]">仅显示前 100 条结果,请细化搜索</li>}</ul>
        ) : (
          <>
            {recent.length > 0 && cwd === '' && (
              <div className="px-3 pt-2">
                <div className="text-xs text-[var(--text-secondary)] mb-1">最近打开</div>
                {recent.map(p => <button key={p} onClick={() => openNote(p)} className="flex items-center gap-2 w-full px-1 py-1 text-sm text-left hover:bg-[var(--bg-tertiary)] rounded"><FileText size={14} />{p.split('/').pop()}</button>)}
                <div className="h-px bg-[var(--border)] my-2" />
              </div>
            )}
            {crumbs.length > 0 && (
              <button onClick={() => setCwd(crumbs.slice(0, -1).join('/'))} className="flex items-center gap-1 px-3 py-2 text-sm text-[var(--text-secondary)]"><ChevronLeft size={14} />返回上级</button>
            )}
            <ul>{entries.map(e => (
              <li key={e.name}>
                <button onClick={() => e.type === 'dir' ? setCwd(cwd ? `${cwd}/${e.name}` : e.name) : openNote(cwd ? `${cwd}/${e.name}` : e.name)}
                  className="flex items-center gap-2 w-full px-3 py-2 text-sm text-left hover:bg-[var(--bg-tertiary)]">
                  {e.type === 'dir' ? <Folder size={14} className="text-[var(--accent-blue)]" /> : <FileText size={14} className="text-[var(--text-secondary)]" />}
                  {e.name}
                </button>
              </li>
            ))}</ul>
          </>
        )}
      </div>
    </div>
  )
}
