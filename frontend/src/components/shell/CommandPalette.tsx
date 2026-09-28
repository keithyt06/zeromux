import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Search, BookOpen, Terminal, CornerDownLeft, Zap } from 'lucide-react'
import type { SearchResult, DirHit, NoteHit, SessionType } from '../../lib/api'
import { warmSearchIndex } from '../../lib/api'
import { rankBy } from '../../lib/fuzzy'
import { parseNew, loadLastType, saveLastType, type NewType } from '../../lib/paletteParse'
import { usePathSearch } from '../../lib/usePathSearch'
import { matchHostTmux } from '../../lib/hostTmux'
import { askAgentPrompt } from '../../lib/askAgent'
import { triage, toneOf, labelOf } from '../../lib/triage'
import { useIsNarrow } from '../../lib/useMediaQuery'
import { usePromptPresets } from '../../lib/usePromptPresets'
import { resolvePresetPick, splitSlash } from '../../lib/presetPick'
import type { PromptPreset } from '../../lib/api'
import { PresetPicker } from '../composer/PresetPicker'
import { Dialog, Sheet, StatusDot } from '../ui'
import QuickTargets from '../QuickTargets'
import SearchResults from '../SearchResults'
import { TypeIcon } from './TypeIcon'
import { SendToMenu } from '../SendToMenu'
import { askAgentPaletteText, type PaletteAction } from './paletteActions'
import type { ShellState } from './useShellState'

// The session types ⌘K new mode offers (Kiro is gone; vault is a doc tab, not a session).
const TYPE_CHOICES = ['claude', 'codex', 'crew', 'tmux'] as const
const TYPE_LABEL: Record<NewType, string> = { claude: 'Claude', codex: 'Codex', crew: 'Crew', tmux: '终端', vault: '笔记库' }

// Still building (indexing) or rebuilding with no hits → re-query in 4s so the
// user never has to retype after a restart. Dirs: re-query on refreshing+empty
// (scheduled rebuild). Notes: re-query only during indexing (initial build can
// take 50s+). Once built, inotify keeps live, so zero results during refresh
// are real misses. Module-level so usePathSearch gets a stable predicate.
const paletteRequery = (r: SearchResult) => {
  const pending = (s: { indexing: boolean; refreshing: boolean; items: unknown[] } | null) =>
    !!s && (s.indexing || (s.refreshing && s.items.length === 0))
  return pending(r.dirs) || !!r.notes?.indexing
}

export interface CommandPaletteProps {
  open: boolean
  onClose(): void
  initial?: { mode: 'search' | 'new'; text?: string }
  shell: ShellState
  actions: PaletteAction[]
  vaultEnabled?: boolean
  now?: number
  /** 「管理…」 under the new-mode `/` preset list. */
  onManagePresets?(): void
}

export function CommandPalette(p: CommandPaletteProps) {
  if (!p.open) return null
  return <PaletteBody {...p} />
}

type Act = { t: 'session'; id: string } | { t: 'action'; a: PaletteAction } | { t: 'tmux'; name: string }
type Item = { id: string; act: Act; node: ReactNode }

function stripNewPrefix(t: string): { forced: boolean; rest: string } {
  if (t.startsWith('+')) return { forced: true, rest: t.slice(1) }
  if (t.startsWith('新建 ')) return { forced: true, rest: t.slice(3) }
  return { forced: false, rest: t }
}

// New-mode text = [+|新建 ]<type?> <dir> <prompt>; split off the raw prompt part so a
// line-start `/` there opens the preset list and a pick replaces only that part.
function splitPrompt(text: string, rest: string, hasType: boolean): { head: string; prompt: string } | null {
  const m = new RegExp(`^(\\s*(?:\\S+\\s+){${hasType ? 2 : 1}})([\\s\\S]*)$`).exec(rest)
  return m ? { head: text.slice(0, text.length - rest.length) + m[1], prompt: m[2] } : null
}

