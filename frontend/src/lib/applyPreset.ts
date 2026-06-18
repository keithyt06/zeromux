/**
 * Apply a prompt preset to the current input box content.
 *
 * - If the preset body contains a `{{input}}` token (whitespace inside the
 *   braces tolerated), every occurrence is replaced with the current input —
 *   i.e. the preset *wraps* what the user already typed ("给下面这段写单测:\n\n{{input}}").
 * - Otherwise the body replaces the whole input (today's behavior, backward compatible).
 *
 * Uses a function replacer so regex-special sequences in `current` (`$&`, `$1`, …)
 * are inserted literally rather than interpreted as replacement-string specials.
 *
 * The regex is a fresh literal each call (not a shared module-level `/g` object):
 * `.replace` with no match already returns `body` unchanged, so a separate
 * `.test()` guard is unnecessary — and a shared global regex would carry mutable
 * `lastIndex` between calls, which is a footgun worth not having at all.
 */
export function applyPreset(body: string, current: string): string {
  return body.replace(/\{\{\s*input\s*\}\}/g, () => current)
}
