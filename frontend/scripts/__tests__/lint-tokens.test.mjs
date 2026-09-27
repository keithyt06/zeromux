import { describe, it, expect } from 'vitest'
import { countViolations } from '../lint-tokens.mjs'

describe('countViolations', () => {
  it('counts sub-12px arbitrary text sizes only', () => {
    const c = countViolations('<a className="text-[10px] text-[11px] text-[12px] text-[9px] text-[8px]" />')
    expect(c.smallText).toBe(4)
  })
  it('counts raw Tailwind palette colors', () => {
    const c = countViolations('className="text-yellow-400 bg-orange-500 border-zinc-700 text-[var(--fg)]"')
    expect(c.paletteColor).toBe(3)
  })
  it('counts z-N utilities but not z-(--z-modal) or z-sticky', () => {
    const c = countViolations('className="z-10 z-50 z-(--z-modal) z-sticky"')
    expect(c.zIndex).toBe(2)
  })
  it('counts native dialogs, ignoring comments and window.confirm mentions in comments', () => {
    const src = [
      "if (!confirm('x')) return",
      "window.alert('y')",
      "const n = prompt('name')",
      "// do not use window.confirm here",
      "  /* alert( */",
      "promptText({ title: 't' })",
      "await confirmDialog()",
    ].join('\n')
    expect(countViolations(src).nativeDialog).toBe(3)
  })
  it('counts emoji icons from the deny-list', () => {
    expect(countViolations("<span>📜</span><b>👍 👎</b>{'⧉ x'}🖱").emojiIcon).toBe(5)
  })
  it('does not count the sanctioned confirm() primitive when imported from components/ui', () => {
    const src = [
      "import { confirm } from '../components/ui'",
      "await confirm({title:'x'})",
    ].join('\n')
    expect(countViolations(src).nativeDialog).toBe(0)
  })
  it('still counts window.confirm alongside an imported confirm() primitive', () => {
    const src = [
      "import { confirm } from '../components/ui'",
      "await confirm({title:'x'})",
      "window.confirm('y')",
    ].join('\n')
    expect(countViolations(src).nativeDialog).toBe(1)
  })
})
