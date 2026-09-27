import { useState, type MouseEvent } from 'react'
import { MoreHorizontal, Zap, Repeat, MessageSquarePlus, FolderInput } from 'lucide-react'
import type { SearchResult, DirHit, NoteHit } from '../lib/api'
import { RowIcon } from './QuickTargets'
import { orderSections, compactHint } from '../lib/searchOrder'
import { IconButton, Menu, type MenuItem } from './ui'

function Hint({ text }: { text: string }) {
  return text ? <span className="truncate text-ui-2xs text-[var(--text-muted)]">{text}</span> : null
}

function Status({ text }: { text: string }) {
  return <div className="px-3 py-2 text-ui-2xs text-[var(--text-muted)]">{text}</div>
}

export default function SearchResults({ result, showNotes, onPickDir, onDirMenu, onPickNote, onAskAgent, onOpenHere, onRetry, failed }: {
  result: SearchResult
  showNotes: boolean
  onPickDir: (hit: DirHit) => void
  onDirMenu?: { changeAgent: (hit: DirHit) => void; withPrompt: (hit: DirHit) => void }
  onPickNote: (hit: NoteHit) => void
  onAskAgent: (hit: NoteHit) => void
  onOpenHere?: (hit: NoteHit) => void
  onRetry?: () => void
  failed?: boolean
}) {
  const [menu, setMenu] = useState<{ key: string; anchor: HTMLElement; items: MenuItem[]; title: string } | null>(null)
  const toggleMenu = (key: string, title: string, items: MenuItem[]) => (e: MouseEvent<HTMLButtonElement>) => {
    const anchor = e.currentTarget
    setMenu(cur => (cur?.key === key ? null : { key, anchor, items, title }))
  }
  const more = (key: string, title: string, items: MenuItem[]) => (
    <span className="shrink-0 flex items-center pr-1">
      <IconButton label="更多" icon={MoreHorizontal} size="sm" data-testid="sr-menu" aria-haspopup="menu"
        aria-expanded={menu?.key === key} onClick={toggleMenu(key, title, items)} />
    </span>
  )

  if (failed) {
    return (
      <div className="px-3 py-2 flex items-center justify-between gap-2">
        <span className="text-ui-2xs text-[var(--text-muted)]">搜索暂时不可用</span>
        {onRetry && (
          <button type="button" onClick={onRetry}
            className="shrink-0 px-2 py-1 min-h-[44px] text-ui-2xs font-semibold bg-[var(--bg-hover)] rounded">重试</button>
        )}
      </div>
    )
  }

  const rowBtn = 'flex items-start gap-2 flex-1 min-w-0 px-3 py-2 min-h-[48px] text-left hover:bg-[var(--bg-hover)] transition-colors'
  const sideBtn = 'shrink-0 w-11 flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors'

  const dirSection = () => {
    const s = result.dirs
    if (!s) return null
    return (
      <div key="dirs">
        <div className="px-3 pt-2 pb-1 text-ui-2xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">目录</div>
        {s.indexing ? <Status text="正在建立目录索引…" />
          : s.items.length === 0 ? <Status text={s.refreshing ? '索引刷新中…' : '未找到（仅索引 6 层内）· 用「其他目录…」浏览'} />
          : (
            <ul>
              {s.items.map(h => {
                const key = `d|${h.path}`
                return (
                  <li key={key} className="border-b border-[var(--border)] last:border-b-0">
                    <div className="flex items-stretch">
                      <button type="button" className={rowBtn} title={h.path} onClick={() => onPickDir(h)}>
                        <span className="mt-0.5"><RowIcon kind="dir" agent={h.agent ?? ''} /></span>
                        <span className="flex flex-col min-w-0 flex-1">
                          <span className="truncate text-xs text-[var(--text-primary)]">{h.display}</span>
                          <Hint text={h.hint} />
                        </span>
                      </button>
                      {onDirMenu && h.agent && more(key, h.display, [
                        { label: '换 agent 类型', icon: Repeat, onSelect: () => onDirMenu.changeAgent(h) },
                        { label: '带 prompt 打开', icon: MessageSquarePlus, onSelect: () => onDirMenu.withPrompt(h) },
                      ])}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
      </div>
    )
  }

  const noteSection = () => {
    const s = result.notes
    if (!s || !showNotes) return null
    return (
      <div key="notes">
        <div className="px-3 pt-2 pb-1 text-ui-2xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">笔记</div>
        {s.indexing ? <Status text="正在建立笔记索引…" />
          : s.items.length === 0 ? <Status text="无匹配笔记" />
          : (
            <ul>
              {s.items.map(h => {
                const key = `n|${h.kind}|${h.path}`
                return (
                  <li key={key} className="border-b border-[var(--border)] last:border-b-0">
                    <div className="flex items-stretch">
                      <button type="button" className={rowBtn} title={h.path} onClick={() => onPickNote(h)}>
                        <span className="mt-0.5"><RowIcon kind={h.kind} agent="" /></span>
                        <span className="flex flex-col min-w-0 flex-1">
                          <span className="truncate text-xs text-[var(--text-primary)]">{h.display}</span>
                          <Hint text={compactHint(h.hint)} />
                        </span>
                      </button>
                      {/* ⚡ = ask an agent about this note, in the note's own folder. A separate
                          ≥44px target (never hover-only — invisible-but-tappable on phones). */}
                      <button type="button" data-testid="sr-ask" className={sideBtn} title="问 agent"
                        onClick={() => onAskAgent(h)}><Zap size={14} /></button>
                      {h.kind === 'folder' && onOpenHere && more(key, h.display, [
                        { label: '在此开 agent', icon: FolderInput, onSelect: () => onOpenHere(h) },
                      ])}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
      </div>
    )
  }

  return (
    <div>
      {orderSections(result, showNotes).map(k => (k === 'dirs' ? dirSection() : noteSection()))}
      <Menu open={!!menu} onClose={() => setMenu(null)} anchor={menu?.anchor ?? null} items={menu?.items ?? []} title={menu?.title} />
    </div>
  )
}
