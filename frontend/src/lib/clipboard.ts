import type { IClipboardProvider } from '@xterm/addon-clipboard'

// OSC52 provider for the terminal: writes go to the system clipboard (tmux
// copy-mode → browser), but READ requests always answer empty — otherwise any
// program in the pane (or `cat` of a hostile file) could exfiltrate the
// user's clipboard via an OSC52 query.
export function writeOnlyClipboard(clip: Pick<Clipboard, 'writeText'> = navigator.clipboard): IClipboardProvider {
  return {
    readText: () => '',
    writeText: (sel, text) => (sel === 'c' ? clip.writeText(text) : undefined),
  }
}
