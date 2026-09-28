import { applyPreset } from './applyPreset'
import { confirm } from '../components/ui/dialogs'

const INPUT_TOKEN = /\{\{\s*input\s*\}\}/

/** `/fix 登录页` (text after the leading `/`) → filter token `fix`, argument `登录页`. */
export function splitSlash(query: string): { token: string; arg: string } {
  const m = /^(\S*)\s*([\s\S]*)$/.exec(query)!
  return { token: m[1], arg: m[2] }
}

/** Resolve the text a picked preset puts in the input (spec §2.3):
 *  `{{input}}` wraps the argument; otherwise the body replaces the input, after a
 *  confirm when that would discard typed text. null = the user cancelled. */
export async function resolvePresetPick(body: string, arg: string): Promise<string | null> {
  if (INPUT_TOKEN.test(body)) return applyPreset(body, arg)
  if (arg.trim() && !(await confirm({ title: '用预设覆盖当前输入?' }))) return null
  return body
}
