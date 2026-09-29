import { useState, useEffect, useRef, useCallback, type RefObject } from 'react'
import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import { wsUrl } from '../lib/api'
import type { WsStatus } from '../lib/wsStatus'
import { b64decode } from '../lib/base64'
import { shouldSendMouseOffOnConnect } from '../lib/desktopHints'
import { shouldSendResize } from '../lib/terminalSize'

// WS lifecycle of one terminal session (/ws/term/{id}), moved verbatim out of
// TerminalView. Replay-window scroll, the copy-mode pill and the notice banners
// stay in the view; the hook reaches them only through the callbacks below.

export interface TerminalSocketOptions {
  sessionId: string
  /** wsEpoch: bumped after revive to re-run the connect effect. */
  epoch: number
  /** Owned by the view: its pre-hook callbacks (sendScroll, sendInput, onBinary,
   *  scroll_watch) read it, and the init effect must be declared before this hook. */
  wsRef: RefObject<WebSocket | null>
  /** Ref twin of the view's `ended` (handleRevive clears it); set here on tmux_ended. */
  endedRef: RefObject<boolean>
  /** Last cols/rows sent to the PTY; shared with the view's handleResize / active effect. */
  lastDims: RefObject<{ cols: number; rows: number }>
  termRef: RefObject<Terminal | null>
  fitRef: RefObject<FitAddon | null>
  containerRef: RefObject<HTMLDivElement | null>
  activeRef: RefObject<boolean>
  tmuxRef: RefObject<string | null | undefined>
  tmuxOriginRef: RefObject<'own' | 'external' | null | undefined>
  /** Called from the xterm write callback of every `output` frame. */
  onOutputSettled: () => void
  onScrollState: (msg: { in_mode?: boolean; app_scroll?: boolean; new_lines?: unknown }) => void
  onNotice: (kind: 'tmux_lost' | 'tmux_ended' | 'tmux_down') => void
  /** onopen, after reset + first resize + mouse-off; `send` writes to the new socket. */
  onOpen: (send: (msg: object) => void) => void
}

