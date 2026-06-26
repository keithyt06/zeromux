# Claude 成本校准 + 会话级累计 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修正 Claude per-turn 成本(CLI 报的是会话累计值,需差分还原本轮),并在会话头部展示正确的会话级累计(轮次/耗时/成本)。

**Architecture:** 在 Claude fan-out 任务内维护 `prev_cost` 局部变量做 cost 差分(tokens 已是单轮不动);用 `is_resumed` 布尔区分冷启动(首轮=total 本身)与 resume(首轮=0)。会话级累计在写路径 `record_run_metric` 单调累加三个新 Session 字段(避开 cap-50 滑动窗口),经已有 `GET /api/sessions/{id}/runs` 的响应附加给前端头部渲染。

**Tech Stack:** Rust/Axum 后端(`cargo test` 内联 `#[cfg(test)]`),React 19 + Vite + Vitest 前端。

## Global Constraints

- 不破坏广播扇出不变量:fan-out 任务是会话进程唯一所有者,`prev_cost` 是 fan-out 局部变量(无锁)。
- 差分**仅 Claude**(`agent_label == "claude-code"`);Kiro/Codex `cost_usd` 恒 `None`,不动。
- tokens(`tokens_in/out`)**不做差分**(实证证实单轮)。
- lifetime 累加**统一在 `record_run_metric` 一个点**,不复用 `turns_completed`。
- 实证证据(spec §2):`total_cost_usd` 累计,`usage.*` 单轮。
- 后端测试:`cargo test`;前端测试:`cd frontend && npm test`。
- 提交信息体尾部加:`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## File Structure

- `src/run_metrics.rs` — 新增纯函数 `diff_cost(prev, cur, is_first, is_resumed) -> (Option<f64>, Option<f64>)`(返回 `(本轮增量, 新的prev)`);新增 `SessionLifetime` 结构体。
- `src/session_manager.rs` — Session 加三字段;`record_run_metric` 累加;`runs_for_session` 返回 lifetime;`spawn_acp_fanout` 加 `is_resumed` 参数 + Claude 路径差分。
- `src/web.rs` — `GET /api/sessions/{id}/runs` 响应附加 `lifetime`。
- `frontend/src/components/AcpChatView.tsx` — 头部渲染会话级累计。
- `frontend/src/components/__tests__/` — 头部渲染测试。

---

### Task 1: cost 差分纯函数 + 单元测试

**Files:**
- Modify: `src/run_metrics.rs`(在 `duration_ms` 函数 `:84-87` 之后新增)
- Test: `src/run_metrics.rs`(文件末尾 `#[cfg(test)] mod tests`)

**Interfaces:**
- Produces: `pub fn diff_cost(prev: Option<f64>, cur: Option<f64>, is_first: bool, is_resumed: bool) -> (Option<f64>, Option<f64>)` — 返回 `(本轮增量cost, 更新后的prev)`。

**语义表**(spec §3.2/§3.3):
- `cur == None` → 返回 `(None, prev)`(本轮不计、prev 不推进)。
- `is_first && is_resumed`(resume 首轮)→ 返回 `(None, Some(cur))`(记 0/None、prev 设为该轮 total,避免误算历史额)。
- 其余(含 `is_first && !is_resumed` 冷启动首轮:此时 prev 由调用方初始化为 `Some(0.0)`)→ `delta = max(0.0, cur - prev.unwrap_or(0.0))`,返回 `(Some(delta), Some(cur))`。
- prev 为 None 且非 resume-首轮的兜底(理论不达,防御):视 prev=0.0。

- [ ] **Step 1: 写失败测试**

在 `src/run_metrics.rs` 末尾的测试模块内加入:

