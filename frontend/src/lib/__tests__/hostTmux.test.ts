import { describe, it, expect } from 'vitest'
import { isOrphan, matchHostTmux } from '../hostTmux'

const h = (name: string, path = '/home/ubuntu') => ({ name, windows: 1, attached: 0, created: 0, path })

describe('hostTmux', () => {
  it('zmx- prefix marks zeromux leftovers', () => {
    expect(isOrphan(h('zmx-3f2a9c1e'))).toBe(true)
    expect(isOrphan(h('vscode-dev'))).toBe(false)
  })
  it('matches by name or path, case-insensitive; empty query → none', () => {
    const list = [h('vscode-dev', '/home/ubuntu/api'), h('build', '/srv/Web')]
    expect(matchHostTmux(list, 'VSC').map(x => x.name)).toEqual(['vscode-dev'])
    expect(matchHostTmux(list, 'web').map(x => x.name)).toEqual(['build'])
    expect(matchHostTmux(list, '  ')).toEqual([])
  })
})
