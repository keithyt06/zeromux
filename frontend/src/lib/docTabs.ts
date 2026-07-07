export type DocTab = { id: string; title: string; kind: 'vault' }

const KEY = 'zeromux:doc-tabs'

// Generic label a doc tab shows when no note is open (list mode) and what we persist —
// live note names live only in memory, never on disk (refresh reopens in list mode).
export const DEFAULT_DOC_TITLE = '文档'

// Note title shown in the sidebar tab: basename without a trailing .md (case-insensitive).
export function docTitleFromPath(path: string): string {
  const base = path.split('/').pop() || path
  return base.replace(/\.md$/i, '') || base
}

const uuid = () =>
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36)

export function newDocTab(title: string): DocTab {
  return { id: `doc-${uuid()}`, title, kind: 'vault' }
}

export function isDocTabId(id: string | null): boolean {
  return typeof id === 'string' && id.startsWith('doc-')
}

// Resolve which pane should be active given the current session + doc-tab ids.
// Keeps the previous selection if it still resolves to a live pane; otherwise
// falls back to the first session, then the first doc tab, then null. This is the
// single invariant behind "activeId must always point at a rendered pane" — used
// both when (re)loading the session list and to decide whether the empty state shows.
export function resolveActivePane(
  activeId: string | null,
  sessionIds: string[],
  docTabIds: string[],
): string | null {
  if (activeId && (sessionIds.includes(activeId) || docTabIds.includes(activeId))) return activeId
  return sessionIds[0] ?? docTabIds[0] ?? null
}

function isValid(t: unknown): t is DocTab {
  return !!t && typeof t === 'object'
    && typeof (t as DocTab).id === 'string'
    && typeof (t as DocTab).title === 'string'
    && (t as DocTab).kind === 'vault'
}

export function loadDocTabs(): DocTab[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(v) ? v.filter(isValid).map(t => ({ id: t.id, title: t.title, kind: t.kind })) : []
  } catch { return [] }
}

export function saveDocTabs(tabs: DocTab[]): void {
  localStorage.setItem(KEY, JSON.stringify(
    tabs.map(t => ({ id: t.id, title: t.kind === 'vault' ? DEFAULT_DOC_TITLE : t.title, kind: t.kind }))
  ))
}
