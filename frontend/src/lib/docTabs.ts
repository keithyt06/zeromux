export type DocTab = { id: string; title: string; kind: 'vault' }

const KEY = 'zeromux:doc-tabs'

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
  localStorage.setItem(KEY, JSON.stringify(tabs.map(t => ({ id: t.id, title: t.title, kind: t.kind }))))
}
