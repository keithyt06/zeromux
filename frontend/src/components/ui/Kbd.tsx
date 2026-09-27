import type { ReactNode } from 'react'
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="px-1.5 py-0.5 rounded-[var(--r-sm)] bg-[var(--surface-3)] border border-[var(--border)] text-ui-2xs font-mono text-[var(--fg-muted)]">{children}</kbd>
}
