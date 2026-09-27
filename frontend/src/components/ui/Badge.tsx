export function Badge({ count, tone = 'attention', dot }: { count?: number; tone?: 'attention' | 'danger'; dot?: boolean }) {
  if (!dot && !count) return null
  const bg = tone === 'danger' ? 'bg-[var(--danger)]' : 'bg-[var(--attention)]'
  if (dot) return <span aria-hidden className={`inline-block w-2 h-2 rounded-full ${bg}`} />
  return <span className={`num inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-ui-2xs font-semibold text-[var(--on-accent)] ${bg}`}>{count! > 99 ? '99+' : count}</span>
}
