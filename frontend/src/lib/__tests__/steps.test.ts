import { describe, it, expect } from 'vitest'
import { toSteps, touchedFiles, conclusion, stepCount } from '../steps'
import type { Block, TurnGroup } from '../transcript'

const tu = (name: string, summary?: string, input?: unknown): Block => ({ type: 'tool_use', name, summary, input })
const tr = (name: string, text: string): Block => ({ type: 'tool_result', name, text })
const tx = (text: string): Block => ({ type: 'text', text })
const th = (text: string): Block => ({ type: 'thinking', text })
const grp = (blocks: Block[], complete = true): TurnGroup => ({
  turnId: 1, userPrompts: [], blocks, complete,
  assistantText() { return this.blocks.filter(b => b.type === 'text').map(b => b.text ?? '').join('') },
})

describe('toSteps', () => {
  it('Claude: no results — a tool step closes when the next step starts', () => {
    const st = toSteps([tu('Read', 'a.ts'), tu('Edit', 'a.ts'), tx('done')], true)
    expect(st.map(s => [s.kind, s.name, s.status])).toEqual([
      ['tool', 'Read', 'done'], ['tool', 'Edit', 'done'], ['text', undefined, 'done'],
    ])
  })
  it('running turn: the last open tool step stays running', () => {
    const st = toSteps([tu('Read', 'a.ts'), tu('Bash', 'npm test')], false)
    expect(st.map(s => s.status)).toEqual(['done', 'running'])
  })
  it('Codex/Crew: a result pairs with the most recent unpaired same-name step', () => {
    const st = toSteps([tu('shell', 'ls'), tr('shell', 'a\nb'), tu('apply_patch', 'x.rs'), tr('apply_patch', 'ok')], true)
    expect(st).toHaveLength(2)
    expect(st[0].result).toBe('a\nb')
    expect(st[1].result).toBe('ok')
  })
  it('same-name consecutive calls pair in order', () => {
    const st = toSteps([tu('shell', 'one'), tu('shell', 'two'), tr('shell', 'R2')], true)
    expect(st[0].result).toBeUndefined()
    expect(st[1].result).toBe('R2')
  })
  it('merges consecutive thinking into one collapsed step with a count (replaces density)', () => {
    const st = toSteps([th('a'), th('b'), tu('Read'), th('c')], true)
    expect(st[0]).toMatchObject({ kind: 'thinking', count: 2, text: 'a\n\nb' })
    expect(st[2]).toMatchObject({ kind: 'thinking', count: 1 })
  })
  it('error block is an inline error step, approval keeps its id', () => {
    const st = toSteps([{ type: 'error', text: 'transient' }, { type: 'approval', name: 'rm', summary: 'why', approvalId: 'a1' }], false)
    expect(st[0]).toMatchObject({ kind: 'error', status: 'error', text: 'transient' })
    expect(st[1]).toMatchObject({ kind: 'approval', approvalId: 'a1', name: 'rm', summary: 'why' })
  })
  it('stepCount counts tools and approvals only', () => {
    expect(stepCount(toSteps([th('x'), tu('Read'), tx('y'), { type: 'approval', approvalId: 'a' }], true))).toBe(2)
  })
})

describe('touchedFiles', () => {
  it('Edit/Write/MultiEdit/NotebookEdit use input paths; dedupe keeps order', () => {
    const st = toSteps([
      tu('Edit', 'x', { file_path: '/r/src/a.ts' }), tu('Write', 'x', { file_path: '/r/src/b.ts' }),
      tu('MultiEdit', 'x', { file_path: '/r/src/a.ts' }), tu('NotebookEdit', 'x', { notebook_path: '/r/n.ipynb' }),
    ], true)
    expect(touchedFiles(st).map(f => f.path)).toEqual(['/r/src/a.ts', '/r/src/b.ts', '/r/n.ipynb'])
    expect(touchedFiles(st)[0].label).toBe('src/a.ts')
  })
  it('apply_patch splits its summary on ", " only (paths may contain spaces)', () => {
    const st = toSteps([tu('apply_patch', 'src/x.rs, docs/my notes.md')], true)
    expect(touchedFiles(st).map(f => f.path)).toEqual(['src/x.rs', 'docs/my notes.md'])
  })
  it('orphan tool_result (Codex try_send dropped the use) becomes its own done tool step', () => {
    const st = toSteps([tr('shell', 'out'), tx('ok')], true)
    expect(st.map(s => s.kind)).toEqual(['tool', 'text'])
    expect(st[0].result).toBe('out')
    expect(st[0].status).toBe('done')
  })
  it('other write-ish tools only when summary looks like a path', () => {
    const st = toSteps([tu('create_file', 'docs/a.md'), tu('str_replace', 'not a path here'), tu('Read', 'src/r.ts')], true)
    expect(touchedFiles(st).map(f => f.path)).toEqual(['docs/a.md'])
  })
})

describe('conclusion', () => {
  it('first paragraph of the last text step, capped at 600 chars', () => {
    expect(conclusion(grp([tx('early'), tu('Read'), tx('Fixed it.\n\nDetails follow')]))).toBe('Fixed it.')
    expect(conclusion(grp([tx('y'.repeat(900))])).length).toBe(600)
  })
  it('empty when there is no text', () => {
    expect(conclusion(grp([tu('Read')]))).toBe('')
  })
})
