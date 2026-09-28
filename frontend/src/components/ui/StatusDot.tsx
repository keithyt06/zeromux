export type DotTone = 'danger' | 'stuck' | 'attention' | 'running' | 'muted'

const FILL: Record<Exclude<DotTone, 'muted'>, string> = {
  danger: 'bg-[var(--danger)]',
  stuck: 'bg-[var(--stuck)]',
  attention: 'bg-[var(--attention)]',
  running: 'bg-[var(--running)]',
}

/** Five-state status mark (spec §3.1): shape AND colour differ so it still
 *  reads for colour-blind users. 8px visual, centered in a 12px box. */
export function StatusDot({ tone, label, shape }: { tone: DotTone; label: string; shape?: 'dot' | 'diamond' }) {
  const s = shape ?? (tone === 'attention' ? 'diamond' : 'dot')
  const base = 'relative inline-block shrink-0 w-2 h-2'
  const form = s === 'diamond' ? 'rotate-45 rounded-[1px]' : 'rounded-full'
  const look = tone === 'muted'
    ? 'border border-[var(--fg-subtle)]'
    : `${FILL[tone]}${tone === 'running' ? ' dot-breathe' : ''}${tone === 'stuck' ? ' ring-2 ring-[var(--stuck)]/35' : ''}`
  return (
    <span role="img" aria-label={label} title={label} data-tone={tone} data-shape={s} className={`${base} ${form} ${look}`}>
      {tone === 'danger' && <span aria-hidden className="absolute inset-[2.5px] rounded-full bg-[var(--surface-1)]" />}
    </span>
  )
}
