import { useEffect, useRef, useState } from 'react'
import { mermaidCache } from './cache'
import { fnv1a } from './hash'

interface Props { code: string }

type State =
  | { kind: 'pending' }
  | { kind: 'svg'; svg: string }
  | { kind: 'error'; msg: string }

export default function MermaidBlock({ code }: Props) {
  const key = fnv1a(code)
  const cached = mermaidCache.get(key)
  const [state, setState] = useState<State>(
    cached ? { kind: 'svg', svg: cached } : { kind: 'pending' }
  )
  // Which `key` the current `state` was derived for. The useState initializer runs
  // only once at mount, so when React reuses this instance at the same position with a
  // DIFFERENT `code` (new `key`), `state` still holds the PREVIOUS diagram. Without
  // this guard the effect's `state.kind === 'svg'` early-return would keep painting the
  // stale SVG for the new source (e.g. previewing file B after file A in FileBrowser).
  // Tracking the rendered key lets the effect detect the change and re-render. (review 2026-08-05)
  const renderedKeyRef = useRef<string | null>(cached ? key : null)

  useEffect(() => {
    // Only skip work when the CURRENT svg belongs to the CURRENT code. If `key` changed
    // under a reused instance, fall through and re-render (adopting cache if present).
    if (state.kind === 'svg' && renderedKeyRef.current === key) return
    let cancel = false
    ;(async () => {
      try {
        const hit = mermaidCache.get(key)
        if (hit) {
          if (cancel) return
          renderedKeyRef.current = key
          setState({ kind: 'svg', svg: hit })
          return
        }
        const m = (await import('mermaid')).default
        m.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' })
        await m.parse(code)
        const id = `mid-${key}`
        const { svg } = await m.render(id, code)
        if (cancel) return
        mermaidCache.set(key, svg)
        renderedKeyRef.current = key
        setState({ kind: 'svg', svg })
      } catch (e) {
        if (cancel) return
        renderedKeyRef.current = key
        setState({ kind: 'error', msg: String(e).slice(0, 200) })
      }
    })()
    return () => { cancel = true }
  }, [code, key, state.kind])

  if (state.kind === 'svg') {
    return (
      <div
        className="mermaid-rendered bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md p-3 my-2 overflow-x-auto text-center"
        dangerouslySetInnerHTML={{ __html: state.svg }}
      />
    )
  }
  if (state.kind === 'error') {
    return (
      <div className="mermaid-err bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md p-3 my-2">
        <pre className="text-[12px] text-[var(--text-secondary)] font-mono overflow-x-auto">{code}</pre>
        <p className="text-[var(--accent-red)] text-xs mt-1">Mermaid: {state.msg}</p>
      </div>
    )
  }
  return (
    <pre className="mermaid-pending bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md p-3 my-2 overflow-x-auto text-[12px] text-[var(--text-secondary)] opacity-60 font-mono">
      {code}
    </pre>
  )
}
