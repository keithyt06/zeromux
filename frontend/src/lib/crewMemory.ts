// Crew 记忆的纯函数层。抽出来是因为这三条约束每一条都会让第一次实现失败:
//   1. PUT /api/memory/semantic 路径**不带** key(带 key 是 405)—— 后端代理保证
//   2. 必须有 X-Session-Key,且值是已存在的 slot —— 后端代理补齐
//   3. key 必须带命名空间前缀(pref.|project.|user.|lesson.)且匹配
//      ^[a-z][a-z0-9_.]*[a-z0-9]$,否则 "Key must match an allowed prefix"
const ALLOWED_PREFIXES = ['pref.', 'project.', 'user.', 'lesson.'] as const

/** Gateway 侧的 key 正则(实测)。 */
export const KEY_RE = /^[a-z][a-z0-9_.]*[a-z0-9]$/

/**
 * 把用户自由输入变成一对合法 (key, value)。
 *
 * 用户在手机上不会(也不该)自己写 `pref.pkg_manager`。输入两种形态都接受:
 *   - `包管理器用 pnpm`     → key 由前几个 ASCII 词生成,value 为整句原文
 *   - `pkg_manager = pnpm` → 显式 key=value,key 自动补 `pref.` 前缀
 * 无法从输入提取任何 ASCII 词时(纯中文),用稳定的 `pref.note_<hash>` 兜底 ——
 * 绝不发一个会被 Gateway 400 掉的 key,也绝不静默丢弃用户的话。
 */
export function normalizeMemoryKey(input: string): { key: string; value: string } {
  const text = input.trim()
  const eq = text.indexOf('=')
  let rawKey = ''
  let value = text
  if (eq > 0) {
    rawKey = text.slice(0, eq).trim()
    value = text.slice(eq + 1).trim() || text
  }
  if (!rawKey) rawKey = text
  const lowered = rawKey.toLowerCase().trim()
  // 已经是一个合法的带前缀 key(如 `project.repo`)→ 原样采用。这一步必须在
  // slug 化**之前**:slug 把 `.` 也折成 `_`,会把 project.repo 变成
  // pref.project_repo(前缀丢失、语义漂移,Gateway 侧成了另一条记忆)。
  if (hasAllowedPrefix(lowered) && KEY_RE.test(lowered)) return { key: lowered, value }
  // slug:小写、非 [a-z0-9] 折成 `_`、掐头去尾。中文字符全被折掉,故可能为空。
  let slug = lowered.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  // 限长,避免把整段话当 key。
  slug = slug.split('_').filter(Boolean).slice(0, 4).join('_')
  if (!slug || !KEY_RE.test(slug)) slug = `note_${stableHash(text)}`
  return { key: `pref.${slug}`, value }
}

function hasAllowedPrefix(k: string): boolean {
  return ALLOWED_PREFIXES.some(p => k.startsWith(p))
}

/** 稳定的 32-bit FNV-1a,转 base36。同一句话总得到同一个 key(重写=更新而非堆积)。 */
function stableHash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

/** Gateway 的 `value_json` 是 JSON 字符串(`"\"pnpm\""`);坏数据回落原文不抛。 */
export function parseSemanticValue(valueJson: string): string {
  try {
    const v = JSON.parse(valueJson)
    return typeof v === 'string' ? v : JSON.stringify(v)
  } catch {
    return valueJson
  }
}

/**
 * markdown 文档 → 可显示/可删的「行」。跳过标题(`#`)、HTML 注释与空行 ——
 * `# User Preferences` 和 `<!-- Learned from conversations -->` 是骨架,不是记忆。
 * 实测 preferences.md 现在只有 56 字节且全是骨架:不过滤 → 面板显示「已记 2 条」,
 * 用户点删就删掉文件结构。
 */
export function mdLines(md: string): string[] {
  return md.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#') && !l.startsWith('<!--'))
}

/**
 * 删掉 mdLines 的第 idx 行后重组整个文档。
 * 关键:idx 是**过滤后**列表的下标,必须映射回原始行号,否则会删错行
 * (标题和注释都在原始数组里占位)。preferences 的 PUT 是整文件覆盖,删错不可逆。
 */
export function dropMdLine(md: string, idx: number): string {
  const raw = md.split('\n')
  let seen = -1
  const out: string[] = []
  for (const line of raw) {
    const t = line.trim()
    const isContent = t.length > 0 && !t.startsWith('#') && !t.startsWith('<!--')
    if (isContent) {
      seen += 1
      if (seen === idx) continue   // 跳过被删的那一行
    }
    out.push(line)
  }
  return out.join('\n')
}