```rust
    #[test]
    fn diff_cost_normal_cumulative_sequence() {
        // 累计 0.01 → 0.03 → 0.06,增量应为 0.01 / 0.02 / 0.03
        let (d1, p1) = diff_cost(Some(0.0), Some(0.01), true, false);
        assert_eq!(d1, Some(0.01));
        let (d2, p2) = diff_cost(p1, Some(0.03), false, false);
        assert_eq!(d2, Some(0.02));
        let (d3, _p3) = diff_cost(p2, Some(0.06), false, false);
        assert_eq!(d3, Some(0.03));
    }

    #[test]
    fn diff_cost_cold_start_first_turn_keeps_full_value() {
        // 冷启动:prev 由调用方初始化为 Some(0.0),首轮增量 = total 本身
        let (d, p) = diff_cost(Some(0.0), Some(0.28), true, false);
        assert_eq!(d, Some(0.28));
        assert_eq!(p, Some(0.28));
    }

    #[test]
    fn diff_cost_resume_first_turn_records_zero() {
        // resume 首轮:prev=None,记 None,prev 设为该轮 total
        let (d, p) = diff_cost(None, Some(0.50), true, true);
        assert_eq!(d, None);
        assert_eq!(p, Some(0.50));
        // 下一轮正常差分
        let (d2, _) = diff_cost(p, Some(0.55), false, true);
        assert!((d2.unwrap() - 0.05).abs() < 1e-9);
    }

    #[test]
    fn diff_cost_none_does_not_advance_prev() {
        let (d, p) = diff_cost(Some(0.03), None, false, false);
        assert_eq!(d, None);
        assert_eq!(p, Some(0.03)); // 基线不变
        // 下一轮以旧基线差分
        let (d2, _) = diff_cost(p, Some(0.05), false, false);
        assert_eq!(d2, Some(0.02));
    }

    #[test]
    fn diff_cost_negative_clamped_to_zero() {
        let (d, p) = diff_cost(Some(0.10), Some(0.04), false, false);
        assert_eq!(d, Some(0.0));
        assert_eq!(p, Some(0.04)); // 仍推进基线
    }
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test --lib run_metrics::tests::diff_cost 2>&1 | tail -20`
Expected: 编译失败 `cannot find function diff_cost`。

- [ ] **Step 3: 实现 diff_cost**

在 `src/run_metrics.rs` 的 `duration_ms`(`:87`)之后插入:

```rust
/// 把 Claude CLI 的累计 `total_cost_usd` 差分成本轮增量。
/// 返回 `(本轮增量, 更新后的 prev)`。tokens 不走此函数(实证证实单轮)。
///
/// - `cur == None`：本轮不计成本,prev 不推进。
/// - resume 首轮(`is_first && is_resumed`,prev=None）：记 None,prev 设为 cur，
///   避免把 CLI 恢复的历史累计额误算成本轮花费。
/// - 冷启动首轮(`is_first && !is_resumed`)：调用方把 prev 初始化为 `Some(0.0)`，
///   故增量 = cur - 0 = cur 本身。
/// - 负差 clamp 到 0(对齐 `duration_ms` 的单调回拨保护）。
pub fn diff_cost(
    prev: Option<f64>,
    cur: Option<f64>,
    is_first: bool,
    is_resumed: bool,
) -> (Option<f64>, Option<f64>) {
    let Some(cur) = cur else {
        return (None, prev); // None：不计、不推进
    };
    if is_first && is_resumed {
        return (None, Some(cur)); // resume 首轮:不误算历史额
    }
    let base = prev.unwrap_or(0.0);
    let delta = (cur - base).max(0.0);
    (Some(delta), Some(cur))
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test --lib run_metrics::tests::diff_cost 2>&1 | tail -20`
Expected: 5 个测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/run_metrics.rs
git commit -m "feat(metrics): diff_cost pure fn — cumulative→per-turn cost

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Session 加 lifetime 字段 + record_run_metric 累加

