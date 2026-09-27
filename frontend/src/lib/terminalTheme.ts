import type { ITheme } from '@xterm/xterm'

const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const

/** xterm theme derived from the CSS tokens of the currently applied theme
 *  (index.css). Single source for the terminal palette — replaces the
 *  hard-coded THEMES table that duplicated --ansi-*. */
export function readTerminalTheme(): ITheme {
  const cs = getComputedStyle(document.documentElement)
  const v = (n: string) => cs.getPropertyValue(n).trim()
  const t: ITheme = {
    background: v('--surface-0'),
    foreground: v('--term-fg'),
    cursor: v('--accent'),
    selectionBackground: v('--term-selection'),
  }
  ANSI.forEach((k, i) => { (t as Record<string, string>)[k] = v(`--ansi-${i}`) })
  return t
}
