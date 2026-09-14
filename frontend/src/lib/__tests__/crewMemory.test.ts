import { describe, it, expect } from 'vitest'
import { normalizeMemoryKey, KEY_RE, mdLines, dropMdLine, parseSemanticValue } from '../crewMemory'

// T15-a:key 归一化(约束 3:前缀 + 正则)。实测约束:key 必须匹配
// ^[a-z][a-z0-9_.]*[a-z0-9]$ 且带前缀 pref.|project.|user.|lesson.,否则
// Gateway 回 "Key must match an allowed prefix"。
describe('T15-a key 归一化', () => {
  it('自由中文输入自动加 pref. 前缀，且 key 合法', () => {
    const { key, value } = normalizeMemoryKey('提交前必须先跑 npm test')
    expect(key.startsWith('pref.')).toBe(true)
    expect(KEY_RE.test(key)).toBe(true)
    // value 保留用户原话 —— key 是索引，不是内容。
    expect(value).toBe('提交前必须先跑 npm test')
  })

  it('纯中文（无任何 ASCII 词）也产出合法 key，绝不发一个会被 400 掉的 key', () => {
    const { key } = normalizeMemoryKey('回复一律用中文')
    expect(key.startsWith('pref.note_')).toBe(true)
    expect(KEY_RE.test(key)).toBe(true)
  })

  it('同一句话两次归一化得到同一个 key（重写=更新，不堆积重复行）', () => {
    expect(normalizeMemoryKey('回复一律用中文').key)
      .toBe(normalizeMemoryKey('回复一律用中文').key)
  })

  it('key=value 形态：key 补前缀，value 取右侧', () => {
    const { key, value } = normalizeMemoryKey('pkg_manager = pnpm')
    expect(key).toBe('pref.pkg_manager')
    expect(value).toBe('pnpm')
  })

  it('已带合法前缀时不再叠一层（不产出 pref.pref.x / pref.project_repo）', () => {
    expect(normalizeMemoryKey('project.repo = zeromux').key).toBe('project.repo')
    expect(normalizeMemoryKey('lesson.no_force_push = true').key).toBe('lesson.no_force_push')
  })

  it('大写/空格/标点被折成合法 slug，且不以 _ 收尾（正则要求末位是 [a-z0-9]）', () => {
    const { key } = normalizeMemoryKey('Use PNPM, Not NPM!')
    expect(KEY_RE.test(key)).toBe(true)
    expect(key.endsWith('_')).toBe(false)
    expect(key.startsWith('pref.')).toBe(true)
  })

  it('超长输入不把整段话当 key（限 4 段）', () => {
    expect(normalizeMemoryKey('a b c d e f g h i j k l').key).toBe('pref.a_b_c_d')
  })
})

describe('T15-b markdown 层', () => {
  it('骨架（标题 + HTML 注释）不算记忆，所以初始状态是「空」', () => {
    // 实测 preferences.md 只有 56 字节:一个标题 + 一行注释。若把它们列成可删行,
    // 用户会删掉文件结构,并误以为「已经记了两条」。
    expect(mdLines('# User Preferences\n\n<!-- Learned from conversations -->\n')).toEqual([])
    expect(mdLines('# User Preferences\n\n- 用 pnpm\n- 提交前跑测试\n'))
      .toEqual(['- 用 pnpm', '- 提交前跑测试'])
  })

  it('删一行按过滤后下标映射回原始行号（否则删错行，且 PUT 整文件不可逆）', () => {
    const md = '# User Preferences\n\n<!-- note -->\n- 用 pnpm\n- 提交前跑测试\n'
    // idx=1 是过滤后的第二条(「提交前跑测试」),原始数组里它是第 5 行。
    const next = dropMdLine(md, 1)
    expect(mdLines(next)).toEqual(['- 用 pnpm'])
    // 骨架必须完整保留。
    expect(next).toContain('# User Preferences')
    expect(next).toContain('<!-- note -->')
  })

  it('value_json 是 JSON 字符串，坏数据回落原文不抛', () => {
    expect(parseSemanticValue('"pnpm"')).toBe('pnpm')
    expect(parseSemanticValue('{"a":1}')).toBe('{"a":1}')
    expect(parseSemanticValue('not json')).toBe('not json')
  })
})
