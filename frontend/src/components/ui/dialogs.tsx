import { useEffect, useState } from 'react'
import { Dialog } from './Dialog'

type Req =
  | { kind: 'confirm'; title: string; body?: string; confirmLabel: string; cancelLabel: string; danger: boolean; resolve(v: boolean): void }
  | { kind: 'prompt'; title: string; initial: string; placeholder?: string; confirmLabel: string; resolve(v: string | null): void }

let push: ((r: Req) => void) | null = null
const pending: Req[] = []

/** Promise-based replacements for window.confirm / window.prompt (bad on
 *  mobile, unstyled, and block the event loop). DialogHost renders them. */
// eslint-disable-next-line react-refresh/only-export-components -- imperative API is the point of this module
export function confirm(o: { title: string; body?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise(resolve => {
    const r: Req = { kind: 'confirm', title: o.title, body: o.body, confirmLabel: o.confirmLabel ?? '确定', cancelLabel: o.cancelLabel ?? '取消', danger: !!o.danger, resolve }
    if (push) push(r); else pending.push(r)
  })
}
// eslint-disable-next-line react-refresh/only-export-components -- imperative API is the point of this module
export function promptText(o: { title: string; initial?: string; placeholder?: string; confirmLabel?: string }): Promise<string | null> {
  return new Promise(resolve => {
    const r: Req = { kind: 'prompt', title: o.title, initial: o.initial ?? '', placeholder: o.placeholder, confirmLabel: o.confirmLabel ?? '确定', resolve }
    if (push) push(r); else pending.push(r)
  })
}

export function DialogHost() {
  const [queue, setQueue] = useState<Req[]>(() => pending.splice(0))
  const [text, setText] = useState(() => (queue[0]?.kind === 'prompt' ? queue[0].initial : ''))
  useEffect(() => {
    push = r => setQueue(q => [...q, r])
    return () => { push = null }
  }, [])
  const cur = queue[0]
  const [shown, setShown] = useState<Req | undefined>(cur)
  if (shown !== cur) { setShown(cur); if (cur?.kind === 'prompt') setText(cur.initial) }
  const done = (v: boolean | string | null) => {
    if (!cur) return
    if (cur.kind === 'confirm') cur.resolve(v === true)
    else cur.resolve(typeof v === 'string' ? (v.trim() || null) : null)
    setQueue(q => q.slice(1))
  }
  const btn = 'ctl px-3 rounded-[var(--r-md)] text-ui-sm'
  return (
    <Dialog open={!!cur} onClose={() => done(cur?.kind === 'confirm' ? false : null)} title={cur?.title}>
      {cur && (
        <form className="p-4 pt-2 space-y-3" onSubmit={e => { e.preventDefault(); done(cur.kind === 'confirm' ? true : text) }}>
          {cur.kind === 'confirm' && cur.body && <p className="text-ui-sm text-[var(--fg-muted)] whitespace-pre-wrap">{cur.body}</p>}
          {cur.kind === 'prompt' && (
            <input autoFocus value={text} placeholder={cur.placeholder} onChange={e => setText(e.target.value)}
              className="w-full px-3 py-2 text-ui-input bg-[var(--surface-1)] border border-[var(--border)] rounded-[var(--r-md)] outline-none focus:border-[var(--accent)]" />
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => done(cur.kind === 'confirm' ? false : null)} className={`${btn} text-[var(--fg-muted)] hover:bg-[var(--surface-hover)]`}>
              {cur.kind === 'confirm' ? cur.cancelLabel : '取消'}
            </button>
            <button type="submit" className={`${btn} ${cur.kind === 'confirm' && cur.danger ? 'text-[var(--danger)] border border-[var(--danger)]' : 'bg-[var(--accent)] text-[var(--on-accent)]'}`}>
              {cur.confirmLabel}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  )
}
