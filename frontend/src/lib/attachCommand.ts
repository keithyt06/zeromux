// `=` forces tmux exact match (plain -t prefix-matches: `zmx-ab` → `zmx-abc`).
export function attachCommand(name: string): string {
  return `tmux attach -t '=${name.replace(/'/g, `'\\''`)}'`
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  }
}
