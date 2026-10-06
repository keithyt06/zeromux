import type { KeyboardEvent } from 'react'
export function SegmentedControl<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange(v: T): void; label: string }) {
  const i = options.findIndex(o => o.value === value)
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); onChange(options[(i + 1) % options.length].value) }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); onChange(options[(i - 1 + options.length) % options.length].value) }
  }
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex p-0.5 rounded-[var(--r-md)] bg-[var(--surface-2)] border border-[var(--border-subtle)]">
      {options.map(o => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} tabIndex={o.value === value ? 0 : -1}
          onKeyDown={onKey} onClick={() => onChange(o.value)}
          className={`ctl min-h-[var(--hit)] px-3 rounded-[calc(var(--r-md)-2px)] text-ui-xs transition-colors duration-[var(--dur-fast)] ${o.value === value ? 'bg-[var(--surface-3)] text-[var(--fg-strong)]' : 'text-[var(--fg-muted)] hover:text-[var(--fg)]'}`}>
          {o.label}
        </button>
      ))}
    </div>
  )
}
