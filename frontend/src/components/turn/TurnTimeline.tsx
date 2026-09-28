import type { Step } from '../../lib/steps'
import { StepRow } from './StepRow'

export function TurnTimeline({ steps, complete, resolved, onResolve, onToggleStep }: {
  steps: Step[]; complete: boolean
  resolved?: Record<string, 'approve' | 'reject'>
  onResolve?: (id: string, a: 'approve' | 'reject') => void
  onToggleStep?: (open: boolean) => void
}) {
  return (
    <div className="space-y-1">
      {steps.map((s, i) => (
        <StepRow key={i} step={s} complete={complete} decision={s.approvalId ? resolved?.[s.approvalId] : undefined} onResolve={onResolve} onToggle={onToggleStep} />
      ))}
    </div>
  )
}
