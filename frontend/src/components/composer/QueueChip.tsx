const LABEL: Record<string, string> = { collect: 'Collect', interrupt: 'Interrupt' }

/** Queue-mode chip inside the composer (V8): one tap flips Collect ⇄ Interrupt.
 *  Controlled: `mode` is the backend-authoritative value (I-6); the parent only
 *  changes it once the flip was delivered. Interrupt while busy = highlighted chip
 *  + 「将打断」 (V9 — the send button keeps its colour). */
export function QueueChip({ mode, busy, onToggle }: { mode: string; busy: boolean; onToggle(): void }) {
  const label = LABEL[mode] ?? mode
  const hot = busy && mode === 'interrupt'
  return (
    <span className="inline-flex items-center gap-1.5">
      <button type="button" onClick={onToggle} aria-label={`队列模式 ${label}`} data-hot={hot ? '1' : undefined}
        title="多条消息同时在途时如何处理(点按切换)"
        className={`inline-flex items-center min-h-[var(--hit)] px-2 rounded-[var(--r-md)] text-ui-2xs focus-ring transition-colors duration-[var(--dur-fast)] ${hot ? 'text-[var(--attention)] bg-[var(--surface-3)] font-semibold' : 'text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--surface-hover)]'}`}>
        {label}
      </button>
      {hot && <span className="text-ui-2xs text-[var(--attention)]">将打断</span>}
    </span>
  )
}
