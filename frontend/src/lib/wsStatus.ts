// Connection state of a session's WebSocket, surfaced to the user so a send
// during a drop is never silent (audit B8). `sinceMs` = when this status began.
export type WsStatus = 'connecting' | 'open' | 'reconnecting' | 'ended'

// A healthy reconnect finishes well under this; showing the bar sooner would
// flash on every transient proxy drop.
export const CONNECTION_BAR_DELAY_MS = 1500

export function connectionBarText(status: WsStatus, sinceMs: number, now: number): string | null {
  if (status === 'open') return null
  if (status === 'ended') return '会话已结束'
  if (now - sinceMs < CONNECTION_BAR_DELAY_MS) return null
  return status === 'reconnecting' ? '连接断开,正在重连…' : '正在连接…'
}
