import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import MarkdownContent from '../markdown/MarkdownContent'
import { formatCost } from '../../lib/format'

export function TurnSummaryCard({ conclusionText, files, steps, cost, errored, expanded, onExpand, onOpenChanges }: {
  conclusionText: string; files: { path: string; label: string }[]; steps: number; cost?: number; errored?: boolean; expanded?: boolean
  onExpand: () => void; onOpenChanges?: () => void
}) {
  const shown = files.slice(0, 3)
  // Text heuristic for "exceeds 6 lines" (spec §3.4): jsdom can't measure layout,
  // and a measured overflow would need setState-in-effect.
  const long = conclusionText.length > 280 || conclusionText.split('\n').length > 6
  const [full, setFull] = useState(false)
  return (
    <div data-testid="turn-summary" data-errored={errored ? '1' : '0'}
      className={`rounded-[var(--r-lg)] p-3 space-y-2 ${errored ? 'bg-[var(--danger)]/[0.04]' : 'bg-[var(--surface-2)]'}`}>
      {errored && <p className="text-ui-xs font-medium text-[var(--danger)]">本轮出错结束</p>}
      {conclusionText && <div data-testid="turn-conclusion" className={`text-ui-base text-[var(--fg)] leading-relaxed ${full ? '' : 'line-clamp-6'}`}><MarkdownContent text={conclusionText} isComplete /></div>}
      {conclusionText && long && !full && (
        <button type="button" onClick={() => setFull(true)} className="ctl px-2 -mx-2 text-ui-xs text-[var(--fg-muted)] hover:text-[var(--fg)]">展开全文</button>
      )}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ui-xs text-[var(--fg-subtle)]">
        {shown.map(f => (
          <button key={f.path} type="button" onClick={onOpenChanges} aria-label={f.label}
            className="ctl px-2 rounded-[var(--r-sm)] bg-[var(--surface-3)] text-[var(--fg-muted)] hover:text-[var(--fg)]">{f.label}</button>
        ))}
        {files.length > 3 && <span>+{files.length - 3}</span>}
        <span className="num">{steps} 步</span>
        {cost != null && cost > 0 && <span className="num">{formatCost(cost, 'long')}</span>}
        <button type="button" onClick={onExpand} aria-expanded={!!expanded} className="ml-auto ctl px-2 inline-flex items-center gap-1 text-[var(--fg-muted)] hover:text-[var(--fg)]">
          过程 <ChevronDown size={12} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </button>
      </div>
    </div>
  )
}
