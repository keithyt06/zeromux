import { Fragment } from 'react'
import { X } from 'lucide-react'
import { formatAway, type AwaySummary } from '../../lib/awaySummary'
import { formatCost } from '../../lib/format'
import { IconButton } from '../ui'

/** 「离开期间」card at the top of the triage list (F3). First-paint component: keep it tiny. */
export function AwayCard({ summary, onSelect, onDismiss }: {
  summary: AwaySummary | null
  onSelect(id: string): void
  onDismiss(): void
}) {
  if (!summary) return null
  const dot = <span aria-hidden className="text-[var(--fg-subtle)]">·</span>
  return (
    <section aria-label="离开期间" className="mx-2 mt-2 pl-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--surface-1)] flex items-center gap-1">
      <div className="flex-1 min-w-0 flex flex-wrap items-center gap-x-1.5 text-ui-xs text-[var(--fg-muted)]">
        <span>{`离开 ${formatAway(summary.awayMs)}`}</span>
        {summary.items.map(i => (
          <Fragment key={i.key}>
            {dot}
            <button type="button" disabled={!i.firstId} onClick={() => i.firstId && onSelect(i.firstId)}
              className="min-h-[var(--hit)] px-0.5 rounded-[var(--r-sm)] text-[var(--fg)] hover:text-[var(--accent)] disabled:text-[var(--fg-muted)]">
              {`${i.label} ${i.count}`}
            </button>
          </Fragment>
        ))}
        {summary.costUsd > 0 && <>{dot}<span className="num">{formatCost(summary.costUsd, 'short')}</span></>}
        {summary.costPartial && <>{dot}<span className="text-[var(--fg-subtle)]">部分未计</span></>}
      </div>
      <IconButton label="关闭离开摘要" icon={X} size="sm" onClick={onDismiss} />
    </section>
  )
}
