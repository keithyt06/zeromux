import { Mic, MicOff } from 'lucide-react'
import type { PointerEvent } from 'react'

interface MicButtonProps {
  isRecording: boolean
  supported: boolean
  onPressStart: () => void
  onPressEnd: () => void
}

export function MicButton({ isRecording, supported, onPressStart, onPressEnd }: MicButtonProps) {
  const disabled = !supported

  const handleDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (disabled) return
    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    onPressStart()
  }
  const handleUp = (e: PointerEvent<HTMLButtonElement>) => {
    if (disabled) return
    // Always call onPressEnd, even if isRecording=false — user may release
    // before getUserMedia/ws-open finishes. onPressEnd (stop) is idempotent;
    // calling it during that startup window is what tears the in-flight
    // start() down so the mic doesn't end up permanently captured.
    onPressEnd()
    ;(e.target as HTMLElement).releasePointerCapture?.(e.pointerId)
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onPointerDown={handleDown}
      onPointerUp={handleUp}
      onPointerCancel={handleUp}
      onPointerLeave={handleUp}
      title={
        disabled
          ? '浏览器不支持 AudioWorklet，无法使用语音输入'
          : isRecording
            ? '松开停止'
            : '按住说话'
      }
      aria-label={isRecording ? 'Recording' : 'Voice input'}
      aria-pressed={isRecording}
      className={
        'self-end p-2 rounded-lg transition-colors select-none ' +
        (disabled
          ? 'bg-[var(--btn-disabled-bg)] text-[var(--btn-disabled-text)] cursor-not-allowed'
          : isRecording
            ? 'bg-[var(--accent-red)] text-white animate-pulse'
            : 'bg-[var(--bg-primary)] hover:bg-[var(--bg-tertiary)] text-[var(--text-primary)] border border-[var(--border)]')
      }
      style={{ touchAction: 'manipulation', WebkitTouchCallout: 'none' }}
    >
      {disabled ? <MicOff size={16} /> : <Mic size={16} />}
    </button>
  )
}
