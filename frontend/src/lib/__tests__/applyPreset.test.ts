import { describe, it, expect } from 'vitest'
import { applyPreset } from '../applyPreset'

describe('applyPreset', () => {
  it('no token: replaces the whole input (backward compatible)', () => {
    expect(applyPreset('审查这个 PR', 'old draft')).toBe('审查这个 PR')
  })

  it('no token, empty current: still just the body', () => {
    expect(applyPreset('解释代码', '')).toBe('解释代码')
  })

  it('{{input}} token: splices current input into the body', () => {
    expect(applyPreset('给下面这段写单测:\n\n{{input}}', 'fn add(a,b){}'))
      .toBe('给下面这段写单测:\n\nfn add(a,b){}')
  })

  it('{{input}} with empty current: token becomes empty string', () => {
    expect(applyPreset('翻译:{{input}}', '')).toBe('翻译:')
  })

  it('multiple {{input}} tokens all replaced', () => {
    expect(applyPreset('A {{input}} B {{input}}', 'X')).toBe('A X B X')
  })

  it('token surrounded by whitespace tolerated ({{ input }})', () => {
    expect(applyPreset('解释 {{ input }} 谢谢', 'this')).toBe('解释 this 谢谢')
  })

  it('current input with regex-special chars inserted literally', () => {
    // $& / $1 are replacement-string specials — must not be interpreted.
    expect(applyPreset('wrap: {{input}}', '$& and $1 and \\n')).toBe('wrap: $& and $1 and \\n')
  })
})
