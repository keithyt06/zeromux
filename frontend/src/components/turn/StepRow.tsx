import { useState } from 'react'
import { ChevronRight, Ban, Check, AlertCircle } from 'lucide-react'
import type { Step } from '../../lib/steps'
import { StatusDot } from '../ui'
import MarkdownContent from '../markdown/MarkdownContent'

const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…(已截断)` : s)

/** One step. Tools/thinking expand in place; JSON.stringify runs only when open. */
export function StepRow({ step, complete, decision, onResolve, onToggle }: {
  step: Step; complete: boolean
  decision?: 'approve' | 'reject'
  onResolve?: (id: string, a: 'approve' | 'reject') => void
  onToggle?: (open: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  // Notify outside the state updater (updaters must stay pure).
  const toggle = () => { const next = !open; setOpen(next); onToggle?.(next) }
  if (step.kind === 'text') return <div className="text-ui-base text-[var(--fg)] leading-relaxed"><MarkdownContent text={step.text ?? ''} isComplete={complete} /></div>
  if (step.kind === 'error') return (
    <div className="flex items-start gap-1.5 text-ui-xs text-[var(--danger)]"><AlertCircle size={13} className="shrink-0 mt-0.5" /><span className="whitespace-pre-wrap break-words">{step.text || 'Error'}</span></div>
  )
  if (step.kind === 'approval') return (
    <div className="rounded-[var(--r-md)] border border-[var(--attention)]/40 bg-[var(--attention)]/5 p-2 text-ui-xs">
      <div className="flex items-center gap-1.5 font-medium text-[var(--attention)]"><StatusDot tone="attention" label="待审批" />需要你批准{step.name && <span className="text-[var(--fg)] font-normal truncate">· {step.name}</span>}</div>
      {step.summary && <p className="mt-1 text-[var(--fg-muted)] break-words">{step.summary}</p>}
      {step.text && <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--surface-2)] p-2 text-[var(--fg-muted)]">{cap(step.text, 2000)}</pre>}
      {decision ? <p className="mt-1.5 italic text-[var(--fg-subtle)]">{decision === 'approve' ? '已批准' : '已拒绝'}</p>
        : step.approvalId ? (
          <div className="mt-2 flex gap-2">
            <button data-testid="approval-reject" onClick={() => onResolve?.(step.approvalId!, 'reject')}
              className="flex-1 min-h-[44px] rounded-[var(--r-md)] border border-[var(--border)] text-[var(--fg-muted)] hover:text-[var(--danger)] inline-flex items-center justify-center gap-1"><Ban size={13} />拒绝</button>
            <button data-testid="approval-approve" onClick={() => onResolve?.(step.approvalId!, 'approve')}
              className="flex-1 min-h-[44px] rounded-[var(--r-md)] bg-[var(--success-solid)] text-[var(--on-accent)] inline-flex items-center justify-center gap-1"><Check size={13} />批准</button>
          </div>
        ) : <p className="mt-1.5 text-[var(--attention)]">审批 id 缺失，无法在此回答</p>}
    </div>
  )
  const isThinking = step.kind === 'thinking'
  const inputStr = open && step.input != null ? JSON.stringify(step.input, null, 2) : null
  const hasRawInput = !!inputStr && inputStr !== '{}' && inputStr !== 'null'
  return (
    <div className="text-ui-xs">
      <button type="button" onClick={toggle} aria-expanded={open}
        className="row w-full flex items-center gap-2 text-left text-[var(--fg-muted)] hover:text-[var(--fg)]">
        <ChevronRight size={12} className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        {isThinking
          ? <span className="italic text-[var(--fg-subtle)]">思考 · {step.count ?? 1} 段</span>
          : <>
              <StatusDot tone={step.status === 'running' ? 'running' : step.status === 'error' ? 'danger' : 'muted'} label={step.status === 'running' ? '运行中' : '完成'} />
              <span className="font-medium text-[var(--fg)]">{step.name ?? 'tool'}</span>
              {step.summary && <span className="truncate min-w-0">{step.summary}</span>}
            </>}
      </button>
      {open && (isThinking
        ? <div className="pl-5 pt-1 italic text-[var(--fg-subtle)] whitespace-pre-wrap">{step.text}</div>
        : <div className="pl-5 pt-1 space-y-1">
            {hasRawInput && <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--surface-2)] p-2 text-[var(--fg-muted)]">{cap(inputStr!, 2000)}</pre>}
            {step.result != null && <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--surface-2)] p-2 text-[var(--fg-muted)]">{cap(step.result, 4000)}</pre>}
          </div>)}
    </div>
  )
}
