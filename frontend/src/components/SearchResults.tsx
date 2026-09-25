import { useState } from 'react'
import { MoreVertical, Zap, Repeat, MessageSquarePlus, FolderInput } from 'lucide-react'
import type { SearchResult, DirHit, NoteHit } from '../lib/api'
import { RowIcon } from './QuickTargets'
import { orderSections, compactHint } from '../lib/searchOrder'

function Hint({ text }: { text: string }) {
  return text ? <span className="truncate text-[10px] text-[var(--text-muted)]">{text}</span> : null
}

function Status({ text }: { text: string }) {
  return <div className="px-3 py-2 text-[10px] text-[var(--text-muted)]">{text}</div>
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
  const [openMenu, setOpenMenu] = useState<string | null>(null)

  if (failed) {
    return (
      <div className="px-3 py-2 flex items-center justify-between gap-2">
        <span className="text-[10px] text-[var(--text-muted)]">搜索暂时不可用</span>
        {onRetry && (
          <button type="button" onClick={onRetry}
            className="shrink-0 px-2 py-1 min-h-[44px] text-[10px] font-semibold bg-[var(--bg-hover)] rounded">重试</button>
        )}
      </div>
    )
  }

  const rowBtn = 'flex items-start gap-2 flex-1 min-w-0 px-3 py-2 min-h-[48px] text-left hover:bg-[var(--bg-hover)] transition-colors'
  const sideBtn = 'shrink-0 w-11 flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors'
  const menuItem = 'flex items-center gap-2 w-full px-3 py-2.5 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'

  const dirSection = () => {
    const s = result.dirs
    if (!s) return null
    return (
      <div key="dirs">
        <div className="px-3 pt-2 pb-1 text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">目录</div>
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
                      {onDirMenu && h.agent && (
                        <button type="button" data-testid="sr-menu" className={sideBtn} title="更多操作"
                          onClick={() => setOpenMenu(c => (c === key ? null : key))}><MoreVertical size={14} /></button>
                      )}
                    </div>
                    {openMenu === key && onDirMenu && (
                      <div className="border-t border-[var(--border)] bg-[var(--bg-secondary)]">
                        <button type="button" className={menuItem} onClick={() => { setOpenMenu(null); onDirMenu.changeAgent(h) }}>
                          <Repeat size={13} className="shrink-0" />换 agent 类型
                        </button>
                        <button type="button" className={menuItem} onClick={() => { setOpenMenu(null); onDirMenu.withPrompt(h) }}>
                          <MessageSquarePlus size={13} className="shrink-0" />带 prompt 打开
                        </button>
                      </div>
                    )}
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
        <div className="px-3 pt-2 pb-1 text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">笔记</div>
        {s.indexing ? <Status text="正在建立笔记索引…" />
          : s.items.length === 0 ? <Status text={s.refreshing ? '笔记索引刷新中…' : '无匹配笔记'} />
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
                      {h.kind === 'folder' && onOpenHere && (
                        <button type="button" data-testid="sr-menu" className={sideBtn} title="更多操作"
                          onClick={() => setOpenMenu(c => (c === key ? null : key))}><MoreVertical size={14} /></button>
                      )}
                    </div>
                    {openMenu === key && onOpenHere && (
                      <div className="border-t border-[var(--border)] bg-[var(--bg-secondary)]">
                        <button type="button" className={menuItem} onClick={() => { setOpenMenu(null); onOpenHere(h) }}>
                          <FolderInput size={13} className="shrink-0" />在此开 agent
                        </button>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
      </div>
    )
  }

  return <div>{orderSections(result, showNotes).map(k => (k === 'dirs' ? dirSection() : noteSection()))}</div>
}
