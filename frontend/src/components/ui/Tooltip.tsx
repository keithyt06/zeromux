import { cloneElement, useId, useRef, useState, type ReactElement } from 'react'
import { useMediaQuery } from '../../lib/useMediaQuery'

/** Desktop-only hover label (touch devices get nothing — no hover exists). */
export function Tooltip({ label, children }: { label: string; children: ReactElement<Record<string, unknown>> }) {
  const hover = useMediaQuery('(hover: hover)')
  const id = useId()
  const [show, setShow] = useState(false)
  const t = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  if (!hover) return children
  return (
    <span className="relative inline-flex" onMouseEnter={() => { t.current = setTimeout(() => setShow(true), 500) }} onMouseLeave={() => { clearTimeout(t.current); setShow(false) }}>
      {cloneElement(children, { 'aria-describedby': show ? id : undefined })}
      {show && <span id={id} role="tooltip" className="absolute top-full mt-1 left-1/2 -translate-x-1/2 z-popover whitespace-nowrap px-2 py-1 rounded-[var(--r-sm)] bg-[var(--surface-3)] border border-[var(--border)] text-ui-2xs text-[var(--fg)] pointer-events-none">{label}</span>}
    </span>
  )
}
