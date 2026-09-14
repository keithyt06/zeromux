import { describe, it, expect, vi } from 'vitest'
import { coerceAgent } from '../quickTargets'
import { notifyQuickTargetsChanged, subscribeQuickTargets } from '../quickTargetsBus'

describe('coerceAgent', () => {
  it('接受当前四种 SessionType', () => {
    expect(coerceAgent('claude')).toBe('claude')
    expect(coerceAgent('codex')).toBe('codex')
    expect(coerceAgent('crew')).toBe('crew')
    expect(coerceAgent('tmux')).toBe('tmux')
  })

  it('空串 → null（note 行不参与 agent 校验）', () => {
    expect(coerceAgent('')).toBeNull()
  })

  it('null / undefined → null', () => {
    expect(coerceAgent(null)).toBeNull()
    expect(coerceAgent(undefined)).toBeNull()
  })

  it('未知字符串 → null，绝不把脏值发给后端', () => {
    // 某个 agent 类型日后被移除时，库里的旧行会留下已失效的字符串。
    expect(coerceAgent('gemini')).toBeNull()
    // 'kiro' 正是这个场景的实例：后端已换成 crew，库里 quick_targets 的历史
    // kiro 行必须收敛为 null（→ 让用户重选类型），不能原样发给 create_session。
    expect(coerceAgent('kiro')).toBeNull()
    expect(coerceAgent('CLAUDE')).toBeNull()   // 大小写敏感，不做宽松匹配
  })
})

describe('quickTargetsBus', () => {
  it('notify 触发所有订阅者', () => {
    const a = vi.fn()
    const b = vi.fn()
    const offA = subscribeQuickTargets(a)
    const offB = subscribeQuickTargets(b)
    notifyQuickTargetsChanged()
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    offA(); offB()
  })

  it('退订后不再收到通知（组件 unmount 后不能泄漏）', () => {
    const f = vi.fn()
    const off = subscribeQuickTargets(f)
    off()
    notifyQuickTargetsChanged()
    expect(f).not.toHaveBeenCalled()
  })

  it('无订阅者时 notify 不抛', () => {
    expect(() => notifyQuickTargetsChanged()).not.toThrow()
  })
})
