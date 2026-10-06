import { describe, it, expect } from 'vitest'
import { conventionPrompt, lastOwnPrompt } from '../conventionPrompt'
import { buildPromptWithAttachments } from '../attachments'

describe('conventionPrompt', () => {
  it('embeds the convention verbatim, untruncated, after the fixed instructions', () => {
    const long = '包管理一律用 pnpm，不要用 npm。'.repeat(40) + '\n第二行 `code` $x$'
    const p = conventionPrompt(long)
    expect(p.endsWith(`约定：${long}`)).toBe(true)
    expect(p).toContain('CLAUDE.md 的「## 约定(zeromux)」一节末尾')
    expect(p).toContain('AGENTS.md')
    expect(p).toContain('只追加，不改动其他内容')
    expect(p).toContain('完成后回复「已记录」和追加的原文')
  })
})

describe('lastOwnPrompt', () => {
  it('prefill skips peer messages and blank composer', () => {
    // Review Focus 5: the newest OWN non-blank prompt, never a peer's message.
    expect(lastOwnPrompt([
      { type: 'user_prompt', text: '用 pnpm' },
      { type: 'content_block', text: 'ok' },
      { type: 'user_prompt', text: '   ' },
      { type: 'peer_message', text: '来自别的会话', from_name: 'zmx-ai-abc' },
    ])).toBe('用 pnpm')
    expect(lastOwnPrompt([])).toBe('')
  })

  it('skips a previous 记为约定 template message', () => {
    expect(lastOwnPrompt([
      { type: 'user_prompt', text: '以后都用 pnpm' },
      { type: 'user_prompt', text: conventionPrompt('以后都用 pnpm') },
    ])).toBe('以后都用 pnpm')
  })

  it('strips the attachment block; attachment-only messages are skipped', () => {
    expect(lastOwnPrompt([
      { type: 'user_prompt', text: buildPromptWithAttachments('看下这个报错', ['a.png', 'log.txt']) },
    ])).toBe('看下这个报错')
    expect(lastOwnPrompt([
      { type: 'user_prompt', text: '更早的一条' },
      { type: 'user_prompt', text: buildPromptWithAttachments('', ['shot.png']) },
    ])).toBe('更早的一条')
  })
})
