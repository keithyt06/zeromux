import { useState } from 'react'
import { ChevronLeft, MoreHorizontal, PanelRight } from 'lucide-react'
import type { SessionInfo } from '../../lib/api'
import type { Attention } from '../../lib/triage'
import { toneOf, labelOf } from '../../lib/triage'
import type { SessionAction } from '../../lib/sessionActions'
import { formatCost, formatDuration } from '../../lib/format'
import { IconButton, Menu, StatusDot } from '../ui'
import { TypeIcon } from './TypeIcon'
import { CrewVariantBadge } from './CrewVariantBadge'

/** The single session top bar (spec M20 / S3 §2.1). Status, elapsed and cost come
 *  from the triage data; ⋯ renders the sessionActions registry (V15). */
export function FocusHeader({ session, attention, now, narrow, needsYou, onBack, actions, panelOpen, onTogglePanel, ctxUsage }: {
  session: SessionInfo
  attention: Attention
  now: number
  narrow: boolean
  needsYou: number
  onBack(): void
  actions: SessionAction[]
  panelOpen: boolean
  onTogglePanel(): void
  ctxUsage?: { used: number; total: number } | null
}) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const running = session.turn_state === 'running' && session.turn_started_ms != null
  const elapsed = running ? formatDuration(now - session.turn_started_ms!) : ''
  const cost = session.lifetime_cost_usd ? formatCost(session.lifetime_cost_usd, 'short') : ''
  const ctxPct = ctxUsage && ctxUsage.total > 0 ? Math.round((ctxUsage.used / ctxUsage.total) * 100) : null
  const dormant = !!session.peer_name && !session.running
  return (
    <header className="shrink-0 flex items-center gap-2 px-2 min-h-[var(--row-h)] [@media(pointer:coarse)]:min-h-[48px] border-b border-[var(--border-subtle)] bg-[var(--surface-1)]">
      {narrow && (
        <button type="button" onClick={onBack} aria-label={`返回分诊 (${needsYou})`}
          className="shrink-0 inline-flex items-center gap-0.5 min-h-[var(--hit)] px-1 rounded-[var(--r-md)] text-ui-sm text-[var(--accent)] hover:bg-[var(--surface-hover)]">
          <ChevronLeft size={18} /><span>分诊</span>{needsYou > 0 && <span className="num">{`(${needsYou})`}</span>}
        </button>
      )}
      {!narrow && <StatusDot tone={toneOf(attention)} label={labelOf(attention)} />}
      {!narrow && <span className="shrink-0 text-ui-xs text-[var(--fg-muted)]">{labelOf(attention)}</span>}
      {!narrow && elapsed && <span className="num shrink-0 text-ui-xs text-[var(--fg-muted)]">{elapsed}</span>}
      {!narrow && cost && <span className="num shrink-0 text-ui-xs text-[var(--fg-subtle)]">{cost}</span>}
      <TypeIcon type={session.type} size={14} className="shrink-0 text-[var(--fg-muted)]" />
      <CrewVariantBadge session={session} />
      <span className="min-w-0 truncate text-ui-sm font-medium text-[var(--fg-strong)]" title={session.description || session.name}>{session.name}</span>
      {narrow && <StatusDot tone={toneOf(attention)} label={labelOf(attention)} />}
      {ctxPct != null && <span className="num shrink-0 text-ui-2xs text-[var(--fg-subtle)]" title="上下文用量(Crew 提供)">{`ctx ${ctxPct}%`}</span>}
      {dormant && !narrow && <span className="shrink-0 text-ui-2xs text-[var(--fg-subtle)]">休眠 · 打开会话后才能收到消息</span>}
      <span className="flex-1" />
      <IconButton label="面板" icon={PanelRight} active={panelOpen} onClick={onTogglePanel} aria-pressed={panelOpen} />
      <IconButton ref={setAnchor} label="会话操作" icon={MoreHorizontal} onClick={() => setOpen(v => !v)} aria-haspopup="menu" aria-expanded={open} />
      <Menu open={open} onClose={() => setOpen(false)} anchor={anchor} title={session.name}
        items={actions.map(a => ({ label: a.label, danger: a.danger, onSelect: () => { a.run() } }))} />
    </header>
  )
}
