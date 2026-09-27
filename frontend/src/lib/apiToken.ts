// Single source for reading the legacy-mode auth token. Kept outside lib/api/
// so api.ts's `export * from './api/*'` aggregate never re-exports it —
// core.ts, files.ts and vault.ts import it directly instead of each keeping
// their own private copy.
export function getToken(): string {
  return localStorage.getItem('zeromux_token') || ''
}
