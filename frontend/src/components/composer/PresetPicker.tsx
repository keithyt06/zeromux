import { useEffect, useEffectEvent, useState } from 'react'
import { Pencil } from 'lucide-react'
import type { PromptPreset } from '../../lib/api'
import { rankBy } from '../../lib/fuzzy'
import { splitSlash } from '../../lib/presetPick'
import { Popover } from '../ui'

/** The single preset entry (V7): line-start `/` in the composer or the ⌘K
 *  new-mode prompt. Focus stays in the caller's input; ↑↓/Enter are taken here
 *  (capture phase) so the input never sees them while the list is open. */
export function PresetPicker({ open, query, presets, anchor, onPick, onManage, onClose }: {
  open: boolean; query: string; presets: PromptPreset[]; anchor: HTMLElement | null
  onPick(p: PromptPreset): void; onManage(): void; onClose(): void
}) {
  const { token } = splitSlash(query)
  const items = rankBy(token, presets, p => [p.title])
  const [hi, setHi] = useState(0)
  const [prevToken, setPrevToken] = useState(token)
  if (prevToken !== token) { setPrevToken(token); setHi(0) }
  const cur = Math.min(hi, Math.max(0, items.length - 1))

  const onKey = useEffectEvent((e: KeyboardEvent) => {
    // Only keys typed into OUR input: agent panes stay mounted while hidden, so a
    // picker left open in another session must never eat ⌘K's or another pane's Enter.
    if (!anchor?.contains(e.target as Node)) return
    // IME: Enter/arrows confirm or move the candidate, never the list.
    if (e.isComposing || e.keyCode === 229) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!items.length) return
      e.preventDefault(); e.stopPropagation()
      setHi((cur + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length)
    } else if (e.key === 'Enter' && !e.shiftKey && items[cur]) {
      e.preventDefault(); e.stopPropagation()
      onPick(items[cur])
    }
  })
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => onKey(e)
    document.addEventListener('keydown', h, true)
    return () => document.removeEventListener('keydown', h, true)
  }, [open])

  // A leading `/` that matches nothing (e.g. a path) is just text: no list.
  if (token && !items.length) return null
  // mousedown preventDefault keeps focus (and the soft keyboard) in the input.
  const keep = (e: { preventDefault(): void }) => e.preventDefault()
  return (
    <Popover open={open} onClose={onClose} anchor={anchor} placement="top" anchored>
      <div role="listbox" aria-label="常用 prompt">
        {items.length === 0 && <div className="px-3 py-2 text-ui-2xs text-[var(--fg-subtle)]">还没有常用 prompt</div>}
        {items.map((p, i) => (
          <div key={p.id} role="option" aria-selected={i === cur} title={p.body}
            onMouseDown={keep} onMouseMove={() => { if (i !== cur) setHi(i) }} onClick={() => onPick(p)}
            className={`row flex flex-col justify-center px-3 cursor-pointer ${i === cur ? 'bg-[var(--surface-hover)]' : ''}`}>
            <span className="text-ui-sm text-[var(--fg)] truncate">{p.title}</span>
            <span className="text-ui-2xs text-[var(--fg-subtle)] truncate">{p.body}</span>
          </div>
        ))}
      </div>
      <button type="button" onMouseDown={keep} onClick={onManage}
        className="row w-full flex items-center gap-2 px-3 border-t border-[var(--border-subtle)] text-left text-ui-sm text-[var(--fg-muted)] hover:bg-[var(--surface-hover)]">
        <Pencil size={14} className="shrink-0" />管理…
      </button>
    </Popover>
  )
}