**Files:**
- Modify: `src/session_manager.rs:207-237`(Session 结构体加三字段)
- Modify: `src/session_manager.rs:584-595`(`record_run_metric` 累加)
- Modify: 所有 `Session { ... }` 构造点(`:817、:924、:1187、:1290、:1749、:3140、:3323、:3594` 及测试)加三字段初值 0
- Test: `src/session_manager.rs`(`#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: 无(纯字段累加)。
- Produces: Session 字段 `lifetime_turns: u64`、`lifetime_duration_ms: i64`、`lifetime_cost_usd: f64`;`record_run_metric` 在入队时累加三者。

- [ ] **Step 1: 写失败测试**

在 `src/session_manager.rs` 测试模块加入(用已有的 `record_run_metric` + 一个构造 RunMetric 的辅助;参考 `:3364` 附近现有 RunMetric 构造):

```rust
    #[test]
    fn lifetime_accumulates_beyond_cap50() {
        let mgr = test_manager(); // 见现有测试辅助;若无则用 SessionManager::new_for_test 模式
        let sid = "s-life";
        insert_test_session(&mgr, sid, "owner1"); // 现有测试里插入会话的方式
        for i in 0..80u64 {
            let m = crate::run_metrics::RunMetric {
                run_id: format!("r{i}"), session_id: sid.into(), work_dir: "/w".into(),
                agent_type: "claude-code".into(), turn_seq: i, started_ms: 0, ended_ms: 100,
                duration_ms: 100, outcome: crate::run_metrics::RunOutcome::Completed,
                failure_kind: None, verdict: None,
                verdict_source: crate::run_metrics::VerdictSource::None,
                cost_usd: Some(0.01), tokens_in: None, tokens_out: None, input_snapshot_ref: None,
            };
            mgr.record_run_metric(sid, m);
        }
        let (lt, ld, lc) = mgr.session_lifetime(sid).unwrap();
        assert_eq!(lt, 80);                       // 不被 cap-50 截断
        assert_eq!(ld, 8000);                     // 80 × 100ms
        assert!((lc - 0.80).abs() < 1e-9);        // 80 × 0.01
    }

    #[test]
    fn lifetime_cost_skips_none_but_counts_turn() {
        let mgr = test_manager();
        let sid = "s-none";
        insert_test_session(&mgr, sid, "owner1");
        for c in [Some(0.05), None, Some(0.03)] {
            let m = crate::run_metrics::RunMetric {
                run_id: "r".into(), session_id: sid.into(), work_dir: "/w".into(),
                agent_type: "claude-code".into(), turn_seq: 0, started_ms: 0, ended_ms: 50,
                duration_ms: 50, outcome: crate::run_metrics::RunOutcome::Completed,
                failure_kind: None, verdict: None,
                verdict_source: crate::run_metrics::VerdictSource::None,
                cost_usd: c, tokens_in: None, tokens_out: None, input_snapshot_ref: None,
            };
            mgr.record_run_metric(sid, m);
        }
        let (lt, ld, lc) = mgr.session_lifetime(sid).unwrap();
        assert_eq!(lt, 3);                  // 含 None 那轮
        assert_eq!(ld, 150);                // 3 × 50
        assert!((lc - 0.08).abs() < 1e-9);  // 0.05 + 0.03,跳过 None
    }
```

> 实现 Step 前,先在测试里确认现有的会话构造/插入辅助名(grep `fn test_` 或 `SessionManager::` 构造)。若现有测试用别的方式插入会话,沿用之;`session_lifetime` 是本任务新增的读取辅助(Step 3）。

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test --lib lifetime_ 2>&1 | tail -20`
Expected: 编译失败 `no method named session_lifetime` / 字段不存在。

- [ ] **Step 3: 加字段 + 累加 + 读取辅助**

3a. Session 结构体(`:231` `run_metrics` 字段之后)加:

```rust
    /// 会话级单调累计(不受 run_metrics cap-50 截断;三维度同源,统一在
    /// record_run_metric 累加,含后台调度运行)。
    lifetime_turns: u64,
    lifetime_duration_ms: i64,
    lifetime_cost_usd: f64,
```

3b. 每个 `Session { ... }` 构造字面量(grep `run_metrics: VecDeque::new()` 找到全部)在 `run_metrics: ...` 之后加:

```rust
            lifetime_turns: 0,
            lifetime_duration_ms: 0,
            lifetime_cost_usd: 0.0,
```

3c. `record_run_metric`(`:587` 锁内 `if let Some(s)` 块,`push_back` 之后)加累加:

```rust
                s.lifetime_turns += 1;
                s.lifetime_duration_ms += m.duration_ms;
                s.lifetime_cost_usd += m.cost_usd.unwrap_or(0.0);
```

3d. 在 `runs_for_session` 之后加读取辅助(供测试与 Task 3 用):

```rust
    /// 会话级累计 (turns, duration_ms, cost_usd)。owner 校验留给调用方/上层端点。
    pub fn session_lifetime(&self, sid: &str) -> Option<(u64, i64, f64)> {
        let map = self.sessions.lock().unwrap();
        let s = map.get(sid)?;
        Some((s.lifetime_turns, s.lifetime_duration_ms, s.lifetime_cost_usd))
    }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test --lib lifetime_ 2>&1 | tail -20`
Expected: 2 个测试 PASS。再跑 `cargo build 2>&1 | tail -5` 确认所有构造点已补字段(无 `missing field` 错误)。

- [ ] **Step 5: 提交**

```bash
git add src/session_manager.rs
git commit -m "feat(metrics): session lifetime totals accumulate in write path

3 monotonic fields (turns/duration/cost), summed in record_run_metric so
they survive the cap-50 VecDeque truncation. Includes background runs.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: fan-out 接入 cost 差分(仅 Claude)+ is_resumed

**Files:**
- Modify: `src/session_manager.rs:845-857`(`spawn_acp_fanout` 调用处传 `is_resumed`)
- Modify: `src/session_manager.rs`(`spawn_acp_fanout` 函数签名 + fan-out 局部 `prev_cost` + Result 取值处差分)
- Modify: Kiro/Codex 调用 `spawn_acp_fanout`/对应 fanout 的处(若共用同一 fanout 则传 `false` 或各自 resume.is_some())

**Interfaces:**
- Consumes: `crate::run_metrics::diff_cost`(Task 1);`is_resumed: bool` 来自 spawn 时 `resume.is_some()`。
- Produces: Result 写入 `RunMetric.cost_usd` 的值从此是**本轮增量**(仅 Claude)。

> **核实前置**(实现者第一步必做):`grep -n "fn spawn_acp_fanout" src/session_manager.rs` 确认签名;`grep -n "spawn_acp_fanout(" src/session_manager.rs` 找全部调用点(Claude `:845`,可能还有 Kiro)。Codex 走 `spawn_codex_fanout`(独立函数)。确认 Claude 走哪个 fanout、agent_label 是 `"claude-code"`。

- [ ] **Step 1: 写失败测试**

差分核心已被 Task 1 的纯函数测试覆盖。本任务的接入正确性靠**真机验证**(spec §6 验证标准)+ 下面这个针对"差分只作用于 Claude"的守卫测试。在测试模块加:

```rust
    #[test]
    fn diff_cost_only_applies_to_claude_label() {
        // 文档化不变量:非 claude-code label 不调用 diff_cost(Kiro/Codex cost 恒 None)。
        // 这里断言纯函数对 None 输入的恒等行为,作为接入处的回归锚点。
        let (d, p) = crate::run_metrics::diff_cost(Some(0.0), None, true, false);
        assert_eq!(d, None);
        assert_eq!(p, Some(0.0));
    }
```

- [ ] **Step 2: 运行确认失败/通过基线**

Run: `cargo test --lib diff_cost_only_applies 2>&1 | tail -10`
Expected: PASS(纯函数已存在;此测试锚定接入语义,不应失败)。

- [ ] **Step 3: 接入差分**

3a. `spawn_acp_fanout` 函数签名加参数 `is_resumed: bool`(放在 `agent_label` 之后、`work_dir` 之前或末尾,与现有风格一致)。

3b. fan-out 局部变量区(`:1924` `run_started_ms` 附近)加:

```rust
        // ── cost 差分状态(仅 claude-code;见 cost-calibration spec)──
        // 冷启动:prev=Some(0.0)→首轮增量=total 本身;resume:prev=None→首轮记 0。
        let mut prev_cost: Option<f64> = if is_resumed { None } else { Some(0.0) };
        let mut first_cost_seen = false;
        let is_claude = agent_label == "claude-code";
```

3c. Result 取值处(`:2005-2008` `let (mc, mt_in, mt_out) = match &evt { AcpEvent::Result {...} => (*cost_usd, *tokens_in, *tokens_out), ... }`)改为:对 Claude 用 `diff_cost` 还原本轮 cost:

```rust
                                let (raw_cost, mt_in, mt_out) = match &evt {
                                    AcpEvent::Result { cost_usd, tokens_in, tokens_out, .. } => (*cost_usd, *tokens_in, *tokens_out),
                                    _ => (None, None, None),
                                };
                                let mc = if is_claude {
                                    let is_first = !first_cost_seen;
                                    let (delta, new_prev) = crate::run_metrics::diff_cost(prev_cost, raw_cost, is_first, is_resumed);
                                    // 推进基线:只要 raw_cost 非 None 就推进(含 Cancelled 但有值;spec §3.3)
                                    if raw_cost.is_some() { first_cost_seen = true; prev_cost = new_prev; }
                                    delta
                                } else {
                                    raw_cost // Kiro/Codex 恒 None,不动
                                };
```

> 注意:`mc` 在原码后续传入 `build_run_metric(... mc, mt_in, mt_out)`(`:2018`),变量名保持 `mc/mt_in/mt_out` 不变,下游无需改。

3d. 更新 Claude 的 `spawn_acp_fanout` 调用(`:845`)传 `resume.is_some()`:在调用参数表加一行(位置对应 Step 3a 签名)`resume.is_some(),`。若 Kiro 也走 `spawn_acp_fanout`,同样传其 `resume.is_some()`(Kiro is_claude=false,差分不触发,值无副作用但保持正确)。Codex 的 `spawn_codex_fanout` 若不共用此函数则不动。

- [ ] **Step 4: 运行测试 + 编译**

Run: `cargo test --lib 2>&1 | tail -15 && cargo build 2>&1 | tail -5`
Expected: 全部测试 PASS;编译无错(签名改动的所有调用点已更新)。

- [ ] **Step 5: 提交**

```bash
git add src/session_manager.rs
git commit -m "feat(metrics): wire per-turn cost diff into Claude fan-out

prev_cost local var diffs CLI cumulative total_cost_usd; is_resumed
distinguishes cold-start (first=total) vs resume (first=0). Claude-only;
tokens untouched (per-turn already). Advances baseline on any non-None
value incl. Cancelled (interrupt-resend).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: REST 端点附加 lifetime

**Files:**
- Modify: `src/web.rs:659-670`(`get_session_runs` 响应加 `lifetime`)
- Test: `src/web.rs`(若有 handler 测试)或靠 Task 2 的 `session_lifetime` 单元覆盖 + 手测

**Interfaces:**
- Consumes: `state.sessions.session_lifetime(&id)`(Task 2)。
- Produces: `GET /api/sessions/{id}/runs` 响应 JSON 增加 `"lifetime": { "turns", "duration_ms", "cost_usd" }`。

- [ ] **Step 1: 改 handler**

`get_session_runs`(`:659`)在已有 `runs_for_session` 之后、组装 JSON 前,读 lifetime 并附加。改 `Ok(Json(...))`:

```rust
    let (runs, stats) = state
        .sessions
        .runs_for_session(&id, &user.id, query.limit, query.before)
        .ok_or(StatusCode::NOT_FOUND)?;
    let (lt_turns, lt_dur, lt_cost) = state
        .sessions
        .session_lifetime(&id)
        .unwrap_or((0, 0, 0.0));
    Ok(Json(serde_json::json!({
        "runs": runs,
        "stats": stats,
        "lifetime": { "turns": lt_turns, "duration_ms": lt_dur, "cost_usd": lt_cost }
    })))
```

> owner 校验已由 `runs_for_session` 完成(它先返回 None→404)。`session_lifetime` 在其后调用,会话必存在且属调用者,`unwrap_or` 仅为类型兜底。

- [ ] **Step 2: 编译 + 现有端点测试**

Run: `cargo build 2>&1 | tail -5 && cargo test --lib 2>&1 | tail -10`
Expected: 编译通过;现有测试不回归。

- [ ] **Step 3: 手测端点形状(若有运行实例)**

实现者笔记:此端点 owner-scoped,手测需登录态;留待 Task 6 真机验证一并做。本步仅确认编译。

- [ ] **Step 4: 提交**

```bash
git add src/web.rs
git commit -m "feat(api): add session lifetime totals to GET /sessions/{id}/runs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: 前端会话头部渲染累计

**Files:**
- Modify: `frontend/src/components/AcpChatView.tsx`(头部展示;读已有 metrics fetch 的响应)
- Test: `frontend/src/components/__tests__/`(新增渲染测试,跟随现有测试风格)

**Interfaces:**
- Consumes: `GET /api/sessions/{id}/runs` 响应的 `lifetime: { turns, duration_ms, cost_usd }`(Task 4)。
- Produces: 头部显示 "总计 N 轮 · M 分 · $X"(非 Claude 会话 cost 显示 "—")。

> **核实前置**:`grep -n "runs\|stats\|metricsRefresh\|/runs" frontend/src/components/AcpChatView.tsx frontend/src/components/RunMetricsPanel.tsx` 确认现有 fetch `/api/sessions/{id}/runs` 的位置与响应解析方式;沿用同一 fetch(它已返回 stats,现在多了 lifetime)。确认 agentType 如何判断(props `agentType`)。复用 `RunMetricsPanel.tsx:149-156` 的非 Claude "—" 范式。

- [ ] **Step 1: 写失败测试**

在 `frontend/src/components/__tests__/` 新建 `acpHeaderLifetime.test.tsx`(或并入现有 AcpChatView 测试文件,跟随仓库测试组织):

```tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { SessionLifetimeBadge } from '../SessionLifetimeBadge'

describe('SessionLifetimeBadge', () => {
  it('renders turns, duration, cost for claude', () => {
    render(<SessionLifetimeBadge agentType="claude" lifetime={{ turns: 3, duration_ms: 125000, cost_usd: 0.42 }} />)
    expect(screen.getByText(/3\s*轮/)).toBeInTheDocument()
    expect(screen.getByText(/\$0\.42/)).toBeInTheDocument()
  })

  it('shows dash for non-claude cost', () => {
    render(<SessionLifetimeBadge agentType="codex" lifetime={{ turns: 2, duration_ms: 60000, cost_usd: 0 }} />)
    expect(screen.getByText(/2\s*轮/)).toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd frontend && npx vitest run src/components/__tests__/acpHeaderLifetime.test.tsx 2>&1 | tail -15`
Expected: FAIL — 找不到 `SessionLifetimeBadge`。

- [ ] **Step 3: 实现组件**

新建 `frontend/src/components/SessionLifetimeBadge.tsx`:

```tsx
type Lifetime = { turns: number; duration_ms: number; cost_usd: number }

function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}秒`
  const m = Math.floor(s / 60)
  return `${m}分`
}

export function SessionLifetimeBadge({ agentType, lifetime }: { agentType: string; lifetime: Lifetime }) {
  const isClaude = agentType === 'claude'
  return (
    <span className="text-xs text-zinc-400">
      总计 {lifetime.turns} 轮 · {fmtDur(lifetime.duration_ms)} ·{' '}
      {isClaude ? `$${lifetime.cost_usd.toFixed(2)}` : <span title="该后端不上报成本">—</span>}
    </span>
  )
}
```

- [ ] **Step 4: 接入 AcpChatView 头部**

在 `AcpChatView.tsx`:① import `SessionLifetimeBadge`;② 在已有 `/api/sessions/{id}/runs` fetch 的响应解析处,把 `lifetime`(默认 `{turns:0,duration_ms:0,cost_usd:0}`)存入 state;③ 在头部区域(SessionInfoBar 附近,跟随 `showMetrics` 风格)渲染 `<SessionLifetimeBadge agentType={agentType} lifetime={lifetime} />`。

> 具体接入行号由 Step 0 核实结果决定。保持与现有 `metricsRefresh`/header 渲染一致;debounce 刷新已有(`bumpMetrics`),lifetime 随同一 fetch 更新。

- [ ] **Step 5: 运行测试 + lint**

Run: `cd frontend && npx vitest run src/components/__tests__/acpHeaderLifetime.test.tsx 2>&1 | tail -10 && npm run lint 2>&1 | tail -10`
Expected: 组件测试 PASS;lint 无新错(既存 flaky/既存错忽略,新增代码须干净)。

- [ ] **Step 6: 提交**

```bash
git add frontend/src/components/SessionLifetimeBadge.tsx frontend/src/components/__tests__/acpHeaderLifetime.test.tsx frontend/src/components/AcpChatView.tsx
git commit -m "feat(ui): session lifetime badge in chat header (turns/duration/cost)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: 全量测试 + 真机验证

**Files:** 无代码改动(验证任务)。

- [ ] **Step 1: 后端全量**

Run: `cargo test 2>&1 | tail -15`
Expected: 全绿(含 Task 1/2/3 新增 + 既有)。

- [ ] **Step 2: 前端全量**

Run: `cd frontend && npm test 2>&1 | tail -15`
Expected: 全绿(KaTeX 既存 flaky 若出现,记录但非回归)。

- [ ] **Step 3: 真机验证(spec §6 验证标准)**

构建并本地起一个实例(或在 dev 环境),用一个 Claude 会话:
- 发 3 轮 prompt,确认头部"总花费" ≈ 三轮**真实增量之和**,且**不随轮次膨胀**(对比修复前每轮显示累计值)。
- 冷启动只发 1 轮的会话:总花费 ≈ 该轮真实成本(**非 0** — 验证 P1-B 冷启动修复)。
- 发 80+ 轮(或脚本灌)确认 `lifetime_turns` 不封顶 50(验证 P1-A)。
- Codex/Kiro 会话:头部 cost 显示 "—",轮次/耗时正常。

将验证结果(实际数字)记录到本计划末尾或 commit 信息。

- [ ] **Step 4: 标记完成**

无需提交(纯验证)。若发现偏差,回到对应 Task 修复并补测试。

---

## Self-Review

**1. Spec coverage:**
- spec §3.1 差分仅 cost 仅 Claude → Task 1(纯函数)+ Task 3(接入 is_claude 守卫)✅
- spec §3.2 is_resumed 冷启动/resume → Task 1 测试 2/3 + Task 3 prev_cost 初始化 ✅
- spec §3.3 None/负差/Cancelled 推进 → Task 1 测试 4/5 + Task 3 "raw_cost.is_some() 才推进" ✅
- spec §4.1 写路径累加避开 cap-50 → Task 2 `lifetime_accumulates_beyond_cap50` ✅
- spec §4.3 含后台运行 → Task 2 record_run_metric 无差别累加(注释写明)✅
- spec §4.4 零新端点 + 诚实 "—" → Task 4(附加 lifetime)+ Task 5(非 Claude "—")✅
- spec §6 测试 1-10 → Task 1(1-5)/Task 2(7,9)/Task 3(守卫)/Task 5(10)。测试 #6 Cancelled-推进:由 Task 3 的 "raw_cost.is_some() 才推进" 逻辑覆盖,纯函数 Task 1 已测负差/None 推进语义,接入处靠真机 §6 验证 interrupt-resend。测试 #8 含调度:Task 2 record_run_metric 无差别累加已覆盖(注释 §4.3)。✅

**2. Placeholder scan:** 无 TBD/TODO;每个改代码步均有完整代码块。Task 2/3/5 的"核实前置"是要求实现者先 grep 确认行号(因测试辅助名/接入行号依赖现有代码),非占位符——给出了确切 grep 命令。

**3. Type consistency:** `diff_cost(prev, cur, is_first, is_resumed) -> (Option<f64>, Option<f64>)` 在 Task 1 定义、Task 3 消费,签名一致;`session_lifetime(sid) -> Option<(u64,i64,f64)>` Task 2 定义、Task 4 消费一致;`lifetime` JSON 形状 Task 4 产出 `{turns,duration_ms,cost_usd}`、Task 5 消费一致;`SessionLifetimeBadge` props Task 5 内部一致。
