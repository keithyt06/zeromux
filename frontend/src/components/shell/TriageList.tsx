import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { BookOpen, MoreHorizontal, Terminal } from 'lucide-react'
import type { SessionInfo, HostTmux } from '../../lib/api'
import type { DocTab } from '../../lib/docTabs'
import { groupTriage, type TriageItem } from '../../lib/triage'
import { isOrphan } from '../../lib/hostTmux'
import type { SessionControls } from '../../lib/sessionControls'
import type { SessionAction } from '../../lib/sessionActions'
import { IconButton, Menu } from '../ui'
import { TriageRow } from './TriageRow'
import { useAwayWindow } from '../../lib/awayClock'
import { summarizeAway } from '../../lib/awaySummary'
import { AwayCard } from './AwayCard'

export interface TriageListProps {
  sessions: SessionInfo[]
  activeId: string | null
  onSelect(id: string): void
  lastViewedMs: Record<string, number>
  confirmsBySession: Record<string, number>
  controls: RefObject<Record<string, SessionControls>>
  actionsFor(s: SessionInfo): SessionAction[]
  now: number
  hostTmux?: HostTmux[]
  onAttachTmux?(name: string): void
  docTabs?: DocTab[]
  onCloseDocTab?(id: string): void
  onOpenConfirm?(): void
  onRowRender?: () => void
}

function Group({ title, items, render }: { title: string; items: TriageItem[]; render(i: TriageItem): React.ReactNode }) {
  if (items.length === 0) return null
  return (
    <section className="pt-2">
      <h3 className="px-3 pb-1 text-ui-2xs font-semibold text-[var(--fg-subtle)]">{`${title} (${items.length})`}</h3>
      <ul role="list" aria-label={title} className="space-y-0.5">{items.map(render)}</ul>
    </section>
  )
}

function DocRow({ t, active, onSelect, onClose }: { t: DocTab; active: boolean; onSelect(id: string): void; onClose?(id: string): void }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  return (
    <li role="listitem" onClick={() => onSelect(t.id)}
      className={`row min-h-[48px] mx-1 px-2 rounded-[var(--r-md)] cursor-pointer flex items-center gap-2 ${active ? 'bg-[var(--surface-3)] shadow-[inset_2px_0_0_var(--brand)]' : 'hover:bg-[var(--surface-hover)]'}`}>
      <BookOpen size={14} className="shrink-0 text-[var(--accent)]" />
      <span data-row-name className="flex-1 min-w-0 truncate text-ui-sm text-[var(--fg-strong)]">{t.title}</span>
      {onClose && (
        <span className="shrink-0" onClick={e => e.stopPropagation()}>
          <IconButton ref={setAnchor} label="文档菜单" icon={MoreHorizontal} size="sm" onClick={() => setOpen(v => !v)} aria-haspopup="menu" aria-expanded={open} />
          <Menu open={open} onClose={() => setOpen(false)} anchor={anchor} title={t.title} items={[{ label: '关闭', danger: true, onSelect: () => onClose(t.id) }]} />
        </span>
      )}
    </li>
  )
}

/** Triage queue (spec §4.3/§4.4): 需要你 / 运行中 / 空闲 + 本机 tmux + 文档. */
export function TriageList(p: TriageListProps) {
  const { sessions, activeId, lastViewedMs, confirmsBySession, now, hostTmux = [], docTabs = [] } = p
  const groups = useMemo(() => groupTriage(sessions, { now, activeId, lastViewedMs, confirmsBySession }),
    [sessions, now, activeId, lastViewedMs, confirmsBySession])
  const away = useAwayWindow()
  const awaySummary = useMemo(
    () => (away.dismissed ? null : summarizeAway(sessions, confirmsBySession, away.leftMs, away.backMs)),
    [away.dismissed, away.leftMs, away.backMs, sessions, confirmsBySession])

  // Rows are memoized on data only; hand them stable identities that forward to
  // the latest props so an unchanged row never re-renders for a new closure (I-9).
  const latest = useRef(p)
  useEffect(() => { latest.current = p })
  const onSelect = useCallback((id: string) => latest.current.onSelect(id), [])
  const onOpenConfirm = useCallback(() => latest.current.onOpenConfirm?.(), [])
  const controls = useMemo<RefObject<Record<string, SessionControls>>>(() => ({
    get current() { return latest.current.controls.current },
  }), [])

  const row = (i: TriageItem) => (
    <TriageRow key={i.s.id} item={i} active={i.s.id === activeId} onSelect={onSelect} controls={controls}
      actions={p.actionsFor(i.s)} now={now} onOpenConfirm={p.onOpenConfirm ? onOpenConfirm : undefined} onRender={p.onRowRender} />
  )

  return (
    <div className="pb-2">
      <AwayCard summary={awaySummary} onSelect={onSelect} onDismiss={away.dismiss} />
      <Group title="需要你" items={groups.needsYou} render={row} />
      <Group title="运行中" items={groups.running} render={row} />
      <Group title="空闲" items={groups.idle} render={row} />
      {hostTmux.length > 0 && p.onAttachTmux && (
        <details className="mx-1 mt-2">
          <summary className="row px-2 flex items-center cursor-pointer text-ui-2xs font-semibold text-[var(--fg-subtle)]">{`本机 tmux (${hostTmux.length})`}</summary>
          <ul role="list" aria-label="本机 tmux">
            {hostTmux.map(h => (
              <li key={h.name}>
                <button type="button" onClick={() => p.onAttachTmux!(h.name)} title={`${h.path}\n点击接入`}
                  className="row w-full flex items-center gap-2 px-2 rounded-[var(--r-md)] text-left text-ui-sm text-[var(--fg-muted)] hover:bg-[var(--surface-hover)]">
                  <Terminal size={14} className="shrink-0" />
                  <span className="truncate">{h.name}</span>
                  {isOrphan(h) && <span className="shrink-0 text-ui-2xs text-[var(--attention)]">zeromux 遗留</span>}
                  <span className="num ml-auto shrink-0 text-ui-2xs text-[var(--fg-subtle)]">{`${h.windows} win${h.attached > 0 ? ` · ${h.attached} 在看` : ''}`}</span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      {docTabs.length > 0 && (
        <section className="pt-2">
          <h3 className="px-3 pb-1 text-ui-2xs font-semibold text-[var(--fg-subtle)]">文档</h3>
          <ul role="list" aria-label="文档" className="space-y-0.5">
            {docTabs.map(t => <DocRow key={t.id} t={t} active={t.id === activeId} onSelect={onSelect} onClose={p.onCloseDocTab} />)}
          </ul>
        </section>
      )}
    </div>
  )
}
