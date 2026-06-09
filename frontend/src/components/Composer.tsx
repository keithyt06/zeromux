import { useRef, useEffect, type KeyboardEvent, type ReactNode } from 'react'
import { Send } from 'lucide-react'

interface ComposerProps {
  value: string
  onChange: (v: string) => void
  /** Called with the trimmed text. Caller decides what bytes to send. */
  onSend: (text: string) => void
  /** Chat: true (Enter submits). Terminal: false (Enter = newline, button submits). */
  submitOnEnter: boolean
  placeholder?: string
  /** Optional extra control rendered between textarea and send (e.g. a future MicButton). */
  rightSlot?: ReactNode
}

function autoResize(t: HTMLTextAreaElement) {
  t.style.height = 'auto'
  t.style.height = Math.min(t.scrollHeight, 120) + 'px'
}

export default function Composer({
  value, onChange, onSend, submitOnEnter, placeholder, rightSlot,
}: ComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null)

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
    if (submitOnEnter && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="flex gap-2">
      <textarea
        ref={inputRef}
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={1}
        /* text-base = 16px：低于 16px 时 iOS Safari 聚焦会自动放大整页，把右侧发送键挤出视口。 */
        className="flex-1 px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-base text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--accent-blue)] resize-none min-h-[40px] max-h-[120px]"
        style={{ height: 'auto', overflow: 'hidden' }}
        onInput={e => autoResize(e.target as HTMLTextAreaElement)}
      />
      {rightSlot}
      <button
        onClick={send}
        disabled={!value.trim()}
        aria-label="send"
        className="self-end p-2 bg-[var(--accent-green)] hover:bg-[var(--accent-green-hover)] disabled:bg-[var(--btn-disabled-bg)] disabled:text-[var(--btn-disabled-text)] text-white rounded-lg transition-colors"
        title="Send"
      >
        <Send size={16} />
      </button>
    </div>
  )
}
