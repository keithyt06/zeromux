import { memo, useMemo, useRef, useState } from 'react'
import type { TurnGroup } from '../../lib/transcript'
import { toSteps, touchedFiles, conclusion, lastText, stepCount } from '../../lib/steps'
import { peerLabel } from '../../lib/peer'
import { formatCost } from '../../lib/format'
import { TurnTimeline } from './TurnTimeline'
import { TurnSummaryCard } from './TurnSummaryCard'

type Props = {
  group: TurnGroup; agentName: string
  resolvedApprovals?: Record<string, 'approve' | 'reject'>
  onResolveApproval?: (id: string, action: 'approve' | 'reject') => void
  peerNames?: Record<string, string>
  onOpenChanges?: () => void
}

// Running → timeline; complete → summary card (S3 §3.3–3.4). If the user opened a
// step while it ran, keep the timeline so we don't yank what they're reading.
function TurnViewImpl({ group, agentName, resolvedApprovals, onResolveApproval, peerNames, onOpenChanges }: Props) {
  const steps = useMemo(() => toSteps(group.blocks, group.complete), [group])
  const [expanded, setExpanded] = useState(false)
  const [pinnedOpen, setPinnedOpen] = useState(false)
  // Open step rows in the mounted timeline; closing the last one unpins, so a
  // completed turn falls back to its card.
  const openRows = useRef(0)
  const onToggleStep = (open: boolean) => {
    openRows.current = Math.max(0, openRows.current + (open ? 1 : -1))
    if (open && !group.complete) setPinnedOpen(true)
    if (!open && openRows.current === 0) setPinnedOpen(false)
  }
  const files = useMemo(() => touchedFiles(steps), [steps])
  const nSteps = stepCount(steps)
  // A text-only reply has nothing to summarise: render it in full, not as 「0 步」.
  const summarisable = nSteps > 0 || files.length > 0
  // 过程 ▾ expands the timeline in place UNDER the card (chips stay reachable).
  const showCard = group.complete && !pinnedOpen && summarisable
  const showTimeline = !showCard || expanded
  return (
    <div className="space-y-2">
      {group.userPrompts.map((p, i) => (
        <div key={p.clientId ?? i}>
          <p className={`text-ui-2xs font-semibold mb-0.5 ${p.fromName ? 'text-[var(--peer)]' : 'text-[var(--accent)]'}`}>
            {p.fromName ? `来自 @${peerLabel(p.fromName, peerNames ?? {})}` : 'You'}
          </p>
          <p className="text-ui-base text-[var(--fg)] whitespace-pre-wrap">{p.text}</p>
        </div>
      ))}
      {steps.length > 0 && (
        <div className="space-y-1">
          <p className="text-ui-2xs font-semibold text-[var(--peer)]">{agentName}</p>
          {showCard && <TurnSummaryCard conclusionText={conclusion(group)} fullText={lastText(group)} files={files} steps={nSteps}
            cost={group.cost} errored={group.errored} expanded={expanded} onExpand={() => { if (expanded) openRows.current = 0; setExpanded(!expanded) }} onOpenChanges={onOpenChanges} />}
          {showTimeline && <TurnTimeline steps={steps} complete={group.complete} resolved={resolvedApprovals} onResolve={onResolveApproval}
            onToggleStep={onToggleStep} />}
          {!showCard && group.complete && group.cost != null && group.cost > 0 &&
            <p className="num text-ui-xs text-[var(--fg-subtle)]">{formatCost(group.cost, 'long')}</p>}
          {group.complete && group.errored && !showCard && <p className="text-ui-xs text-[var(--danger)]">本轮出错结束</p>}
        </div>
      )}
    </div>
  )
}

export const TurnView = memo(TurnViewImpl, (a, b) =>
  a.group === b.group && a.agentName === b.agentName && a.resolvedApprovals === b.resolvedApprovals &&
  a.onResolveApproval === b.onResolveApproval && a.peerNames === b.peerNames && a.onOpenChanges === b.onOpenChanges)
