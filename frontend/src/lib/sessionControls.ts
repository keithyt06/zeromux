import { useCallback, useRef } from 'react'

export interface PendingApproval { id: string; tool: string; purpose?: string }

/** WS-only controls each mounted agent view registers, keyed by session id, so
 *  shell-level UI (triage row actions, FocusHeader, SendToMenu) can drive a
 *  session without opening another socket (a new WS triggers a full replay). */
export interface SessionControls {
  setQueueMode(mode: string): void
  /** withAttachments (default true): attach + clear this session's pending composer
   *  uploads. Shell-level senders (SendToMenu) pass false so they never carry them off (A7). */
  sendPrompt(text: string, opts?: { withAttachments?: boolean }): boolean
  /** false = socket not OPEN; nothing sent, local state untouched. */
  interrupt(): boolean
  /** false = socket not OPEN; nothing sent, approval NOT marked resolved. */
  resolveApproval(id: string, action: 'approve' | 'reject'): boolean
  pendingApprovals(): PendingApproval[]
}

export type RegisterControls = (sid: string, api: SessionControls | null) => void

export function useControlsRegistry() {
  const controls = useRef<Record<string, SessionControls>>({})
  const register = useCallback<RegisterControls>((sid, api) => {
    if (api) controls.current[sid] = api
    else delete controls.current[sid]
  }, [])
  return { controls, register }
}
