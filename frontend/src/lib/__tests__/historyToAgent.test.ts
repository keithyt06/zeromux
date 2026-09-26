import { describe, it, expect } from 'vitest'
import { historyPrompt, AGENT_MAX_BYTES } from '../historyToAgent'

describe('historyPrompt', () => {
  it('wraps output with context', () => {
    const p = historyPrompt({ name: 'api', workDir: '/w', text: 'error: boom' })
    expect(p).toContain('终端「api」（/w）')
    expect(p).toContain('```\nerror: boom\n```')
  })
  it('keeps only the tail under the byte cap, line-aligned', () => {
    const text = Array.from({ length: 20000 }, (_, i) => `line ${i}`).join('\n')
    const p = historyPrompt({ name: 'a', workDir: '/w', text })
    const body = p.split('```\n')[1].split('\n```')[0]
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(AGENT_MAX_BYTES)
    expect(body.endsWith('line 19999')).toBe(true)
    expect(body.startsWith('line ')).toBe(true)
    expect(p).toContain('（已截取最后')
  })
})
