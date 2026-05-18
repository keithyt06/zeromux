import { useCallback, useEffect, useRef, useState } from 'react'
import { wsUrl } from './api'
import { PCM_WORKLET_SOURCE } from './pcmWorklet'

export interface UseTranscribeOptions {
  language?: string
  onFinal: (text: string) => void
}

export interface UseTranscribeReturn {
  isRecording: boolean
  partial: string
  error: string | null
  supported: boolean
  start: () => Promise<void>
  stop: () => void
}

// Touch only globals — never `AudioContext.prototype.audioWorklet`, which is an
// instance getter and throws "Illegal invocation" when read off the prototype.
// AudioWorkletNode being a global is the cleanest proxy for AudioWorklet support.
const SUPPORTED =
  typeof window !== 'undefined' &&
  typeof window.AudioContext !== 'undefined' &&
  typeof window.AudioWorkletNode !== 'undefined' &&
  !!navigator.mediaDevices?.getUserMedia

export function useTranscribe(opts: UseTranscribeOptions): UseTranscribeReturn {
  const [isRecording, setIsRecording] = useState(false)
  const [partial, setPartial] = useState('')
  const [error, setError] = useState<string | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const workletNodeRef = useRef<AudioWorkletNode | null>(null)
  const blobUrlRef = useRef<string | null>(null)
  const onFinalRef = useRef(opts.onFinal)
  onFinalRef.current = opts.onFinal

  const isRecordingRef = useRef(isRecording)
  isRecordingRef.current = isRecording

  const cleanup = useCallback(() => {
    workletNodeRef.current?.disconnect()
    workletNodeRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    ctxRef.current?.close().catch(() => {})
    ctxRef.current = null
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      try {
        wsRef.current.send(JSON.stringify({ type: 'stop' }))
      } catch {
        // ignore
      }
    }
    wsRef.current?.close()
    wsRef.current = null
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current)
      blobUrlRef.current = null
    }
    setIsRecording(false)
    setPartial('')
  }, [])

  useEffect(() => () => cleanup(), [cleanup])

  const start = useCallback(async () => {
    if (!SUPPORTED) return
    if (isRecordingRef.current) return
    setError(null)
    setPartial('')

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1 } as MediaTrackConstraints,
      })
    } catch {
      setError('需要麦克风权限')
      return
    }
    streamRef.current = stream

    let ctx: AudioContext
    try {
      ctx = new AudioContext({ sampleRate: 16000 })
    } catch {
      ctx = new AudioContext()
    }
    ctxRef.current = ctx

    const blob = new Blob([PCM_WORKLET_SOURCE], { type: 'application/javascript' })
    const blobUrl = URL.createObjectURL(blob)
    blobUrlRef.current = blobUrl
    try {
      await ctx.audioWorklet.addModule(blobUrl)
    } catch {
      setError('AudioWorklet 加载失败')
      cleanup()
      return
    }

    const ws = new WebSocket(wsUrl('/ws/transcribe'))
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: 'start',
          language: opts.language ?? 'zh-CN',
        }),
      )
      setIsRecording(true)

      const source = ctx.createMediaStreamSource(stream)
      const node = new AudioWorkletNode(ctx, 'pcm-worklet')
      workletNodeRef.current = node
      node.port.onmessage = (ev) => {
        const buf = ev.data as ArrayBuffer
        if (ws.readyState === WebSocket.OPEN) ws.send(buf)
      }
      source.connect(node)
      const sink = ctx.createGain()
      sink.gain.value = 0
      node.connect(sink).connect(ctx.destination)
    }

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string)
        if (msg.type === 'partial' && typeof msg.text === 'string') {
          setPartial(msg.text)
        } else if (msg.type === 'final' && typeof msg.text === 'string') {
          setPartial('')
          onFinalRef.current(msg.text)
        } else if (msg.type === 'error' && typeof msg.message === 'string') {
          setError(msg.message)
          setPartial('')
          cleanup()
        }
      } catch {
        // ignore non-JSON server frames
      }
    }

    ws.onerror = () => {
      setError('连接失败')
      cleanup()
    }
    ws.onclose = (ev) => {
      if (isRecordingRef.current && ev.code !== 1000) {
        setError('连接已断开')
      }
      cleanup()
    }
  }, [cleanup, opts.language])

  const stop = useCallback(() => {
    cleanup()
  }, [cleanup])

  return {
    isRecording,
    partial,
    error,
    supported: SUPPORTED,
    start,
    stop,
  }
}
