import { useEffect, useRef } from 'react'

interface Props {
  message: string
  actionLabel?: string
  onAction?: () => void
  durationMs: number
  onDone: () => void
}

export default function Toast({ message, actionLabel, onAction, durationMs, onDone }: Props) {
  const doneRef = useRef(false)
  const finish = () => { if (!doneRef.current) { doneRef.current = true; onDone() } }
  useEffect(() => {
    const t = setTimeout(finish, durationMs)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [durationMs])
  return (
    <div role="status" className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-2 rounded-lg shadow-lg bg-[var(--bg-tertiary)] text-xs text-[var(--text-primary)] border border-[var(--border)]">
      <span>{message}</span>
      {actionLabel && (
        <button className="font-medium text-[var(--accent-blue)]" onClick={() => { onAction?.(); finish() }}>{actionLabel}</button>
      )}
    </div>
  )
}
