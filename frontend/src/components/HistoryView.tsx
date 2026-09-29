import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpToLine, ArrowDownToLine, ChevronUp, ChevronDown, X } from 'lucide-react'
import { getHistory } from '../lib/api'
import { parseAnsiLine, stripAnsi, type Span } from '../lib/ansi'
import { chunkLines, findMatches } from '../lib/historySearch'
import { confirm, IconButton } from './ui'

const CHUNK = 500

interface Props {
  sessionId: string
  title: string
  onClose: () => void
  split?: boolean
  onSendToAgent?: (selectionOrTail: string) => void
}

// Loaded payload remembers which mode it was fetched in, so a mode toggle never
// renders raw escapes (or strips a plain capture) while the refetch is in flight.
interface Loaded { text: string; truncated: boolean; ansi: boolean; alternate: boolean }

const parseChunks = (chunks: string[]): Span[][][] => chunks.map(c => c.split('\n').map(parseAnsiLine))

// Full tmux history as native, scrollable, long-press-selectable text. Blocks of
// 500 lines with content-visibility keep 50k lines smooth on phones.
export default function HistoryView({ sessionId, title, onClose, split, onSendToAgent }: Props) {
  const [ansi, setAnsi] = useState(false)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  // Worker output tagged with the chunks it was computed from; stale results are ignored.
  const [workerSpans, setWorkerSpans] = useState<{ src: string[]; spans: Span[][][] } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    ;(document.activeElement as HTMLElement | null)?.blur?.()   // drop the soft keyboard
    getHistory(sessionId, ansi)
      .then(r => { if (!cancelled) { setLoaded({ text: r.text, truncated: r.truncated, ansi, alternate: !!r.alternate }); setError(null) } })
      .catch(e => { if (!cancelled) setError(String(e?.message ?? e)) })
    return () => { cancelled = true }
  }, [sessionId, ansi])

  const text = loaded?.text ?? null
  const colored = loaded?.ansi ?? false
  const chunks = useMemo(() => (text === null ? [] : chunkLines(text, CHUNK)), [text])
  const plainChunks = useMemo(() => (colored ? chunks.map(stripAnsi) : chunks), [chunks, colored])
  const matches = useMemo(() => findMatches(plainChunks, q), [plainChunks, q])
  const cur = matches.length ? Math.min(idx, matches.length - 1) : -1

  // SGR parsing of 50k lines runs in a worker; jsdom/old browsers parse inline.
  const hasWorker = typeof Worker !== 'undefined'
  const inlineSpans = useMemo(() => (colored && !hasWorker ? parseChunks(chunks) : null), [colored, hasWorker, chunks])
  useEffect(() => {
    if (!colored || !hasWorker) return
    const w = new Worker(new URL('../lib/ansi.worker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (e: MessageEvent<Span[][][]>) => setWorkerSpans({ src: chunks, spans: e.data })
    w.postMessage(chunks)
    return () => w.terminate()
  }, [colored, hasWorker, chunks])
  const spans = colored ? (inlineSpans ?? (workerSpans?.src === chunks ? workerSpans.spans : null)) : null

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && text !== null) el.scrollTop = el.scrollHeight
  }, [text])

  // Bring the current match into view: the <mark> in plain mode, its block in color mode.
  useEffect(() => {
    if (cur < 0) return
    const root = scrollRef.current
    const el = root?.querySelector('[data-current]') ?? root?.querySelectorAll('pre')[matches[cur].chunk]
    el?.scrollIntoView?.({ block: 'center' })
  }, [cur, matches])

  const step = (d: number) => { if (matches.length) setIdx((cur + d + matches.length) % matches.length) }
  const toTop = () => { if (scrollRef.current) scrollRef.current.scrollTop = 0 }
  const toBottom = () => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight }
  const btn = 'px-2.5 py-1.5 rounded border border-[var(--border)] text-ui-xs text-[var(--text-secondary)] active:bg-[var(--bg-hover)]'
  const preCls = 'px-3 m-0 text-ui-2xs leading-[1.35] font-mono whitespace-pre-wrap break-all text-[var(--text-primary)]'
  const preStyle = { contentVisibility: 'auto', containIntrinsicSize: `auto ${CHUNK * 16}px` } as const
  const rootCls = split
    ? 'absolute inset-y-0 right-0 w-1/2 border-l border-[var(--border)]'
    : 'absolute inset-0'

  const renderChunk = (c: string, i: number) => {
    if (spans?.[i]) {
      return spans[i].map((line, li) => (
        <span key={li}>
          {line.map((sp, si) => (
            <span key={si} style={{ color: sp.fg, background: sp.bg, fontWeight: sp.bold ? 600 : undefined }}>{sp.text}</span>
          ))}
          {li < spans[i].length - 1 ? '\n' : null}
        </span>
      ))
    }
    // Only the current match is highlighted — marking every hit in 50k lines is too heavy.
    const m = cur >= 0 && !colored ? matches[cur] : null
    if (!m || m.chunk !== i) return colored ? plainChunks[i] : c
    return <>{c.slice(0, m.offset)}<mark data-current="">{c.slice(m.offset, m.offset + q.length)}</mark>{c.slice(m.offset + q.length)}</>
  }

  return (
    <div className={`${rootCls} z-drawer flex flex-col bg-[var(--bg-primary)]`}>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)] bg-[var(--bg-secondary)] text-ui-xs">
        <span className="shrink-0 max-w-[40%] truncate font-medium text-[var(--text-primary)]">历史 · {title}</span>
        <input value={q} placeholder="搜索历史"
          onChange={e => { setQ(e.target.value); setIdx(0) }}
          onKeyDown={e => { if (e.key === 'Enter') step(e.shiftKey ? -1 : 1) }}
          className="flex-1 min-w-0 px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-primary)] text-ui-input outline-none" />
        <span className="shrink-0 tabular-nums text-[var(--text-muted)]">{matches.length ? `${cur + 1}/${matches.length}` : q ? '0/0' : ''}</span>
        <IconButton label="上一个" icon={ChevronUp} size="sm" onClick={() => step(-1)} />
        <IconButton label="下一个" icon={ChevronDown} size="sm" onClick={() => step(1)} />
        <IconButton label="关闭历史" icon={X} size="sm" onClick={onClose} />
      </div>
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain select-text" style={{ touchAction: 'pan-y', WebkitUserSelect: 'text' }}>
        {loaded?.alternate && <div className="px-3 py-1.5 text-ui-2xs text-[var(--accent-yellow)] border-b border-[var(--border)]">当前程序处于全屏模式（如 Claude Code/vim），历史只含当前屏；请在终端中直接滑动查看。新开的终端已默认关闭 Claude Code 全屏模式。</div>}
        {loaded?.truncated && <div className="px-3 py-1 text-ui-2xs text-[var(--text-muted)]">仅显示最近 5MB</div>}
        {error && <div className="px-3 py-2 text-ui-xs text-[var(--accent-red)]">{error}</div>}
        {text === null && !error && <div className="px-3 py-2 text-ui-xs text-[var(--text-muted)]">Loading...</div>}
        {chunks.map((c, i) => <pre key={i} className={preCls} style={preStyle}>{renderChunk(c, i)}</pre>)}
      </div>
      <div className="flex gap-2 px-3 py-2 border-t border-[var(--border)] bg-[var(--bg-secondary)]">
        <button className={`${btn} flex items-center gap-1`} onClick={toTop}><ArrowUpToLine size={14} /> 首行</button>
        <button className={`${btn} flex items-center gap-1`} onClick={toBottom}><ArrowDownToLine size={14} /> 底部</button>
        <button className={btn} onClick={() => text !== null && navigator.clipboard?.writeText(colored ? stripAnsi(text) : text)}>复制全部</button>
        <button className={btn} onClick={() => setAnsi(a => !a)}>{ansi ? '纯文本' : '颜色'}</button>
        {onSendToAgent && (
          <button className={btn} onClick={async () => {
            const sel = window.getSelection()?.toString() ?? ''
            const raw = colored ? stripAnsi(text ?? '') : (text ?? '')
            const payload = sel.trim() ? sel : raw.split('\n').slice(-200).join('\n')
            if (await confirm({ title: '发给 agent？', body: '内容可能包含密钥或令牌,请确认后再发送。', confirmLabel: '发送' })) onSendToAgent(payload)
          }}>发给 agent</button>
        )}
      </div>
    </div>
  )
}