export function useTerminalSocket(o: TerminalSocketOptions) {
  const { sessionId, epoch, wsRef, endedRef, lastDims, termRef, fitRef, containerRef, activeRef, tmuxRef, tmuxOriginRef } = o
  // The view's callbacks are held in refs synced every render (same idiom as
  // useAcpSocket), so the connect effect keeps its [sessionId, epoch] deps.
  const onOutputSettledRef = useRef(o.onOutputSettled)
  useEffect(() => { onOutputSettledRef.current = o.onOutputSettled }, [o.onOutputSettled])
  const onScrollStateRef = useRef(o.onScrollState)
  useEffect(() => { onScrollStateRef.current = o.onScrollState }, [o.onScrollState])
  const onNoticeRef = useRef(o.onNotice)
  useEffect(() => { onNoticeRef.current = o.onNotice }, [o.onNotice])
  const onOpenRef = useRef(o.onOpen)
  useEffect(() => { onOpenRef.current = o.onOpen }, [o.onOpen])

  // Terminal WS status for ConnectionBar (display only; backoff logic untouched).
  const [wsStatus, setWsStatus] = useState<{ status: WsStatus; since: number }>(() => ({ status: 'connecting', since: Date.now() }))

  // Connect WebSocket
  useEffect(() => {
    if (!termRef.current) return
    if (wsRef.current) return

    let disposed = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let stableTimer: ReturnType<typeof setTimeout> | undefined
    let attempt = 0

    const connect = () => {
      if (disposed) return
      const ws = new WebSocket(wsUrl(`/ws/term/${sessionId}`))
      wsRef.current = ws

      ws.onopen = () => {
        setWsStatus({ status: 'open', since: Date.now() })
        // Reset backoff only after the connection proves STABLE (~3s), not on the
        // instant it opens — otherwise an accept-then-immediately-close loop resets
        // attempt→0 every open and the 10s cap is never reached (permanent ~1s
        // reconnect hammer). A healthy socket outlives the timer. (review 2026-08-05)
        clearTimeout(stableTimer)
        stableTimer = setTimeout(() => { attempt = 0 }, 3000)
        // The server replays full scrollback on (re)connect; reset the terminal
        // first so a reconnect doesn't double-paint the buffer.
        termRef.current?.reset()
        // Only the active, visible view may size the PTY: a hidden view's
        // proposeDimensions() is a ~10x5 fallback that would shrink the shared
        // tmux window (window-size latest). When skipped, invalidate lastDims so
        // the `active` effect sends the real size once this view is shown (the
        // fresh attach may have come up at another client's size).
        const fit = fitRef.current
        const el = containerRef.current
        const dims = fit?.proposeDimensions()
        if (dims && el && shouldSendResize({
          active: activeRef.current,
          containerWidth: el.clientWidth,
          containerHeight: el.clientHeight,
          cols: dims.cols,
          rows: dims.rows,
          last: { cols: 0, rows: 0 }, // first send on a new socket is never redundant
        })) {
          ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }))
          lastDims.current = { cols: dims.cols, rows: dims.rows }
        } else {
          lastDims.current = { cols: 0, rows: 0 }
        }
        // tmux 会话默认 mouse=on（tmux.conf）；用户上次关过就在（重）连接时同步关掉，
        // 否则每次新建/重连的会话又会回到 tmux 接管鼠标。
        // Own sessions only: External ones (e.g. VSCode's) keep their own option.
        if (shouldSendMouseOffOnConnect(!!tmuxRef.current, tmuxOriginRef.current, localStorage)) ws.send(JSON.stringify({ type: 'mouse', on: false }))
        onOpenRef.current(msg => ws.send(JSON.stringify(msg)))
      }

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data)
          if (msg.type === 'notice') {
            if (msg.kind === 'tmux_lost') onNoticeRef.current('tmux_lost')
            if (msg.kind === 'tmux_ended') { endedRef.current = true; onNoticeRef.current('tmux_ended') }
            if (msg.kind === 'tmux_down') onNoticeRef.current('tmux_down')
            return
          }
          if (msg.type === 'scroll_state') {
            onScrollStateRef.current(msg)
            return
          }
          if (msg.type === 'output') {
            termRef.current?.write(b64decode(msg.data), () => onOutputSettledRef.current())
          }
        } catch { /* ignore */ }
      }

      ws.onclose = () => {
        // Identity guard: a late close from a superseded socket must not null
        // (orphan) the live one. Unreachable under browser semantics today (one
        // close per socket; see the effect cleanup below) — defensive (B14).
        if (wsRef.current !== ws && wsRef.current !== null) return
        wsRef.current = null
        // Keep `since` while already reconnecting: resetting it on every failed
        // retry would re-arm ConnectionBar's delay and blink the bar off each
        // backoff cycle (same pattern as AcpChatView).
        if (!disposed) setWsStatus(prev => endedRef.current ? { status: 'ended', since: Date.now() } : prev.status === 'reconnecting' ? prev : { status: 'reconnecting', since: Date.now() })
        // A close before the stability timer fires means this open did NOT prove
        // stable — cancel the pending reset so `attempt` keeps escalating.
        clearTimeout(stableTimer)
        // Auto-reconnect through idle-timeout proxy drops / transient closes so
        // the terminal never freezes silently. Exponential backoff, capped at 10s.
        if (!disposed && !endedRef.current) {
          const delay = Math.min(1000 * 2 ** attempt, 10000)
          attempt += 1
          retryTimer = setTimeout(connect, delay)
        }
      }
      ws.onerror = () => { ws.close() }
    }

    connect()

    return () => {
      disposed = true
      if (retryTimer) clearTimeout(retryTimer)
      if (stableTimer) clearTimeout(stableTimer)
      wsRef.current?.close()
      // close() is async in browsers: clear the ref now so a re-run of this
      // effect (wsEpoch bump / StrictMode) isn't stopped by `if (wsRef.current)`.
      // Safe only together with the onclose identity guard above.
      wsRef.current = null
    }
  }, [sessionId, epoch]) // eslint-disable-line react-hooks/exhaustive-deps -- refs are stable; deps stay [sessionId, epoch]

  // scroll / scroll_watch / mouse / resize frames: sent only while OPEN.
  const sendRaw = useCallback((msg: object) => {
    const ws = wsRef.current
    if (ws?.readyState !== WebSocket.OPEN) return false
    ws.send(JSON.stringify(msg))
    return true
  }, [wsRef])

  return { wsStatus, sendRaw }
}
