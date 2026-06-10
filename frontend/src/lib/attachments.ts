/** 把已上传附件的相对路径拼进 prompt。指令化措辞让 agent 真去 Read(spec E4)。 */
export function buildPromptWithAttachments(text: string, paths: string[]): string {
  if (paths.length === 0) return text
  const lines = paths.map(p => `./${p}`).join('\n')
  const block = `[用户上传了以下文件,请先用 Read 工具读取后再回应:\n${lines}]`
  const trimmed = text.trim()
  return trimmed ? `${trimmed}\n\n${block}` : block
}