function PaletteBody({ onClose, initial, shell, actions, vaultEnabled = false, now: nowProp, onManagePresets }: CommandPaletteProps) {
  const [openedAt] = useState(() => Date.now())
  const now = nowProp ?? openedAt
  const narrow = useIsNarrow()
  const titleId = useId()
  const [text, setText] = useState(initial?.text ?? '')
  const [forcedNew, setForcedNew] = useState(initial?.mode === 'new')
  const [hi, setHi] = useState<string | null>(null)
  const [dirPick, setDirPick] = useState(0)
  const [createError, setCreateError] = useState<string | null>(null)
  // Synchronous in-flight guard: two taps can land in the same tick before a
  // re-render, so state alone can't stop a double create. `creating` mirrors it
  // for the pending UI.
  const creatingRef = useRef(false)
  const [creating, setCreating] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { warmSearchIndex(vaultEnabled ? 'dirs,notes' : 'dirs').catch(() => {}) }, [vaultEnabled])

  const { forced, rest } = stripNewPrefix(text)
  const parsed = parseNew(rest)
  // A bare type word ("tmux") still searches; a type word followed by more text is new mode.
  const newMode = forcedNew || forced || (parsed.type !== null && /\s/.test(rest.trimStart()))
  const newType: NewType = parsed.type ?? loadLastType()

  // ── new mode `/` presets (V7: same picker as the composer) ──
  const presetStore = usePromptPresets()
  const { reload: reloadPresets } = presetStore
  const promptPart = newMode ? splitPrompt(text, rest, parsed.type !== null) : null
  const slashQuery = promptPart?.prompt.startsWith('/') ? promptPart.prompt.slice(1) : null
  const inSlash = slashQuery !== null
  // Esc/tap-outside/pick keeps the list closed until the user types again (a pick's
  // own setText must not reopen it, even if the preset body starts with `/`).
  const [slashDismissed, setSlashDismissed] = useState(false)
  useEffect(() => { if (inSlash) reloadPresets() }, [inSlash, reloadPresets])
  const [inputBox, setInputBox] = useState<HTMLDivElement | null>(null)
  const pickPreset = async (p: PromptPreset) => {
    if (!promptPart || slashQuery === null) return
    setSlashDismissed(true)
    const next = await resolvePresetPick(p.body, splitSlash(slashQuery).arg)
    if (next !== null) setText(promptPart.head + next)
    inputRef.current?.focus()
  }

  // Await creation; only close on success. On failure keep the palette open with
  // a visible reason (audit B3) — never close silently.
  const runCreate = async (create: () => Promise<void>, after: () => void = onClose) => {
    if (creatingRef.current) return
    creatingRef.current = true
    setCreating(true)
    setCreateError(null)
    try {
      await create()
      after()
    } catch (e) {
      setCreateError(`创建失败:${(e as Error).message || '未知错误'}`)
    } finally {
      creatingRef.current = false
      setCreating(false)
    }
  }

  const goNew = (t: string) => { setForcedNew(true); setText(t); setDirPick(0); setCreateError(null); inputRef.current?.focus() }
  const lastAgent = () => loadLastType()

  // ── search mode ──
  const search = usePathSearch(newMode ? '' : text, {
    scope: vaultEnabled ? 'dirs,notes' : 'dirs', debounceMs: 150, enabled: !newMode, requeryWhile: paletteRequery,
  })
  // ── new mode: resolve the directory fragment ──
  const dirSearch = usePathSearch(newMode && !parsed.literalPath ? parsed.dir : '', {
    scope: 'dirs', debounceMs: 150, enabled: newMode && !parsed.literalPath, requeryWhile: paletteRequery,
  })
  const dirCandidates = newMode && !parsed.literalPath && parsed.dir && dirSearch.result && dirSearch.resultQuery === parsed.dir
    ? dirSearch.result.dirs?.items ?? [] : []
  const resolvedDir: string | null = !newMode ? null
    : parsed.literalPath ? parsed.dir
    : !parsed.dir ? ''
    : dirCandidates.length ? dirCandidates[dirPick % dirCandidates.length].path : null

  const ctx = { now, activeId: shell.activeId, lastViewedMs: shell.lastViewedMs, confirmsBySession: shell.confirmsBySession }
  const sessionRow = (s: ShellState['sessions'][number]) => {
    const a = triage(s, ctx)
    return (
      <>
        <StatusDot tone={toneOf(a)} label={labelOf(a)} />
        <TypeIcon type={s.type} size={14} className="shrink-0 text-[var(--fg-muted)]" />
        <span className="flex-1 min-w-0 truncate text-ui-sm text-[var(--fg-strong)]">{s.name}</span>
        <span className="shrink-0 truncate max-w-[40%] text-ui-2xs text-[var(--fg-subtle)]">{s.work_dir}</span>
      </>
    )
  }

  const selectSession = (id: string) => { shell.select(id); onClose() }
  const q = text.trim()
  const items: Item[] = []
  if (!newMode) {
    const out = items
    const sess = q
      ? rankBy(q, shell.sessions, s => [s.name, s.work_dir, s.peer_name ?? '']).slice(0, 8)
      : [...shell.sessions].sort((a, b) => b.last_activity_ms - a.last_activity_ms).slice(0, 5)
    for (const s of sess) out.push({ id: `s:${s.id}`, act: { t: 'session', id: s.id }, node: sessionRow(s) })
    if (q) {
      for (const a of rankBy(q, actions, x => [x.label])) out.push({ id: `a:${a.id}`, act: { t: 'action', a }, node: <span className="flex-1 truncate text-ui-sm">{a.label}</span> })
      for (const h of matchHostTmux(shell.hostTmux, q)) out.push({
        id: `t:${h.name}`, act: { t: 'tmux', name: h.name },
        node: <><Terminal size={14} className="shrink-0 text-[var(--success)]" /><span className="flex-1 truncate text-ui-sm">{`接入 tmux:${h.name}`}</span><span className="shrink-0 truncate text-ui-2xs text-[var(--fg-subtle)]">{h.path}</span></>,
      })
    }
  }
  const runItem = (it: Item) => {
    const a = it.act
    if (a.t === 'session') selectSession(a.id)
    else if (a.t === 'action') { a.a.run(); onClose() }
    else runCreate(() => shell.create('tmux', undefined, a.name))
  }
  const hiId = items.some(i => i.id === hi) ? hi : items[0]?.id ?? null

  const pickDirHit = (h: DirHit) => {
    if (h.agent) { runCreate(() => shell.create(h.agent!, h.path)); return }
    goNew(`${lastAgent()} ${h.path} `)
  }
  const pickNoteHit = (h: NoteHit) => { shell.openVault({ path: h.path, kind: h.kind }); onClose() }
  // ⚡ → SendToMenu (M24/V6); its「＋ 新开…」prefills new mode right here. SearchResults
  // reports only the hit, so the ⚡ button is captured on the click's way down.
  const askAnchorRef = useRef<HTMLElement | null>(null)
  const [noteSend, setNoteSend] = useState<{ anchor: HTMLElement | null; text: string; workDir: string } | null>(null)
  const askAgent = (h: NoteHit) => setNoteSend({
    anchor: askAnchorRef.current, workDir: h.abs_dir, text: askAgentPrompt({ absDir: h.abs_dir, relPath: h.path, kind: h.kind }),
  })

  const submitNew = () => {
    if (resolvedDir === null) return
    const type = newType
    const prompt = parsed.prompt
    runCreate(
      () => (type === 'vault' ? shell.create('vault') : shell.create(type, resolvedDir || undefined, undefined, prompt || undefined)),
      () => { if (type !== 'vault') saveLastType(type as SessionType); onClose() },
    )
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!items.length) return
      e.preventDefault()
      const i = Math.max(0, items.findIndex(x => x.id === hiId))
      const j = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length
      setHi(items[j].id)
    } else if (e.key === 'Tab' && newMode && dirCandidates.length > 1) {
      e.preventDefault()
      setDirPick(n => (n + (e.shiftKey ? dirCandidates.length - 1 : 1)) % dirCandidates.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (newMode) { submitNew(); return }
      const it = items.find(x => x.id === hiId)
      if (it) { runItem(it); return }
      // Nothing in memory matched: fall back to the best dir/note hit — only if the
      // shown results belong to this query (debounce not yet fired otherwise).
      if (!search.result || search.resultQuery !== text) return
      const first = [...(search.result.dirs?.items ?? []).map(h => ({ t: 'd' as const, h, s: h.score })),
        ...(vaultEnabled ? search.result.notes?.items ?? [] : []).map(h => ({ t: 'n' as const, h, s: h.score }))]
        .sort((a, b) => b.s - a.s)[0]
      if (!first) return
      if (first.t === 'd') pickDirHit(first.h as DirHit); else pickNoteHit(first.h as NoteHit)
    }
  }

  const setType = (t: NewType) => {
    const body = parsed.type ? rest.trimStart().replace(/^\S+\s*/, '') : rest.trimStart()
    goNew(`${t} ${body}`)
  }

  const preview = (() => {
    if (!newMode) return null
    if (createError) return createError
    if (creating) return '创建中…'
    if (newType === 'vault') return `${TYPE_LABEL.vault}`
    const dir = resolvedDir === null
      ? (dirSearch.result && dirSearch.resultQuery === parsed.dir ? '未找到目录' : '搜索目录…')
      : resolvedDir || '默认目录'
    return `${TYPE_LABEL[newType]} · ${dir}${parsed.prompt ? ` · "${parsed.prompt}"` : ''}`
  })()

  const row = 'row w-full flex items-center gap-2.5 px-3 text-left rounded-[var(--r-md)]'
  const body = (
    <div className="flex flex-col max-h-[min(70dvh,560px)] md:max-h-[min(70vh,560px)]">
      <h2 id={titleId} className="sr-only">命令面板</h2>
      <div ref={setInputBox} className="flex items-center gap-2 px-3 border-b border-[var(--border-subtle)]">
        <Search size={16} className="shrink-0 text-[var(--fg-subtle)]" />
        <input ref={inputRef} autoFocus value={text} onKeyDown={onKey} maxLength={512}
          onChange={e => { setText(e.target.value); setDirPick(0); setCreateError(null); setSlashDismissed(false); if (!e.target.value) setForcedNew(initial?.mode === 'new') }}
          placeholder={forcedNew ? '类型 目录 prompt,如 codex zeromux 修 bug' : '搜索会话、动作、目录…  以 + 开头新建'}
          aria-label="命令" role="combobox" aria-expanded aria-controls={`${titleId}-list`}
          className="flex-1 min-w-0 min-h-[48px] bg-transparent outline-none text-ui-input text-[var(--fg)] placeholder:text-[var(--fg-subtle)]" />
      </div>
      <PresetPicker open={inSlash && !slashDismissed} query={slashQuery ?? ''} presets={presetStore.presets} anchor={inputBox}
        onPick={p => { pickPreset(p) }} onClose={() => setSlashDismissed(true)}
        onManage={() => { onClose(); onManagePresets?.() }} />
      {newMode ? (
        <div className="p-2 space-y-2">
          <div role="radiogroup" aria-label="会话类型" className="flex flex-wrap gap-1">
            {TYPE_CHOICES.map(t => (
              <button key={t} type="button" role="radio" aria-checked={newType === t} onClick={() => setType(t)}
                className={`ctl inline-flex items-center gap-1.5 px-3 rounded-[var(--r-md)] text-ui-xs border ${newType === t ? 'border-[var(--accent)] text-[var(--fg-strong)] bg-[var(--surface-3)]' : 'border-[var(--border)] text-[var(--fg-muted)]'}`}>
                <TypeIcon type={t} size={14} />{TYPE_LABEL[t]}
              </button>
            ))}
            {vaultEnabled && (
              <button type="button" role="radio" aria-checked={newType === 'vault'} onClick={() => setType('vault')}
                className={`ctl inline-flex items-center gap-1.5 px-3 rounded-[var(--r-md)] text-ui-xs border ${newType === 'vault' ? 'border-[var(--accent)] text-[var(--fg-strong)] bg-[var(--surface-3)]' : 'border-[var(--border)] text-[var(--fg-muted)]'}`}>
                <BookOpen size={14} />{TYPE_LABEL.vault}
              </button>
            )}
          </div>
          {dirCandidates.length > 1 && (
            <p className="px-1 text-ui-2xs text-[var(--fg-subtle)]">{`Tab 切换目录候选 (${(dirPick % dirCandidates.length) + 1}/${dirCandidates.length})`}</p>
          )}
          <button type="button" data-testid="palette-preview" onClick={submitNew} disabled={resolvedDir === null || creating}
            role={createError ? 'alert' : undefined}
            className={`${row} min-h-[48px] border ${createError ? 'border-[var(--danger)] text-[var(--danger)]' : 'border-[var(--border)] text-[var(--fg)]'} disabled:opacity-60`}>
            <span className="flex-1 min-w-0 truncate text-ui-sm">{preview}</span>
            <CornerDownLeft size={14} className="shrink-0 text-[var(--fg-subtle)]" />
          </button>
        </div>
      ) : (
        <div id={`${titleId}-list`} className="flex-1 min-h-0 overflow-y-auto p-1">
          {createError && <div role="alert" className="mx-2 my-1 px-2 py-1.5 rounded-[var(--r-md)] text-ui-xs text-[var(--danger)] border border-[var(--danger)]">{createError}</div>}
          {creating && <div className="mx-2 my-1 px-2 py-1.5 text-ui-xs text-[var(--fg-subtle)]">创建中…</div>}
          {!q && (
            <QuickTargets kind="dir"
              onPick={(path, agent) => runCreate(() => shell.create(agent ?? lastAgent(), path))}
              onChangeAgent={path => goNew(`${lastAgent()} ${path} `)}
              onPickWithPrompt={(path, agent) => goNew(`${agent ?? lastAgent()} ${path} `)} />
          )}
          {items.length > 0 && (
            <ul role="listbox" aria-label="结果" className="py-1">
              {items.map(it => (
                <li key={it.id} role="option" aria-selected={it.id === hiId} data-palette-item={it.id}
                  onClick={() => runItem(it)} onMouseMove={() => { if (hi !== it.id) setHi(it.id) }}
                  className={`${row} cursor-pointer ${it.id === hiId ? 'bg-[var(--surface-hover)]' : ''}`}>
                  {it.node}
                </li>
              ))}
            </ul>
          )}
          {q && (search.result || search.failed) && (
            <div className="contents" onClickCapture={e => { askAnchorRef.current = (e.target as Element).closest('button') }}>
            <SearchResults result={search.result ?? { dirs: null, notes: null }} failed={search.failed} onRetry={search.retry}
              showNotes={vaultEnabled} onPickDir={pickDirHit}
              onDirMenu={{ changeAgent: h => goNew(`${lastAgent()} ${h.path} `), withPrompt: h => goNew(`${h.agent ?? lastAgent()} ${h.path} `) }}
              onPickNote={pickNoteHit} onAskAgent={askAgent} onOpenHere={h => goNew(`${lastAgent()} ${h.abs_dir} `)} />
            </div>
          )}
          {noteSend && (
            <SendToMenu open anchor={noteSend.anchor} onClose={() => setNoteSend(null)} text={noteSend.text} workDir={noteSend.workDir}
              sessions={shell.sessions} controls={shell.controls} queueModes={shell.queueModes} onSelectSession={selectSession}
              onNew={({ workDir, prompt }) => goNew(askAgentPaletteText(lastAgent(), workDir ?? '', prompt))} />
          )}
          {!q && (
            <button type="button" onClick={() => goNew('')} className={`${row} text-ui-sm text-[var(--fg-muted)] hover:bg-[var(--surface-hover)]`}>
              <Zap size={14} className="shrink-0" /><span>新建会话…</span>
            </button>
          )}
        </div>
      )}
    </div>
  )

  return narrow
    ? <Sheet open side="full" onClose={onClose} title="命令面板">{body}</Sheet>
    : <Dialog open onClose={onClose} labelledBy={titleId} size="lg">{body}</Dialog>
}
