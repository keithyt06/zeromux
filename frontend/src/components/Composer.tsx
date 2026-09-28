import { useRef, useEffect, useEffectEvent, type KeyboardEvent, type ReactNode } from 'react'
import { Send } from 'lucide-react'

interface ComposerProps {
  value: string
  onChange: (v: string) => void
  /** Called with the trimmed text. Caller decides what bytes to send.
   *  Return `false` when the text was NOT delivered (e.g. socket not open):
   *  the caller must then leave `value` untouched so nothing typed is lost. */
  onSend: (text: string) => boolean | void
  /** Chat: true (Enter submits). Terminal: false (Enter = newline, button submits). */
  submitOnEnter: boolean
  placeholder?: string
  /** Optional extra control rendered between textarea and send (e.g. a future MicButton). */
  rightSlot?: ReactNode
  /** Controls rendered inside the input box, bottom row (agent: queue chip + 「＋」). */
  leftSlot?: ReactNode
  /** Line-start `/` mode: called with the text after `/` on every change while the
   *  value starts with `/`, and once with `null` when it stops doing so. */
  onSlash?: (query: string | null) => void
}

function autoResize(t: HTMLTextAreaElement) {
  t.style.height = 'auto'
  t.style.height = Math.min(t.scrollHeight, 120) + 'px'
}

export default function Composer({
  value, onChange, onSend, submitOnEnter, placeholder, rightSlot, leftSlot, onSlash,
}: ComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const slash = useEffectEvent((q: string | null) => onSlash?.(q))
  const inSlash = useRef(false)
  useEffect(() => {
    if (value.startsWith('/')) { inSlash.current = true; slash(value.slice(1)) }
    else if (inSlash.current) { inSlash.current = false; slash(null) }
  }, [value])

  // Re-fit height whenever value changes from the outside (e.g. voice transcript
  // appended, or cleared after send) — onInput only fires for user typing.
  useEffect(() => {
    if (inputRef.current) autoResize(inputRef.current)
  }, [value])

  const send = () => {
    const text = value.trim()
    if (!text) return
    onSend(text)
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    // IME guard: while a CJK candidate is being chosen, Enter confirms the
    // candidate — it must never submit. Safari fires keydown with keyCode 229
    // after compositionend, when isComposing is already false, so check both.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (submitOnEnter && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="flex items-end gap-2">
      <div className="flex-1 min-w-0 flex flex-col bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg focus-within:border-[var(--accent-blue)]">
        <textarea
          ref={inputRef}
          value={value}
          onChange={e => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={1}
          /* text-base = 16px：低于 16px 时 iOS Safari 聚焦会自动放大整页，把右侧发送键挤出视口。 */
          className="w-full px-3 py-2 bg-transparent text-base text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none resize-none min-h-[40px] max-h-[120px]"
          style={{ height: 'auto', overflow: 'hidden' }}
          onInput={e => autoResize(e.target as HTMLTextAreaElement)}
        />
        {leftSlot && <div className="flex items-center gap-1 px-1">{leftSlot}</div>}
      </div>
      {rightSlot}
      <button
        onClick={send}
        disabled={!value.trim()}
        aria-label="send"
        className="shrink-0 inline-flex items-center justify-center w-9 h-9 bg-[var(--accent-green)] hover:bg-[var(--accent-green-hover)] disabled:bg-[var(--btn-disabled-bg)] disabled:text-[var(--btn-disabled-text)] text-white rounded-lg transition-colors"
        title="Send"
      >
        <Send size={16} />
      </button>
    </div>
  )
}
