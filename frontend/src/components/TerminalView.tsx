import { useEffect, useRef, useCallback, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { wsUrl, getSessionStatus } from '../lib/api'
import type { SessionStatus } from '../lib/api'
import type { Theme } from '../lib/theme'
import { b64encode, b64decode } from '../lib/base64'
import { GitBranch, Folder, Circle } from 'lucide-react'

const THEMES = {
  dark: {
    background: '#0d1117',
    foreground: '#c9d1d9',
    cursor: '#58a6ff',
    selectionBackground: '#264f78',
    black: '#484f58',
    red: '#ff7b72',
    green: '#3fb950',
    yellow: '#d29922',
    blue: '#58a6ff',
    magenta: '#bc8cff',
    cyan: '#39c5cf',
    white: '#b1bac4',
    brightBlack: '#6e7681',
    brightRed: '#ffa198',
    brightGreen: '#56d364',
    brightYellow: '#e3b341',
    brightBlue: '#79c0ff',
    brightMagenta: '#d2a8ff',
    brightCyan: '#56d4dd',
    brightWhite: '#f0f6fc',
  },
  light: {
    background: '#ffffff',
    foreground: '#1f2328',
    cursor: '#0969da',
    selectionBackground: '#b6d4fe',
    black: '#24292f',
    red: '#cf222e',
    green: '#1a7f37',
    yellow: '#9a6700',
    blue: '#0969da',
    magenta: '#8250df',
    cyan: '#1b7c83',
    white: '#6e7781',
    brightBlack: '#57606a',
    brightRed: '#a40e26',
    brightGreen: '#116329',
    brightYellow: '#7d4e00',
    brightBlue: '#0550ae',
    brightMagenta: '#6639ba',
    brightCyan: '#136061',
    brightWhite: '#8c959f',
  },
}

interface Props {
  sessionId: string
  active: boolean
  theme: Theme
}

export default function TerminalView({ sessionId, active, theme }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const initRef = useRef(false)
  const [status, setStatus] = useState<SessionStatus | null>(null)

  // Fetch status
  useEffect(() => {
    let cancelled = false
    const fetchStatus = () => {
      getSessionStatus(sessionId).then(s => {
        if (!cancelled) setStatus(s)
      }).catch(() => {})
    }
    fetchStatus()
    const interval = setInterval(fetchStatus, 10000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [sessionId])

  // Initialize terminal once
  useEffect(() => {
    if (initRef.current || !containerRef.current) return
    initRef.current = true

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      theme: THEMES[theme],
      allowProposedApi: true,
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)

    try {
      term.loadAddon(new WebglAddon())
    } catch {
      // fallback to canvas
    }

    fit.fit()
    termRef.current = term
    fitRef.current = fit

    term.onData(data => {
      const ws = wsRef.current
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data: b64encode(new TextEncoder().encode(data)) }))
      }
    })

    term.onBinary(data => {
      const ws = wsRef.current
      if (ws?.readyState === WebSocket.OPEN) {
        const bytes = new Uint8Array(data.length)
        for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i)
        ws.send(JSON.stringify({ type: 'input', data: b64encode(bytes) }))
      }
    })

    return () => {
      wsRef.current?.close()
      term.dispose()
    }
  }, [sessionId])

  // Update terminal theme when it changes
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = THEMES[theme]
    }
  }, [theme])

  // Connect WebSocket
  useEffect(() => {
    if (!termRef.current) return
    if (wsRef.current) return

    let disposed = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let attempt = 0

    const connect = () => {
      if (disposed) return
      const ws = new WebSocket(wsUrl(`/ws/term/${sessionId}`))
      wsRef.current = ws

      ws.onopen = () => {
        attempt = 0
        // The server replays full scrollback on (re)connect; reset the terminal
        // first so a reconnect doesn't double-paint the buffer.
        termRef.current?.reset()
        const fit = fitRef.current
        if (fit) {
          const dims = fit.proposeDimensions()
          if (dims) {
            ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }))
          }
        }
      }

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data)
          if (msg.type === 'output') {
            termRef.current?.write(b64decode(msg.data))
          }
        } catch { /* ignore */ }
      }

      ws.onclose = () => {
        wsRef.current = null
        // Auto-reconnect through idle-timeout proxy drops / transient closes so
        // the terminal never freezes silently. Exponential backoff, capped at 10s.
        if (!disposed) {
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
      wsRef.current?.close()
    }
  }, [sessionId])

  const handleResize = useCallback(() => {
    const fit = fitRef.current
    const term = termRef.current
    const ws = wsRef.current
    if (!fit || !term) return
    fit.fit()
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
    }
  }, [])

  useEffect(() => {
    if (active) {
      const t = setTimeout(() => {
        handleResize()
        termRef.current?.focus()
      }, 50)
      return () => clearTimeout(t)
    }
  }, [active, handleResize])

  useEffect(() => {
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [handleResize])

  return (
    <div className="flex flex-col h-full">
      <div ref={containerRef} className="xterm-container w-full flex-1 min-h-0" />
      <div className="flex items-center gap-3 px-4 py-3 border-t border-[var(--border)] bg-[var(--bg-secondary)] min-h-[40px]">
        {status ? (
          <>
            <div className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
              <Folder size={13} className="shrink-0" />
              <span className="truncate max-w-[200px]" title={status.work_dir}>{status.work_dir}</span>
            </div>
            {status.is_git && (
              <>
                <div className="flex items-center gap-1.5 text-xs text-[var(--accent-purple)]">
                  <GitBranch size={13} className="shrink-0" />
                  <span>{status.git_branch}</span>
                </div>
                {status.git_dirty > 0 && (
                  <div className="flex items-center gap-1 text-xs text-[var(--accent-yellow)]">
                    <Circle size={8} className="fill-current shrink-0" />
                    <span>{status.git_dirty} changed</span>
                  </div>
                )}
              </>
            )}
          </>
        ) : (
          <span className="text-xs text-[var(--text-muted)]">Loading...</span>
        )}
      </div>
    </div>
  )
}
