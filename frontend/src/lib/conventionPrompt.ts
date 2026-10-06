// F4 方案 A (spec §4.2): the current agent appends the convention itself; no backend
// write endpoint (the file API overwrites whole files — lost-update race with the agent).
const HEAD = '请把下面这条约定追加到仓库根目录 CLAUDE.md 的「## 约定(zeromux)」一节末尾（没有该节就在文件末尾新建；若仓库根存在 AGENTS.md，同样追加一份）。'
// Prefix of the block buildPromptWithAttachments appends (lib/attachments.ts).
const ATTACH = '[用户上传了以下文件'

export function conventionPrompt(text: string): string {
  return [
    HEAD,
    '只追加，不改动其他内容，保持简洁的一行式表述；完成后回复「已记录」和追加的原文。',
    `约定：${text}`,
  ].join('\n')
}

/** Newest non-blank prompt the user typed in THIS session (peer messages, previous
 *  记为约定 templates and the attachment block excluded). */
export function lastOwnPrompt(events: { type: string; text?: string; from_name?: string }[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type !== 'user_prompt' || e.from_name || !e.text || e.text.startsWith(HEAD)) continue
    const at = e.text.indexOf(ATTACH)
    const text = (at >= 0 ? e.text.slice(0, at) : e.text).trim()
    if (text) return text
  }
  return ''
}
