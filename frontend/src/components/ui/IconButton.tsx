import type { ButtonHTMLAttributes, Ref } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Tooltip } from './Tooltip'

export function IconButton({ label, icon: Icon, active, danger, size = 'md', className = '', ...rest }: {
  label: string; icon: LucideIcon; active?: boolean; danger?: boolean; size?: 'sm' | 'md'; ref?: Ref<HTMLButtonElement>
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const vis = size === 'sm' ? 'w-7 h-7' : 'w-7 h-7 [@media(pointer:coarse)]:w-9 [@media(pointer:coarse)]:h-9'
  const tone = danger ? 'text-[var(--danger)]' : active ? 'text-[var(--accent)] bg-[var(--surface-3)]' : 'text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--surface-hover)]'
  return (
    <Tooltip label={label}>
      <button type="button" aria-label={label} {...rest}
        className={`relative inline-flex items-center justify-center min-w-[var(--hit)] min-h-[var(--hit)] rounded-[var(--r-md)] transition-colors duration-[var(--dur-fast)] focus-ring ${tone} ${className}`}>
        <span className={`inline-flex items-center justify-center ${vis}`}><Icon size={size === 'sm' ? 16 : 18} /></span>
      </button>
    </Tooltip>
  )
}
