import { Terminal } from 'lucide-react'
import type { SessionType } from '../../lib/api'
import { ClaudeCodeIcon, CrewIcon, CodexIcon } from '../BrandIcons'

/** Per-agent-type icon (moved from Sidebar's SessionTypeIcon). One place so the
 *  triage row, icon rail and ⌘K stay in sync as agent types are added. */
export function TypeIcon({ type, size = 14, className }: { type: SessionType; size?: number; className?: string }) {
  switch (type) {
    case 'claude': return <ClaudeCodeIcon size={size} className={className} />
    case 'crew':   return <CrewIcon size={size} className={className} />
    case 'codex':  return <CodexIcon size={size} className={className} />
    case 'tmux':
    default:       return <Terminal size={size} className={className} />
  }
}
