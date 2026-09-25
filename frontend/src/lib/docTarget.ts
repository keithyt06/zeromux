import type { DocTab } from './docTabs'

/** Opening a note from search reuses the most recently created doc tab (tabs are
 *  appended, so the last one) instead of spawning a new tab per tap — on a phone
 *  tabs would pile up and each one keeps a VaultReader mounted. */
export function pickDocTabForTarget(tabs: DocTab[]): string | null {
  return tabs.length ? tabs[tabs.length - 1].id : null
}
