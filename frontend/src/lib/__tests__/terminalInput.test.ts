import { describe, it, expect } from 'vitest'
import { arrowSequence, rowHeight, linesFromDrag, bracketedPaste, submitSequence, controlSequence } from '../terminalInput'

describe('arrowSequence', () => {
  it('普通光标键模式用 CSI（\\x1b[）', () => {
    expect(arrowSequence('up', false)).toBe('\x1b[A')
    expect(arrowSequence('down', false)).toBe('\x1b[B')
    expect(arrowSequence('right', false)).toBe('\x1b[C')
    expect(arrowSequence('left', false)).toBe('\x1b[D')
  })
  it('应用光标键模式用 SS3（\\x1bO）—— claude TUI 菜单常用', () => {
    expect(arrowSequence('up', true)).toBe('\x1bOA')
    expect(arrowSequence('down', true)).toBe('\x1bOB')
    expect(arrowSequence('right', true)).toBe('\x1bOC')
    expect(arrowSequence('left', true)).toBe('\x1bOD')
  })
  it('Enter 恒为回车，与模式无关', () => {
    expect(arrowSequence('enter', false)).toBe('\r')
    expect(arrowSequence('enter', true)).toBe('\r')
  })
})

describe('rowHeight', () => {
  it('clientHeight / rows', () => {
    expect(rowHeight(480, 24, 14)).toBe(20)
  })
  it('clientHeight 为 0 时回落 fontSize*1.2', () => {
    expect(rowHeight(0, 24, 14)).toBeCloseTo(16.8)
  })
  it('rows 为 0 时回落 fontSize*1.2', () => {
    expect(rowHeight(480, 0, 14)).toBeCloseTo(16.8)
  })
})

describe('linesFromDrag', () => {
  it('手指上移（currentY < startY）→ 向下滚（正数，看更新内容）', () => {
    expect(linesFromDrag(200, 100, 20)).toBe(5)
  })
  it('手指下移（currentY > startY）→ 向上滚（负数，看历史）', () => {
    expect(linesFromDrag(100, 200, 20)).toBe(-5)
  })
  it('不足一行的微小移动返回 0', () => {
    expect(linesFromDrag(100, 95, 20)).toBe(0)
  })
  it('行高非正时返回 0（不崩）', () => {
    expect(linesFromDrag(200, 100, 0)).toBe(0)
  })
})

describe('bracketedPaste', () => {
  it('用 DECSET 2004 粘贴标记包裹文本', () => {
    expect(bracketedPaste('hello')).toBe('\x1b[200~hello\x1b[201~')
  })
  it('保留内部换行（多行 prompt 仍是一次粘贴）', () => {
    expect(bracketedPaste('a\nb\nc')).toBe('\x1b[200~a\nb\nc\x1b[201~')
  })
  it('空串也照样包裹（非空判断在调用方）', () => {
    expect(bracketedPaste('')).toBe('\x1b[200~\x1b[201~')
  })
})

describe('submitSequence', () => {
  it('bracketed paste 模式开 → 回车（TUI 输入框，如 Claude Code）', () => {
    expect(submitSequence(true)).toBe('\r')
  })
  it('bracketed paste 模式关 → 空串（裸 shell：多行不自动执行）', () => {
    expect(submitSequence(false)).toBe('')
  })
})

describe('controlSequence', () => {
  it('esc → ESC 字节', () => { expect(controlSequence('esc')).toBe('\x1b') })
  it('ctrl-c → ETX (0x03)', () => { expect(controlSequence('ctrl-c')).toBe('\x03') })
  it('y / n → 字面字符', () => {
    expect(controlSequence('y')).toBe('y')
    expect(controlSequence('n')).toBe('n')
  })
})
