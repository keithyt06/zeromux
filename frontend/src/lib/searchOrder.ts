import type { SearchResult } from './api'

/** Section order follows each section's best hit — a fixed "dirs first" would bury
 *  a clearly better note match below six directory rows. */
export function orderSections(r: SearchResult, showNotes: boolean): Array<'dirs' | 'notes'> {
  const best = (xs: { score: number }[] | undefined) => (xs && xs.length ? Math.max(...xs.map(x => x.score)) : -1)
  const kinds: Array<'dirs' | 'notes'> = ['dirs']
  if (showNotes) kinds.push('notes')
  return kinds.sort((a, b) => best(r[b]?.items) - best(r[a]?.items))
}

/** Vault hints all start with `projects/long-term/…` (PARA layout); on a 224px
 *  popover that prefix alone eats the width and the year/section that tells 20
 *  identical `阅读理解` rows apart gets truncated. Drop it. */
export function compactHint(hint: string): string {
  return hint.replace(/^projects\/(long-term|short-term)\/?/, '')
}
