import { useEffect, useRef, useCallback, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { wsUrl, getSessionStatus } from '../lib/api'
import type { SessionStatus } from '../lib/api'
import type { Theme } from '../lib/theme'
import { b64encode, b64decode } from '../lib/base64'
import { GitBranch, Folder, Circle } from 'lucide-react'
import MobileKeyBar from './MobileKeyBar'
import { arrowSequence, rowHeight, linesFromDrag, type ArrowKey } from '../lib/terminalInput'

const FONT_SIZE = 14

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
  // 触摸设备检测：any-pointer:coarse 或 maxTouchPoints>0，少漏触屏笔记本/iPad。
  // 触摸能力在页面生命周期内不变，用惰性初始化在挂载时算一次即可（避免 effect 内 setState）。
  const [isTouch] = useState(
    () =>
      (typeof matchMedia !== 'undefined' && matchMedia('(any-pointer: coarse)').matches) ||
      (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)
  )

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

  // 所有 client→PTY 输入走这一条；term.onData 与 MobileKeyBar 共用。
  const sendInput = useCallback((data: string) => {
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data: b64encode(new TextEncoder().encode(data)) }))
    }
  }, [])

  // 虚拟方向键：先回到底部（否则用户在 scrollback 里点键看不到反馈），
  // 再按当前光标键模式（DECCKM）生成序列发送。
  const handleArrowKey = useCallback((key: ArrowKey) => {
    const term = termRef.current
    if (!term) return
    term.scrollToBottom()
    sendInput(arrowSequence(key, term.modes.applicationCursorKeysMode))
  }, [sendInput])

  // Initialize terminal once
  useEffect(() => {
    if (initRef.current || !containerRef.current) return
    initRef.current = true

    const term = new Terminal({
      cursorBlink: true,
      fontSize: FONT_SIZE,
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
      sendInput(data)
    })

    term.onBinary(data => {
      const ws = wsRef.current
      if (ws?.readyState === WebSocket.OPEN) {
        const bytes = new Uint8Array(data.length)
        for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i)
        ws.send(JSON.stringify({ type: 'input', data: b64encode(bytes) }))
      }
    })

    // 移动端触摸滚动：完全接管手势（CSS 已禁原生滚动），位移换算成 scrollLines。
    const container = containerRef.current
    let startY = 0
    let touchId: number | null = null

    const onTouchStart = (e: TouchEvent) => {
      // 仅单指进入滚动逻辑；多指（pinch）忽略。
      if (e.touches.length !== 1) { touchId = null; return }
      startY = e.touches[0].clientY
      touchId = e.touches[0].identifier
    }
    const onTouchMove = (e: TouchEvent) => {
      if (touchId === null) return
      let t: Touch | undefined
      for (let i = 0; i < e.touches.length; i++) {
        if (e.touches[i].identifier === touchId) { t = e.touches[i]; break }
      }
      if (!t) return
      e.preventDefault()  // 全程阻止，防止浏览器抢手势 / 橡皮筋
      const rh = rowHeight(term.element?.clientHeight ?? 0, term.rows, FONT_SIZE)
      const lines = linesFromDrag(startY, t.clientY, rh)
      if (lines !== 0) {
        term.scrollLines(lines)
        startY = t.clientY
      }
    }

    const onTouchEnd = () => { touchId = null }

    container?.addEventListener('touchstart', onTouchStart, { passive: true })
    container?.addEventListener('touchmove', onTouchMove, { passive: false })
    container?.addEventListener('touchend', onTouchEnd, { passive: true })
    container?.addEventListener('touchcancel', onTouchEnd, { passive: true })

    return () => {
      container?.removeEventListener('touchstart', onTouchStart)
      container?.removeEventListener('touchmove', onTouchMove)
      container?.removeEventListener('touchend', onTouchEnd)
      container?.removeEventListener('touchcancel', onTouchEnd)
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

  // 键条占用约 40px 高度，改变终端可用区；渲染后重新 fit，避免底部行被遮 / canvas 尺寸过期。
  useEffect(() => {
    if (!isTouch) return
    const t = setTimeout(handleResize, 50)
    return () => clearTimeout(t)
  }, [isTouch, handleResize])

  return (
    <div className="flex flex-col h-full">
      <div ref={containerRef} className="xterm-container w-full flex-1 min-h-0" />
      {isTouch && <MobileKeyBar onKey={handleArrowKey} />}
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
