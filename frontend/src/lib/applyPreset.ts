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
 */
const INPUT_TOKEN = /\{\{\s*input\s*\}\}/g

export function applyPreset(body: string, current: string): string {
  if (!INPUT_TOKEN.test(body)) return body
  return body.replace(INPUT_TOKEN, () => current)
}
