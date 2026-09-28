import { memo, useState, type RefObject } from 'react'
import { MoreHorizontal, Monitor, Square, ShieldCheck, ClipboardCheck, Clock } from 'lucide-react'
import type { TriageItem } from '../../lib/triage'
import { toneOf, labelOf } from '../../lib/triage'
import type { SessionControls } from '../../lib/sessionControls'
import type { SessionAction } from '../../lib/sessionActions'
import { formatCost, formatDuration, formatRelative } from '../../lib/format'
import { IconButton, Menu, StatusDot, toast } from '../ui'
import { TypeIcon } from './TypeIcon'

export interface TriageRowProps {
  item: TriageItem
  active: boolean
  onSelect(id: string): void
  controls: RefObject<Record<string, SessionControls>>
  actions: SessionAction[]
  now: number
  onOpenConfirm?: () => void
  onRender?: () => void
}

const NOT_CONNECTED = '未连接,稍后重试'

// Right-hand time: running = turn elapsed, otherwise relative last activity.
function timeLabel(s: TriageItem['s'], now: number): string {
  if (s.turn_state === 'running' && s.turn_started_ms != null) return formatDuration(now - s.turn_started_ms)
  return s.last_activity_ms ? formatRelative(s.last_activity_ms, now) : ''
}

function TriageRowImpl({ item, active, onSelect, controls, actions, now, onOpenConfirm, onRender }: TriageRowProps) {
  onRender?.()
  const { s, attention } = item
  const [menuAnchor, setMenuAnchor] = useState<HTMLButtonElement | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const agent = s.type !== 'tmux'
  const time = timeLabel(s, now)
  const second = s.last_snippet ?? s.current_step ?? s.description
  const cost = s.lifetime_cost_usd ? formatCost(s.lifetime_cost_usd, 'short') : ''
  const showApproval = agent && attention === 'approval' && (s.pending_approvals ?? 0) > 0
  // Only while the backend still counts pending approvals: pendingApprovals()
  // also lists unresolved cards from completed turns.
  const approvals = showApproval && expanded ? (controls.current?.[s.id]?.pendingApprovals() ?? []) : []

  const stop = (e: { stopPropagation(): void }) => e.stopPropagation()
  const interrupt = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!controls.current?.[s.id]?.interrupt()) toast.push({ message: NOT_CONNECTED })
  }
  const resolve = (id: string, action: 'approve' | 'reject') => (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!controls.current?.[s.id]?.resolveApproval(id, action)) { toast.push({ message: NOT_CONNECTED }); return }
    // Collapse rather than re-read: the view marks it resolved only after its own commit.
    setExpanded(false)
  }

  return (
    <li role="listitem" data-session-row={s.id} aria-current={active ? 'true' : undefined} onClick={() => onSelect(s.id)}
      className={`row min-h-[56px] [@media(pointer:coarse)]:min-h-[64px] mx-1 px-2 py-1.5 rounded-[var(--r-md)] cursor-pointer flex flex-col justify-center transition-colors duration-[var(--dur-fast)] ${active ? 'bg-[var(--surface-3)] shadow-[inset_2px_0_0_var(--brand)]' : 'hover:bg-[var(--surface-hover)]'}`}>
      <div className="flex items-center gap-2 min-w-0">
        <StatusDot tone={toneOf(attention)} label={labelOf(attention)} />
        <span className="relative shrink-0 flex items-center text-[var(--fg-muted)]" title={s.source_task_id ? '定时任务' : undefined}>
          <TypeIcon type={s.type} size={14} />
          {s.source_task_id && <Clock size={10} aria-label="定时任务" className="absolute -bottom-1 -right-1 text-[var(--fg-subtle)]" />}
        </span>
        <span data-row-name className="flex-1 min-w-0 truncate text-ui-sm text-[var(--fg-strong)]"
          onDoubleClick={e => { e.stopPropagation(); actions.find(a => a.id === 'rename')?.run() }}>{s.name}</span>
        {s.other_clients > 0 && (
          <span className="shrink-0 inline-flex items-center gap-0.5 text-ui-2xs text-[var(--accent)]" title="其他终端也在查看">
            <Monitor size={12} aria-hidden /><span className="num">{s.other_clients}</span>
          </span>
        )}
        {cost && <span className="num shrink-0 hidden md:inline text-ui-2xs text-[var(--fg-subtle)]">{cost}</span>}
        <span className="num shrink-0 text-ui-2xs text-[var(--fg-subtle)]">{time}</span>
        <span className="shrink-0 -my-1" onClick={stop}>
          <IconButton ref={setMenuAnchor} label="会话菜单" icon={MoreHorizontal} size="sm" onClick={() => setMenuOpen(v => !v)}
            aria-haspopup="menu" aria-expanded={menuOpen} />
          <Menu open={menuOpen} onClose={() => setMenuOpen(false)} anchor={menuAnchor} title={s.name}
            items={actions.map(a => ({ label: a.label, danger: a.danger, onSelect: () => { a.run() } }))} />
        </span>
      </div>
      {(second || (agent && (attention === 'running' || attention === 'stuck' || showApproval || attention === 'confirm'))) && (
        <div className="flex items-center gap-2 min-w-0 pl-[22px]">
          <span className="flex-1 min-w-0 truncate text-ui-xs text-[var(--fg-subtle)]">{second}</span>
          {agent && (attention === 'running' || attention === 'stuck') && (
            <span className="shrink-0 -my-2" onClick={stop}>
              <IconButton label={`中断 ${s.name}`} icon={Square} size="sm" onClick={interrupt} />
            </span>
          )}
          {showApproval && (
            <span className="shrink-0 -my-2" onClick={stop}>
              <IconButton label={`批准 ${s.name}`} icon={ShieldCheck} size="sm" active={expanded} aria-expanded={expanded}
                onClick={e => { e.stopPropagation(); setExpanded(v => !v) }} />
            </span>
          )}
          {agent && attention === 'confirm' && onOpenConfirm && (
            <span className="shrink-0 -my-2" onClick={stop}>
              <IconButton label="打开确认" icon={ClipboardCheck} size="sm" onClick={e => { e.stopPropagation(); onOpenConfirm() }} />
            </span>
          )}
        </div>
      )}
      {showApproval && expanded && (
        <div className="mt-1 ml-[22px] space-y-1.5" onClick={stop}>
          {approvals.length === 0 && <p className="text-ui-xs text-[var(--fg-subtle)]">审批详情加载中,打开会话查看</p>}
          {approvals.map(ap => (
            <div key={ap.id} className="rounded-[var(--r-md)] border border-[var(--border)] bg-[var(--surface-2)] p-2">
              <p className="text-ui-xs text-[var(--fg)] break-words font-mono">{ap.tool}</p>
              {ap.purpose && <p className="text-ui-xs text-[var(--fg-muted)] break-words">{ap.purpose}</p>}
              <div className="flex gap-2 mt-1.5">
                <button type="button" onClick={resolve(ap.id, 'approve')}
                  className="min-h-[44px] flex-1 rounded-[var(--r-md)] bg-[var(--accent)] text-[var(--on-accent)] text-ui-sm">批准</button>
                <button type="button" onClick={resolve(ap.id, 'reject')}
                  className="min-h-[44px] flex-1 rounded-[var(--r-md)] border border-[var(--border)] text-[var(--fg)] text-ui-sm">拒绝</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </li>
  )
}

// Row identity signature (I-9): a 3s poll replaces the whole list with fresh
// objects; only rows whose visible fields changed re-render.
function same(a: TriageRowProps, b: TriageRowProps): boolean {
  const x = a.item.s, y = b.item.s
  const cents = (v?: number) => Math.round((v ?? 0) * 100)
  return x.id === y.id && a.item.attention === b.item.attention && x.name === y.name && x.description === y.description
    && x.last_snippet === y.last_snippet && x.current_step === y.current_step
    && cents(x.lifetime_cost_usd) === cents(y.lifetime_cost_usd) && x.other_clients === y.other_clients
    && a.active === b.active && timeLabel(x, a.now) === timeLabel(y, b.now)
    && x.turn_state === y.turn_state && (x.pending_approvals ?? 0) === (y.pending_approvals ?? 0) && x.type === y.type
    && x.source_task_id === y.source_task_id && x.tmux_name === y.tmux_name && x.peer_name === y.peer_name
    && a.actions.length === b.actions.length
    && a.onSelect === b.onSelect && a.controls === b.controls && a.onOpenConfirm === b.onOpenConfirm
}

export const TriageRow = memo(TriageRowImpl, same)
