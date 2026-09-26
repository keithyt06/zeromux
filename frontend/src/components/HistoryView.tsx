import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getHistory } from '../lib/api'

const CHUNK = 500

export function chunkLines(text: string, size: number): string[] {
  const lines = text.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i += size) out.push(lines.slice(i, i + size).join('\n'))
  return out
}

interface Props { sessionId: string; title: string; onClose: () => void }

// Full tmux history as native, scrollable, long-press-selectable text. Blocks of
// 500 lines with content-visibility keep 50k lines smooth on phones.
export default function HistoryView({ sessionId, title, onClose }: Props) {
  const [text, setText] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    ;(document.activeElement as HTMLElement | null)?.blur?.()   // drop the soft keyboard
    getHistory(sessionId)
      .then(r => { if (!cancelled) { setText(r.text); setTruncated(r.truncated) } })
      .catch(e => { if (!cancelled) setError(String(e?.message ?? e)) })
    return () => { cancelled = true }
  }, [sessionId])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && text !== null) el.scrollTop = el.scrollHeight
  }, [text])

  const toTop = () => { if (scrollRef.current) scrollRef.current.scrollTop = 0 }
  const toBottom = () => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight }
  const btn = 'px-2.5 py-1.5 rounded border border-[var(--border)] text-xs text-[var(--text-secondary)] active:bg-[var(--bg-hover)]'

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-[var(--bg-primary)]">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)] bg-[var(--bg-secondary)] text-xs">
        <span className="flex-1 truncate font-medium text-[var(--text-primary)]">历史 · {title}</span>
        <button aria-label="关闭历史" onClick={onClose} className="px-2 text-[var(--text-muted)] hover:text-[var(--text-primary)]">✕</button>
      </div>
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain select-text" style={{ touchAction: 'pan-y', WebkitUserSelect: 'text' }}>
        {truncated && <div className="px-3 py-1 text-[10px] text-[var(--text-muted)]">仅显示最近 5MB</div>}
        {error && <div className="px-3 py-2 text-xs text-[var(--accent-red)]">{error}</div>}
        {text === null && !error && <div className="px-3 py-2 text-xs text-[var(--text-muted)]">Loading...</div>}
        {text !== null && chunkLines(text, CHUNK).map((c, i) => (
          <pre key={i} className="px-3 m-0 text-[12px] leading-[1.35] font-mono whitespace-pre-wrap break-all text-[var(--text-primary)]"
            style={{ contentVisibility: 'auto', containIntrinsicSize: `auto ${CHUNK * 16}px` }}>{c}</pre>
        ))}
      </div>
      <div className="flex gap-2 px-3 py-2 border-t border-[var(--border)] bg-[var(--bg-secondary)]">
        <button className={btn} onClick={toTop}>⤒ 首行</button>
        <button className={btn} onClick={toBottom}>⤓ 底部</button>
        <button className={btn} onClick={() => text !== null && navigator.clipboard?.writeText(text)}>复制全部</button>
      </div>
    </div>
  )
}
