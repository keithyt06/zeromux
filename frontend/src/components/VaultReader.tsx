import { useState, useEffect, useCallback, useRef } from 'react'
import { X, ChevronLeft, Search, FileText, Folder } from 'lucide-react'
import { listVault, getVaultFile, searchPaths, resolveWikiLink } from '../lib/api'
import { filterVaultEntries, resolveVaultImageSrc } from '../lib/vault'
import QuickTargets from './QuickTargets'
import { notifyQuickTargetsChanged } from '../lib/quickTargetsBus'
import MarkdownContent from './markdown/MarkdownContent'
import type { DirListEntry } from '../lib/api'
import { docTitleFromPath } from '../lib/docTabs'

export default function VaultReader({ onClose, onTitleChange }: { onClose?: () => void; onTitleChange?: (title: string | null) => void }) {
  const [mode, setMode] = useState<'list' | 'read'>('list')
  const [cwd, setCwd] = useState('')
  const [entries, setEntries] = useState<DirListEntry[]>([])
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ path: string; name: string }[]>([])
  const [searchTruncated, setSearchTruncated] = useState(false)
  const [openPath, setOpenPath] = useState('')
  const [content, setContent] = useState('')
  const [truncated, setTruncated] = useState(false)
  // Monotonic request tokens so an out-of-order response can't paint stale
  // content — the same stale-response hardening applied to GitViewer.selectCommit
  // and FileBrowser.openFile (reviews 2026-08-03/06/07). A slow read of note A
  // resolving AFTER a fast read of note B (tapped second) must not overwrite B.
  const openReqRef = useRef(0)
  const searchReqRef = useRef(0)

  // `ignore` invalidates a stale directory listing when cwd changes before the
  // in-flight listVault resolves (matches FileBrowser's listing effect).
  useEffect(() => {
    let ignore = false
    listVault(cwd)
      .then(r => { if (!ignore) setEntries(filterVaultEntries(r.entries)) })
      .catch(() => { if (!ignore) setEntries([]) })
    return () => { ignore = true }
  }, [cwd])

  useEffect(() => {
    const t = setTimeout(() => {
      if (!query.trim()) { setResults([]); setSearchTruncated(false); return }
      const req = ++searchReqRef.current
      searchPaths(query, 'notes', 50)
        .then(r => { if (searchReqRef.current === req) {
          setResults((r.notes?.items ?? []).map(i => ({ path: i.path, name: i.display })))
          setSearchTruncated(!!r.notes?.truncated)
        } })
        .catch(() => { if (searchReqRef.current === req) { setResults([]); setSearchTruncated(false) } })
    }, 200)
    return () => clearTimeout(t)
  }, [query])

  const openNote = useCallback((path: string) => {
    const req = ++openReqRef.current
    getVaultFile(path).then(r => {
      if (openReqRef.current !== req) return // a newer openNote superseded this read
      setContent(r.content); setTruncated(r.truncated); setOpenPath(path); setMode('read')
      notifyQuickTargetsChanged()   // vault_file bumped on the server; re-rank the list
      onTitleChange?.(docTitleFromPath(path))
    }).catch(() => {
      if (openReqRef.current !== req) return
      // A stale entry (note deleted/moved in Obsidian) 404s here. The backend's
      // read-time guard prunes and deletes the row on the next listing, so all
      // that's left to do is tell the user.
      alert('无法打开笔记(可能已被删除或移动):' + path)
    })
  }, [onTitleChange])

  const onWikiLink = useCallback((name: string) => {
    resolveWikiLink(name).then(r => {
      if (r && 'path' in r) openNote(r.path)
      else if (r && 'indexing' in r) alert('笔记索引建立中，请稍候再试')
      else alert('未找到对应笔记:' + name)
    })
  }, [openNote])

  // READ MODE
  if (mode === 'read') {
    return (
      <div className="h-full bg-[var(--bg-primary)] flex flex-col">
        <div className="flex items-center gap-2 p-2 border-b border-[var(--border)]">
          <button onClick={() => { setMode('list'); onTitleChange?.(null) }} className="p-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"><ChevronLeft size={18} /></button>
          <span className="text-sm truncate flex-1">{openPath}</span>
          {onClose && <button onClick={onClose} className="p-1.5 text-[var(--text-secondary)] hover:text-[var(--accent-red)]"><X size={18} /></button>}
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
    <div className="h-full bg-[var(--bg-primary)] flex flex-col">
      <div className="flex items-center gap-2 p-2 border-b border-[var(--border)]">
        <span className="text-sm font-bold flex-1">📓 Obsidian</span>
        {onClose && <button onClick={onClose} className="p-1.5 text-[var(--text-secondary)] hover:text-[var(--accent-red)]"><X size={18} /></button>}
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
            {/* `hidden` rather than conditional rendering: VaultReader stays mounted in
                App.tsx (visibility toggled by class, deliberately never unmounted so
                scroll state survives), so conditional rendering would remount on every
                cwd change and re-pay the full per-note validation IO. */}
            <div className={cwd === '' ? '' : 'hidden'}>
              <QuickTargets kind="note" onPick={(path) => openNote(path)} />
            </div>
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
