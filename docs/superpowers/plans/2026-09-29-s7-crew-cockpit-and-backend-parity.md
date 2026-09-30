# S7 Crew 驾驶舱 + 后端 parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 定时任务先放行 Codex（S7-a），再补 worktree 逐会话隔离 / Codex tokens / 「7 天未唤醒」（S7-a2）；经门槛 T 人工判定后（S7-c），把 Crew 的巡检、子任务、目标、外部 slot 接入和 conductor 定时任务接进 ZeroMux（S7-d/e/f）。附录 A 串联为可选。

**Architecture:** 定时 run 的终结逻辑先从 Claude fan-out 抽成 `settle_scheduled_run` / `tee_scheduled_event`（逐行等价），再原样移植到 Codex（S7-a），最后移植到 Crew（S7-f）。每个后端都要用「五条路径」单测锁住「run 永不停在 running」。Crew 驾驶舱全部走新的只读代理模块 `src/crew_proxy.rs`：slot 列表和父子关系**只读** S6 `CrewWatch::snapshot()`，只有 `/api/spawn`、ledger、autonudge、monitors 会现拉 Gateway。新面板全部懒加载。

**Tech Stack:** Rust（axum 0.8、tokio full、rusqlite bundled、reqwest rustls、rmcp 1.7）；React 19 + Vite + Tailwind v4 + vitest/happy-dom；Kiro Crew 0.6.0 Gateway（只读，`~/.kiro/crew-venv/lib/python3.12/site-packages/kiro_crew/`）。

**Spec:** `docs/superpowers/specs/2026-09-29-s7-crew-cockpit-and-backend-parity-design.md`（v2）。前置接口：`2026-09-29-s5-feed-and-crew-probe-design.md` §0.2 U1–U5、§7、§8；`2026-09-29-s6-gate-review-dispatch-design.md` §2.2、§4.2（V19 `snapshot()`）、§8、§15。

**基线:** `main` @ `ae5fef7`（S4 已合入；S4 只改了 `frontend/` 里终端相关的文件，`src/` 与 `33c2236` 逐字相同）。下文 `file:line` 均在 `ae5fef7` 上核实过。S5/S6 合入后这些行号会漂移，所以每个改动都同时给出**锚点字符串**，执行时以锚点为准：`grep -n '<锚点>' <file>`。

---

## Global Constraints

- 持久化字段只用 S5 U1 的三列 `crew_mode`（`""|crew`）、`crew_agent`（如 `kirocrew-conductor`）、`crew_origin`（`zeromux|external`）。S7 **不新增** crew 相关列，也不用 `own` 这个取值。
- `owns_slot = crew_origin != "external"`（U2）。**禁止**用 `resume.is_none()` 推断。
- posture 持久化只走 S5 的 `persist_posture(sid)`（U3）；S7 新增的 `Posture.last_crew_meta` **只存内存**，不写库。
- 推送 payload 统一用 `payload_for(kind, name, sid, fk, body)` 五参数形式（U4）。
- 埋点 target 统一为 `zmx_usage`（U5），格式 `tracing::info!(target: "zmx_usage", "...")`。
- slot 数据的唯一写者是 S6 `crew_watch`。S7 只调用 `state.crew_watch.snapshot() -> Arc<SlotsSnapshot>`，字段以 S6 §4.2 为准（`gateway_ok`、`refreshed_ms`、`slots: Vec<SlotView>`，`SlotView{key,title,agent,mode,project,origin,created_by,running,orchestrating,subagents_running,queue_depth,needs_input,pending_approval,pending_approval_tool,last_message_head,last_activity_ts}`）。**不建** `SlotsCache`，也不另起轮询。
- secret、token 一律**每次现读 / 现 mint，绝不缓存**；错误串中不得出现 token、`mc_token_`、secret 值。所有到 Gateway 的 HTTP 客户端都设 `redirect(Policy::none())`。
- fan-out 独占进程：所有 client→process 的交互都经 `SessionInput`；`finalize_run` 只在 fan-out 内部调用。
- 门槛 T（spec §0.1）没过时，S7-d/e/f 与附录 A **一律不做**。② Codex、⑧、F6、7 天未唤醒不受 T 约束。
- 首屏 br 预算：S7 累计 < 2.4KB（CommandPalette「接入」< 1.5KB、FocusHeader 巡检徽章 < 0.6KB、7 天未唤醒 < 0.3KB）；`npm run build` 内含 `check-size.mjs dist 337920`。新面板必须放进 `lazyPanels.ts`。
- `frontend/src/__tests__/App.characterization.test.tsx` 不改，保持绿。
- 字号只用 `text-ui-*`，颜色只用语义 token，图标只用 lucide，**禁 emoji**，禁原生 `alert/confirm/prompt`；`npm run lint` 的 token 棘轮不得增加。
- 用户可见文案用中文，代码和注释用英文。
- 每个 Task 的门：`cargo test`、`cd frontend && npm test`、`npm run lint`、`npm run build` 全绿（纯后端 Task 可只跑 `cargo test`，但每期收尾的 Task 必须全跑）。
- 冒烟一律 `--data-dir "$(mktemp -d)"` + `--tmux-socket zmx-s7-smoke` + 端口 ≥ 18090。
- 部署只用 `./deploy.sh --build`，而且必须**先 commit + push，再 deploy**（在 zeromux 终端里运行时，deploy 会经 cgroup 逃逸，本终端掉线属于预期）。部署前 `find frontend/node_modules -maxdepth 3 -type l -lname '/tmp/*'` 必须输出为空。
- 测试不碰真实 Gateway，一律用 `src/mock_gateway.rs`（Task 16 建）。只有 spike 可以对本机 Gateway 做只读 GET。

## Review Focus

1. **启停一个旧任务，或编辑它，它的后端不能被悄悄改掉**：老任务的 `agent_type` 可能是库里遗留的 `'kiro'` 或 `''`，打开表单时下拉应显示 Claude，保存时发 `'claude'`，而不是把 `'kiro'` 原样发回去触发 400。测试在 Task 5 Step 1（`legacy agent_type opens as Claude`）。
2. **Codex 定时 run 进行中，用户在同一会话里点「中断」按钮**（`SessionInput::Interrupt`，不是队列模式打断）：run 必须落到终态（failed），不能停在 running；并且不发 `run_failed` 推送，因为 intent 是 Cancelled。测试在 Task 3 Step 1（`sched_interrupt_button_finalizes_run`）。
3. **Codex 进程在定时 run 中途崩溃**，panic 路径会连发 Error 和 Exit 两个边界：只 finalize 一次（failed/cli_error），第二个边界不能改写结果，`active_run_count` 归零。测试在 Task 3 Step 1（`sched_error_then_exit_finalizes_once`）。
4. **接入的外部 slot 在 Crew 侧被删掉之后，重启 ZeroMux 或重连**：不能回落去新建一个 slot（那等于凭空多出一个 Crew 会话），必须把会话标为 Ended，并提示「Crew 会话已不存在」。测试在 Task 23 Step 1（`external_resume_failure_never_creates_a_slot`）。
5. **Gateway 重启、secret 轮换之后，子任务 tab 和巡检徽章照常能用**：代理层每个请求都要现读 secret。测试在 Task 16 Step 1（`secret_is_reread_on_every_request`）。

---

## File Structure

| 文件 | 动作 | 职责 | 期 |
|---|---|---|---|
| `src/scheduled_tasks.rs` | Modify | `upsert_config` SET 加 `agent_type`；`last_woken_ms` 列、`mark_woken`、`gate_silent_days`、`gate_silent_for_owner`；附录 A 的串联字段与触发 | a / a2 / A |
| `src/web.rs` | Modify | `ScheduledTaskReq.agent_type`、`resolve_agent_type`；`CreateSessionReq.isolation` / `crew_attach`；`list_confirmations.gate_silent`；三个 Crew 代理路由 | a / a2 / d / e |
| `src/session_manager.rs` | Modify | `settle_scheduled_run`、`tee_scheduled_event`；Codex/Crew fan-out 移植；`create_codex_session_tagged`、`create_crew_session_tagged`；`scheduled_session_type` 放行；`scheduled_input_snapshot`、`replay_inputs`、`scheduled_goal`；`worktree_lock` 与 async worktree；`Posture.last_crew_meta`；`crew_binding` / `crew_slot_bindings` / `create_crew_attach_session`；外部会话的 resume 失败处理 | a / a2 / e / f |
| `src/acp/codex_process.rs` | Modify | `#[cfg(test)] test_handle()`；⑧ 的 `probe_codex_notifications`、`extract_codex_token_count`、tokens 与 ContextUsage | a / a2 |
| `src/acp/crew_process.rs` | Modify | `#[cfg(test)] test_handle()` | f |
| `src/crew_proxy.rs` | Create | Gateway 只读代理：`GwTarget`、`gw_get_secret`、`cookie_ctx`、`project_*` 纯函数与三个 handler | d / e |
| `src/mock_gateway.rs` | Create | `#[cfg(test)]` 的 axum mock Gateway：记录请求，按路由返回预设响应 | d |
| `src/main.rs` | Modify | `mod crew_proxy;`、`#[cfg(test)] mod mock_gateway;` | d |
| `Cargo.toml` | Modify | 附录 A 才加 `regex = "1"` | A |
| `frontend/src/lib/scheduledBackend.ts` | Create | 后端下拉选项、遗留值归一、图标映射 | a |
| `frontend/src/components/ScheduledTasksPanel.tsx` | Modify | 「后端」下拉、TaskRow 图标、conductor run 行副文字 | a / f |
| `frontend/src/lib/api/scheduler.ts` | Modify | `ScheduledTaskReq.agent_type`；`listConfirmations` 返回 `gate_silent` | a / a2 |
| `frontend/src/lib/api/sessions.ts` | Modify | `createSession` 第 6 参 `CreateOpts{isolation?, crewAttach?}` | a2 / e |
| `frontend/src/lib/api/crew.ts` | Create | `getCrewPatrol`、`getCrewTasks`、`listCrewSlots` | d / e |
| `frontend/src/lib/api.ts` | Modify | `export * from './api/crew'` | d |
| `frontend/src/lib/patrol.ts` | Create | `formatPatrol` | d |
| `frontend/src/components/shell/FocusHeader.tsx` | Modify | `PatrolBadge`；ctx 标题改为「后端提供」 | d / a2 |
| `frontend/src/lib/crewMeta.ts` | Create | `parseCrewMeta`、`alignTopics` | e |
| `frontend/src/components/crew/CrewTasksPanel.tsx` | Create | 子任务 tab（含目标卡与巡检行） | e |
| `frontend/src/components/shell/{ContextPanel.tsx,useShellState.ts,lazyPanels.ts}` | Modify | `'tasks'` tab 与懒加载注册；`create` 的 opts；外部 Crew 的关闭确认 | e |
| `frontend/src/lib/crewSlots.ts` | Create | `matchCrewSlots` | e |
| `frontend/src/components/shell/CommandPalette.tsx`、`AppShell.tsx` | Modify | ⌘K「接入 Crew 会话」 | e |
| `frontend/src/lib/closeSession.ts` | Modify | `closeCrewMessage` | e / f |
| `frontend/src/lib/gateSilent.ts` | Create | 7 天未唤醒的行文案 | a2 |
| `frontend/src/hooks/useAcpSocket.ts` | Modify | labelMap 加 `attached`、`crew_slot_gone` | e |
| `frontend/src/components/AcpChatView.tsx` | Modify | ctx 标题改为「后端提供」 | a2 |
| `frontend/src/components/RunMetricsPanel.tsx` | Modify | 所有后端都显示 tokens | a2 |

---

## 前置检查的通用写法

每一期开头都有一段「前置已上线」检查：一组 `grep`，每条都必须**命中**。任何一条没命中，就停下来回报「前置 X 未上线」，不要在 S7 里临时补 S5/S6 的接口。唯一的例外是 spec §0.1 明确允许的 `zmx_usage` 埋点补丁。

# S7-a：② 定时任务支持 Codex（单独一期）

**前提：** 无。与 S7-a2 没有代码依赖，可以并行开两个分支，但**合并与部署分开**。本期结束前必须经过 Task 6 的独立 reviewer。

### 前置已上线（S7-a 开工前执行）

S7-a 不依赖 S5/S6 的新接口，但 S5 F2 会改动 Claude 的 finalize 块（新增 `run_done` 推送，`payload_for` 改成五个参数）。Task 2 抽取时必须**原样**带上 S5 改过的内容，所以先确认 S5 F2 是否已经合入：

```bash
cd /home/ubuntu/s3-workspace/keith-space/github-search/ai/zeromux
git log --oneline -1
grep -n 'fn maybe_push_run_done' src/session_manager.rs      # 命中 = S5 F2 已合入
grep -n 'pub fn payload_for(kind: &str, name: &str, session_id: &str, fk: Option<&str>, body: Option<&str>)' src/push.rs
```

- 两条都命中：Task 2 用下面给出的「S5 已合入」版本。
- 两条都没命中：S5 F2 还没合入。**先等 S5-a 合入，再开 S7-a**，否则两边会在同一个块上冲突。
- 只命中一条：说明 S5 的状态不一致，停下来回报。

### Task 1: `upsert_config` 的 ON CONFLICT SET 加 `agent_type`

**Files:**
- Modify: `src/scheduled_tasks.rs:481`（锚点 `ON CONFLICT(id) DO UPDATE SET name=?3`）
- Test: `src/scheduled_tasks.rs` 的 `mod store_tests`（锚点 `fn config_roundtrip_and_owner_filter`）

**Interfaces:**
- Produces: `upsert_config` 在同一个 id 上再次 upsert 时会覆盖 `agent_type`。Task 4 依赖这一点。

- [ ] **Step 1: 写失败测试**

在 `mod store_tests` 里、`fn config_roundtrip_and_owner_filter` 之后追加：

```rust
    #[test]
    fn upsert_updates_agent_type_on_conflict() {
        // CTO M1: the ON CONFLICT SET list omitted agent_type, so switching a task
        // from claude to codex was silently dropped on every update.
        let (s, _dir) = store();
        let mut c = TaskConfig { id:"t1".into(), owner_id:"alice".into(), name:"daily".into(),
            trigger_type:"cron".into(), trigger_spec:"0 0 9 * * *".into(), tz:"Asia/Shanghai".into(),
            agent_type:"claude".into(), work_dir:"/tmp".into(), prompt:"review".into(),
            enabled:true, retention_n:20, created_ms:123, side_effects:false, max_runtime_min:None, idle_timeout_min:None };
        s.upsert_config(&c).unwrap();
        c.agent_type = "codex".into();
        s.upsert_config(&c).unwrap();
        assert_eq!(s.get_config("t1").unwrap().unwrap().agent_type, "codex");
    }
```

S6 T1 会给 `TaskConfig` 加上 `gate_cmd`、`gate_since_ms`，这两个字段带 `#[serde(default)]`，但结构体字面量仍然要写全。如果编译报缺字段，就在字面量末尾补 `gate_cmd: None, gate_since_ms: None`，这不改变测试语义。

- [ ] **Step 2: 确认测试失败**

Run: `cargo test upsert_updates_agent_type_on_conflict`
Expected: FAIL，`left: "claude"`、`right: "codex"`。

- [ ] **Step 3: 最小实现**

在 `src/scheduled_tasks.rs` 的 SET 列表里加 `agent_type=?7`。当前一行是：

```rust
             ON CONFLICT(id) DO UPDATE SET name=?3,trigger_spec=?5,work_dir=?8,prompt=?9,enabled=?10,retention_n=?11,side_effects=?13,max_runtime_min=?14,idle_timeout_min=?15",
```

改为：

```rust
             ON CONFLICT(id) DO UPDATE SET name=?3,trigger_spec=?5,agent_type=?7,work_dir=?8,prompt=?9,enabled=?10,retention_n=?11,side_effects=?13,max_runtime_min=?14,idle_timeout_min=?15",
```

如果 S6 已经在这行末尾追加了 `,gate_cmd=?16,gate_since_ms=?17`，保留它们，只插入 `agent_type=?7,`。`query_configs` 的 SELECT（`:497`，下标 6）已经包含 `agent_type`，不用改。

- [ ] **Step 4: 确认通过**

Run: `cargo test upsert_updates_agent_type_on_conflict && cargo test store_tests`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/scheduled_tasks.rs
git commit -m "fix(sched): upsert_config updates agent_type on conflict (S7-a, CTO M1)"
```

---

### Task 2: 抽出 `settle_scheduled_run` / `tee_scheduled_event`，以及快照与分派闭环

**Files:**
- Modify: `src/session_manager.rs`
  - Claude fan-out 的 tee 块：锚点 `// Tee to events.ndjson for the active scheduled run's turn.`（当前 `:2933-2940`）
  - finalize 块：锚点 `// Finalize a scheduled run exactly once, keyed`（当前 `:3005-3052`）
  - `trigger_run` 的快照块：锚点 `// run-record: snapshot the exact input at trigger time`（当前 `:1452-1464`）
  - `replay_run`：锚点 `pub async fn replay_run(`（当前 `:1512-1523`）
  - 新函数放在 `fn finalize_active_run_if_scheduled` 前面（当前 `:2597`）
- Test: `src/session_manager.rs` 的 `mod tests`（锚点 `fn scheduled_agent_type_maps_to_session_type`）

**Interfaces:**
- Produces（Task 3 与 Task 26 使用）：
  - `fn settle_scheduled_run(mgr: &Weak<SessionManager>, sid: &str, owner_id: &str, active_run_id: &mut Option<String>, evt: &AcpEvent, intent_aborted: bool)`
  - `fn tee_scheduled_event(active_run_id: &Option<String>, evt: &AcpEvent)`
  - `fn scheduled_input_snapshot(stype: SessionType, prompt: &str, work_dir: &str) -> String`
  - `fn replay_inputs(snapshot_json: &str) -> Result<(String, String, String), String>`，返回 `(prompt, work_dir, agent_type)`

这是一次**纯重构**，Claude 的行为必须逐字节不变。证明方法是：Claude 现有的所有测试**零修改**通过。

- [ ] **Step 1: 写闭环测试和源码 parity 守卫**

在 `mod tests` 里、`fn scheduled_agent_type_maps_to_session_type` 之后追加：

```rust
    #[test]
    fn snapshot_dispatch_closure_holds_for_every_released_backend() {
        // B2: replay re-runs scheduled_session_type on the snapshot's agent_type.
        // For every backend scheduled dispatch can produce, the Display written into
        // the snapshot must map back to the same backend, else a replay silently
        // switches backends. S7-f adds SessionType::Crew to this list.
        for t in [SessionType::Claude] {
            assert_eq!(scheduled_session_type(&t.to_string()), t, "{t} must round-trip");
            let snap = scheduled_input_snapshot(t, "p", "/w");
            let (prompt, wd, agent) = replay_inputs(&snap).unwrap();
            assert_eq!((prompt.as_str(), wd.as_str()), ("p", "/w"));
            assert_eq!(scheduled_session_type(&agent), t, "replay of a {t} run must stay {t}");
        }
    }

    #[test]
    fn replay_inputs_defaults_old_snapshots_to_claude() {
        let (_, wd, agent) = replay_inputs(r#"{"prompt":"x"}"#).unwrap();
        assert_eq!((wd.as_str(), agent.as_str()), (".", "claude"));
        assert!(replay_inputs("not json").is_err());
    }

    #[test]
    fn scheduled_run_helpers_are_called_by_every_released_fanout() {
        // Parity guard: each fan-out that runs scheduled tasks must tee + settle
        // through the shared helpers. S7-a: claude + codex (2). S7-f: + crew (3).
        let src = include_str!("session_manager.rs");
        let settle = src.matches(concat!("settle_scheduled_run(&mgr, &sid, &owner_id, ", "&mut active_run_id, &evt, intent_aborted);")).count();
        let tee = src.matches(concat!("tee_scheduled_event(", "&active_run_id, &evt);")).count();
        let preempt = src.matches(concat!("finalize_active_run_if_scheduled(&mgr, ", "&mut active_run_id, \"interrupted\");")).count();
        assert_eq!((settle, tee, preempt), (1, 1, 2), "claude only, until Task 3 ports codex");
    }
```

- [ ] **Step 2: 确认测试失败**

Run: `cargo test snapshot_dispatch_closure`
Expected: 编译失败，报 `cannot find function scheduled_input_snapshot` 和 `replay_inputs`。

- [ ] **Step 3: 新增 helper**

在 `fn finalize_active_run_if_scheduled` 前面插入下面的代码。其中 `settle_scheduled_run` 的函数体就是 Claude finalize 块**原样搬过来**的内容：`&evt` 改成 `evt`，`&sid` 改成 `sid`，`owner_id.clone()` 改成 `owner_id.to_string()`，`sid.clone()` 改成 `sid.to_string()`。下面是「S5 F2 已合入」时应有的内容。如果搬过来的原文和它有出入，以**原文**为准，并在 commit message 里记一笔。

```rust
/// Tee one event to the active scheduled run's `events.ndjson` (read back by
/// `run_output_tail`). Shared by every fan-out that runs scheduled tasks so the
/// confirmation queue shows the same evidence for each backend.
fn tee_scheduled_event(active_run_id: &Option<String>, evt: &AcpEvent) {
    if let Some(rid) = active_run_id {
        if let Ok(line) = serde_json::to_string(evt) {
            append_run_event(rid, &line);
        }
    }
}

/// Finalize a scheduled run exactly once at a settling boundary, keyed on
/// `active_run_id`, mapped by terminal event type. Extracted verbatim from
/// `spawn_acp_fanout` (S7-a) so Codex/Crew share it byte-for-byte: a fan-out that
/// never finalizes leaves the run `running`, which blocks auto-update forever
/// (`BlockedByScheduled` never forces through). `intent_aborted` = the settling
/// turn was Cancelled/Timeout (read from the FIFO front BEFORE `settle()`), which
/// suppresses the `run_failed` push (review 2026-08-12, F-RUNFAILED-INTENT).
fn settle_scheduled_run(
    mgr: &Weak<SessionManager>,
    sid: &str,
    owner_id: &str,
    active_run_id: &mut Option<String>,
    evt: &AcpEvent,
    intent_aborted: bool,
) {
    if let Some(rid) = active_run_id.take() {
        if let Some(m) = mgr.upgrade() {
            match evt {
                AcpEvent::Result { text, .. } => {
                    let verdict = crate::scheduled_tasks::extract_verdict(text);
                    m.finalize_run(&rid, "succeeded", verdict.as_deref(),
                        if verdict.is_some() { None } else { Some("no_verdict") });
                    maybe_push_run_done(mgr, sid, owner_id, verdict.as_deref());
                }
                AcpEvent::Error { .. } => {
                    m.finalize_run(&rid, "failed", None, Some("cli_error"));
                    if !intent_aborted {
                        if let Some(p2) = m.push_handle() {
                            let name = m.session_name(sid).unwrap_or_default();
                            let uid = owner_id.to_string();
                            let sid2 = sid.to_string();
                            tokio::spawn(async move {
                                p2.send_to_user(&uid, &crate::push::payload_for("run_failed", &name, &sid2, Some("cli_error"), None)).await;
                            });
                        }
                    }
                }
                AcpEvent::Exit { .. } => {
                    m.finalize_run(&rid, "failed", None, Some("cli_exited"));
                    if !intent_aborted {
                        if let Some(p2) = m.push_handle() {
                            let name = m.session_name(sid).unwrap_or_default();
                            let uid = owner_id.to_string();
                            let sid2 = sid.to_string();
                            tokio::spawn(async move {
                                p2.send_to_user(&uid, &crate::push::payload_for("run_failed", &name, &sid2, Some("cli_exited"), None)).await;
                            });
                        }
                    }
                }
                _ => { *active_run_id = Some(rid); } // not terminal, keep waiting
            }
        }
    }
}

/// The run-record input snapshot. `agent_type` records the DISPATCHED backend's
/// Display (not the task label) so a replay reproduces this run's backend even if
/// the task config changed since. Invariant (B2): for every backend
/// `scheduled_session_type` can return, `scheduled_session_type(&t.to_string()) == t`.
fn scheduled_input_snapshot(stype: SessionType, prompt: &str, work_dir: &str) -> String {
    serde_json::json!({
        "prompt": prompt,
        "work_dir": work_dir,
        "agent_type": stype.to_string(),
        "secrets": [],
    }).to_string()
}

/// Inverse of `scheduled_input_snapshot` for `replay_run`. Old snapshots without
/// `agent_type` default to "claude" (the only backend at the time).
fn replay_inputs(snapshot_json: &str) -> Result<(String, String, String), String> {
    let v: serde_json::Value = serde_json::from_str(snapshot_json)
        .map_err(|e| format!("bad snapshot: {e}"))?;
    Ok((
        v["prompt"].as_str().unwrap_or("").to_string(),
        v["work_dir"].as_str().unwrap_or(".").to_string(),
        v["agent_type"].as_str().unwrap_or("claude").to_string(),
    ))
}
```

- [ ] **Step 4: Claude fan-out 改为调用 helper**

(a) 把 tee 块

```rust
                            if let Some(rid) = &active_run_id {
                                if let Ok(line) = serde_json::to_string(&evt) {
                                    append_run_event(rid, &line);
                                }
                            }
```

替换为：

```rust
                            tee_scheduled_event(&active_run_id, &evt);
```

(b) 把从 `// Finalize a scheduled run exactly once, keyed` 到对应的 `if let Some(rid) = active_run_id.take() { … }` 结束的整个块（当前 `:3005-3052`）替换为：

```rust
                                // Finalize a scheduled run exactly once (shared helper, S7-a).
                                settle_scheduled_run(&mgr, &sid, &owner_id, &mut active_run_id, &evt, intent_aborted);
```

它上方的 `let intent_aborted = intent_suppresses_push(turn_starts.front_intent());` 保留原位。

(c) `trigger_run` 里的快照块改为：

```rust
        if let Some(store) = self.scheduled.lock().unwrap().clone() {
            let snap = scheduled_input_snapshot(scheduled_session_type(agent_type), &prompt, &canonical_str);
            let _ = store.set_input_snapshot(run_id, &snap);
        }
```

(d) `replay_run` 函数体改为：

```rust
        let (prompt, work_dir, agent_type) = replay_inputs(snapshot_json)?;
        self.trigger_run(new_run_id, name, &work_dir, owner_id, task_id, prompt, &agent_type).await
```

- [ ] **Step 5: 确认通过，且 Claude 的测试零修改**

Run: `cargo test snapshot_dispatch_closure replay_inputs_defaults scheduled_run_helpers && cargo test`
Expected: 全部 PASS。`git diff --stat -- src/session_manager.rs` 里 `mod tests` 以外的已有测试一行都没改。

- [ ] **Step 6: Commit**

```bash
git add src/session_manager.rs
git commit -m "refactor(sched): extract settle_scheduled_run/tee_scheduled_event + snapshot helpers (S7-a, no behavior change)"
```

---

### Task 3: Codex fan-out 移植 + `create_codex_session_tagged` + 放行 `"codex"`

**Files:**
- Modify: `src/acp/codex_process.rs`（在 `impl Drop for CodexProcess` 前面加 `#[cfg(test)]` 的测试句柄）
- Modify: `src/session_manager.rs`
  - `fn spawn_codex_fanout`（锚点 `fn spawn_codex_fanout(`，当前 `:4205`）
  - `pub async fn create_codex_session`（当前 `:1606`）
  - `fn scheduled_session_type`（当前 `:2639`）与它的文档注释（`:2610-2638`）
  - `trigger_run` 的 match（锚点 `let sid = match scheduled_session_type(agent_type)`，当前 `:1429`）
- Test: `src/session_manager.rs` 新模块 `mod sched_parity_tests`（追加到文件末尾），以及 `mod tests` 里的 `scheduled_agent_type_maps_to_session_type`

**Interfaces:**
- Consumes: Task 2 的 `settle_scheduled_run`、`tee_scheduled_event`。
- Produces:
  - `CodexProcess::test_handle() -> (CodexProcess, mpsc::Sender<AcpEvent>, TestCmds)`（仅 test）
  - `TestCmds::next(&mut self) -> Option<&'static str>`，取值 `"prompt" | "cancel" | "stop"`
  - `pub async fn create_codex_session_tagged(&self, name: String, work_dir: &str, cols: u16, rows: u16, owner_id: &str, source_task_id: Option<String>) -> Result<String, String>`
  - `scheduled_session_type("codex") == SessionType::Codex`

- [ ] **Step 1: 写失败测试（五条路径 × Codex，外加 Review Focus 2 和 3）**

先在 `src/acp/codex_process.rs` 的 `impl Drop for CodexProcess` 前面加测试句柄。它不启动任何进程：

```rust
/// Test-only handle: a CodexProcess with no child/rmcp, driven by the test. The
/// fan-out sees exactly the channel shape of a real process.
#[cfg(test)]
pub struct TestCmds(mpsc::Receiver<Cmd>);

#[cfg(test)]
impl TestCmds {
    pub async fn next(&mut self) -> Option<&'static str> {
        self.0.recv().await.map(|c| match c {
            Cmd::Prompt(_) => "prompt",
            Cmd::Cancel => "cancel",
            Cmd::Stop => "stop",
        })
    }
}

#[cfg(test)]
impl CodexProcess {
    pub fn test_handle() -> (Self, mpsc::Sender<AcpEvent>, TestCmds) {
        let (cmd_tx, cmd_rx) = mpsc::channel::<Cmd>(16);
        let (event_tx, event_rx) = mpsc::channel::<AcpEvent>(256);
        (Self { cmd_tx, event_rx }, event_tx, TestCmds(cmd_rx))
    }
}
```

然后在 `src/session_manager.rs` 末尾追加一个新模块：

```rust
#[cfg(test)]
mod sched_parity_tests {
    //! S7 §6.3 hard requirement: for every fan-out that runs scheduled tasks,
    //! a run can never stay `running` — Result / Error / Exit / Interrupt-preempt /
    //! collect-flush all end with `active_run_count() == 0`.
    use super::*;
    use crate::acp::process::AcpEvent;
    use std::time::Duration;

    pub(super) struct Home { _g: std::sync::MutexGuard<'static, ()>, prev: Option<String>, pub dir: tempfile::TempDir }
    impl Drop for Home {
        fn drop(&mut self) {
            match &self.prev { Some(h) => std::env::set_var("HOME", h), None => std::env::remove_var("HOME") }
        }
    }
    /// tee_scheduled_event writes under $HOME/.zeromux/runs — never the real HOME.
    pub(super) fn temp_home() -> Home {
        let g = HOME_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let prev = std::env::var("HOME").ok();
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", dir.path());
        Home { _g: g, prev, dir }
    }

    pub(super) fn mgr(data: &std::path::Path) -> Arc<SessionManager> {
        let events = Arc::new(crate::events::EventStore::open(data).unwrap());
        let store = Arc::new(crate::session_store::SessionStore::open(data).unwrap());
        let m = SessionManager::new(events, store, "claude".into(), "codex".into(), "off".into(),
            5476, "/nonexistent-crew".into(), "bash".into(), false,
            crate::tmux::TmuxCtl::new(Some("zmx-test-unused".into())));
        m.set_scheduled_store(Arc::new(crate::scheduled_tasks::ScheduledStore::open(data).unwrap()));
        m
    }

    pub(super) fn seed_run(m: &SessionManager, run_id: &str) {
        let store = m.scheduled.lock().unwrap().clone().unwrap();
        let run = crate::scheduled_tasks::TaskRun {
            id: run_id.into(), task_id: "t1".into(), scheduled_for_ms: 1, state: "claimed".into(),
            session_id: None, verdict: None, failure_kind: None, started_ms: Some(1), ended_ms: None,
            input_snapshot: None, confirm_status: None, replay_of: None,
        };
        store.claim_run(&run).unwrap();
        store.set_run_state(run_id, "running", Some("s1"), None, None, None).unwrap();
    }

    /// Poll until the run leaves claimed/running (fan-out runs on another task).
    pub(super) async fn wait_terminal(m: &SessionManager, run_id: &str) -> crate::scheduled_tasks::TaskRun {
        let store = m.scheduled.lock().unwrap().clone().unwrap();
        for _ in 0..200 {
            let r = store.runs_for_task("t1", 50).unwrap().into_iter().find(|r| r.id == run_id).unwrap();
            if r.state != "running" && r.state != "claimed" { return r; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("run {run_id} stayed running");
    }

    pub(super) fn count(m: &SessionManager) -> i64 {
        m.scheduled.lock().unwrap().clone().unwrap().active_run_count().unwrap()
    }

    pub(super) fn prompt(run: Option<&str>) -> SessionInput {
        SessionInput::Prompt { text: "goal".into(), run_id: run.map(String::from), client_id: None }
    }
    pub(super) fn result(text: &str) -> AcpEvent {
        AcpEvent::Result { text: text.into(), turn_id: 0, session_id: "th".into(), cost_usd: None, tokens_in: None, tokens_out: None }
    }

    /// Backends whose fan-out runs scheduled tasks. S7-f appends `B::Crew`.
    #[derive(Clone, Copy, Debug)]
    pub(super) enum B { Codex }
    pub(super) const RELEASED: &[B] = &[B::Codex];

    pub(super) enum Cmds { Codex(crate::acp::codex_process::TestCmds) }
    impl Cmds {
        pub(super) async fn next(&mut self) -> Option<&'static str> {
            match self { Cmds::Codex(c) => c.next().await }
        }
    }

    pub(super) struct H { pub m: Arc<SessionManager>, pub input: mpsc::Sender<SessionInput>, pub ev: mpsc::Sender<AcpEvent>, pub cmds: Cmds, _home: Home }

    pub(super) async fn harness(b: B) -> H {
        let home = temp_home();
        let m = mgr(home.dir.path());
        let (event_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        let (input, input_rx) = mpsc::channel::<SessionInput>(64);
        let (ev, cmds) = match b {
            B::Codex => {
                let (p, ev, c) = crate::acp::codex_process::CodexProcess::test_handle();
                spawn_codex_fanout("s1".into(), p, event_tx, input_rx, m.events.clone(), "codex",
                    "/tmp".into(), "o".into(), m.weak());
                (ev, Cmds::Codex(c))
            }
        };
        H { m, input, ev, cmds, _home: home }
    }

    #[tokio::test]
    async fn sched_result_finalizes_succeeded_with_verdict() {
        for &b in RELEASED {
            let mut h = harness(b).await;
            seed_run(&h.m, "r1");
            h.input.send(prompt(Some("r1"))).await.unwrap();
            assert_eq!(h.cmds.next().await, Some("prompt"));
            h.ev.send(result("done\n<<<VERDICT>>>2 issues<<<END>>>")).await.unwrap();
            let r = wait_terminal(&h.m, "r1").await;
            assert_eq!((r.state.as_str(), r.verdict.as_deref()), ("succeeded", Some("2 issues")));
            assert_eq!(count(&h.m), 0);
        }
    }

    #[tokio::test]
    async fn sched_error_then_exit_finalizes_once() {
        // Review Focus 3: the panic path emits Error then Exit (codex_process.rs).
        for &b in RELEASED {
            let mut h = harness(b).await;
            seed_run(&h.m, "r1");
            h.input.send(prompt(Some("r1"))).await.unwrap();
            assert_eq!(h.cmds.next().await, Some("prompt"));
            h.ev.send(AcpEvent::Error { message: "event loop panicked".into() }).await.unwrap();
            h.ev.send(AcpEvent::Exit { code: -1 }).await.unwrap();
            let r = wait_terminal(&h.m, "r1").await;
            tokio::time::sleep(Duration::from_millis(50)).await; // let the Exit boundary land
            let store = h.m.scheduled.lock().unwrap().clone().unwrap();
            let r2 = store.runs_for_task("t1", 5).unwrap().into_iter().find(|x| x.id == "r1").unwrap();
            assert_eq!((r.state.as_str(), r.failure_kind.as_deref()), ("failed", Some("cli_error")));
            assert_eq!(r2.failure_kind.as_deref(), Some("cli_error"), "second boundary must not rewrite");
            assert_eq!(count(&h.m), 0);
        }
    }

    #[tokio::test]
    async fn sched_exit_finalizes_cli_exited() {
        for &b in RELEASED {
            let mut h = harness(b).await;
            seed_run(&h.m, "r1");
            h.input.send(prompt(Some("r1"))).await.unwrap();
            assert_eq!(h.cmds.next().await, Some("prompt"));
            h.ev.send(AcpEvent::Exit { code: 0 }).await.unwrap();
            let r = wait_terminal(&h.m, "r1").await;
            assert_eq!((r.state.as_str(), r.failure_kind.as_deref()), ("failed", Some("cli_exited")));
            assert_eq!(count(&h.m), 0);
        }
    }

    #[tokio::test]
    async fn sched_queue_interrupt_preempt_finalizes_interrupted() {
        for &b in RELEASED {
            let mut h = harness(b).await;
            seed_run(&h.m, "r1");
            h.input.send(SessionInput::SetQueueMode(QueueMode::Interrupt)).await.unwrap();
            h.input.send(prompt(Some("r1"))).await.unwrap();
            assert_eq!(h.cmds.next().await, Some("prompt"));
            h.input.send(prompt(None)).await.unwrap(); // user prompt preempts the scheduled turn
            assert_eq!(h.cmds.next().await, Some("cancel"));
            let r = wait_terminal(&h.m, "r1").await;
            assert_eq!((r.state.as_str(), r.failure_kind.as_deref()), ("failed", Some("interrupted")));
            assert_eq!(count(&h.m), 0);
        }
    }

    #[tokio::test]
    async fn sched_interrupt_button_finalizes_run() {
        // Review Focus 2: the explicit 中断 button (SessionInput::Interrupt) on a
        // scheduled Codex turn: Codex answers with AcpEvent::Error("Codex turn
        // cancelled") → the boundary finalizes; intent=Cancelled suppresses run_failed.
        for &b in RELEASED {
            let mut h = harness(b).await;
            seed_run(&h.m, "r1");
            h.input.send(prompt(Some("r1"))).await.unwrap();
            assert_eq!(h.cmds.next().await, Some("prompt"));
            h.input.send(SessionInput::Interrupt).await.unwrap();
            assert_eq!(h.cmds.next().await, Some("cancel"));
            h.ev.send(AcpEvent::Error { message: "turn cancelled".into() }).await.unwrap();
            let r = wait_terminal(&h.m, "r1").await;
            assert_eq!(r.state, "failed");
            assert_eq!(count(&h.m), 0);
        }
    }

    #[tokio::test]
    async fn sched_collect_flush_after_scheduled_turn_does_not_touch_the_run() {
        for &b in RELEASED {
            let mut h = harness(b).await;
            seed_run(&h.m, "r1");
            h.input.send(prompt(Some("r1"))).await.unwrap();
            assert_eq!(h.cmds.next().await, Some("prompt"));
            h.input.send(prompt(None)).await.unwrap(); // collect: queued behind the scheduled turn
            tokio::time::sleep(Duration::from_millis(20)).await;
            h.ev.send(result("<<<VERDICT>>>first<<<END>>>")).await.unwrap();
            let r = wait_terminal(&h.m, "r1").await;
            assert_eq!(r.verdict.as_deref(), Some("first"));
            assert_eq!(h.cmds.next().await, Some("prompt"), "merged flush turn is sent");
            h.ev.send(result("<<<VERDICT>>>second<<<END>>>")).await.unwrap();
            tokio::time::sleep(Duration::from_millis(50)).await;
            let store = h.m.scheduled.lock().unwrap().clone().unwrap();
            let r2 = store.runs_for_task("t1", 5).unwrap().into_iter().find(|x| x.id == "r1").unwrap();
            assert_eq!(r2.verdict.as_deref(), Some("first"), "the flushed turn carries no run_id");
            assert_eq!(count(&h.m), 0);
        }
    }

    #[tokio::test]
    async fn sched_mid_turn_error_block_does_not_finalize() {
        // F-CODEX-1: a mid-turn error is a NON-boundary ContentBlock{error}.
        for &b in RELEASED {
            let mut h = harness(b).await;
            seed_run(&h.m, "r1");
            h.input.send(prompt(Some("r1"))).await.unwrap();
            assert_eq!(h.cmds.next().await, Some("prompt"));
            h.ev.send(AcpEvent::ContentBlock { block_type: std::borrow::Cow::Borrowed("error"), turn_id: 0,
                text: Some("Codex: transient".into()), name: None, input: None, streaming: Some(false), summary: None }).await.unwrap();
            tokio::time::sleep(Duration::from_millis(50)).await;
            assert_eq!(count(&h.m), 1, "still running after a mid-turn error block");
            h.ev.send(result("ok")).await.unwrap();
            let r = wait_terminal(&h.m, "r1").await;
            assert_eq!((r.state.as_str(), r.failure_kind.as_deref()), ("succeeded", Some("no_verdict")));
        }
    }

    #[tokio::test]
    async fn sched_scheduled_turn_tees_events_ndjson() {
        for &b in RELEASED {
            let mut h = harness(b).await;
            seed_run(&h.m, "r1");
            h.input.send(prompt(Some("r1"))).await.unwrap();
            assert_eq!(h.cmds.next().await, Some("prompt"));
            h.ev.send(result("hello tail")).await.unwrap();
            wait_terminal(&h.m, "r1").await;
            let tail = crate::scheduled_tasks::run_output_tail("r1", 10);
            assert!(tail.iter().any(|l| l.contains("hello tail")), "{tail:?}");
        }
    }

}
```

再把 `mod tests` 里 `scheduled_agent_type_maps_to_session_type` 的最后两条断言改掉：

```rust
        assert!(matches!(scheduled_session_type("crew"), SessionType::Claude));
        assert!(matches!(scheduled_session_type("codex"), SessionType::Claude));
```

改为：

```rust
        // S7-a: codex fan-out now finalizes runs (sched_parity_tests) → released.
        assert!(matches!(scheduled_session_type("codex"), SessionType::Codex));
        // Crew is NOT released until S7-f ports its fan-out.
        assert!(matches!(scheduled_session_type("crew"), SessionType::Claude));
        assert!(matches!(scheduled_session_type("crew-conductor"), SessionType::Claude));
```

同时把 Task 2 的两个测试更新到 S7-a 的目标状态：`snapshot_dispatch_closure_holds_for_every_released_backend` 的数组改成 `[SessionType::Claude, SessionType::Codex]`；`scheduled_run_helpers_are_called_by_every_released_fanout` 的期望改成 `(2, 2, 4)`，消息改成 `"claude + codex"`。

- [ ] **Step 2: 确认测试失败**

Run: `cargo test sched_parity_tests; cargo test scheduled_agent_type_maps snapshot_dispatch_closure scheduled_run_helpers`
Expected: `sched_result_finalizes…` 等用例 panic `run r1 stayed running`；映射断言失败；parity 守卫得到 `(1,1,2)`。

- [ ] **Step 3: 移植 Codex fan-out**

在 `fn spawn_codex_fanout` 里做以下六处改动：

(1) 状态声明：在 `let mut boundary_count: u64 = 0;` 下面加一行：

```rust
        let mut active_run_id: Option<String> = None;
```

(2) 在 `emit(&mgr, &sid, &event_tx, turn_seq, &evt);` 下面加一行：

```rust
                            tee_scheduled_event(&active_run_id, &evt);
```

(3) 边界块：把 `if boundary_count >= turn_seq {` 里 turn_done 推送的那段注释和两行代码

```rust
                                    // turn_done push (parity with spawn_acp_fanout — F4).
                                    // Codex runs no scheduled tasks, so every settling
                                    // turn here is interactive (no active_run_id gate needed).
```

改为下面这样。只替换这三行注释，并把 `let dur …` / `maybe_push_turn_done(…)` 两行包进 `if` 里：

```rust
                                    // turn_done push: interactive turns only (a scheduled
                                    // turn has active_run_id Some) — parity with spawn_acp_fanout.
                                    if active_run_id.is_none() {
                                        let dur = turn_starts.front().map(|s| now_millis() - s).unwrap_or(0);
                                        maybe_push_turn_done(&mgr, &sid, &owner_id, dur, turn_starts.front_intent());
                                    }
```

`maybe_mark_vault_dirty(&mgr, &work_dir);` 仍然留在 `if boundary_count >= turn_seq` 块里，不受这个门影响。

(4) 仍然在 `if is_boundary {` 块里、`let term = match &evt {` 前面插入：

```rust
                                let intent_aborted = intent_suppresses_push(turn_starts.front_intent());
                                settle_scheduled_run(&mgr, &sid, &owner_id, &mut active_run_id, &evt, intent_aborted);
```

这两行必须放在 `turn_starts.settle()` **之前**，因为 intent 要从 FIFO 队首读取。注意 Claude 的 finalize 不受 `boundary_count >= turn_seq` 限制，这里保持一致，也不加这个限制。

(5) 输入分支：

- `run_id.is_some()` 臂里，`queue.clear();` 下面加 `active_run_id = run_id.clone();`，并把注释 `// C3:调度 prompt 绕过 collect(codex 当前不跑调度,留此分支保持三 fanout 对称)` 改为 `// C3:调度 prompt 绕过 collect,自成干净 turn(S7-a 起 codex 跑调度)`。
- `QueueMode::Interrupt if local_running` 臂里，`queue.clear();` 下面加：

  ```rust
                                        finalize_active_run_if_scheduled(&mgr, &mut active_run_id, "interrupted");
  ```

- `QueueMode::Passthrough` 臂的第一行加：

  ```rust
                                        finalize_active_run_if_scheduled(&mgr, &mut active_run_id, "interrupted");
  ```

- collect 臂「真正空闲：立即发送」分支（`} else {` 后、`turn_seq += 1;` 前）加 `active_run_id = None;`。

(6) collect flush 分支：`let merged = queue.drain_merged();` 下面加 `active_run_id = None; // 合并 turn 永不携带 run_id(C3)`。

- [ ] **Step 4: tagged 构造与分派**

把 `pub async fn create_codex_session` 改名为 `create_codex_session_tagged`，签名改为：

```rust
    pub async fn create_codex_session_tagged(
        &self,
        name: String,
        work_dir: &str,
        cols: u16,
        rows: u16,
        owner_id: &str,
        source_task_id: Option<String>,
    ) -> Result<String, String> {
```

函数体里只改一处：`source_task_id: None,` 改为 `source_task_id,`。然后在它前面重新加一个薄包装，保留原签名（`web.rs:936` 的调用点不用动）：

```rust
    pub async fn create_codex_session(
        &self,
        name: String,
        _codex_path: &str,
        _codex_reasoning: &str,
        work_dir: &str,
        cols: u16,
        rows: u16,
        owner_id: &str,
    ) -> Result<String, String> {
        self.create_codex_session_tagged(name, work_dir, cols, rows, owner_id, None).await
    }
```

`scheduled_session_type` 改为：

```rust
fn scheduled_session_type(agent_type: &str) -> SessionType {
    match agent_type {
        // S7-a: spawn_codex_fanout finalizes runs (settle_scheduled_run) and gates
        // turn_done on active_run_id — see sched_parity_tests.
        "codex" => SessionType::Codex,
        // Crew is released in S7-f. Everything else keeps the Claude fallback.
        _ => SessionType::Claude,
    }
}
```

同时把文档注释里「**为什么 `"crew"` / `"codex"` 目前也回落 Claude**」这一段改写：第一句改为「**为什么 `"crew"` 目前也回落 Claude**」，并在列举 fan-out 的那句里删掉 `spawn_codex_fanout`，改成「`spawn_codex_fanout` 已于 S7-a 补齐（`settle_scheduled_run`），`spawn_crew_fanout` 仍缺」。

`trigger_run` 的 match 改为：

```rust
        let sid = match scheduled_session_type(agent_type) {
            SessionType::Claude
            // Unreachable until released (S7-f moves Crew out). Exhaustive on purpose:
            // releasing a backend without its own arm fails to compile.
            | SessionType::Crew
            | SessionType::Tmux => self
                .create_acp_session_tagged(name, &canonical_str, 80, 24, owner_id, Some(task_id.to_string()))
                .await?,
            SessionType::Codex => self
                .create_codex_session_tagged(name, &canonical_str, 80, 24, owner_id, Some(task_id.to_string()))
                .await?,
        };
```

- [ ] **Step 5: 确认通过**

Run: `cargo test sched_parity_tests && cargo test scheduled_agent_type_maps snapshot_dispatch_closure scheduled_run_helpers && cargo test`
Expected: 全部 PASS。其中 `every_fanout_marks_vault_dirty_next_to_turn_done_push` 仍然是 3。

- [ ] **Step 6: Commit**

```bash
git add src/session_manager.rs src/acp/codex_process.rs
git commit -m "feat(sched): Codex fan-out finalizes scheduled runs; release agent_type=codex (S7-a)"
```

---

### Task 4: API 接受 `agent_type`（缺省时保留原值）

**Files:**
- Modify: `src/web.rs`
  - `struct ScheduledTaskReq`（`:3388-3403`）
  - `create_scheduled`（`:3441`，锚点 `agent_type: "claude".into(),` 第一处）
  - `update_scheduled`（`:3484`，第二处）
- Test: `src/web.rs` 的 `mod path_safety_tests`（`:4102`）

**Interfaces:**
- Consumes: Task 1（SET 已包含 `agent_type`）。
- Produces: `fn resolve_agent_type(req: Option<&str>, existing: Option<&str>) -> Result<String, (StatusCode, String)>`，以及常量 `SCHEDULED_AGENT_TYPES: &[&str]`（S7-f 会往里加 `"crew-conductor"`）。

- [ ] **Step 1: 写失败测试**

在 `mod path_safety_tests` 末尾追加：

```rust
    #[test]
    fn resolve_agent_type_whitelist_and_preserve() {
        assert_eq!(resolve_agent_type(None, None).unwrap(), "claude", "create default");
        assert_eq!(resolve_agent_type(Some("codex"), None).unwrap(), "codex");
        // handleToggle PUTs without agent_type: keep the stored backend, else a
        // pause/resume silently turns a Codex task back into Claude.
        assert_eq!(resolve_agent_type(None, Some("codex")).unwrap(), "codex");
        assert_eq!(resolve_agent_type(Some("claude"), Some("codex")).unwrap(), "claude");
        assert_eq!(resolve_agent_type(Some("kiro"), None).unwrap_err().0, StatusCode::BAD_REQUEST);
        // "crew" is a snapshot value (replay path), never an API label.
        assert_eq!(resolve_agent_type(Some("crew"), None).unwrap_err().0, StatusCode::BAD_REQUEST);
        assert_eq!(resolve_agent_type(Some("crew-conductor"), None).unwrap_err().0, StatusCode::BAD_REQUEST,
            "not released until S7-f");
    }
```

- [ ] **Step 2: 确认测试失败**

Run: `cargo test resolve_agent_type_whitelist`
Expected: 编译失败，报 `cannot find function resolve_agent_type`。

- [ ] **Step 3: 实现**

`ScheduledTaskReq` 末尾（`idle_timeout_min` 后面）加：

```rust
    /// Scheduled backend label. None on update = keep the stored value (the
    /// frontend's enable-toggle PUT omits it). Whitelist: SCHEDULED_AGENT_TYPES.
    #[serde(default)]
    agent_type: Option<String>,
```

在 `fn default_retention` 后面加：

```rust
/// Backends a scheduled task may use. Each entry needs a fan-out that finalizes
/// runs (session_manager::sched_parity_tests). S7-f adds "crew-conductor".
const SCHEDULED_AGENT_TYPES: &[&str] = &["claude", "codex"];

fn resolve_agent_type(req: Option<&str>, existing: Option<&str>) -> Result<String, (StatusCode, String)> {
    match req {
        None => Ok(existing.unwrap_or("claude").to_string()),
        Some(a) if SCHEDULED_AGENT_TYPES.contains(&a) => Ok(a.to_string()),
        Some(a) => Err((StatusCode::BAD_REQUEST, format!("unsupported agent_type: {a}"))),
    }
}
```

`create_scheduled` 里，在 `validate_work_dir_under_home(&req.work_dir)?;` 下面加 `let agent_type = resolve_agent_type(req.agent_type.as_deref(), None)?;`，并把字面量里的 `agent_type: "claude".into(),` 改成 `agent_type,`。

`update_scheduled` 里，在 `validate_work_dir_under_home(&req.work_dir)?;` 下面加 `let agent_type = resolve_agent_type(req.agent_type.as_deref(), Some(&existing.agent_type))?;`，字面量同样改成 `agent_type,`。注意这一行要写在 `id: existing.id` 把 `existing` 部分 move 掉**之前**，也就是现在的位置。

- [ ] **Step 4: 确认通过**

Run: `cargo test resolve_agent_type_whitelist && cargo test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/web.rs
git commit -m "feat(api): scheduled tasks accept agent_type (claude|codex), update keeps stored value (S7-a)"
```

---

### Task 5: 前端「后端」下拉 + TaskRow 图标

**Files:**
- Create: `frontend/src/lib/scheduledBackend.ts`
- Modify: `frontend/src/lib/api/scheduler.ts`（`interface ScheduledTaskReq`，`:44-54`）
- Modify: `frontend/src/components/ScheduledTasksPanel.tsx`（`TaskRow` `:308-`；`TaskForm` `:386-`；表单「名称」块 `:462-465`；`submit` 的 body `:419-428`）
- Test: `frontend/src/lib/__tests__/scheduledBackend.test.ts`、`frontend/src/components/__tests__/ScheduledTasksPanel.backend.test.tsx`

**Interfaces:**
- Produces: `type ScheduledBackend = 'claude' | 'codex' | 'crew-conductor'`；`BACKEND_OPTIONS`；`normalizeBackend(a)`；`backendIconType(a): SessionType`。

- [ ] **Step 1: 写失败测试**

`frontend/src/lib/__tests__/scheduledBackend.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { normalizeBackend, backendIconType, BACKEND_OPTIONS } from '../scheduledBackend'

describe('scheduledBackend', () => {
  it('offers claude + codex', () => {
    expect(BACKEND_OPTIONS.map(o => o.value)).toEqual(['claude', 'codex'])
  })
  it('legacy / unknown values normalize to claude', () => {
    for (const v of ['kiro', '', null, undefined, 'crew']) expect(normalizeBackend(v)).toBe('claude')
    expect(normalizeBackend('codex')).toBe('codex')
  })
  it('icon type', () => {
    expect(backendIconType('codex')).toBe('codex')
    expect(backendIconType('crew-conductor')).toBe('crew')
    expect(backendIconType('kiro')).toBe('claude')
  })
})
```

`frontend/src/components/__tests__/ScheduledTasksPanel.backend.test.tsx`：

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { TaskForm } from '../ScheduledTasksPanel'
import * as api from '../../lib/api'

const base: api.ScheduledTask = {
  id: 't1', owner_id: 'u', name: '夜间任务', trigger_type: 'cron', trigger_spec: '0 0 9 * * *',
  tz: 'Asia/Shanghai', agent_type: 'claude', work_dir: '/w', prompt: 'p', enabled: true,
  retention_n: 20, created_ms: 1, side_effects: false, max_runtime_min: null, idle_timeout_min: null,
}

describe('TaskForm backend select', () => {
  afterEach(() => vi.restoreAllMocks())

  it('create sends the picked backend', async () => {
    const create = vi.spyOn(api, 'createScheduledTask').mockResolvedValue(base)
    render(<TaskForm task={null} onCancel={() => {}} onSaved={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('每日构建'), { target: { value: 'n' } })
    fireEvent.change(screen.getByPlaceholderText('/home/ubuntu/project'), { target: { value: '/w' } })
    fireEvent.change(screen.getByPlaceholderText('要执行的任务...'), { target: { value: 'p' } })
    fireEvent.change(screen.getByLabelText('后端'), { target: { value: 'codex' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(create).toHaveBeenCalled())
    expect(create.mock.calls[0][0].agent_type).toBe('codex')
  })

  it('legacy agent_type opens as Claude and saves claude (Review Focus 1)', async () => {
    const upd = vi.spyOn(api, 'updateScheduledTask').mockResolvedValue(base)
    render(<TaskForm task={{ ...base, agent_type: 'kiro' }} onCancel={() => {}} onSaved={() => {}} />)
    expect((screen.getByLabelText('后端') as HTMLSelectElement).value).toBe('claude')
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(upd).toHaveBeenCalled())
    expect(upd.mock.calls[0][1].agent_type).toBe('claude')
  })

  it('editing a codex task keeps codex', async () => {
    const upd = vi.spyOn(api, 'updateScheduledTask').mockResolvedValue(base)
    render(<TaskForm task={{ ...base, agent_type: 'codex' }} onCancel={() => {}} onSaved={() => {}} />)
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(upd).toHaveBeenCalled())
    expect(upd.mock.calls[0][1].agent_type).toBe('codex')
  })
})
```

- [ ] **Step 2: 确认失败**

Run: `cd frontend && npx vitest run src/lib/__tests__/scheduledBackend.test.ts src/components/__tests__/ScheduledTasksPanel.backend.test.tsx`
Expected: FAIL，报找不到模块 `../scheduledBackend`，并且找不到 label「后端」。

- [ ] **Step 3: 实现**

`frontend/src/lib/scheduledBackend.ts`：

```ts
import type { SessionType } from './api'

/** Scheduled-task backend labels (server whitelist: web.rs SCHEDULED_AGENT_TYPES). */
export type ScheduledBackend = 'claude' | 'codex' | 'crew-conductor'

export const BACKEND_OPTIONS: { value: ScheduledBackend; label: string }[] = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
]

/** Stored rows may carry legacy values ('kiro', ''): show and save them as Claude,
 *  never echo them back (the server would 400). */
export function normalizeBackend(a: string | null | undefined): ScheduledBackend {
  return BACKEND_OPTIONS.some(o => o.value === a) ? (a as ScheduledBackend) : 'claude'
}

export function backendIconType(a: string): SessionType {
  return a === 'codex' ? 'codex' : a === 'crew-conductor' ? 'crew' : 'claude'
}
```

`frontend/src/lib/api/scheduler.ts` 的 `ScheduledTaskReq` 末尾加一行 `agent_type?: string`。

`ScheduledTasksPanel.tsx`：

- import 区加：
  ```tsx
  import { TypeIcon } from './shell/TypeIcon'
  import { BACKEND_OPTIONS, normalizeBackend, backendIconType, type ScheduledBackend } from '../lib/scheduledBackend'
  ```
- `TaskRow` 名称行里，`{task.name}` 前面插入：
  ```tsx
            <TypeIcon type={backendIconType(task.agent_type)} size={12} className="shrink-0 text-[var(--fg-muted)]" />
  ```
- `TaskForm` 的 state 区，在 `const [enabled, …]` 下面加：
  ```tsx
    const [backend, setBackend] = useState<ScheduledBackend>(normalizeBackend(task?.agent_type))
  ```
- `submit` 的 body 在 `idle_timeout_min: idleTimeout,` 后面加 `agent_type: backend,`。
- 「名称」块后面插入：
  ```tsx
      <div>
        <label className={labelCls}>后端</label>
        <select aria-label="后端" value={backend} onChange={e => setBackend(e.target.value as ScheduledBackend)} className={inputCls}>
          {BACKEND_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
  ```

`handleToggle` 不改。`ScheduledTasksPanel.toggle.test.tsx` 断言的是请求体里**不含** `agent_type`，必须原样通过。

- [ ] **Step 4: 确认通过**

Run: `cd frontend && npx vitest run src/lib/__tests__/scheduledBackend.test.ts src/components/__tests__/ScheduledTasksPanel.backend.test.tsx src/components/__tests__/ScheduledTasksPanel.toggle.test.tsx && npm test && npm run lint && npm run build`
Expected: 全绿；首屏体积不变（ScheduledTasksPanel 是懒加载的）。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/scheduledBackend.ts frontend/src/lib/__tests__/scheduledBackend.test.ts frontend/src/lib/api/scheduler.ts frontend/src/components/ScheduledTasksPanel.tsx frontend/src/components/__tests__/ScheduledTasksPanel.backend.test.tsx
git commit -m "feat(ui): scheduled task backend select (Claude/Codex) + row icon (S7-a)"
```

---

### Task 6: 独立 reviewer：五条路径 × 三后端 parity 矩阵

**这是一个 review 步骤，不写代码。** 执行者派一个**全新的** reviewer subagent（不复用实现 Task 1–5 的上下文，用最强模型），把下面这段原文作为它的 prompt。只有 reviewer 给出「PASS」之后，才能进 Task 7。

````text
你是 ZeroMux S7-a 的独立 reviewer。仓库 /home/ubuntu/s3-workspace/keith-space/github-search/ai/zeromux，
分支上 S7-a 的提交是 main..HEAD（git log main..HEAD --oneline）。先读
docs/superpowers/specs/2026-09-29-s7-crew-cockpit-and-backend-parity-design.md §6.1–§6.4，
以及 CLAUDE.md 的「broadcast fan-out」一节。只读，不改代码。

逐格填下面这张矩阵。每一格都要给出**你亲自 Read 过的** src/session_manager.rs 行号，
以及覆盖它的测试名（没有测试就写「无」）。

| 路径 \ 后端 | Claude（spawn_acp_fanout） | Codex（spawn_codex_fanout） | Crew（spawn_crew_fanout） |
|---|---|---|---|
| ① Result 边界 → succeeded + verdict/no_verdict | | | 预期：不可达，trigger_run 仍分派到 Claude |
| ② Error 边界 → failed/cli_error；intent 为 Cancelled/Timeout 时不发 run_failed | | | 同上 |
| ③ Exit 边界 → failed/cli_exited；Error+Exit 双边界只 finalize 一次 | | | 同上 |
| ④ Interrupt 抢占（QueueMode::Interrupt 与 Passthrough 两个臂）→ finalize_active_run_if_scheduled("interrupted") | | | 同上 |
| ⑤ collect flush / 空闲直发 → active_run_id=None，合并 turn 不带 run_id | | | 同上 |

另外逐条核对：
1. turn_done 推送在 Claude 和 Codex 中都受 active_run_id.is_none() 门控；vault reconcile 不受这个门控。
2. settle_scheduled_run 的调用位置在 turn_starts.settle() 之前（intent 从 FIFO 队首读）。
3. tee_scheduled_event 在 emit 之后、边界判断之前，两个后端位置相同。
4. settle_scheduled_run 的函数体与抽取前 Claude 的原块逐字等价
   （git show <Task 2 的提交> -- src/session_manager.rs 对比）。
5. scheduled_session_type 只放行 "codex"；"crew"/"crew-conductor" 仍然回落 Claude；
   trigger_run 的 match 仍然是穷尽的（没有 `_` 臂）。
6. 快照↔分派闭环：scheduled_input_snapshot 写入的是分派后的 Display；replay_inputs→
   scheduled_session_type 对 Claude、Codex 都闭合。
7. web.rs 的 resolve_agent_type：update 缺省时保留原值；白名单不含 "crew"。
8. upsert_config 的 SET 包含 agent_type=?7。
9. 在 Codex fan-out 的 run_id 臂里，active_run_id 在 turn_starts.start 之前被赋值。
10. 有没有 Codex 路径会让一个 turn_starts 条目永远不被 settle（例如 send_prompt 失败而进程没死）？

运行：cargo test sched_parity_tests && cargo test && (cd frontend && npm test)

输出：填好的矩阵 + 10 条核对结论（每条 PASS/FAIL + 证据行号）+ 最终一行「PASS」或「FAIL: <原因>」。
不要写报告文件，直接回复。
````

- [ ] **Step 1:** 派出 reviewer。
- [ ] **Step 2:** 结果为 FAIL 时：每个 FAIL 项都要先写一个能复现的失败测试（加到 `mod sched_parity_tests`），再修，然后派一个**新的** reviewer 重审，直到 PASS。
- [ ] **Step 3:** 把 reviewer 的最终矩阵贴进下一个 commit 的 message 正文（Task 7）。

---

### Task 7: S7-a 验收 + 部署

- [ ] **Step 1: 全量门**

```bash
cargo test && (cd frontend && npm test && npm run lint && npm run build)
```

- [ ] **Step 2: 隔离冒烟（Codex 定时 run 的真实进程）**

```bash
D=$(mktemp -d); cargo build --release
./target/release/zeromux --port 18091 --password smoke --data-dir "$D" --tmux-socket zmx-s7-smoke --work-dir "$HOME" &
PID=$!; sleep 3
TOK=$(curl -s -X POST localhost:18091/auth/login -H 'content-type: application/json' -d '{"password":"smoke"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
TID=$(curl -s -X POST localhost:18091/api/scheduled-tasks -H "Authorization: Bearer $TOK" -H 'content-type: application/json' \
  -d "{\"name\":\"s7a\",\"schedule\":{\"kind\":\"cron\",\"expr\":\"0 0 3 * * *\"},\"work_dir\":\"$HOME\",\"prompt\":\"reply OK\",\"agent_type\":\"codex\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -s -X POST localhost:18091/api/scheduled-tasks/$TID/run -H "Authorization: Bearer $TOK"; sleep 90
curl -s localhost:18091/api/scheduled-tasks/$TID/runs -H "Authorization: Bearer $TOK"
kill $PID
```

Expected：run 的 `state` 为 `succeeded`；打开对应会话，类型是 codex。如果 `/auth/login` 的返回结构和上面假设的不一致，照 `src/web.rs` 里 `legacy_login` 的实际返回取 token。

- [ ] **Step 3: 提交矩阵，push，部署**

```bash
git commit --allow-empty -m "chore(S7-a): parity review PASS

<粘贴 Task 6 reviewer 的矩阵>"
git push origin HEAD
./deploy.sh --build
```

- [ ] **Step 4: 线上验证**：`curl -s https://zeromux.keithyu.cloud/api/scheduler/health` 返回 `healthy:true`。之后连续 7 天，每天执行一次 `journalctl -u zeromux --since today | grep -c BlockedByScheduled`，结果应该是 0，或者只出现在一个 run 的时长之内（spec §11.2 ② 的指标）。


---

# S7-a2：F6 逐会话隔离 + ⑧ 实测 + 7 天未唤醒

**前提：** F6 的前端开关依赖 S6 F6（批量派发）；7 天未唤醒依赖 S6 T1（预检）和 S5 F3（离开卡）。其余部分没有前提。与 S7-a 没有代码依赖。

### 前置已上线（S7-a2 开工前执行）

```bash
cd /home/ubuntu/s3-workspace/keith-space/github-search/ai/zeromux
grep -n 'gate_since_ms' src/scheduled_tasks.rs            # S6 T1：列 + TaskConfig 字段
grep -n 'fn spawn_gated_run' src/scheduled_tasks.rs        # S6 T1：Wake 分支所在函数
grep -n 'runBatch' frontend/src/components/shell/CommandPalette.tsx   # S6 F6 批量派发
grep -rn 'AwayCard' frontend/src/components/shell/AppShell.tsx frontend/src/components/shell/TriageList.tsx  # S5 F3
```

- Task 8、Task 10 不依赖上面任何一条，可以先做。
- Task 9 的前端部分需要第 3 条命中；Task 11、Task 12 需要第 1、2、4 条都命中。没命中的部分**跳过**，并在 Task 13 验收时标注「待 S6/S5 上线后补」，不要自己实现替代品。

### Task 8: `worktree_lock` 字段 + `spawn_blocking` 串行化（D10）

**Files:**
- Modify: `src/session_manager.rs`
  - `pub struct SessionManager`（锚点 `worktree_isolation: bool,` 字段，当前 `:366`）
  - `SessionManager::new`（当前 `:708-741`）
  - `create_acp_session_tagged`、`create_codex_session_tagged` 里的 `resolve_work_dir(work_dir, &id, self.worktree_isolation)` 及其 `map_err` 里的 `remove_worktree`（当前 `:1271-1282`、`:1617-1628`）
  - `remove_session` 的 worktree 清理（当前 `:1994-2000`）
  - 新函数放在 `fn resolve_work_dir` 后面（当前 `:506-527`）
- Test: `mod resolve_work_dir_tests`（当前 `:4546`）

**Interfaces:**
- Produces:
  - `async fn with_worktree_lock<T: Send + 'static>(lock: Arc<tokio::sync::Mutex<()>>, f: impl FnOnce() -> T + Send + 'static) -> T`
  - `async fn resolve_work_dir_async(lock: Arc<tokio::sync::Mutex<()>>, work_dir: String, session_id: String, isolation: bool) -> (PathBuf, Option<PathBuf>)`
  - `async fn remove_worktree_async(lock: Arc<tokio::sync::Mutex<()>>, repo_dir: PathBuf, wt_path: PathBuf)`

- [ ] **Step 1: 写失败测试**

在 `mod resolve_work_dir_tests` 里追加。先把模块头的 `use super::resolve_work_dir;` 改为 `use super::*;`：

```rust
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn worktree_ops_are_serialized() {
        // D10: every git worktree add/remove runs under one lock — 4 concurrent
        // callers' critical sections must not overlap.
        let lock = std::sync::Arc::new(tokio::sync::Mutex::new(()));
        let log = std::sync::Arc::new(std::sync::Mutex::new(Vec::<(std::time::Instant, std::time::Instant)>::new()));
        let mut hs = vec![];
        for _ in 0..4 {
            let (lock, log) = (lock.clone(), log.clone());
            hs.push(tokio::spawn(async move {
                with_worktree_lock(lock, move || {
                    let a = std::time::Instant::now();
                    std::thread::sleep(std::time::Duration::from_millis(80));
                    log.lock().unwrap().push((a, std::time::Instant::now()));
                }).await
            }));
        }
        for h in hs { h.await.unwrap(); }
        let mut v = log.lock().unwrap().clone();
        v.sort_by_key(|x| x.0);
        for w in v.windows(2) { assert!(w[0].1 <= w[1].0, "critical sections overlapped"); }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn worktree_op_does_not_block_the_runtime() {
        // The ~24s JuiceFS `git worktree add` must not freeze a tokio worker: on a
        // single-threaded runtime an interval keeps ticking during the blocking op.
        let lock = std::sync::Arc::new(tokio::sync::Mutex::new(()));
        let ticks = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
        let t2 = ticks.clone();
        let ticker = tokio::spawn(async move {
            let mut iv = tokio::time::interval(std::time::Duration::from_millis(20));
            loop { iv.tick().await; t2.fetch_add(1, std::sync::atomic::Ordering::Relaxed); }
        });
        with_worktree_lock(lock, || std::thread::sleep(std::time::Duration::from_millis(300))).await;
        ticker.abort();
        assert!(ticks.load(std::sync::atomic::Ordering::Relaxed) >= 8, "runtime was blocked");
    }

    #[tokio::test]
    async fn resolve_work_dir_async_creates_worktree_and_falls_back_off() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        git_init(path);
        for args in [vec!["config", "user.email", "t@t"], vec!["config", "user.name", "t"],
                     vec!["commit", "--allow-empty", "-q", "-m", "init"]] {
            assert!(std::process::Command::new("git").args(&args).current_dir(path).status().unwrap().success());
        }
        let lock = std::sync::Arc::new(tokio::sync::Mutex::new(()));
        let p = path.to_string_lossy().to_string();
        let (eff, wt) = resolve_work_dir_async(lock.clone(), p.clone(), "sidASYNC1".into(), true).await;
        let wt = wt.expect("worktree created");
        assert_eq!(eff, wt);
        let (eff2, wt2) = resolve_work_dir_async(lock.clone(), p.clone(), "sidASYNC2".into(), false).await;
        assert!(wt2.is_none());
        assert_eq!(eff2, std::path::PathBuf::from(&p));
        remove_worktree_async(lock, path.to_path_buf(), wt.clone()).await;
        assert!(!wt.exists(), "worktree removed");
    }

    #[tokio::test]
    async fn non_git_dir_with_isolation_uses_base_silently() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().to_string_lossy().to_string();
        let lock = std::sync::Arc::new(tokio::sync::Mutex::new(()));
        let (eff, wt) = resolve_work_dir_async(lock, p.clone(), "sidNOGIT".into(), true).await;
        assert!(wt.is_none());
        assert_eq!(eff, std::path::PathBuf::from(p));
    }
```

- [ ] **Step 2: 确认失败**

Run: `cargo test resolve_work_dir_tests`
Expected: 编译失败，报 `cannot find function with_worktree_lock` 等。

- [ ] **Step 3: 实现**

在 `fn resolve_work_dir` 后面插入：

```rust
/// Run a blocking git-worktree operation under the manager-wide worktree lock,
/// off the async workers (D10, CTO m6). `git worktree add` is ~24s on JuiceFS; a
/// sync call inside an async fn would pin a tokio worker for that long.
async fn with_worktree_lock<T: Send + 'static>(
    lock: Arc<tokio::sync::Mutex<()>>,
    f: impl FnOnce() -> T + Send + 'static,
) -> T {
    let _g = lock.lock().await;
    tokio::task::spawn_blocking(f).await.expect("worktree task panicked")
}

async fn resolve_work_dir_async(
    lock: Arc<tokio::sync::Mutex<()>>,
    work_dir: String,
    session_id: String,
    isolation: bool,
) -> (PathBuf, Option<PathBuf>) {
    if !isolation {
        return resolve_work_dir(&work_dir, &session_id, false); // no git call at all
    }
    with_worktree_lock(lock, move || resolve_work_dir(&work_dir, &session_id, true)).await
}

async fn remove_worktree_async(lock: Arc<tokio::sync::Mutex<()>>, repo_dir: PathBuf, wt_path: PathBuf) {
    with_worktree_lock(lock, move || remove_worktree(&repo_dir, &wt_path)).await
}
```

在 `SessionManager` 结构体的 `worktree_isolation: bool,` 下面加字段：

```rust
    /// Serializes every `git worktree add/remove` (D10). A field, not a static, so
    /// each test manager gets its own lock (CTO m6).
    worktree_lock: Arc<tokio::sync::Mutex<()>>,
```

在 `new()` 的结构体字面量里、`worktree_isolation,` 下面加 `worktree_lock: Arc::new(tokio::sync::Mutex::new(())),`。

两个 create 函数里，把

```rust
        let (effective_dir, worktree_path) = resolve_work_dir(work_dir, &id, self.worktree_isolation);
```

改为

```rust
        let (effective_dir, worktree_path) = resolve_work_dir_async(
            self.worktree_lock.clone(), work_dir.to_string(), id.clone(), self.worktree_isolation).await;
```

并把 `.map_err(|e| { if let Some(wt) = &worktree_path { let base = PathBuf::from(work_dir); remove_worktree(&base, wt); } e })?;` 改写为：

```rust
        let running = match self
            .spawn_claude(&id, &effective_dir.to_string_lossy(), owner_id, None, source_task_id.as_deref())
            .await
        {
            Ok(r) => r,
            Err(e) => {
                if let Some(wt) = worktree_path.clone() {
                    remove_worktree_async(self.worktree_lock.clone(), PathBuf::from(work_dir), wt).await;
                }
                return Err(e);
            }
        };
```

Codex 版本同理，只是把 `spawn_claude(…)` 换成 `spawn_codex(&id, &effective_dir.to_string_lossy(), owner_id, None)`。`create_crew_session` 固定传 false，不走 git，保持同步版本不动。

`remove_session` 里，把

```rust
            if let Some(wt_path) = &session.worktree_path {
                if let Some(worktrees_dir) = wt_path.parent() {
                    if let Some(repo_dir) = worktrees_dir.parent() {
                        remove_worktree(repo_dir, wt_path);
                    }
                }
            }
```

改为：

```rust
            if let Some(wt_path) = session.worktree_path.clone() {
                if let Some(repo_dir) = wt_path.parent().and_then(|p| p.parent()).map(|p| p.to_path_buf()) {
                    // remove_session is sync: hand the blocking git call to the runtime
                    // under the same lock; only a runtime-less caller (sync unit test)
                    // falls back to the inline call.
                    match tokio::runtime::Handle::try_current() {
                        Ok(h) => { h.spawn(remove_worktree_async(self.worktree_lock.clone(), repo_dir, wt_path)); }
                        Err(_) => remove_worktree(&repo_dir, &wt_path),
                    }
                }
            }
```

- [ ] **Step 4: 确认通过**

Run: `cargo test resolve_work_dir_tests && cargo test`
Expected: PASS。原有的 `isolation_off_skips_worktree_in_git_repo` 和 `isolation_on_creates_worktree_in_git_repo` 继续通过（同步版本保留）。

- [ ] **Step 5: Commit**

```bash
git add src/session_manager.rs
git commit -m "perf(worktree): serialize git worktree add/remove under a manager lock on spawn_blocking (S7-a2 F6, D10)"
```

---

### Task 9: 逐会话 `isolation` 选项（API + 批量派发复选框）

**Files:**
- Modify: `src/web.rs`（`struct CreateSessionReq` `:829-836`；`create_session` 的 Claude/Codex 臂 `:927-938`）
- Modify: `src/session_manager.rs`（`create_acp_session`、`create_acp_session_tagged`、`create_codex_session`、`create_codex_session_tagged` 加 `isolation: bool`；`trigger_run` 两个臂传 `self.worktree_isolation`）
- Modify: `frontend/src/lib/api/sessions.ts`（`createSession`，当前 `:69-76`）
- Modify: `frontend/src/components/shell/CommandPalette.tsx`（S6 `runBatch` 与批量预览）
- Test: `src/web.rs` 的 `mod path_safety_tests`；`frontend/src/lib/__tests__/createSession.test.ts`；S6 的 runBatch 测试文件（`grep -rln runBatch frontend/src --include=*.test.*`）

**Interfaces:**
- Produces:
  - `fn effective_isolation(req: Option<bool>, global: bool, stype: SessionType) -> bool`（web.rs）
  - `pub fn worktree_isolation(&self) -> bool`（SessionManager）
  - TS：`export interface CreateOpts { isolation?: boolean; crewAttach?: string }`；`createSession(type, name?, workDir?, tmuxTarget?, initialPrompt?, opts?: CreateOpts)`。Task 24 会使用 `crewAttach`。

- [ ] **Step 1: 写失败测试**

Rust（`mod path_safety_tests` 末尾）：

```rust
    #[test]
    fn effective_isolation_per_request_with_crew_forced_off() {
        use crate::session_manager::SessionType::*;
        assert!(!effective_isolation(None, false, Claude));
        assert!(effective_isolation(None, true, Claude), "None = global");
        assert!(effective_isolation(Some(true), false, Codex));
        assert!(!effective_isolation(Some(false), true, Claude));
        assert!(!effective_isolation(Some(true), true, Crew), "Crew cwd is Gateway-owned");
        assert!(!effective_isolation(Some(true), true, Tmux));
    }
```

TS（追加到 `frontend/src/lib/__tests__/createSession.test.ts`）。先 `sed -n 1,30p` 看一下该文件已有的 fetch mock 写法，下面这段按 `vi.spyOn(globalThis, 'fetch')` 的写法写。如果该文件用的是别的 mock 方式，照它的方式改写，断言不变：

```ts
import { createSession } from '../api'

describe('createSession opts', () => {
  it('sends isolation and crew_attach when given, null otherwise', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'x', name: 'n', type: 'claude' })))
    await createSession('claude', undefined, '/w', undefined, 'p', { isolation: true })
    expect(JSON.parse((f.mock.calls[0][1] as RequestInit).body as string)).toMatchObject({ isolation: true, crew_attach: null })
    await createSession('crew', undefined, undefined, undefined, undefined, { crewAttach: 'chat-1' })
    expect(JSON.parse((f.mock.calls[1][1] as RequestInit).body as string)).toMatchObject({ isolation: null, crew_attach: 'chat-1' })
    f.mockRestore()
  })
})
```

runBatch 测试（加到 S6 的 runBatch 测试文件里；`deps` / `opts` 的形状以 S6 §8.3 实际实现为准。下面按 `runBatch(items, deps, opts)`、`deps.createSession` 与 `api.createSession` 同签名来写）：

```ts
  it('isolation: passes {isolation:true} and skips the 200ms gap (waits for each create)', async () => {
    const createSession = vi.fn().mockResolvedValue({ id: 'n', name: 'n', type: 'claude' })
    const sleep = vi.fn().mockResolvedValue(undefined)
    await runBatch(
      [{ id: 'b1', type: 'claude', dir: '/w', prompt: 'p1' }, { id: 'b2', type: 'claude', dir: '/w', prompt: 'p2' }],
      { ...fakeDeps(), createSession, sleep },
      { isolation: true },
    )
    expect(createSession.mock.calls.map(c => c[5])).toEqual([{ isolation: true }, { isolation: true }])
    expect(sleep).not.toHaveBeenCalled()
  })
```

（`fakeDeps()` 用 S6 测试文件里已有的 fake 工厂；如果它叫别的名字，就用那个名字。）

- [ ] **Step 2: 确认失败**

Run: `cargo test effective_isolation_per_request; cd frontend && npx vitest run src/lib/__tests__/createSession.test.ts`
Expected: Rust 编译失败（找不到函数）；TS 断言失败（请求体里没有 `isolation` 字段）。

- [ ] **Step 3: 实现**

`src/session_manager.rs`：

- 加访问器（放在 `pub fn tmux(&self)` 后面）：

  ```rust
      pub fn worktree_isolation(&self) -> bool { self.worktree_isolation }
  ```

- `create_acp_session`、`create_acp_session_tagged`、`create_codex_session`、`create_codex_session_tagged` 的参数表末尾各加 `isolation: bool`。tagged 版本内部把 `self.worktree_isolation` 换成 `isolation`；包装函数把 `isolation` 透传下去。
- `trigger_run` 的 Claude 臂和 Codex 臂末尾传 `self.worktree_isolation`（定时 run 保持全局语义不变）。

`src/web.rs`：

- `CreateSessionReq` 加字段：

  ```rust
      /// Per-session worktree isolation (F6). None = server default. Ignored for crew/tmux.
      #[serde(default)]
      isolation: Option<bool>,
  ```

- 在 `pty_create_error_status` 前面加：

  ```rust
  fn effective_isolation(req: Option<bool>, global: bool, stype: crate::session_manager::SessionType) -> bool {
      use crate::session_manager::SessionType::*;
      match stype { Claude | Codex => req.unwrap_or(global), Crew | Tmux => false }
  }
  ```

- `create_session` 的 Claude 臂和 Codex 臂调用末尾各加参数 `effective_isolation(req.isolation, state.sessions.worktree_isolation(), req.session_type)`。

`frontend/src/lib/api/sessions.ts`：

```ts
export interface CreateOpts { isolation?: boolean; crewAttach?: string }

export async function createSession(type: SessionType, name?: string, workDir?: string, tmuxTarget?: string, initialPrompt?: string, opts?: CreateOpts): Promise<SessionInfo> {
  const res = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ type, name: name || null, work_dir: workDir || null, tmux_target: tmuxTarget || null, initial_prompt: initialPrompt || null,
      isolation: opts?.isolation ?? null, crew_attach: opts?.crewAttach ?? null }),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}
```

`CommandPalette.tsx`（S6 批量预览）：

- 预览区加一个 state `const [isolate, setIsolate] = useState(false)`，以及复选框：

  ```tsx
  <label className="flex items-center gap-2 text-ui-xs text-[var(--fg-muted)]">
    <input type="checkbox" checked={isolate} onChange={e => setIsolate(e.target.checked)} className="accent-[var(--accent)]" />
    每个会话独立 worktree(较慢,约 25s/个)
  </label>
  ```

- 提交时把 `{ isolation: isolate }` 作为 opts 传给 `runBatch`。`runBatch` 内部：`createSession(type, undefined, dir, undefined, prompt, opts.isolation ? { isolation: true } : undefined)`；只有 `!opts.isolation` 时才调用 `sleep(200)`。⌘K 的单个新建**不加**这个选项。

- [ ] **Step 4: 确认通过**

Run: `cargo test && cd frontend && npm test && npm run lint && npm run build`
Expected: 全绿。首屏增量 ≈ 0.1KB br，计入 S6 T8 的份额。

- [ ] **Step 5: Commit**

```bash
git add src/web.rs src/session_manager.rs frontend/src/lib/api/sessions.ts frontend/src/lib/__tests__/createSession.test.ts frontend/src/components/shell/CommandPalette.tsx
git add $(grep -rln runBatch frontend/src --include=*.test.*)
git commit -m "feat(F6): per-session worktree isolation option + batch-dispatch checkbox (S7-a2)"
```

---

### Task 10: ⑧ 实测 `probe_codex_notifications`（结果决定 S7-b 是否进行）

**Files:**
- Modify: `src/acp/codex_process.rs` 的 `mod tests`（加一个 `#[ignore]` 测试）
- Create（仅当实测通过）: `src/acp/fixtures/codex_token_count.json`

**Interfaces:**
- Produces: 判定结论（写进 spec 状态栏），以及实测通过时的夹具文件。Task 14 读这个夹具。

- [ ] **Step 1: 写探针**

在 `src/acp/codex_process.rs` 的 `mod tests` 末尾追加：

```rust
    /// ⑧ spike (spec §8.1). Real `codex mcp-server`; run manually:
    ///   cargo test probe_codex_notifications -- --ignored --nocapture
    /// Records every `codex/event` msg.type with its arrival time relative to the
    /// tools/call response, and prints each token_count notification verbatim.
    #[tokio::test]
    #[ignore]
    async fn probe_codex_notifications() {
        use rmcp::model::CallToolRequestParams;
        use std::sync::{Arc, Mutex};

        #[derive(Clone)]
        struct Probe { t0: std::time::Instant, log: Arc<Mutex<Vec<(u128, String, serde_json::Value)>>> }
        impl ClientHandler for Probe {
            fn on_custom_notification(&self, n: CustomNotification, _c: NotificationContext<RoleClient>)
                -> impl std::future::Future<Output = ()> + Send + '_ {
                let (t0, log) = (self.t0, self.log.clone());
                async move {
                    let ty = n.params.as_ref().and_then(|p| p.get("msg")).and_then(|m| m.get("type"))
                        .and_then(|v| v.as_str()).unwrap_or("?").to_string();
                    log.lock().unwrap().push((t0.elapsed().as_millis(), ty, n.params.clone().unwrap_or_default()));
                }
            }
        }

        let cwd = tempfile::tempdir().unwrap(); // isolated cwd — never a real repo
        let mut cmd = Command::new("codex");
        cmd.arg("mcp-server").current_dir(cwd.path());
        let probe = Probe { t0: std::time::Instant::now(), log: Arc::new(Mutex::new(vec![])) };
        let svc = probe.clone().serve(TokioChildProcess::new(cmd).unwrap()).await.unwrap();

        let mut thread: Option<String> = None;
        for (i, text) in ["reply OK", "list files"].iter().enumerate() {
            let (tool, args) = match &thread {
                None => ("codex", json!({"prompt": text, "cwd": cwd.path(), "sandbox": "danger-full-access", "approval-policy": "never"})),
                Some(t) => ("codex-reply", json!({"prompt": text, "threadId": t})),
            };
            let params = CallToolRequestParams::new(tool).with_arguments(args.as_object().cloned().unwrap());
            let resp = svc.peer().call_tool(params).await.unwrap();
            let at = probe.t0.elapsed().as_millis();
            let (tid, _) = parse_codex_tool_result(&resp);
            if tid.is_some() { thread = tid; }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await; // late notifications
            let log = probe.log.lock().unwrap().clone();
            let tc: Vec<_> = log.iter().filter(|(_, ty, _)| ty == "token_count").collect();
            println!("== turn {i}: response at {at}ms; {} notifications; token_count at {:?}",
                log.len(), tc.iter().map(|(ms, _, _)| *ms).collect::<Vec<_>>());
            for (_, _, p) in &tc { println!("TOKEN_COUNT {}", p); }
            probe.log.lock().unwrap().clear();
        }
    }
```

- [ ] **Step 2: 执行**

Run: `cargo test probe_codex_notifications -- --ignored --nocapture 2>&1 | tee /tmp/probe8.txt`

- [ ] **Step 3: 判定（逐条记录）**

- (a) 每一轮 `token_count at [...]` 都非空；
- (b) 至少有一条 `TOKEN_COUNT` 的 `msg.info` 非 null，并且包含 `total_token_usage.input_tokens` 和 `output_tokens`（本机 rollout 已确认这个结构：`info.{total_token_usage,last_token_usage,model_context_window}`）；
- (c) 每一轮至少有一条 token_count 的时间戳 ≤ `response at`。

**三条都满足**：选一条 `info` 非空的 `TOKEN_COUNT` 行，把其中的 `thread_id`、`id` 值替换成 `"t-redacted"`，写入 `src/acp/fixtures/codex_token_count.json`（内容是整个 `params` 对象）。S7-b（Task 14）可以进行。

**任意一条不满足**：⑧ 结项为「上游不推送」。在 spec 顶部状态行后面追加 `⑧：2026-MM-DD 实测未通过（<哪一条>），UI 维持「—」`。**删掉** Step 1 的探针测试，跳过 Task 14。**不要**去做读取 `~/.codex/sessions` rollout 文件的方案。

- [ ] **Step 4: Commit**

```bash
git add src/acp/codex_process.rs src/acp/fixtures/codex_token_count.json docs/superpowers/specs/2026-09-29-s7-crew-cockpit-and-backend-parity-design.md 2>/dev/null
git commit -m "spike(⑧): probe codex mcp-server token_count notifications — <通过|未通过>"
```

---

### Task 11: 7 天未唤醒：后端（`last_woken_ms` / `mark_woken` / `gate_silent`）

**Files:**
- Modify: `src/scheduled_tasks.rs`
  - `open()` 的 ALTER 列表（当前 `:448-455`，锚点 `"ALTER TABLE agent_task_runs ADD COLUMN replay_of TEXT",`）
  - `struct TaskConfig`（`:380-398`）
  - `query_configs`（`:495-506`）
  - S6 的 `fn spawn_gated_run` 里 Wake 分支的 `trigger_run(` 调用之前
- Modify: `src/web.rs` 的 `list_confirmations`（`:3658-3675`）
- Test: `src/scheduled_tasks.rs` 的 `mod store_tests`

**Interfaces:**
- Consumes: S6 T1 的 `TaskConfig.gate_cmd: Option<String>`、`gate_since_ms: Option<i64>`，以及 `query_configs` 里它们的下标 15、16。
- Produces:
  - `pub fn gate_silent_days(now_ms: i64, last_woken_ms: Option<i64>, gate_since_ms: Option<i64>) -> Option<i64>`
  - `pub fn mark_woken(&self, task_id: &str, now_ms: i64) -> Result<(), String>`
  - `pub fn gate_silent_for_owner(&self, owner: &str, now_ms: i64) -> Result<Vec<GateSilent>, String>`
  - `#[derive(Serialize)] pub struct GateSilent { pub task_id: String, pub name: String, pub days: i64 }`
  - HTTP：`GET /api/scheduled-tasks/confirmations` 的响应多一个字段 `gate_silent: [{task_id,name,days}]`

- [ ] **Step 1: 写失败测试（对应 spec §9b.5 的表格）**

`mod store_tests` 末尾追加：

```rust
    const DAY: i64 = 86_400_000;

    #[test]
    fn gate_silent_days_table() {
        let now = 100 * DAY;
        assert_eq!(gate_silent_days(now, None, Some(now - 8 * DAY)), Some(8));
        assert_eq!(gate_silent_days(now, Some(now - DAY), Some(now - 30 * DAY)), None, "woke yesterday");
        assert_eq!(gate_silent_days(now, Some(now - 30 * DAY), Some(now - 2 * DAY)), None, "gate edited 2d ago");
        assert_eq!(gate_silent_days(now, None, None), None);
        assert_eq!(gate_silent_days(now, Some(now - 7 * DAY), None), Some(7), "boundary is inclusive");
    }

    fn gated(id: &str, owner: &str, enabled: bool, gate: Option<&str>, since: Option<i64>) -> TaskConfig {
        TaskConfig { id: id.into(), owner_id: owner.into(), name: format!("n-{id}"), trigger_type: "cron".into(),
            trigger_spec: "0 0 * * * *".into(), tz: "Asia/Shanghai".into(), agent_type: "claude".into(),
            work_dir: "/tmp".into(), prompt: "p".into(), enabled, retention_n: 20, created_ms: 1,
            side_effects: false, max_runtime_min: None, idle_timeout_min: None,
            gate_cmd: gate.map(String::from), gate_since_ms: since, last_woken_ms: None }
    }

    #[test]
    fn gate_silent_for_owner_filters_disabled_ungated_and_other_owners() {
        let (s, _d) = store();
        let now = 100 * DAY;
        s.upsert_config(&gated("a", "alice", true, Some("exit 1"), Some(now - 9 * DAY))).unwrap();
        s.upsert_config(&gated("b", "alice", true, Some("exit 1"), Some(now - 8 * DAY))).unwrap();
        s.upsert_config(&gated("off", "alice", false, Some("exit 1"), Some(now - 9 * DAY))).unwrap();
        s.upsert_config(&gated("nogate", "alice", true, None, None)).unwrap();
        s.upsert_config(&gated("bob1", "bob", true, Some("exit 1"), Some(now - 9 * DAY))).unwrap();
        let v = s.gate_silent_for_owner("alice", now).unwrap();
        assert_eq!(v.iter().map(|g| (g.task_id.as_str(), g.days)).collect::<Vec<_>>(), vec![("a", 9), ("b", 8)], "days desc");
    }

    #[test]
    fn mark_woken_survives_upsert() {
        let (s, _d) = store();
        let c = gated("a", "alice", true, Some("exit 1"), Some(1));
        s.upsert_config(&c).unwrap();
        s.mark_woken("a", 5_000).unwrap();
        s.upsert_config(&TaskConfig { name: "edited".into(), ..c }).unwrap();
        assert_eq!(s.get_config("a").unwrap().unwrap().last_woken_ms, Some(5_000), "edit must not clear it");
    }

    #[test]
    fn mark_woken_only_on_gate_wake_path() {
        // Run-now and replay don't run the gate (S6 D2) and must not refresh it:
        // the reminder answers "is the gate broken?".
        let sched = include_str!("scheduled_tasks.rs");
        let sm = include_str!("session_manager.rs");
        let web = include_str!("web.rs");
        let needle = concat!(".mark_", "woken(&");
        assert_eq!(sched.matches(needle).count(), 1, "exactly the spawn_gated_run Wake branch");
        assert_eq!(sm.matches(needle).count() + web.matches(needle).count(), 0);
    }
```

（`mark_woken_survives_upsert` 里的调用写作 `s.mark_woken("a", …)`，不带 `&`，所以不会被 `mark_woken_only_on_gate_wake_path` 计入。）

- [ ] **Step 2: 确认失败**

Run: `cargo test gate_silent mark_woken`
Expected: 编译失败（缺少 `last_woken_ms` 字段和对应函数）。

- [ ] **Step 3: 实现**

- ALTER 列表末尾加：
  ```rust
              "ALTER TABLE agent_runs_config ADD COLUMN last_woken_ms INTEGER",
  ```
- `TaskConfig` 末尾加：
  ```rust
      /// Last time the shell gate decided Wake (S7 §9b). Written ONLY by mark_woken —
      /// never by upsert_config (INSERT/SET don't list it), so editing keeps it.
      #[serde(default)]
      pub last_woken_ms: Option<i64>,
  ```
- `query_configs`：SELECT 末尾（S6 的 `,gate_cmd,gate_since_ms` 之后）加 `,last_woken_ms`；取列处加 `last_woken_ms: r.get(17)?,`。如果 S6 的下标不是 15、16，这里就用「最后一个下标 + 1」。
- 所有现有测试和生产代码里的 `TaskConfig { … }` 字面量加 `last_woken_ms: None`（`cargo check` 会逐个指出；`web.rs` 的 create 写 `None`，update 写 `existing.last_woken_ms`）。
- 新增方法与纯函数（放在 `impl ScheduledStore` 里的 `get_config` 后面，以及 impl 外面）：

  ```rust
      pub fn mark_woken(&self, task_id: &str, now_ms: i64) -> Result<(), String> {
          let conn = self.conn.lock().unwrap();
          conn.execute("UPDATE agent_runs_config SET last_woken_ms=?2 WHERE id=?1", params![task_id, now_ms])
              .map_err(|e| e.to_string())?;
          Ok(())
      }

      pub fn gate_silent_for_owner(&self, owner: &str, now_ms: i64) -> Result<Vec<GateSilent>, String> {
          let mut v: Vec<GateSilent> = self.list_for_owner(owner)?.into_iter()
              .filter(|t| t.enabled && t.gate_cmd.is_some())
              .filter_map(|t| gate_silent_days(now_ms, t.last_woken_ms, t.gate_since_ms)
                  .map(|days| GateSilent { task_id: t.id, name: t.name, days }))
              .collect();
          v.sort_by(|a, b| b.days.cmp(&a.days));
          Ok(v)
      }
  ```

  ```rust
  #[derive(Debug, Clone, serde::Serialize)]
  pub struct GateSilent { pub task_id: String, pub name: String, pub days: i64 }

  /// Days since the gate last woke (or was last edited, whichever is later), when
  /// that is ≥ 7. Time-based, not run-count based: prune_runs trims to retention_n
  /// (default 20), so an hourly task has no 7-day run history (S6 D4).
  pub fn gate_silent_days(now_ms: i64, last_woken_ms: Option<i64>, gate_since_ms: Option<i64>) -> Option<i64> {
      const DAY: i64 = 86_400_000;
      let base = match (last_woken_ms, gate_since_ms) {
          (None, None) => return None,
          (a, b) => a.unwrap_or(i64::MIN).max(b.unwrap_or(i64::MIN)),
      };
      let d = (now_ms - base) / DAY;
      (d >= 7).then_some(d)
  }
  ```

- S6 `spawn_gated_run` 的 Wake 分支：在 V16 复核通过之后、`trigger_run(` 之前插入：
  ```rust
              let _ = s.mark_woken(&task.id, chrono::Utc::now().timestamp_millis());
  ```
  变量名 `s` / `task` 以 S6 实际代码为准，但写法必须保持 `.mark_woken(&`，否则 Step 1 的计数测试会失败。
- `web.rs` 的 `list_confirmations`，在 `Ok(Json(serde_json::json!({ "runs": runs, "count": count })))` 前面加：
  ```rust
      let gate_silent = state.scheduled_tasks
          .gate_silent_for_owner(&user.id, chrono::Utc::now().timestamp_millis())
          .unwrap_or_default();
  ```
  并把返回值改为 `serde_json::json!({ "runs": runs, "count": count, "gate_silent": gate_silent })`。

- [ ] **Step 4: 确认通过**

Run: `cargo test gate_silent mark_woken && cargo test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/scheduled_tasks.rs src/web.rs
git commit -m "feat(sched): last_woken_ms + gate_silent in confirmations (S7-a2 §9b)"
```

---

### Task 12: 7 天未唤醒：离开卡里的一行

**Files:**
- Create: `frontend/src/lib/gateSilent.ts`、`frontend/src/lib/__tests__/gateSilent.test.ts`
- Modify: `frontend/src/lib/api/scheduler.ts`（`listConfirmations`，当前 `:93-97`）
- Modify: `frontend/src/components/shell/useSessionsPoll.ts`（确认队列轮询，当前 `:75-88`）
- Modify: `frontend/src/components/shell/useShellState.ts`（`ShellState` 加 `gateSilent`）
- Modify: S5 的 `frontend/src/components/shell/AwayCard.tsx`
- Modify: `frontend/src/components/ScheduledTasksPanel.tsx`（新增 prop `initialEditId`）、`frontend/src/components/shell/AppShell.tsx`（`panel === 'scheduled'` 那行，当前 `:333`）

**Interfaces:**
- Produces: `export interface GateSilent { task_id: string; name: string; days: number }`；`gateSilentRow(items): { text: string; detail: string[] } | null`；`ShellState.gateSilent: GateSilent[]`；`ScheduledTasksPanel` 的 prop `initialEditId?: string`。

- [ ] **Step 1: 写失败测试**

```ts
// frontend/src/lib/__tests__/gateSilent.test.ts
import { describe, it, expect } from 'vitest'
import { gateSilentRow } from '../gateSilent'

describe('gateSilentRow', () => {
  it('none → null', () => { expect(gateSilentRow([])).toBeNull() })
  it('one → names the task', () => {
    expect(gateSilentRow([{ task_id: 'a', name: '夜间检查', days: 8 }])?.text).toBe('任务 夜间检查 已 8 天未唤醒,检查预检?')
  })
  it('several → one merged line, details expand (≤1 card row, PM m2)', () => {
    const r = gateSilentRow([{ task_id: 'a', name: 'A', days: 9 }, { task_id: 'b', name: 'B', days: 8 }, { task_id: 'c', name: 'C', days: 7 }])!
    expect(r.text).toBe('3 个预检任务 ≥7 天未唤醒')
    expect(r.detail).toEqual(['A · 9 天', 'B · 8 天', 'C · 7 天'])
  })
})
```

`AwayCard` 的测试（加到 S5 的 AwayCard 测试文件，用它已有的 render helper）：

```tsx
  it('gate-silent tasks take exactly one row and open the task editor', () => {
    const onOpenTask = vi.fn()
    renderCard({ gateSilent: [{ task_id: 'a', name: 'A', days: 9 }, { task_id: 'b', name: 'B', days: 8 }, { task_id: 'c', name: 'C', days: 7 }], onOpenTask })
    expect(screen.getAllByText(/预检任务/)).toHaveLength(1)
    fireEvent.click(screen.getByText('3 个预检任务 ≥7 天未唤醒'))
    fireEvent.click(screen.getByText('A · 9 天'))
    expect(onOpenTask).toHaveBeenCalledWith('a')
  })
```

- [ ] **Step 2: 确认失败**

Run: `cd frontend && npx vitest run src/lib/__tests__/gateSilent.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

```ts
// frontend/src/lib/gateSilent.ts
export interface GateSilent { task_id: string; name: string; days: number }

/** Away-card row for gated tasks that haven't woken in ≥7 days (S7 §9b.4). Always
 *  one row — several tasks merge — so it never crowds the 3-row card cap. */
export function gateSilentRow(items: GateSilent[]): { text: string; detail: string[] } | null {
  if (items.length === 0) return null
  const detail = items.map(g => `${g.name} · ${g.days} 天`)
  if (items.length === 1) return { text: `任务 ${items[0].name} 已 ${items[0].days} 天未唤醒,检查预检?`, detail }
  return { text: `${items.length} 个预检任务 ≥7 天未唤醒`, detail }
}
```

- `scheduler.ts`：`listConfirmations(): Promise<{ runs: TaskRun[]; count: number; gate_silent: GateSilent[] }>`，函数体改为：
  ```ts
  const j = await res.json(); return { ...j, gate_silent: j.gate_silent ?? [] }
  ```
  文件顶部加 `import type { GateSilent } from '../gateSilent'`，并 `export type { GateSilent }`。
- `useShellState.ts`：加 `const [gateSilent, setGateSilent] = useState<GateSilent[]>([])`，把它传进 `useSessionsPoll` 的选项对象（和 `setConfirmRuns` 放在一起），`ShellState` 类型与返回值里加 `gateSilent`。
- `useSessionsPoll.ts`：选项类型加 `setGateSilent: (g: GateSilent[]) => void`；轮询里 `if (!cancelled) ref.current.setConfirmRuns(r.runs)` 改为：
  ```ts
  if (!cancelled) { ref.current.setConfirmRuns(r.runs); ref.current.setGateSilent(r.gate_silent) }
  ```
- `AwayCard.tsx`（S5）：新增 props `gateSilent: GateSilent[]` 与 `onOpenTask(taskId: string): void`。在 S5 的条目列表里追加一项，优先级取最低一档（S5 §3.2 排序键中的「其他」）：它的 `text` 来自 `gateSilentRow(gateSilent)`，点击后展开 `detail`，每一条都可以点，点击调用 `onOpenTask(task_id)`。`StatusDot tone="muted"`。卡片的显示条件放宽为「`summarizeAway` 非 null **或** `gateSilent.length > 0`」。前提是 `zmx_left_ms` 已存在：首次打开时仍然不显示，这样 characterization 测试的 fixture 不受影响。
- `ScheduledTasksPanel.tsx`：`Props` 加 `initialEditId?: string`；`load()` 成功后加：
  ```ts
  if (initialEditId) { const t0 = data.find(x => x.id === initialEditId); if (t0) { setEditing(t0); setView('form') } }
  ```
  （只在第一次加载时生效：用 `useRef(false)` 记住已经处理过。）
- `AppShell.tsx`：加 `const [editTaskId, setEditTaskId] = useState<string | undefined>()`；AwayCard 的 `onOpenTask={id => { setEditTaskId(id); setPanel('scheduled') }}`；把 `:333` 那行改为 `<ScheduledTasksPanel open initialEditId={editTaskId} onClose={() => { setPanel(null); setEditTaskId(undefined) }} />`。

- [ ] **Step 4: 确认通过**

Run: `cd frontend && npx vitest run src/lib/__tests__/gateSilent.test.ts && npm test && npm run lint && npm run build`
Expected: 全绿，首屏增量 < 0.3KB br（记下 check-size 前后的数值）。

- [ ] **Step 5: Commit**

```bash
git add frontend/src
git commit -m "feat(ui): away-card row for gated tasks silent ≥7d (S7-a2 §9b)"
```

---

### Task 13: S7-a2 验收 + 部署

- [ ] **Step 1: 全量门**：`cargo test && (cd frontend && npm test && npm run lint && npm run build)`
- [ ] **Step 2: 7 天未唤醒冒烟**（隔离 data-dir）：

```bash
D=$(mktemp -d); ./target/release/zeromux --port 18092 --password smoke --data-dir "$D" --tmux-socket zmx-s7-smoke --work-dir "$HOME" &
PID=$!; sleep 3
TOK=smoke
curl -s -X POST localhost:18092/api/scheduled-tasks -H "Authorization: Bearer $TOK" -H 'content-type: application/json' \
  -d "{\"name\":\"gated\",\"schedule\":{\"kind\":\"cron\",\"expr\":\"0 0 3 * * *\"},\"work_dir\":\"$HOME\",\"prompt\":\"x\",\"gate_cmd\":\"exit 1\"}"
python3 - "$D/scheduled.db" <<'PY'
import sqlite3,sys,time; c=sqlite3.connect(sys.argv[1])
c.execute("UPDATE agent_runs_config SET gate_since_ms=?", (int(time.time()*1000)-8*86400000,)); c.commit()
PY
curl -s localhost:18092/api/scheduled-tasks/confirmations -H "Authorization: Bearer $TOK" | python3 -m json.tool | grep -A4 gate_silent
kill $PID
```

Expected：`gate_silent` 里有一条，`days` 为 8。然后在浏览器里打开 18092（先设置 `localStorage.zmx_left_ms` 为 1 小时前的时间戳），离开卡在 ≤30s 内出现该行；把 `gate_since_ms` 改回现在，这一行消失。

- [ ] **Step 3: F6 手测**：在批量派发里勾选隔离，派发 4 项；派发期间另一个终端里输入字符，延迟 < 200ms（spec §11.2 的 F6 指标）。
- [ ] **Step 4:** `git push origin HEAD && ./deploy.sh --build`，然后 `curl -s https://zeromux.keithyu.cloud/api/scheduler/health`。

---

# S7-b：⑧ Codex tokens / 上下文（仅当 Task 10 判定通过）

### Task 14: `extract_codex_token_count` + 每轮 tokens + `ContextUsage`

**前置：** `src/acp/fixtures/codex_token_count.json` 存在（Task 10 通过的产物）。如果不存在，**跳过本 Task**。

**Files:**
- Modify: `src/acp/codex_process.rs`
  - `enum Notify`（`:30-71`）
  - `on_custom_notification` 的 else-if 链（`:110-140`）
  - `run_event_loop`：内层 notify 臂（锚点 `Some(notify) = notify_rx.recv() => {` 的第一处）、外层 notify 臂，以及 `Ok(Ok(resp)) =>` 里的 `AcpEvent::Result { … tokens_in: None, tokens_out: None }`
- Modify: `frontend/src/lib/format.ts`、`frontend/src/components/RunMetricsPanel.tsx`（`RunRow`，当前 `:146-168`）、`frontend/src/components/shell/FocusHeader.tsx:47`、`frontend/src/components/AcpChatView.tsx:336`
- Test: `src/acp/codex_process.rs` 的 `mod tests`；`frontend/src/lib/__tests__/format.test.ts`

**Interfaces:**
- Produces:
  - `struct TokenCount { total_in: u64, total_out: u64, last_in: Option<u64>, window: Option<u64> }`
  - `fn extract_codex_token_count(n: &CustomNotification) -> Option<TokenCount>`
  - `fn turn_tokens(base: Option<(u64, u64)>, now: Option<(u64, u64)>) -> (Option<u64>, Option<u64>)`
  - TS：`formatTokens(n: number | null | undefined): string`

- [ ] **Step 1: 写失败测试**

```rust
    fn tc_notification(params: serde_json::Value) -> CustomNotification {
        CustomNotification::new("codex/event", Some(params))
    }

    #[test]
    fn token_count_fixture_parses() {
        let p: serde_json::Value = serde_json::from_str(include_str!("fixtures/codex_token_count.json")).unwrap();
        let tc = extract_codex_token_count(&tc_notification(p)).expect("fixture parses");
        assert!(tc.total_in > 0 && tc.window.unwrap_or(0) > 0);
    }

    #[test]
    fn token_count_null_info_or_missing_fields_is_none() {
        assert!(extract_codex_token_count(&tc_notification(json!({"msg":{"type":"token_count","info":null}}))).is_none());
        assert!(extract_codex_token_count(&tc_notification(json!({"msg":{"type":"token_count","info":{"total_token_usage":{}}}}))).is_none());
        assert!(extract_codex_token_count(&tc_notification(json!({"msg":{"type":"agent_message_content_delta","delta":"x"}}))).is_none());
    }

    #[test]
    fn turn_tokens_diff_and_saturate() {
        assert_eq!(turn_tokens(Some((100, 10)), Some((250, 40))), (Some(150), Some(30)));
        assert_eq!(turn_tokens(Some((500, 50)), Some((100, 10))), (Some(0), Some(0)), "total rewound (new thread)");
        assert_eq!(turn_tokens(None, Some((1, 1))), (None, None), "no baseline → unknown");
        assert_eq!(turn_tokens(Some((1, 1)), None), (None, None));
    }
```

`CustomNotification::new` 的签名以 rmcp 1.7 为准。如果构造方式不同，参照同一个 `mod tests` 里已有的 `extract_codex_event_delta` 测试是怎么构造通知的，照着写。

```ts
// append to frontend/src/lib/__tests__/format.test.ts
import { formatTokens } from '../format'
describe('formatTokens', () => {
  it('k-abbreviates', () => {
    expect(formatTokens(12_345)).toBe('12.3k'); expect(formatTokens(999)).toBe('999')
    expect(formatTokens(null)).toBe(''); expect(formatTokens(1_200)).toBe('1.2k')
  })
})
```

- [ ] **Step 2: 确认失败**

Run: `cargo test token_count turn_tokens; cd frontend && npx vitest run src/lib/__tests__/format.test.ts`
Expected: 编译失败 / FAIL。

- [ ] **Step 3: 实现**

`codex_process.rs`：

```rust
#[derive(Debug, Clone, Copy, PartialEq)]
struct TokenCount { total_in: u64, total_out: u64, last_in: Option<u64>, window: Option<u64> }

/// `codex/event` `msg.type=="token_count"` → cumulative thread usage. `info` may be
/// null (seen in rollouts); any missing total → None (tokens stay "—").
fn extract_codex_token_count(n: &CustomNotification) -> Option<TokenCount> {
    if n.method != "codex/event" { return None; }
    let msg = n.params.as_ref()?.get("msg")?;
    if msg.get("type")?.as_str()? != "token_count" { return None; }
    let info = msg.get("info")?;
    let total = info.get("total_token_usage")?;
    Some(TokenCount {
        total_in: total.get("input_tokens")?.as_u64()?,
        total_out: total.get("output_tokens")?.as_u64()?,
        last_in: info.get("last_token_usage").and_then(|l| l.get("input_tokens")).and_then(|v| v.as_u64()),
        window: info.get("model_context_window").and_then(|v| v.as_u64()),
    })
}

/// Per-turn tokens = cumulative-at-result minus cumulative-at-turn-start.
fn turn_tokens(base: Option<(u64, u64)>, now: Option<(u64, u64)>) -> (Option<u64>, Option<u64>) {
    match (base, now) {
        (Some((bi, bo)), Some((ni, no))) => (Some(ni.saturating_sub(bi)), Some(no.saturating_sub(bo))),
        _ => (None, None),
    }
}
```

- `enum Notify` 加变体 `TokenCount(TokenCount)`。
- `on_custom_notification` 的 else-if 链末尾加：
  ```rust
              } else if let Some(tc) = extract_codex_token_count(&notification) {
                  send_notify_nonblocking(&tx, Notify::TokenCount(tc));
  ```
  必须用非阻塞发送，**绝不 await**（rmcp 的死锁约束）。
- `run_event_loop`：
  - 在 `let mut thread_id` 下面加 `let mut last_total: Option<(u64, u64)> = None;`。
  - 在 `Some(Cmd::Prompt(text)) => {` 里、drain 之后加：
    ```rust
                        // Baseline for this turn's delta: a fresh thread starts at 0; a
                        // resumed thread with no count seen yet is unknown (None).
                        let turn_base = if thread_id.is_none() { Some((0, 0)) } else { last_total };
    ```
  - 内层 notify 臂的 match 加：
    ```rust
                                        Notify::TokenCount(tc) => {
                                            last_total = Some((tc.total_in, tc.total_out));
                                            if let (Some(used), Some(total)) = (tc.last_in, tc.window) {
                                                if total > 0 && used > 0 {
                                                    let _ = event_tx.send(AcpEvent::ContextUsage { used, total }).await;
                                                }
                                            }
                                        }
    ```
  - 外层 notify 臂把 `Notify::TokenCount(tc) => { last_total = Some((tc.total_in, tc.total_out)); }` 加进去（放在 `Notify::Error` 前面；这种通知不发事件）。
  - `Ok(Ok(resp)) =>` 里构造 `AcpEvent::Result` 之前：
    ```rust
                                    let (tokens_in, tokens_out) = turn_tokens(turn_base, last_total);
    ```
    然后把 `tokens_in: None, tokens_out: None,` 改为 `tokens_in, tokens_out,`。`cost_usd` 保持 `None`（D9）。

前端：

- `format.ts`：
  ```ts
  export function formatTokens(n: number | null | undefined): string {
    if (n == null) return ''
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
  }
  ```
- `RunMetricsPanel.tsx` 的 `RunRow`：在成本 `<span>` 后面插入（对所有后端生效）：
  ```tsx
        {run.tokens_in != null && (
          <span className="text-[var(--text-muted)] tabular-nums shrink-0" title="tokens 入→出">
            {`${formatTokens(run.tokens_in)}→${formatTokens(run.tokens_out)}`}
          </span>
        )}
  ```
  import 改为 `import { formatCost, formatDuration, formatTokens } from '../lib/format'`。成本列逻辑不变。
- `FocusHeader.tsx:47` 与 `AcpChatView.tsx:336` 的 `title` 改为「上下文用量(后端提供)」。

- [ ] **Step 4: 确认通过**

Run: `cargo test && cd frontend && npm test && npm run lint && npm run build`
Expected: 全绿。`frontend/src/components/__tests__/crewEventCases.test.tsx` 如果断言了旧的 title 文案，把它改成新文案。这是唯一允许改动的已有断言，并且要在 commit message 里写明。

- [ ] **Step 5: Commit + 部署**

```bash
git add src/acp/codex_process.rs frontend/src
git commit -m "feat(⑧): Codex per-turn tokens + context usage from token_count notifications (S7-b)"
git push origin HEAD && ./deploy.sh --build
```

线上验证：跑一轮 Codex，运行面板里这一行显示 `x.xk→y`，顶栏显示 `ctx N%`。


---

# S7-c：门槛 T 判定（人工步骤；**没过就在这里停**）

### Task 15: 按 journalctl `zmx_usage` 判定门槛 T

**这是一个人工判定步骤，不写功能代码。** 判定结果决定 S7-d、S7-e、S7-f 以及附录 A 是否执行。

**口径（spec §0.1，唯一口径）：** 从 **S6 T3 上线日**（「并行话题」与「目标指挥」两个 chip 都可用的那天）起算，14 天内，「并行话题」会话（`crew_mode=="crew"`）或「目标指挥」会话（`crew_agent=="kirocrew-conductor"`）**实际使用 ≥ 3 次**，而且这些使用**分布在 ≥ 2 个不同日期**。「一次」指这样一个会话至少发出过 1 条 prompt。按 `crew_first_prompt` 的 sid 去重，模式和 agent 由同一个 sid 的 `crew_create` 行给出。

- [ ] **Step 1: 确认埋点存在**

```bash
cd /home/ubuntu/s3-workspace/keith-space/github-search/ai/zeromux
grep -n 'target: *"zmx_usage", *"crew_create sid=' src/session_manager.rs
grep -n 'target: *"zmx_usage", *"crew_first_prompt sid=' src/session_manager.rs
```

两条都命中，就进入 Step 2。

**有任何一条没命中**：说明 S5 G2 漏了埋点（spec §0.1 允许 S7 补）。按下面的写法补上，走一次提交 + 部署。**14 天的起点改为「补上之日」与「S6 T3 上线日」中较晚的那天**，然后停在这里，等满 14 天再回来做 Step 2。

- `create_crew_session` 在 `self.persist_meta(&session);` 之前加（`mode`、`agent` 用 S5 G2 引入的参数名）：
  ```rust
          tracing::info!(target: "zmx_usage", "crew_create sid={} mode={} agent={}", id, crew_mode, crew_agent);
  ```
- `spawn_crew_fanout`：状态区加 `let mut first_prompt_logged = false;`；在 `Some(SessionInput::Prompt { text, run_id, client_id }) => {` 臂的第一行加：
  ```rust
                              if !first_prompt_logged {
                                  first_prompt_logged = true;
                                  tracing::info!(target: "zmx_usage", "crew_first_prompt sid={}", sid);
                              }
  ```
- 提交：`git commit -am "feat(metrics): zmx_usage crew_create/crew_first_prompt (T gate source)" && git push origin HEAD && ./deploy.sh --build`。

- [ ] **Step 2: 确认日志保留覆盖整个窗口**

```bash
journalctl -u zeromux --no-pager -o short-iso | head -1      # 最早一条的日期必须 ≤ 起算日
```

如果最早一条晚于起算日，说明 journald 已经轮转掉了前面的日志，**不能判定**。这时在 spec 状态栏记「T 判定数据缺失（journald 轮转）」，并回报用户由其定夺，不要猜。

- [ ] **Step 3: 统计**

```bash
SINCE=YYYY-MM-DD        # 起算日（S6 T3 上线日；或 Step 1 补埋点的那天，取较晚者）
UNTIL=$(date -d "$SINCE +14 days" +%F)
journalctl -u zeromux --no-pager -o short-iso | grep 'zmx_usage' | grep 'crew_create sid=' > /tmp/t_create.log
journalctl -u zeromux --since "$SINCE" --until "$UNTIL" --no-pager -o short-iso | grep 'zmx_usage' | grep 'crew_first_prompt sid=' > /tmp/t_first.log
python3 - <<'PY'
import re
kind = {}
for l in open('/tmp/t_create.log'):
    m = re.search(r'crew_create sid=(\S+) mode=(\S*) agent=(\S*)', l)
    if m and (m.group(2) == 'crew' or m.group(3) == 'kirocrew-conductor'):
        kind[m.group(1)] = 'topics' if m.group(2) == 'crew' else 'goal'
uses = {}
for l in open('/tmp/t_first.log'):
    m = re.search(r'^(\d{4}-\d{2}-\d{2})\S*\s.*crew_first_prompt sid=(\S+)', l)
    if m and m.group(2) in kind:
        uses.setdefault(m.group(2), m.group(1))   # first prompt per sid
days = sorted(set(uses.values()))
print(f"uses={len(uses)} days={len(days)} {days}")
for sid, d in sorted(uses.items(), key=lambda x: x[1]): print(d, kind[sid], sid)
print("T PASS" if len(uses) >= 3 and len(days) >= 2 else "T NOT MET")
PY
```

`crew_create` 行**不加** `--since`：会话可能在起算日之前就建好了，而 prompt 在窗口里才发出。只要它是 goal 或 topics 会话，这次使用就算数。

- [ ] **Step 4: 判定规则**

| 情况 | 判定 | 动作 |
|---|---|---|
| 输出 `T PASS`（窗口内任意时刻达到都算，可以提前判） | **过** | 在 spec 状态行后追加 `T：YYYY-MM-DD 判定通过（uses=N days=M）`，继续 S7-d |
| `T NOT MET`，而且今天 < `UNTIL` | **未到期** | 不做判定，到 `UNTIL` 那天重跑 Step 3 |
| 今天 ≥ `UNTIL`，输出 `T NOT MET` | **不过** | 执行下面的归档步骤，然后**整个 S7 计划到此结束** |

**不过时的归档步骤**：

```bash
python3 - <<'PY'
p='docs/superpowers/specs/2026-09-29-s7-crew-cockpit-and-backend-parity-design.md'
s=open(p).read()
s=s.replace('状态:v2', '状态:v2 · T 未过（YYYY-MM-DD 判定,uses=N days=M）→ §2–§4、§6.5、§7、附录 A 归档,不实施', 1)
open(p,'w').write(s)
PY
git commit -am "docs(S7): gate T not met — archive Crew cockpit items" && git push origin HEAD
```

不做「先做一半看看」（spec §0.1）。Task 16 及之后的所有 Task 都**不执行**。

- [ ] **Step 5:** 把判定输出（`uses=… days=…` 以及逐行明细）贴进 commit message。过了就进 S7-d。

---

# S7-d：共享只读代理层 + G8 巡检徽章【T】

**前提：** Task 15 判定**通过**；S6 T4 的 `crew_watch` 快照已上线；S4 已上线并稳定 2 天以上（spec §0.4，S7 前端要等 S4 稳定后再动）。

### 前置已上线（S7-d 开工前执行）

```bash
cd /home/ubuntu/s3-workspace/keith-space/github-search/ai/zeromux
grep -n 'T：.*判定通过' docs/superpowers/specs/2026-09-29-s7-crew-cockpit-and-backend-parity-design.md   # Task 15
grep -n 'pub fn snapshot(&self) -> Arc<SlotsSnapshot>' src/crew_watch.rs                                   # S6 V19
grep -n 'pub struct SlotView' src/crew_watch.rs
grep -n 'pub created_by: Option<String>' src/crew_watch.rs
grep -n 'crew_watch: Arc<' src/main.rs                                                                     # AppState 字段
grep -n 'pub struct CrewMeta' src/session_manager.rs                                                       # S5 G2：Session.crew
grep -n 'crew_agent' frontend/src/lib/api/sessions.ts                                                      # S5 G2：SessionInfo
git log --oneline --since='2 days ago' -- frontend/src/components/TerminalView.tsx | wc -l                 # 期望 0（S4 稳定）
```

如果 `SlotView` 的字段名和 Global Constraints 里列的不一致，以 `src/crew_watch.rs` 的实际定义为准，并把本计划中用到的字段名同步改掉（只改名，不改语义）。

### Task 16: `mock_gateway` + `crew_proxy` 的请求基础设施

**Files:**
- Create: `src/mock_gateway.rs`（`#[cfg(test)]`）
- Create: `src/crew_proxy.rs`
- Modify: `src/main.rs`（模块列表 `:1-25`：在 `mod crew_memory;` 后面加 `mod crew_proxy;`，在 `mod ws_handler;` 后面加 `#[cfg(test)] mod mock_gateway;`）

**Interfaces:**
- Consumes: `crate::acp::crew_process::{read_gateway_secret, mint_ws_token}`（均为 `pub`）。
- Produces:
  - `pub struct GwTarget { pub base: String, pub crew_home: PathBuf, pub port: u16 }`，以及 `GwTarget::from_state(&AppState)`
  - `pub async fn gw_get_secret(t: &GwTarget, http: &reqwest::Client, path: &str, session_key: Option<&str>) -> Result<Value, String>`
  - `pub struct CookieCtx { cookie: String }`，`pub async fn cookie_ctx(t: &GwTarget, http: &reqwest::Client) -> Result<CookieCtx, String>`
  - `pub async fn gw_get_cookie(t: &GwTarget, http: &reqwest::Client, ctx: &CookieCtx, path: &str) -> Result<Value, String>`
  - `pub fn http_client() -> Result<reqwest::Client, String>`
  - 测试用：`mock_gateway::MockGw::start(routes) -> MockGw`，`MockGw::requests() -> Vec<Recorded>`，`Recorded { method, path, headers: HashMap<String,String>, body: String }`，`MockGw::target_with_secret(&self, secret) -> (GwTarget, TempDir)`，`MockGw::set_secret(&self, dir, secret)`

- [ ] **Step 1: 写失败测试**

`src/mock_gateway.rs`（完整文件）：

```rust
//! Test-only fake Kiro Crew Gateway: records every request, answers from a route
//! table keyed on "METHOD /path" (exact) with a JSON body; unknown routes → 200 {}.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug)]
pub struct Recorded { pub method: String, pub path: String, pub headers: HashMap<String, String>, pub body: String }

#[derive(Clone)]
struct St { routes: Arc<HashMap<String, (u16, serde_json::Value)>>, log: Arc<Mutex<Vec<Recorded>>> }

pub struct MockGw { pub port: u16, log: Arc<Mutex<Vec<Recorded>>> }

impl MockGw {
    pub async fn start(routes: Vec<(&str, u16, serde_json::Value)>) -> Self {
        let mut map: HashMap<String, (u16, serde_json::Value)> = routes.into_iter()
            .map(|(k, s, v)| (k.to_string(), (s, v))).collect();
        map.entry("GET /api/token/local".into()).or_insert((200, serde_json::json!({"token":"tok-test"})));
        let st = St { routes: Arc::new(map), log: Arc::new(Mutex::new(vec![])) };
        let log = st.log.clone();
        let app = axum::Router::new().fallback(handle).with_state(st);
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        Self { port, log }
    }
    pub fn requests(&self) -> Vec<Recorded> { self.log.lock().unwrap().clone() }
    /// A crew_home tempdir holding `run/gateway-<port>.secret`.
    pub fn target_with_secret(&self, secret: &str) -> (crate::crew_proxy::GwTarget, tempfile::TempDir) {
        let d = tempfile::tempdir().unwrap();
        self.set_secret(d.path(), secret);
        (crate::crew_proxy::GwTarget { base: format!("http://127.0.0.1:{}", self.port), crew_home: d.path().to_path_buf(), port: self.port }, d)
    }
    pub fn set_secret(&self, crew_home: &std::path::Path, secret: &str) {
        std::fs::create_dir_all(crew_home.join("run")).unwrap();
        std::fs::write(crew_home.join("run").join(format!("gateway-{}.secret", self.port)), format!("{secret}\n")).unwrap();
    }
}

async fn handle(axum::extract::State(st): axum::extract::State<St>, req: axum::extract::Request) -> axum::response::Response {
    use axum::response::IntoResponse;
    let method = req.method().to_string();
    let path = req.uri().path().to_string();
    let headers = req.headers().iter()
        .map(|(k, v)| (k.as_str().to_ascii_lowercase(), v.to_str().unwrap_or("").to_string())).collect();
    let body = String::from_utf8_lossy(&axum::body::to_bytes(req.into_body(), usize::MAX).await.unwrap_or_default()).to_string();
    st.log.lock().unwrap().push(Recorded { method: method.clone(), path: path.clone(), headers, body });
    let (s, v) = st.routes.get(&format!("{method} {path}")).cloned().unwrap_or((200, serde_json::json!({})));
    (axum::http::StatusCode::from_u16(s).unwrap(), axum::Json(v)).into_response()
}
```

`src/crew_proxy.rs` 先只放测试模块（Step 3 再补实现）：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::mock_gateway::MockGw;
    use serde_json::json;

    #[tokio::test]
    async fn secret_is_reread_on_every_request() {
        // Review Focus 5: the Gateway rotates its secret on every restart; a cached
        // secret 403s forever (crew_memory.rs:72-74 lesson).
        let gw = MockGw::start(vec![]).await;
        let (t, dir) = gw.target_with_secret("s-one");
        let http = http_client().unwrap();
        gw_get_secret(&t, &http, "/api/spawn", None).await.unwrap();
        gw.set_secret(dir.path(), "s-two");
        gw_get_secret(&t, &http, "/api/spawn", None).await.unwrap();
        let seen: Vec<_> = gw.requests().iter().map(|r| r.headers.get("x-internal-secret").cloned().unwrap_or_default()).collect();
        assert_eq!(seen, vec!["s-one", "s-two"]);
    }

    #[tokio::test]
    async fn session_key_header_only_when_given() {
        let gw = MockGw::start(vec![]).await;
        let (t, _d) = gw.target_with_secret("sec");
        let http = http_client().unwrap();
        gw_get_secret(&t, &http, "/api/spawn", None).await.unwrap();
        gw_get_secret(&t, &http, "/api/session-ledger", Some("dashboard:zmx-1")).await.unwrap();
        let r = gw.requests();
        assert!(r[0].headers.get("x-session-key").is_none());
        assert_eq!(r[1].headers.get("x-session-key").map(String::as_str), Some("dashboard:zmx-1"));
    }

    #[tokio::test]
    async fn cookie_path_mints_then_sends_cookie_not_query_token() {
        let gw = MockGw::start(vec![]).await;
        let (t, _d) = gw.target_with_secret("sec");
        let http = http_client().unwrap();
        let ctx = cookie_ctx(&t, &http).await.unwrap();
        gw_get_cookie(&t, &http, &ctx, "/api/autonudge/slot/zmx-1").await.unwrap();
        let r = gw.requests();
        assert_eq!(r[0].path, "/api/token/local");
        assert_eq!(r[0].headers.get("x-local-secret").map(String::as_str), Some("sec"));
        assert_eq!(r[1].headers.get("cookie").cloned(), Some(format!("mc_token_{}=tok-test", t.port)));
        assert!(!r[1].path.contains("token"), "token must never ride in the URL");
    }

    #[tokio::test]
    async fn errors_never_echo_token_or_secret() {
        let gw = MockGw::start(vec![("GET /api/spawn", 403, json!({"error":"x"}))]).await;
        let (t, _d) = gw.target_with_secret("SUPERSECRET");
        let http = http_client().unwrap();
        let e = gw_get_secret(&t, &http, "/api/spawn", None).await.unwrap_err();
        for bad in ["SUPERSECRET", "tok-test", "mc_token_", "token="] { assert!(!e.contains(bad), "{e}"); }
        let ctx = cookie_ctx(&t, &http).await.unwrap();
        let e2 = gw_get_cookie(&t, &http, &ctx, "/api/spawn").await.unwrap_err();
        for bad in ["SUPERSECRET", "tok-test", "mc_token_", "token="] { assert!(!e2.contains(bad), "{e2}"); }
    }

    #[tokio::test]
    async fn unreachable_gateway_is_err_not_panic() {
        let d = tempfile::tempdir().unwrap();
        let t = GwTarget { base: "http://127.0.0.1:9".into(), crew_home: d.path().into(), port: 9 };
        let http = http_client().unwrap();
        assert!(gw_get_secret(&t, &http, "/api/spawn", None).await.is_err(), "no secret file");
        std::fs::create_dir_all(d.path().join("run")).unwrap();
        std::fs::write(d.path().join("run/gateway-9.secret"), "s").unwrap();
        assert!(gw_get_secret(&t, &http, "/api/spawn", None).await.is_err(), "connection refused");
    }
}
```

- [ ] **Step 2: 确认失败**

Run: `cargo test crew_proxy`
Expected: 编译失败，缺少 `GwTarget`、`http_client` 等。

- [ ] **Step 3: 实现**

在 `src/crew_proxy.rs` 的测试模块前面插入：

```rust
//! Read-only Kiro Crew Gateway proxy for the Crew cockpit (S7 §1). Slot list and
//! parent/child come ONLY from `crew_watch.snapshot()` (single writer, S6 V19);
//! this module fetches just the per-session extras (spawn / ledger / patrol).
//! Secrets are re-read and tokens re-minted on EVERY request — never cached: the
//! Gateway rotates its secret on restart. Error strings carry paths and status
//! codes only, never tokens or secrets.
use std::path::PathBuf;
use std::sync::Arc;

use axum::{extract::{Path, State}, http::StatusCode, Json};
use serde_json::Value;

use crate::{acp::crew_process::{mint_ws_token, read_gateway_secret}, auth::CurrentUser, AppState};

const UPSTREAM_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

pub struct GwTarget { pub base: String, pub crew_home: PathBuf, pub port: u16 }

impl GwTarget {
    pub fn from_state(s: &AppState) -> Self {
        Self { base: format!("http://127.0.0.1:{}", s.crew_port), crew_home: PathBuf::from(&s.crew_home), port: s.crew_port }
    }
}

pub fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("build crew http client: {e}"))
}

async fn read_json(resp: reqwest::Response, path: &str) -> Result<Value, String> {
    let st = resp.status();
    if !st.is_success() { return Err(format!("Gateway 拒绝 {path}（HTTP {}）", st.as_u16())); }
    resp.json().await.map_err(|_| format!("Gateway 响应不是 JSON：{path}"))
}

/// Secret-authed GET (mixed + strict paths). `session_key` → `X-Session-Key`
/// (strict `/api/session-ledger`: identity comes from that header, D-R3).
pub async fn gw_get_secret(t: &GwTarget, http: &reqwest::Client, path: &str, session_key: Option<&str>) -> Result<Value, String> {
    let secret = read_gateway_secret(&t.crew_home, t.port)?;
    let mut rb = http.get(format!("{}{path}", t.base)).header("X-Internal-Secret", secret).timeout(UPSTREAM_TIMEOUT);
    if let Some(k) = session_key { rb = rb.header("X-Session-Key", k); }
    let resp = rb.send().await.map_err(|_| format!("Gateway 请求失败：{path}"))?;
    read_json(resp, path).await
}

/// One minted token per proxy request, sent as a cookie (NOT `?token=`: URL tokens
/// are one-shot and self-revoke on reuse — crew_memory.rs:82-90).
pub struct CookieCtx { cookie: String }

pub async fn cookie_ctx(t: &GwTarget, http: &reqwest::Client) -> Result<CookieCtx, String> {
    let secret = read_gateway_secret(&t.crew_home, t.port)?;
    let token = mint_ws_token(http, &t.base, &secret).await?;
    Ok(CookieCtx { cookie: format!("mc_token_{}={}", t.port, token) })
}

/// Cookie-authed GET (cookie-only paths: `/api/autonudge*`, `/api/monitors*`).
pub async fn gw_get_cookie(t: &GwTarget, http: &reqwest::Client, ctx: &CookieCtx, path: &str) -> Result<Value, String> {
    let resp = http.get(format!("{}{path}", t.base)).header("Cookie", &ctx.cookie)
        .timeout(UPSTREAM_TIMEOUT).send().await.map_err(|_| format!("Gateway 请求失败：{path}"))?;
    read_json(resp, path).await
}
```

`State`、`Path`、`Json`、`Arc`、`CurrentUser`、`StatusCode` 是给 Task 17 以后的 handler 用的。本 Task 里在文件顶部临时加 `#![allow(unused_imports)]`，Task 17 再删掉。

- [ ] **Step 4: 确认通过**

Run: `cargo test crew_proxy && cargo test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/crew_proxy.rs src/mock_gateway.rs src/main.rs
git commit -m "feat(crew): read-only Gateway proxy base + test mock Gateway (S7-d §1)"
```

---

### Task 17: G8 后端 `GET /api/sessions/{id}/crew/patrol`（**同时查 autonudge 和 monitors**）

**Files:**
- Modify: `src/crew_proxy.rs`（`project_patrol`、`fetch_patrol`、`get_crew_patrol`）
- Modify: `src/session_manager.rs`（`pub fn crew_binding`，放在 `pub fn tmux_binding` 后面，当前 `:2500`）
- Modify: `src/web.rs`（路由表：加在 `.route("/api/crew/memory", …)` 前面，当前 `:77`）

**Interfaces:**
- Consumes: Task 16；S5 的 `Session.crew: Option<CrewMeta{mode, agent, origin}>`（字段都是 `String`）。
- Produces:
  - `pub struct CrewBinding { pub slot_key: String, pub mode: String, pub agent: String, pub origin: String }`
  - `SessionManager::crew_binding(&self, id: &str) -> Option<CrewBinding>`：只有 Crew 会话并且 resume token 已回填时才返回 `Some`
  - `pub fn project_patrol(autonudge: Option<&Value>, monitors: Option<&Value>, now_s: f64) -> Value`
  - HTTP：`GET /api/sessions/{id}/crew/patrol` → `{gateway_ok, kind: "loop"|"monitor"|"none", cycle, max_cycles, active, next_in_s, objective}`

**上游结构（在 `KC/` 上核实过）：**
- `/api/autonudge/slot/{k}` → `{enabled, loop: NudgeLoop|null}`。loop 的字段是 `cycle_count,max_cycles,active,last_fire_ts,idle_secs,message`（`KC/autonudge.py:492-518`），只返回旧式 loop（`KC/dashboard/handlers/autonudge.py:269-277`）。
- `/api/monitors/slot/{k}` → `{enabled, monitor: <整个 loop 序列化>|null}`。**结构化 monitor 的字段嵌套在 `monitor.monitor` 里**（`_serialize_monitor` = `_serialize(loop)`，它把 `payload["monitor"] = monitor_state_public_dict(...)` 放进 loop 的 dict，`:104-115`）。所以 `objective`、`cadence_secs`、`last_observed_at` 在 `monitor.monitor.*`，而 `cycle_count`、`max_cycles`、`active` 在 `monitor.*`（外层 loop）。这一点与 spec §4.2「`monitor.objective`」的写法不同，以源码为准。

- [ ] **Step 1: 写失败测试**

`src/crew_proxy.rs` 的 `mod tests` 追加：

```rust
    #[test]
    fn patrol_prefers_monitor_and_reads_nested_monitor_fields() {
        let an = json!({"enabled":true,"loop":{"cycle_count":1,"max_cycles":5,"active":true,"last_fire_ts":1000.0,"idle_secs":60,"message":"legacy\nmore"}});
        let mo = json!({"enabled":true,"monitor":{"cycle_count":3,"max_cycles":24,"active":true,
            "monitor":{"objective":"等 #123 CI","cadence_secs":300,"last_observed_at":1000.0}}});
        let p = project_patrol(Some(&an), Some(&mo), 1182.0);
        assert_eq!(p["kind"], "monitor");
        assert_eq!((p["cycle"].as_u64(), p["max_cycles"].as_u64()), (Some(3), Some(24)));
        assert_eq!(p["next_in_s"].as_i64(), Some(118));
        assert_eq!(p["objective"], "等 #123 CI");
    }

    #[test]
    fn patrol_loop_only_and_none_and_garbage() {
        let an = json!({"enabled":true,"loop":{"cycle_count":2,"max_cycles":0,"active":false,"last_fire_ts":0.0,"idle_secs":60,"message":"巡检\n第二行"}});
        let p = project_patrol(Some(&an), Some(&json!({"enabled":true,"monitor":null})), 5000.0);
        assert_eq!(p["kind"], "loop");
        assert_eq!(p["max_cycles"].as_u64(), Some(0), "0 = unlimited (UI shows ∞)");
        assert!(p["next_in_s"].is_null(), "last_fire_ts=0 → 待首次");
        assert_eq!(p["objective"], "巡检");
        assert_eq!(project_patrol(None, None, 0.0)["kind"], "none");
        let bad = json!({"loop":{"cycle_count":"x","active":"yes"}});
        let p2 = project_patrol(Some(&bad), Some(&json!([1,2])), 0.0);
        assert_eq!(p2["kind"], "loop");
        assert!(p2["cycle"].is_null() && p2["active"].is_null());
    }

    #[tokio::test]
    async fn fetch_patrol_queries_both_autonudge_and_monitors() {
        // D-G8: /api/autonudge/slot filters structured monitors out, so BOTH must be read.
        let gw = MockGw::start(vec![
            ("GET /api/autonudge/slot/zmx-1", 200, json!({"enabled":true,"loop":null})),
            ("GET /api/monitors/slot/zmx-1", 200, json!({"enabled":true,"monitor":{"cycle_count":1,"max_cycles":24,"active":true,"monitor":{"objective":"o","cadence_secs":60,"last_observed_at":0.0}}})),
        ]).await;
        let (t, _d) = gw.target_with_secret("sec");
        let p = fetch_patrol(&t, "zmx-1", 100.0).await;
        let paths: Vec<_> = gw.requests().into_iter().map(|r| r.path).collect();
        assert!(paths.contains(&"/api/autonudge/slot/zmx-1".to_string()));
        assert!(paths.contains(&"/api/monitors/slot/zmx-1".to_string()));
        assert_eq!((p["gateway_ok"].as_bool(), p["kind"].as_str()), (Some(true), Some("monitor")));
    }

    #[tokio::test]
    async fn fetch_patrol_one_upstream_failing_keeps_the_other() {
        let gw = MockGw::start(vec![
            ("GET /api/monitors/slot/zmx-1", 403, json!({"code":"dashboard_owner_required"})),
            ("GET /api/autonudge/slot/zmx-1", 200, json!({"enabled":true,"loop":{"cycle_count":4,"max_cycles":10,"active":true,"last_fire_ts":0.0,"idle_secs":60,"message":"m"}})),
        ]).await;
        let (t, _d) = gw.target_with_secret("sec");
        let p = fetch_patrol(&t, "zmx-1", 1.0).await;
        assert_eq!(p["kind"], "loop");
        assert_eq!(p["errors"], json!(["monitors"]));
    }

    #[tokio::test]
    async fn fetch_patrol_gateway_down_is_ok_false() {
        let d = tempfile::tempdir().unwrap();
        let t = GwTarget { base: "http://127.0.0.1:9".into(), crew_home: d.path().into(), port: 9 };
        assert_eq!(fetch_patrol(&t, "zmx-1", 1.0).await, json!({"gateway_ok": false}));
    }
```

`src/session_manager.rs` 的 `mod tests` 追加（`Session` 的 `crew` 字段按 S5 的定义写；如果 S5 用了别的字段名，以 S5 为准）：

```rust
    #[test]
    fn crew_binding_requires_crew_type_and_token() {
        let (m, _d) = make_manager();
        let mut s = make_session("c1", "o");
        s.session_type = SessionType::Crew;
        s.crew = Some(CrewMeta { mode: "".into(), agent: "kirocrew-conductor".into(), origin: "zeromux".into() });
        m.sessions.lock().unwrap().insert("c1".into(), s);
        assert!(m.crew_binding("c1").is_none(), "no slot key yet");
        m.sessions.lock().unwrap().get_mut("c1").unwrap().resume_token = Some(ResumeToken::Crew("zmx-1".into()));
        let b = m.crew_binding("c1").unwrap();
        assert_eq!((b.slot_key.as_str(), b.agent.as_str(), b.origin.as_str()), ("zmx-1", "kirocrew-conductor", "zeromux"));
        let mut t = make_session("t1", "o");
        t.resume_token = Some(ResumeToken::Crew("zmx-2".into())); // wrong type
        m.sessions.lock().unwrap().insert("t1".into(), t);
        assert!(m.crew_binding("t1").is_none());
    }
```

- [ ] **Step 2: 确认失败**

Run: `cargo test patrol crew_binding_requires`
Expected: 编译失败。

- [ ] **Step 3: 实现**

`session_manager.rs`（`pub fn tmux_binding` 后面）：

```rust
    /// Crew session → its Gateway slot + S5 persisted meta. None for non-Crew, or
    /// before the slot key was backfilled.
    pub fn crew_binding(&self, id: &str) -> Option<CrewBinding> {
        let map = self.sessions.lock().unwrap();
        let s = map.get(id)?;
        if s.session_type != SessionType::Crew { return None; }
        let Some(ResumeToken::Crew(k)) = &s.resume_token else { return None };
        let c = s.crew.clone().unwrap_or_default();
        Some(CrewBinding { slot_key: k.clone(), mode: c.mode, agent: c.agent, origin: c.origin })
    }
```

```rust
#[derive(Debug, Clone)]
pub struct CrewBinding { pub slot_key: String, pub mode: String, pub agent: String, pub origin: String }
```

（如果 S5 的 `CrewMeta` 没有 derive `Default`，就给它加上 `#[derive(Default)]`；`origin` 的缺省值会是 `""`，消费方把 `""` 当作 `zeromux` 处理。）

`crew_proxy.rs`：删掉 `#![allow(unused_imports)]`，然后加：

```rust
fn u(v: &Value, k: &str) -> Option<u64> { v.get(k).and_then(Value::as_u64) }
fn f(v: &Value, k: &str) -> Option<f64> { v.get(k).and_then(Value::as_f64) }
fn first_line(s: &str, n: usize) -> String { s.lines().next().unwrap_or("").chars().take(n).collect() }

/// Merge the two patrol sources (D-G8): a structured monitor wins over a legacy
/// loop. Lenient: any missing/mistyped field → null, never a panic (R6).
pub fn project_patrol(autonudge: Option<&Value>, monitors: Option<&Value>, now_s: f64) -> Value {
    let mon = monitors.and_then(|m| m.get("monitor")).filter(|m| m.is_object());
    let lp = autonudge.and_then(|a| a.get("loop")).filter(|l| l.is_object());
    let (kind, outer, next, objective) = if let Some(m) = mon {
        let inner = m.get("monitor").cloned().unwrap_or(Value::Null);
        let next = match (f(&inner, "last_observed_at"), f(&inner, "cadence_secs")) {
            (Some(t), Some(c)) if t > 0.0 => Some(((t + c - now_s).max(0.0)) as i64),
            _ => None,
        };
        ("monitor", m, next, inner.get("objective").and_then(Value::as_str).map(|s| first_line(s, 80)))
    } else if let Some(l) = lp {
        let next = match (f(l, "last_fire_ts"), f(l, "idle_secs")) {
            (Some(t), Some(i)) if t > 0.0 => Some(((t + i - now_s).max(0.0)) as i64),
            _ => None,
        };
        ("loop", l, next, l.get("message").and_then(Value::as_str).map(|s| first_line(s, 80)))
    } else {
        return serde_json::json!({"gateway_ok": true, "kind": "none"});
    };
    serde_json::json!({
        "gateway_ok": true, "kind": kind,
        "cycle": u(outer, "cycle_count"), "max_cycles": u(outer, "max_cycles"),
        "active": outer.get("active").and_then(Value::as_bool),
        "next_in_s": next, "objective": objective,
    })
}

pub async fn fetch_patrol(t: &GwTarget, slot: &str, now_s: f64) -> Value {
    let Ok(http) = http_client() else { return serde_json::json!({"gateway_ok": false}) };
    // Minting proves the Gateway is up (same criterion as crew_memory).
    let Ok(ctx) = cookie_ctx(t, &http).await else { return serde_json::json!({"gateway_ok": false}) };
    let (an, mo) = tokio::join!(
        gw_get_cookie(t, &http, &ctx, &format!("/api/autonudge/slot/{slot}")),
        gw_get_cookie(t, &http, &ctx, &format!("/api/monitors/slot/{slot}")),
    );
    let mut errors = vec![];
    if an.is_err() { errors.push("autonudge"); }
    if mo.is_err() { errors.push("monitors"); }
    let mut out = project_patrol(an.as_ref().ok(), mo.as_ref().ok(), now_s);
    if !errors.is_empty() { out["errors"] = serde_json::json!(errors); }
    out
}

/// Owner (or admin) of a Crew session → its binding; 404 for non-Crew / unknown.
fn owned_crew(state: &AppState, user: &CurrentUser, id: &str) -> Result<crate::session_manager::CrewBinding, StatusCode> {
    if !user.is_admin() && !state.sessions.is_owner(id, &user.id) { return Err(StatusCode::FORBIDDEN); }
    state.sessions.crew_binding(id).ok_or(StatusCode::NOT_FOUND)
}

fn now_s() -> f64 { crate::session_manager::now_millis() as f64 / 1000.0 }

/// `GET /api/sessions/{id}/crew/patrol` (G8).
pub async fn get_crew_patrol(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<Value>, StatusCode> {
    let b = owned_crew(&state, &user, &id)?;
    Ok(Json(fetch_patrol(&GwTarget::from_state(&state), &b.slot_key, now_s()).await))
}
```

注意 `slot` 会被拼进 URL 路径。它来自 `ResumeToken::Crew`，取值只有 `zmx-xxxxxxxx`（zeromux 自建）或者 G6 接入时已经校验过的 key（Task 23 会校验 `^[A-Za-z0-9._:-]+$`），不含 `/`、`?`、`%`。

`web.rs` 路由表加：

```rust
        .route("/api/sessions/{id}/crew/patrol", get(crate::crew_proxy::get_crew_patrol))
```

- [ ] **Step 4: 确认通过**

Run: `cargo test patrol crew_binding_requires && cargo test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/crew_proxy.rs src/session_manager.rs src/web.rs
git commit -m "feat(G8): /crew/patrol merges autonudge loop + structured monitor (S7-d)"
```

---

### Task 18: G8 前端 `PatrolBadge` + S7-d 部署

**Files:**
- Create: `frontend/src/lib/api/crew.ts`、`frontend/src/lib/patrol.ts`、`frontend/src/lib/__tests__/patrol.test.ts`
- Modify: `frontend/src/lib/api.ts`（末尾加 `export * from './api/crew'`）
- Modify: `frontend/src/components/shell/FocusHeader.tsx`（在 `:47` 的 ctx span 后面插入）
- Test: `frontend/src/components/shell/__tests__/FocusHeader.test.tsx`

**Interfaces:**
- Produces:
  - `interface CrewPatrol { gateway_ok: boolean; kind?: 'loop'|'monitor'|'none'; cycle?: number|null; max_cycles?: number|null; active?: boolean|null; next_in_s?: number|null; objective?: string|null; errors?: string[] }`
  - `getCrewPatrol(sid): Promise<CrewPatrol>`
  - `formatPatrol(p): { text: string; muted: boolean } | null`
  - Task 21 复用 `formatPatrol` 与 `getCrewPatrol`

- [ ] **Step 1: 写失败测试**

```ts
// frontend/src/lib/__tests__/patrol.test.ts
import { describe, it, expect } from 'vitest'
import { formatPatrol } from '../patrol'

describe('formatPatrol', () => {
  it('none / gateway down → null', () => {
    expect(formatPatrol({ gateway_ok: true, kind: 'none' })).toBeNull()
    expect(formatPatrol({ gateway_ok: false })).toBeNull()
  })
  it('cycle / max and next', () => {
    expect(formatPatrol({ gateway_ok: true, kind: 'monitor', cycle: 3, max_cycles: 24, active: true, next_in_s: 118 }))
      .toEqual({ text: '3/24 · 约 2m', muted: false })
  })
  it('unlimited, first run, stopped', () => {
    expect(formatPatrol({ gateway_ok: true, kind: 'loop', cycle: 3, max_cycles: 0, active: true, next_in_s: null })?.text).toBe('3/∞ · 待首次')
    expect(formatPatrol({ gateway_ok: true, kind: 'loop', cycle: 5, max_cycles: 5, active: false, next_in_s: 0 }))
      .toEqual({ text: '巡检已停', muted: true })
  })
  it('seconds under a minute', () => {
    expect(formatPatrol({ gateway_ok: true, kind: 'loop', cycle: 1, max_cycles: 3, active: true, next_in_s: 40 })?.text).toBe('1/3 · 约 40s')
  })
})
```

`FocusHeader.test.tsx` 追加：

```tsx
  it('crew conductor: patrol badge on desktop, none on phone, none for claude', async () => {
    const spy = vi.spyOn(api, 'getCrewPatrol').mockResolvedValue({ gateway_ok: true, kind: 'monitor', cycle: 3, max_cycles: 24, active: true, next_in_s: 118, objective: '等 CI' })
    const crew = mkSession('c', { type: 'crew', crew_agent: 'kirocrew-conductor' })
    setup({ session: crew })
    expect(await screen.findByText('3/24 · 约 2m')).toBeInTheDocument()
    cleanup()
    setup({ session: crew, narrow: true })
    await new Promise(r => setTimeout(r, 0))
    expect(screen.queryByText(/3\/24/)).toBeNull()
    cleanup(); spy.mockClear()
    setup()
    expect(spy).not.toHaveBeenCalled()
  })
```

文件顶部加 `import * as api from '../../../lib/api'`，并在 `@testing-library/react` 的 import 里加上 `cleanup`。

- [ ] **Step 2: 确认失败**

Run: `cd frontend && npx vitest run src/lib/__tests__/patrol.test.ts src/components/shell/__tests__/FocusHeader.test.tsx`
Expected: FAIL。

- [ ] **Step 3: 实现**

```ts
// frontend/src/lib/api/crew.ts
import { api } from './core'

export interface CrewPatrol {
  gateway_ok: boolean
  kind?: 'loop' | 'monitor' | 'none'
  cycle?: number | null; max_cycles?: number | null; active?: boolean | null
  next_in_s?: number | null; objective?: string | null; errors?: string[]
}

export async function getCrewPatrol(sid: string): Promise<CrewPatrol> {
  const res = await api(`/api/sessions/${sid}/crew/patrol`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}
```

```ts
// frontend/src/lib/patrol.ts
import type { CrewPatrol } from './api'

export function formatPatrol(p: CrewPatrol | null | undefined): { text: string; muted: boolean } | null {
  if (!p || !p.gateway_ok || !p.kind || p.kind === 'none') return null
  if (p.active === false) return { text: '巡检已停', muted: true }
  const max = p.max_cycles === 0 ? '∞' : (p.max_cycles ?? '?')
  const next = p.next_in_s == null ? '待首次'
    : p.next_in_s < 60 ? `约 ${p.next_in_s}s` : `约 ${Math.round(p.next_in_s / 60)}m`
  return { text: `${p.cycle ?? 0}/${max} · ${next}`, muted: false }
}
```

`FocusHeader.tsx`：

- import 区：`import { useState, useCallback } from 'react'`、`import { ChevronLeft, MoreHorizontal, PanelRight, Radar } from 'lucide-react'`、`import { getCrewPatrol, type CrewPatrol } from '../../lib/api'`、`import { formatPatrol } from '../../lib/patrol'`、`import { usePolling } from '../../lib/usePolling'`。
- 文件末尾加一个组件：

  ```tsx
  /** G8: desktop-only patrol badge for Crew conductor sessions (D6: phones show it in the 子任务 tab). */
  function PatrolBadge({ sid }: { sid: string }) {
    const [p, setP] = useState<CrewPatrol | null>(null)
    const load = useCallback(async () => { try { setP(await getCrewPatrol(sid)) } catch { /* keep last */ } }, [sid])
    usePolling(load, 30_000)
    const f = formatPatrol(p)
    if (!f) return null
    return (
      <span className={`num shrink-0 inline-flex items-center gap-1 text-ui-2xs ${f.muted ? 'text-[var(--fg-subtle)]' : 'text-[var(--fg-muted)]'}`} title={p?.objective ?? '巡检'}>
        <Radar size={12} />{f.text}
      </span>
    )
  }
  ```

- 在 ctx 那一行（当前 `:47`）后面插入：

  ```tsx
        {!narrow && session.type === 'crew' && !!session.crew_agent && <PatrolBadge sid={session.id} />}
  ```

FocusHeader 只为焦点会话渲染，所以不在焦点时 PatrolBadge 会卸载，轮询自然停止（spec §4.3）。

- [ ] **Step 4: 确认通过，记录体积**

Run: `cd frontend && npm test && npm run lint && npm run build`
Expected: 全绿；首屏增量 < 0.6KB br（记下 check-size 前后的数值）。如果超出，把 `PatrolBadge` 移进 `lazyPanels.ts`，改为 `lazy(() => import('./PatrolBadge'))` 并用 `<Suspense fallback={null}>` 包起来（spec K5）。

- [ ] **Step 5: Commit、push、部署**

```bash
git add frontend/src
git commit -m "feat(G8): conductor patrol badge in FocusHeader (desktop) (S7-d)"
git push origin HEAD && ./deploy.sh --build
```

线上验证：打开一个 conductor 会话（桌面），让它 `monitor_start` 之后，顶栏在 30 秒内出现 `n/24 · 约 Xm`。


---

# S7-e：G4 子任务 tab / G5 目标卡 + G6 外部 slot 接入【T】

**前提：** S7-d 已上线；S5 R4（`crew_origin`、`owns_slot`，以及 `SlotInit::Resume{owns:false}` 时跳过 `set_slot_project` 的分支）；S6 的 `crew_watch` 快照。G6 接入 `mode=crew` 的 slot 还需要 S6 G3（D13）。

### 前置已上线（S7-e 开工前执行）

```bash
cd /home/ubuntu/s3-workspace/keith-space/github-search/ai/zeromux
grep -n 'fn get_crew_patrol' src/crew_proxy.rs                              # S7-d
grep -n 'owns_slot' src/acp/crew_process.rs                                 # S5 R4
grep -n 'enum SlotInit' -A4 src/acp/crew_process.rs                         # S5：New{mode,agent} | Resume{key,owns}
grep -n 'fn should_delete_on_drop\|fn resume_plan' src/acp/crew_process.rs  # S5 R4 的纯函数
grep -n 'crew_origin' src/session_store.rs                                  # U1 列
grep -n '"crew_meta"' src/acp/crew_process.rs                               # S5 G1：crew_* 帧 → ContentBlock{summary}
grep -n 'fn children_by_parent' src/crew_watch.rs                           # S6 §9.2
grep -n 'NormState.topics\|topics: bool' src/acp/crew_process.rs            # S6 G3（只影响 D13 的置灰；没命中 = G3 未上线）
```

前 7 条必须全部命中。第 8 条的结果记为 `G3_LIVE=yes|no`，Task 24 会用到。

**K3 spike（开工前，只读 + 一次性测试 slot）：** spec §13 K3 问的是「删除 conductor slot 时，Crew 会不会连带清理它创建的 worker」。源码 `KC/dashboard/chat_handlers.py:4623 close_slot` 的文档注释写的是「Non-destructive: the conversation is saved to history (closed=True)」，而且函数体里没有遍历 `created_by` 子 slot 的代码。所以按源码判断，**不会连带删除**，worker 会留在 Gateway 上。实测步骤：

```bash
S=$(cat ~/.kiro/crew/run/gateway-5476.secret)
curl -s -X POST localhost:5476/api/chat/slots -H "X-Internal-Secret: $S" -H 'content-type: application/json' -d '{"name":"zmx-k3probe","agent":"kirocrew-conductor"}'
# 在 Crew 仪表板里让 zmx-k3probe 用 session-control 派出 1 个 worker（或者等 G10 跑一次），记下 worker key W
curl -s -X DELETE localhost:5476/api/chat/slots/zmx-k3probe -H "X-Internal-Secret: $S"
curl -s localhost:5476/api/chat/slots/$W -H "X-Internal-Secret: $S" -o /dev/null -w '%{http_code}\n'   # 200 = worker 仍在
```

结果决定 Task 25 关闭确认文案里的那一句：200 → 「conductor 派出的子会话由 Crew 管理，不会一起删除」；404 → 「conductor 派出的子会话会一起关闭」。把结果写进 spec §13 K3 那一行的末尾。

### Task 19: `Posture.last_crew_meta`（只存内存）

**Files:**
- Modify: `src/session_manager.rs`：`struct Posture`（`:3607-3614`）、`enum PostureDelta`（`:3618-3622`）、`fn posture_delta_of`（`:3640-3654`）、`fn apply_posture_delta`（`:3667-3673`）；加访问器 `pub fn crew_meta_text`
- Test: `mod posture_tests`（`:7079`）

**Interfaces:**
- Produces: `SessionManager::crew_meta_text(&self, id: &str) -> Option<String>`。Task 20 使用。

- [ ] **Step 1: 写失败测试**

`mod posture_tests` 末尾追加（`block(bt, text, name, summary)` 是这个模块里已有的 helper）：

```rust
    #[test]
    fn crew_meta_block_sets_last_crew_meta_capped_4k_on_char_boundary() {
        let meta = block("text", Some("Here's what's in flight:\n- **修复登录** — running: 查 cookie"), None, Some("crew_meta"));
        match posture_delta_of(&meta) { Some(PostureDelta::CrewMeta(t)) => assert!(t.contains("修复登录")), _ => panic!("no CrewMeta") }
        let res = block("text", Some("done"), None, Some("crew_result"));
        assert!(!matches!(posture_delta_of(&res), Some(PostureDelta::CrewMeta(_))), "crew_result is not an overview");
        let big: String = "界".repeat(5000);
        let mut p = Posture::default();
        apply_posture_delta(&mut p, match posture_delta_of(&block("text", Some(&big), None, Some("crew_meta"))) { Some(d) => d, None => panic!() });
        assert_eq!(p.last_crew_meta.as_ref().unwrap().chars().count(), 4096);
    }

    #[test]
    fn crew_meta_is_not_persisted() {
        // V2: persist_posture writes only U3's four fields.
        let src = include_str!("session_manager.rs");
        let body = &src[src.find(concat!("fn persist_", "posture(")).unwrap()..];
        let body = &body[..body.find("\n    }\n").unwrap()];
        assert!(!body.contains("last_crew_meta"));
    }
```

- [ ] **Step 2: 确认失败**

Run: `cargo test crew_meta_block crew_meta_is_not_persisted`
Expected: 编译失败。

- [ ] **Step 3: 实现**

- `struct Posture` 末尾加：
  ```rust
      /// Latest Crew `crew_meta` overview (G4). Memory only — not in persist_posture (V2).
      last_crew_meta: Option<String>,
  ```
- `enum PostureDelta` 加变体 `CrewMeta(String),`。
- `posture_delta_of` 的 match 里、`tool_use` 臂之前加：
  ```rust
          AcpEvent::ContentBlock { summary: Some(s), text: Some(t), .. } if s == "crew_meta" && !t.is_empty() =>
              Some(PostureDelta::CrewMeta(cap_chars(t, 4096))),
  ```
- `apply_posture_delta` 加臂 `PostureDelta::CrewMeta(s) => p.last_crew_meta = Some(s),`。
- 访问器（放在 `crew_binding` 后面）：
  ```rust
      pub fn crew_meta_text(&self, id: &str) -> Option<String> {
          self.sessions.lock().unwrap().get(id).and_then(|s| s.posture.last_crew_meta.clone())
      }
  ```

S5 G1 发出的 ContentBlock，`summary` 是 `Some("crew_meta")`，这里的匹配依赖这一点。如果 S5 实际的 summary 值不同，就以 `grep -n '"crew_meta"' src/acp/crew_process.rs` 找到的字面量为准。

- [ ] **Step 4: 确认通过**

Run: `cargo test posture_tests && cargo test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/session_manager.rs
git commit -m "feat(G4): keep latest crew_meta overview in posture (memory only) (S7-e)"
```

---

### Task 20: `GET /api/sessions/{id}/crew/tasks`（spawn + ledger + snapshot）

**Files:**
- Modify: `src/crew_proxy.rs`（`project_spawn`、`project_slot`、`project_children`、`project_ledger`、`fold_ledger_key`、`fetch_tasks`、`get_crew_tasks`）
- Modify: `src/session_manager.rs`（`pub fn crew_slot_bindings`）
- Modify: `src/web.rs`（路由）
- Create: `src/crew_proxy/fixtures/`（`ledger_ok.json`、`spawn.json`）。数据用 spike 时从本机 Gateway 只读 GET 抓到的内容，脱敏；如果本机没有 ledger（`~/.kiro/crew/ledger/` 不存在），就用下面测试里内联的 JSON 作为夹具。

**Interfaces:**
- Consumes: Task 16/17/19；`state.crew_watch.snapshot() -> Arc<SlotsSnapshot>`（字段 `gateway_ok`、`slots: Vec<SlotView>`）。
- Produces:
  - `SessionManager::crew_slot_bindings(&self) -> HashMap<String, String>`（slot_key → sid，覆盖所有 Crew 会话）
  - `pub fn fold_ledger_key(s: &str) -> &str`
  - `pub fn project_spawn(v: &Value, slot_key: &str) -> Vec<Value>`
  - `pub fn project_ledger(v: &Value, children: &[Value]) -> Value`
  - `pub fn project_slot(s: &SlotView) -> Value`
  - `pub fn project_children(snap: &SlotsSnapshot, slot_key: &str, bound: &HashMap<String,String>) -> Vec<Value>`
  - `pub async fn fetch_tasks(t: &GwTarget, snap: &SlotsSnapshot, b: &CrewBinding, bound: &HashMap<String,String>, meta_text: Option<String>) -> Value`
  - HTTP：`GET /api/sessions/{id}/crew/tasks`，响应结构见 spec §2.2

- [ ] **Step 1: 写失败测试（包含 X-Internal-Secret 与 X-Session-Key 断言）**

`crew_proxy.rs` 的 `mod tests` 追加：

```rust
    use crate::crew_watch::{SlotsSnapshot, SlotView};
    use crate::session_manager::CrewBinding;

    fn slot(key: &str, created_by: Option<&str>) -> SlotView {
        SlotView { key: key.into(), title: Some(format!("t-{key}")), agent: None, mode: Some("".into()), project: Some("/home/u/p".into()),
            origin: Some("user".into()), created_by: created_by.map(String::from), running: false, orchestrating: false,
            subagents_running: false, queue_depth: 0, needs_input: false, pending_approval: false,
            pending_approval_tool: None, last_message_head: None, last_activity_ts: None }
    }
    fn conductor() -> CrewBinding {
        CrewBinding { slot_key: "zmx-1".into(), mode: "".into(), agent: "kirocrew-conductor".into(), origin: "zeromux".into() }
    }

    #[test]
    fn fold_ledger_key_matches_upstream_rule() {
        for k in ["dashboard:chat-1", "dashboard_chat-1", "dashboard_dashboard_chat-1", "chat-1"] { assert_eq!(fold_ledger_key(k), "chat-1", "{k}"); }
    }

    #[test]
    fn spawn_filters_by_parent_and_derives_state() {
        let v = json!({"agents":[
            {"id":"a","task":"修复登录重定向\n细节","done":false,"parent":"dashboard:zmx-1","turns":7,"last_tool":"grep","elapsed":312},
            {"id":"b","task":"x","done":true,"parent":"dashboard:zmx-1","error":"boom","result":""},
            {"id":"c","task":"x","done":true,"parent":"dashboard:zmx-1","stopped":true,"error":""},
            {"id":"d","task":"x","done":false,"parent":"dashboard:zmx-1","awaiting_approval":true},
            {"id":"e","task":"x","done":true,"parent":"dashboard:zmx-1","result":"结论首行\n二"},
            {"id":"z","task":"other","done":false,"parent":"dashboard:chat-9"},
            "garbage", {"id": 5}
        ]});
        let s = project_spawn(&v, "zmx-1");
        let st: Vec<_> = s.iter().map(|x| (x["id"].as_str().unwrap(), x["state"].as_str().unwrap())).collect();
        assert_eq!(st, vec![("a","running"),("b","failed"),("c","stopped"),("d","awaiting"),("e","done")]);
        assert_eq!(s[0]["title"], "修复登录重定向");
        assert_eq!((s[0]["elapsed_s"].as_u64(), s[0]["turns"].as_u64()), (Some(312), Some(7)));
        assert_eq!(s[4]["last"], "结论首行");
    }

    #[test]
    fn ledger_projection_is_lenient() {
        let children = vec![json!({"slot":"chat-7"})];
        let v = json!({"state":{"goal":"清零 flaky","phase":"patrol","next":"等 #123 CI","artifacts":{
            "item-1": "{\"accept\":{\"kind\":\"pr_checks\"},\"session\":\"dashboard_chat-7\",\"round\":2,\"status\":\"running\",\"fails\":1}",
            "item-2": "{\"round\":1,\"status\":\"pass\"}",
            "item-3": "not json",
            "item-4": 42,
            "item-5": "{\"round\":1,\"status\":\"weird\"}",
            "item-6": "[1,2]",
            "notes": "ignored: not item-*"
        }},"events":[{"ts":"2026-09-29T10:00:00Z","kind":"progress","text":"派发 3 项"}, 7]});
        let l = project_ledger(&v, &children);
        assert_eq!((l["goal"].as_str(), l["round"].as_u64()), (Some("清零 flaky"), Some(2)));
        let items = l["items"].as_array().unwrap();
        assert_eq!(items.len(), 6, "bad values keep their row as unknown");
        let by = |k: &str| items.iter().find(|i| i["key"] == k).unwrap().clone();
        assert_eq!((by("item-1")["status"].as_str(), by("item-1")["accept_kind"].as_str(), by("item-1")["child_slot"].as_str()), (Some("running"), Some("pr_checks"), Some("chat-7")));
        assert!(by("item-2")["accept_kind"].is_null(), "rotated terminal entry keeps only round/status");
        for k in ["item-3","item-4","item-5","item-6"] { assert_eq!(by(k)["status"], "unknown", "{k}"); }
        assert_eq!(items[0]["key"], "item-1", "running sorts before pass");
        assert_eq!(l["events"].as_array().unwrap().len(), 1);
        assert!(project_ledger(&json!({"state":{}}), &[])["items"].as_array().unwrap().is_empty(), "artifacts missing");
    }

    #[test]
    fn children_come_from_snapshot_created_by() {
        let snap = SlotsSnapshot { gateway_ok: true, slots: vec![slot("zmx-1", None), slot("chat-7", Some("zmx-1")), slot("chat-8", Some("other"))], ..Default::default() };
        let bound = [("chat-7".to_string(), "sid-7".to_string())].into_iter().collect();
        let c = project_children(&snap, "zmx-1", &bound);
        assert_eq!(c.len(), 1);
        assert_eq!((c[0]["slot"].as_str(), c[0]["attached_sid"].as_str()), (Some("chat-7"), Some("sid-7")));
    }

    #[tokio::test]
    async fn tasks_ledger_request_carries_internal_secret_and_dashboard_session_key() {
        // D-R3: /api/session-ledger is STRICT — secret only, identity from X-Session-Key.
        let gw = MockGw::start(vec![
            ("GET /api/spawn", 200, json!({"agents":[]})),
            ("GET /api/session-ledger", 200, json!({"state":{"goal":"g","artifacts":{}},"events":[]})),
        ]).await;
        let (t, _d) = gw.target_with_secret("sec-L");
        let snap = SlotsSnapshot { gateway_ok: true, slots: vec![slot("zmx-1", None)], ..Default::default() };
        let out = fetch_tasks(&t, &snap, &conductor(), &Default::default(), None).await;
        let r = gw.requests().into_iter().find(|r| r.path == "/api/session-ledger").expect("ledger requested");
        assert_eq!(r.headers.get("x-internal-secret").map(String::as_str), Some("sec-L"));
        assert_eq!(r.headers.get("x-session-key").map(String::as_str), Some("dashboard:zmx-1"));
        assert!(r.headers.get("cookie").is_none(), "strict path: no cookie fallback");
        assert_eq!(out["ledger"]["goal"], "g");
    }

    #[tokio::test]
    async fn tasks_non_conductor_skips_ledger_and_ledger_error_is_isolated() {
        let gw = MockGw::start(vec![
            ("GET /api/spawn", 200, json!({"agents":[{"id":"a","task":"t","done":false,"parent":"dashboard:zmx-1"}]})),
            ("GET /api/session-ledger", 400, json!({"code":"unknown_session"})),
        ]).await;
        let (t, _d) = gw.target_with_secret("s");
        let snap = SlotsSnapshot { gateway_ok: true, slots: vec![slot("zmx-1", None)], ..Default::default() };
        let chat = CrewBinding { agent: "".into(), ..conductor() };
        let out = fetch_tasks(&t, &snap, &chat, &Default::default(), Some("- **a** — running: x".into())).await;
        assert!(gw.requests().iter().all(|r| r.path != "/api/session-ledger"));
        assert!(out["ledger"].is_null());
        assert_eq!(out["meta_text"], "- **a** — running: x");
        let out2 = fetch_tasks(&t, &snap, &conductor(), &Default::default(), None).await;
        assert!(out2["ledger"].is_null());
        assert_eq!(out2["errors"], json!(["ledger"]));
        assert_eq!(out2["subagents"].as_array().unwrap().len(), 1, "spawn unaffected");
    }

    #[tokio::test]
    async fn tasks_snapshot_missing_slot_and_gateway_down() {
        let d = tempfile::tempdir().unwrap();
        let t = GwTarget { base: "http://127.0.0.1:9".into(), crew_home: d.path().into(), port: 9 };
        let snap = SlotsSnapshot::default(); // gateway_ok=false, never refreshed
        let out = fetch_tasks(&t, &snap, &conductor(), &Default::default(), None).await;
        assert_eq!(out["gateway_ok"], false);
        assert!(out["slot"].is_null());
    }
```

`session_manager.rs` 的 `mod tests` 追加：

```rust
    #[test]
    fn crew_slot_bindings_maps_every_crew_session() {
        let (m, _d) = make_manager();
        let mut a = make_session("a", "o"); a.session_type = SessionType::Crew; a.resume_token = Some(ResumeToken::Crew("zmx-a".into()));
        let mut b = make_session("b", "o"); b.resume_token = Some(ResumeToken::Claude("x".into()));
        m.sessions.lock().unwrap().insert("a".into(), a);
        m.sessions.lock().unwrap().insert("b".into(), b);
        let map = m.crew_slot_bindings();
        assert_eq!(map.len(), 1);
        assert_eq!(map.get("zmx-a").map(String::as_str), Some("a"));
    }
```

- [ ] **Step 2: 确认失败**

Run: `cargo test crew_proxy crew_slot_bindings`
Expected: 编译失败。

- [ ] **Step 3: 实现**

`session_manager.rs`（放在 `crew_meta_text` 后面）：

```rust
    /// slot_key → session id for every Crew session (tracked keys, G4 attached_sid / G6 exclusion).
    pub fn crew_slot_bindings(&self) -> std::collections::HashMap<String, String> {
        self.sessions.lock().unwrap().values().filter_map(|s| match (&s.resume_token, s.session_type) {
            (Some(ResumeToken::Crew(k)), SessionType::Crew) => Some((k.clone(), s.id.clone())),
            _ => None,
        }).collect()
    }
```

`crew_proxy.rs`：

```rust
use crate::crew_watch::{SlotsSnapshot, SlotView};
use crate::session_manager::CrewBinding;
use std::collections::HashMap;

/// Same rule as KC/session_ledger.py ledger_key: strip `dashboard:` once, then
/// any number of `dashboard_`.
pub fn fold_ledger_key(s: &str) -> &str {
    let mut k = s.strip_prefix("dashboard:").unwrap_or(s);
    while let Some(r) = k.strip_prefix("dashboard_") { k = r; }
    k
}

fn s(v: &Value, k: &str) -> Option<String> { v.get(k).and_then(Value::as_str).map(String::from) }

/// `/api/spawn` entries of THIS slot only (parent == "dashboard:"+slot, D-G4).
pub fn project_spawn(v: &Value, slot_key: &str) -> Vec<Value> {
    let parent = format!("dashboard:{slot_key}");
    v.get("agents").and_then(Value::as_array).into_iter().flatten()
        .filter(|a| a.get("parent").and_then(Value::as_str) == Some(parent.as_str()))
        .filter_map(|a| {
            let id = a.get("id")?.as_str()?;
            let done = a.get("done").and_then(Value::as_bool).unwrap_or(false);
            let err = s(a, "error").filter(|e| !e.is_empty());
            let state = if done && err.is_some() { "failed" }
                else if done && a.get("stopped").and_then(Value::as_bool).unwrap_or(false) { "stopped" }
                else if done { "done" }
                else if a.get("awaiting_approval").and_then(Value::as_bool).unwrap_or(false) { "awaiting" }
                else { "running" };
            let last = if done { err.or_else(|| s(a, "result")) } else { s(a, "last_tool") };
            Some(serde_json::json!({
                "id": id, "state": state,
                "title": s(a, "task").map(|t| first_line(&t, 80)),
                "last": last.map(|t| first_line(&t, 120)),
                "elapsed_s": u(a, "elapsed"), "turns": u(a, "turns"),
            }))
        }).collect()
}

pub fn project_slot(sv: &SlotView) -> Value {
    serde_json::json!({ "key": sv.key, "mode": sv.mode, "agent": sv.agent, "queue_depth": sv.queue_depth,
        "subagents_running": sv.subagents_running, "needs_input": sv.needs_input || sv.pending_approval })
}

/// Child slots = snapshot entries whose `created_by` is this slot (D-G5, same
/// source as S6 children_by_parent).
pub fn project_children(snap: &SlotsSnapshot, slot_key: &str, bound: &HashMap<String, String>) -> Vec<Value> {
    snap.slots.iter().filter(|c| c.created_by.as_deref() == Some(slot_key)).map(|c| serde_json::json!({
        "slot": c.key, "title": c.title, "running": c.running || c.subagents_running,
        "needs_input": c.needs_input || c.pending_approval, "attached_sid": bound.get(&c.key),
    })).collect()
}

fn status_rank(st: &str) -> u8 { match st { "running" => 0, "waiting" => 1, "fail" => 2, "pass" => 3, _ => 4 } }

/// goal-conductor ledger → card. Each `item-*` value is a JSON STRING; undecodable
/// values keep their row as `unknown` (decode, never validate — §2.4).
pub fn project_ledger(v: &Value, children: &[Value]) -> Value {
    let st = v.get("state").cloned().unwrap_or(Value::Null);
    let mut items: Vec<Value> = st.get("artifacts").and_then(Value::as_object).into_iter().flatten()
        .filter(|(k, _)| k.starts_with("item-"))
        .map(|(k, raw)| {
            let obj = raw.as_str().and_then(|x| serde_json::from_str::<Value>(x).ok()).filter(Value::is_object);
            let Some(o) = obj else { return serde_json::json!({"key": k, "status": "unknown"}) };
            let status = s(&o, "status").filter(|x| ["running", "waiting", "pass", "fail"].contains(&x.as_str()))
                .unwrap_or_else(|| "unknown".into());
            let session = s(&o, "session");
            let child = session.as_deref().map(fold_ledger_key)
                .filter(|k2| children.iter().any(|c| c["slot"].as_str() == Some(*k2))).map(String::from);
            serde_json::json!({ "key": k, "status": status, "round": u(&o, "round"),
                "accept_kind": o.get("accept").and_then(|a| a.get("kind")).and_then(Value::as_str),
                "session": session, "child_slot": child, "fails": u(&o, "fails") })
        }).collect();
    items.sort_by(|a, b| status_rank(a["status"].as_str().unwrap_or("")).cmp(&status_rank(b["status"].as_str().unwrap_or("")))
        .then_with(|| a["key"].as_str().cmp(&b["key"].as_str())));
    let round = items.iter().filter_map(|i| i["round"].as_u64()).max();
    let events: Vec<Value> = v.get("events").and_then(Value::as_array).into_iter().flatten()
        .filter(|e| e.is_object())
        .map(|e| serde_json::json!({ "ts": s(e, "ts"), "kind": s(e, "kind"), "text": s(e, "text").map(|t| t.chars().take(200).collect::<String>()) }))
        .collect();
    serde_json::json!({ "goal": s(&st, "goal"), "phase": s(&st, "phase"), "next": s(&st, "next"),
        "round": round, "items": items, "events": events })
}

pub async fn fetch_tasks(t: &GwTarget, snap: &SlotsSnapshot, b: &CrewBinding, bound: &HashMap<String, String>, meta_text: Option<String>) -> Value {
    let slot = snap.slots.iter().find(|x| x.key == b.slot_key).map(project_slot);
    let children = project_children(snap, &b.slot_key, bound);
    let Ok(http) = http_client() else { return serde_json::json!({"gateway_ok": false, "slot": slot}) };
    let is_conductor = b.agent == "kirocrew-conductor";
    let ledger_key = format!("dashboard:{}", b.slot_key);
    let (spawn, ledger) = tokio::join!(
        gw_get_secret(t, &http, "/api/spawn", None),
        async { if is_conductor { Some(gw_get_secret(t, &http, "/api/session-ledger", Some(&ledger_key)).await) } else { None } },
    );
    let gateway_ok = spawn.is_ok() || matches!(ledger, Some(Ok(_)));
    let mut errors = vec![];
    if spawn.is_err() && gateway_ok { errors.push("spawn"); }
    let ledger_v = match ledger {
        Some(Ok(v)) => project_ledger(&v, &children),
        Some(Err(_)) => { errors.push("ledger"); Value::Null }
        None => Value::Null,
    };
    let mut out = serde_json::json!({
        "gateway_ok": gateway_ok, "slot": slot, "children": children, "meta_text": meta_text,
        "subagents": spawn.map(|v| project_spawn(&v, &b.slot_key)).unwrap_or_default(),
        "ledger": ledger_v,
    });
    if !errors.is_empty() { out["errors"] = serde_json::json!(errors); }
    out
}

/// `GET /api/sessions/{id}/crew/tasks` (G4/G5).
pub async fn get_crew_tasks(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<Value>, StatusCode> {
    let b = owned_crew(&state, &user, &id)?;
    let snap = state.crew_watch.snapshot();
    let bound = state.sessions.crew_slot_bindings();
    let out = fetch_tasks(&GwTarget::from_state(&state), &snap, &b, &bound, state.sessions.crew_meta_text(&id)).await;
    if out["gateway_ok"].as_bool() == Some(true) {
        tracing::info!(target: "zmx_usage", "crew_tasks_open sid={} conductor={}", id, b.agent == "kirocrew-conductor");
    }
    Ok(Json(out))
}
```

`web.rs` 路由加 `.route("/api/sessions/{id}/crew/tasks", get(crate::crew_proxy::get_crew_tasks))`。

- [ ] **Step 4: 确认通过**

Run: `cargo test crew_proxy crew_slot_bindings && cargo test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/crew_proxy.rs src/session_manager.rs src/web.rs src/crew_proxy
git commit -m "feat(G4/G5): /crew/tasks — spawn by parent, ledger via X-Session-Key, children from crew_watch snapshot (S7-e)"
```

---

### Task 21: 前端「子任务」tab（`CrewTasksPanel` + `crewMeta`）

**Files:**
- Create: `frontend/src/lib/crewMeta.ts`、`frontend/src/lib/__tests__/crewMeta.test.ts`
- Create: `frontend/src/components/crew/CrewTasksPanel.tsx`、`frontend/src/components/crew/__tests__/CrewTasksPanel.test.tsx`
- Modify: `frontend/src/lib/api/crew.ts`（`CrewTasks` 类型与 `getCrewTasks`）
- Modify: `frontend/src/components/shell/lazyPanels.ts`（末尾加 `CrewTasksPanel`）
- Modify: `frontend/src/components/shell/useShellState.ts:14`（`ContextTab` 加 `'tasks'`）
- Modify: `frontend/src/components/shell/ContextPanel.tsx`（`TAB_LABEL` `:9`、`tabs` `:33`、`pane` 列表 `:57-68`、新增 prop `onOpenSlot`）
- Modify: `frontend/src/components/shell/AppShell.tsx`（两处 `<ContextPanel …>`，当前 `:246`、`:254`）
- Test: `frontend/src/components/shell/__tests__/ContextPanel.test.tsx`

**Interfaces:**
- Consumes: Task 18 的 `formatPatrol`、`getCrewPatrol`；Task 20 的响应结构。
- Produces:
  - `parseCrewMeta(text): MetaTopic[]`，其中 `MetaTopic { title: string; status: string; queued: number; digest: string }`
  - `alignTopics(subagents, topics)`
  - `CrewTasksPanel({ sessionId, conductor, showing, onOpen(slot, title, attachedSid) })`
  - `ContextPanelProps.onOpenSlot?(slot: string, title: string | null, attachedSid: string | null): void`

- [ ] **Step 1: 写失败测试**

```ts
// frontend/src/lib/__tests__/crewMeta.test.ts
import { describe, it, expect } from 'vitest'
import { parseCrewMeta, alignTopics } from '../crewMeta'

const META = [
  "Here's what's in flight:",
  '- **修复登录重定向** — running (+2 queued): 查 cookie 域',
  '- **调研缓存失效** — waiting: just started',
  '- **全角：标点，也行** — running: 进行中',
  '  - **缩进行不算** — running: x',
  'random line',
].join('\n')

describe('parseCrewMeta', () => {
  it('parses the KC/crew_chat.py _render_topics format', () => {
    expect(parseCrewMeta(META)).toEqual([
      { title: '修复登录重定向', status: 'running', queued: 2, digest: '查 cookie 域' },
      { title: '调研缓存失效', status: 'waiting', queued: 0, digest: 'just started' },
      { title: '全角：标点，也行', status: 'running', queued: 0, digest: '进行中' },
    ])
  })
  it('empty / nothing in flight', () => {
    expect(parseCrewMeta('')).toEqual([])
    expect(parseCrewMeta("Nothing in flight right now — everything's wrapped up.")).toEqual([])
  })
})

describe('alignTopics', () => {
  it('prefix-matches meta topics to subagents; leftovers are meta-only', () => {
    const r = alignTopics([{ id: 'a', title: '修复登录重定向 (detail)' }], parseCrewMeta(META))
    expect(r.matched.a).toMatchObject({ queued: 2, digest: '查 cookie 域' })
    expect(r.metaOnly.map(t => t.title)).toEqual(['调研缓存失效', '全角：标点，也行'])
  })
})
```

```tsx
// frontend/src/components/crew/__tests__/CrewTasksPanel.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import CrewTasksPanel from '../CrewTasksPanel'
import * as api from '../../../lib/api'

const T = (over: Partial<api.CrewTasks> = {}): api.CrewTasks => ({
  gateway_ok: true,
  slot: { key: 'zmx-1', mode: '', agent: 'kirocrew-conductor', queue_depth: 0, subagents_running: true, needs_input: false },
  subagents: [{ id: 'a', title: '修复登录', state: 'running', last: 'grep', elapsed_s: 312, turns: 7 }],
  children: [{ slot: 'chat-7', title: 'worker', running: true, needs_input: true, attached_sid: null }],
  meta_text: null,
  ledger: { goal: '清零 flaky', phase: 'patrol', next: '等 #123 CI', round: 2, events: [],
    items: [{ key: 'item-1', status: 'running', round: 2, accept_kind: 'pr_checks', session: 'dashboard_chat-7', child_slot: 'chat-7', fails: 1 },
            { key: 'item-2', status: 'pass', round: 1, accept_kind: null, session: null, child_slot: null, fails: null }] },
  ...over,
})

describe('CrewTasksPanel', () => {
  afterEach(() => vi.restoreAllMocks())

  it('goal card, items, subagents, children; open unattached child → onOpen(slot,title,null)', async () => {
    vi.spyOn(api, 'getCrewTasks').mockResolvedValue(T())
    vi.spyOn(api, 'getCrewPatrol').mockResolvedValue({ gateway_ok: true, kind: 'monitor', cycle: 3, max_cycles: 24, active: true, next_in_s: 118 })
    const onOpen = vi.fn()
    render(<CrewTasksPanel sessionId="s" conductor showing onOpen={onOpen} />)
    expect(await screen.findByText('清零 flaky')).toBeInTheDocument()
    expect(screen.getByText(/第 2 轮 · 1\/2 通过|第 2 轮/)).toBeInTheDocument()
    expect(await screen.findByText('巡检 3/24 · 约 2m')).toBeInTheDocument()
    expect(screen.getByText('修复登录')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: /打开 worker/ })[0])
    expect(onOpen).toHaveBeenCalledWith('chat-7', 'worker', null)
  })

  it('no ledger yet → conductor hint; ledger error → unreadable', async () => {
    vi.spyOn(api, 'getCrewPatrol').mockResolvedValue({ gateway_ok: true, kind: 'none' })
    const g = vi.spyOn(api, 'getCrewTasks').mockResolvedValue(T({ ledger: { goal: '', phase: '', next: '', round: null, items: [], events: [] } }))
    const { unmount } = render(<CrewTasksPanel sessionId="s" conductor showing onOpen={() => {}} />)
    expect(await screen.findByText(/conductor 尚未记录目标/)).toBeInTheDocument()
    unmount()
    g.mockResolvedValue(T({ ledger: null, errors: ['ledger'] }))
    render(<CrewTasksPanel sessionId="s" conductor showing onOpen={() => {}} />)
    expect(await screen.findByText('目标记录不可读')).toBeInTheDocument()
  })

  it('gateway down keeps last data greyed with a banner', async () => {
    vi.spyOn(api, 'getCrewPatrol').mockResolvedValue({ gateway_ok: false })
    const g = vi.spyOn(api, 'getCrewTasks').mockResolvedValueOnce(T()).mockResolvedValueOnce({ gateway_ok: false } as api.CrewTasks)
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(<CrewTasksPanel sessionId="s" conductor={false} showing onOpen={() => {}} />)
    expect(await screen.findByText('修复登录')).toBeInTheDocument()
    await act(async () => { vi.advanceTimersByTime(10_000) })
    expect(await screen.findByText('Crew Gateway 未运行')).toBeInTheDocument()
    expect(screen.getByText('修复登录')).toBeInTheDocument()
    expect(g).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('stale response: a slow earlier request cannot overwrite a newer one', async () => {
    vi.spyOn(api, 'getCrewPatrol').mockResolvedValue({ gateway_ok: true, kind: 'none' })
    let slowResolve!: (v: api.CrewTasks) => void
    vi.spyOn(api, 'getCrewTasks')
      .mockImplementationOnce(() => new Promise(r => { slowResolve = r }))
      .mockResolvedValueOnce(T({ subagents: [{ id: 'b', title: '新的', state: 'running', last: null, elapsed_s: 1, turns: 1 }] }))
    const { rerender } = render(<CrewTasksPanel sessionId="s1" conductor={false} showing onOpen={() => {}} />)
    rerender(<CrewTasksPanel sessionId="s2" conductor={false} showing onOpen={() => {}} />)
    expect(await screen.findByText('新的')).toBeInTheDocument()
    await act(async () => { slowResolve(T({ subagents: [{ id: 'x', title: '旧的', state: 'running', last: null, elapsed_s: 1, turns: 1 }] })) })
    expect(screen.queryByText('旧的')).toBeNull()
  })

  it('not showing → no polling', () => {
    const g = vi.spyOn(api, 'getCrewTasks').mockResolvedValue(T())
    render(<CrewTasksPanel sessionId="s" conductor showing={false} onOpen={() => {}} />)
    expect(g).not.toHaveBeenCalled()
  })
})
```

`ContextPanel.test.tsx` 追加。`vi.mock('../lazyPanels'` 的返回对象里要加上 `CrewTasksPanel: () => <div>TASKS</div>,`：

```tsx
  it('子任务 tab only for crew sessions', () => {
    const { unmount } = render(<Harness session={mkSession('c', { type: 'crew' })} />)
    expect(screen.getByRole('radio', { name: '子任务' })).toBeInTheDocument()
    unmount()
    render(<Harness session={mkSession('a')} />)
    expect(screen.queryByRole('radio', { name: '子任务' })).toBeNull()
  })
```

- [ ] **Step 2: 确认失败**

Run: `cd frontend && npx vitest run src/lib/__tests__/crewMeta.test.ts src/components/crew src/components/shell/__tests__/ContextPanel.test.tsx`
Expected: FAIL。

- [ ] **Step 3: 实现**

```ts
// frontend/src/lib/crewMeta.ts
/** Parse a `crew_meta` overview (KC/crew_chat.py _render_topics:
 *  "- **title** — status (+n queued): digest"). Non-matching lines are ignored. */
export interface MetaTopic { title: string; status: string; queued: number; digest: string }

const LINE = /^- \*\*(.+?)\*\* — (\S+)(?: \(\+(\d+) queued\))?: (.*)$/

export function parseCrewMeta(text: string | null | undefined): MetaTopic[] {
  if (!text) return []
  return text.split('\n').flatMap(l => {
    const m = LINE.exec(l)
    return m ? [{ title: m[1], status: m[2], queued: m[3] ? Number(m[3]) : 0, digest: m[4] }] : []
  })
}

/** Pair meta topics with subagents by title prefix; unmatched topics are
 *  "只在上次概览里出现". */
export function alignTopics(subs: { id: string; title?: string | null }[], topics: MetaTopic[]) {
  const matched: Record<string, MetaTopic> = {}
  const used = new Set<number>()
  for (const s of subs) {
    const t = s.title ?? ''
    const i = topics.findIndex((x, j) => !used.has(j) && (t.startsWith(x.title) || x.title.startsWith(t)) && t !== '')
    if (i >= 0) { matched[s.id] = topics[i]; used.add(i) }
  }
  return { matched, metaOnly: topics.filter((_, j) => !used.has(j)) }
}
```

`frontend/src/lib/api/crew.ts` 追加：

```ts
export interface CrewSubagent { id: string; title: string | null; state: 'running' | 'done' | 'failed' | 'stopped' | 'awaiting'; last: string | null; elapsed_s: number | null; turns: number | null }
export interface CrewChild { slot: string; title: string | null; running: boolean; needs_input: boolean; attached_sid: string | null }
export interface LedgerItem { key: string; status: 'running' | 'waiting' | 'pass' | 'fail' | 'unknown'; round: number | null; accept_kind: string | null; session: string | null; child_slot: string | null; fails: number | null }
export interface CrewLedger { goal: string | null; phase: string | null; next: string | null; round: number | null; items: LedgerItem[]; events: { ts: string | null; kind: string | null; text: string | null }[] }
export interface CrewTasks {
  gateway_ok: boolean
  slot?: { key: string; mode: string | null; agent: string | null; queue_depth: number; subagents_running: boolean; needs_input: boolean } | null
  subagents?: CrewSubagent[]; children?: CrewChild[]; meta_text?: string | null
  ledger?: CrewLedger | null; errors?: string[]
}
export async function getCrewTasks(sid: string): Promise<CrewTasks> {
  const res = await api(`/api/sessions/${sid}/crew/tasks`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}
```

`frontend/src/components/crew/CrewTasksPanel.tsx`：

```tsx
import { useCallback, useEffect, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { getCrewTasks, getCrewPatrol, type CrewTasks, type CrewPatrol, type LedgerItem } from '../../lib/api'
import { useLatestRequest } from '../../lib/useLatestRequest'
import { usePolling } from '../../lib/usePolling'
import { formatPatrol } from '../../lib/patrol'
import { parseCrewMeta, alignTopics } from '../../lib/crewMeta'
import { formatDuration } from '../../lib/format'
import { StatusDot } from '../ui'

type Tone = React.ComponentProps<typeof StatusDot>['tone']
const SUB_TONE: Record<string, Tone> = { running: 'running', awaiting: 'ask', failed: 'error', stopped: 'muted', done: 'done' }
const SUB_LABEL: Record<string, string> = { running: '运行', awaiting: '待批准', failed: '失败', stopped: '已停', done: '完成' }
const ITEM_TONE: Record<LedgerItem['status'], Tone> = { running: 'running', waiting: 'ask', fail: 'error', pass: 'done', unknown: 'muted' }

/** G4/G5: 子任务 tab. Polls every 10s only while visible (spec §2.3); children and
 *  slot come from the 30s crew_watch snapshot, so only subagents/ledger move faster. */
export default function CrewTasksPanel({ sessionId, conductor, showing, onOpen }: {
  sessionId: string; conductor: boolean; showing: boolean
  onOpen(slot: string, title: string | null, attachedSid: string | null): void
}) {
  const [data, setData] = useState<CrewTasks | null>(null)
  const [down, setDown] = useState(false)
  const [patrol, setPatrol] = useState<CrewPatrol | null>(null)
  const [showDone, setShowDone] = useState(false)
  const req = useLatestRequest()
  useEffect(() => { req.bump(); setData(null); setDown(false) }, [sessionId, req])

  const load = useCallback(async () => {
    const t = req.begin()
    try {
      const [d, p] = await Promise.all([getCrewTasks(sessionId), conductor ? getCrewPatrol(sessionId).catch(() => null) : Promise.resolve(null)])
      if (!req.isCurrent(t)) return
      if (!d.gateway_ok) { setDown(true); return }   // keep last data, grey it
      setDown(false); setData(d); setPatrol(p)
    } catch { if (req.isCurrent(t)) setDown(true) }
  }, [sessionId, conductor, req])
  usePolling(load, 10_000, { enabled: showing })

  if (!data && !down) return <div className="p-3 text-ui-sm text-[var(--fg-subtle)]">加载中...</div>
  const d = data ?? { gateway_ok: false }
  if (d.gateway_ok && d.slot === null) return <div className="p-3 text-ui-sm text-[var(--fg-subtle)]">Crew slot 已不存在</div>
  const subs = d.subagents ?? []
  const { matched, metaOnly } = alignTopics(subs, parseCrewMeta(d.meta_text))
  const items = d.ledger?.items ?? []
  const shownItems = showDone ? items : items.filter(i => i.status !== 'pass' && i.status !== 'fail')
  const pass = items.filter(i => i.status === 'pass').length, fail = items.filter(i => i.status === 'fail').length
  const pf = formatPatrol(patrol)
  const needsYou = (d.children ?? []).filter(c => c.needs_input).length + (d.slot?.needs_input ? 1 : 0)
  const openBtn = (slot: string, title: string | null, sid: string | null) => (
    <button type="button" aria-label={`打开 ${title ?? slot}`} onClick={() => onOpen(slot, title, sid)}
      className="shrink-0 inline-flex items-center gap-1 min-h-[var(--hit)] px-2 rounded-[var(--r-md)] text-ui-xs text-[var(--accent)] hover:bg-[var(--surface-hover)]">
      <ExternalLink size={12} />打开
    </button>
  )

  return (
    <div className={`h-full overflow-y-auto p-3 space-y-3 ${down ? 'opacity-60' : ''}`}>
      {down && <div className="text-ui-xs text-[var(--fg-muted)] bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1">Crew Gateway 未运行</div>}
      {conductor && (
        <section className="rounded-[var(--r-md)] border border-[var(--border)] bg-[var(--surface-2)] p-3 space-y-1">
          {d.ledger === null && d.errors?.includes('ledger') ? <div className="text-ui-sm text-[var(--fg-muted)]">目标记录不可读</div>
            : !d.ledger?.goal ? <div className="text-ui-sm text-[var(--fg-muted)]">conductor 尚未记录目标(第 0 轮等待你确认计划)</div>
            : <>
                <div className="text-ui-sm font-medium text-[var(--fg-strong)]">{d.ledger.goal}</div>
                <div className="text-ui-xs text-[var(--fg-muted)]">{`第 ${d.ledger.round ?? 0} 轮 · ${pass}/${items.length} 通过${fail ? ` · ${fail} 失败` : ''}${d.ledger.phase ? ` · 阶段 ${d.ledger.phase}` : ''}`}</div>
                {d.ledger.next && <div className="text-ui-xs text-[var(--fg-muted)]">{`下一步:${d.ledger.next}`}</div>}
              </>}
          {pf && <div className="text-ui-xs text-[var(--fg-subtle)]">{`巡检 ${pf.text}`}</div>}
          {needsYou > 0 && <div className="text-ui-xs text-[var(--attention)]">{`${needsYou} 个待回答 → 回到对话`}</div>}
        </section>
      )}
      {conductor && items.length > 0 && (
        <section className="space-y-1">
          {shownItems.map(i => (
            <div key={i.key} className="flex items-center gap-2 text-ui-xs">
              <StatusDot tone={ITEM_TONE[i.status]} label={i.status} />
              <span className="shrink-0 text-[var(--fg-muted)]">{i.key}</span>
              <span className="flex-1 truncate text-[var(--fg-subtle)]">{i.accept_kind ?? '—'}{i.fails ? ` · 失败 ${i.fails}` : ''}</span>
              {i.child_slot && openBtn(i.child_slot, i.key, (d.children ?? []).find(c => c.slot === i.child_slot)?.attached_sid ?? null)}
            </div>
          ))}
          {items.length !== shownItems.length && <button type="button" onClick={() => setShowDone(true)} className="text-ui-2xs text-[var(--fg-subtle)]">{`显示已结束 (${items.length - shownItems.length})`}</button>}
        </section>
      )}
      <section className="space-y-1">
        {subs.map(s => (
          <div key={s.id} className="flex items-center gap-2 text-ui-xs">
            <StatusDot tone={SUB_TONE[s.state]} label={SUB_LABEL[s.state]} />
            <span className="min-w-0 flex-1 truncate text-[var(--fg)]">{s.title}</span>
            <span className="shrink-0 truncate text-[var(--fg-subtle)]">
              {[matched[s.id]?.queued ? `+${matched[s.id].queued} 排队` : '', s.state === 'running' && s.elapsed_s != null ? formatDuration(s.elapsed_s * 1000) : '', s.turns ? `${s.turns} 步` : '', s.state !== 'running' ? s.last ?? '' : ''].filter(Boolean).join(' · ')}
            </span>
          </div>
        ))}
        {metaOnly.map(t => (
          <div key={`m:${t.title}`} className="flex items-center gap-2 text-ui-xs text-[var(--fg-subtle)]">
            <StatusDot tone="muted" label={t.status} /><span className="flex-1 truncate">{t.title}</span><span className="shrink-0">来自上次概览</span>
          </div>
        ))}
        {subs.length === 0 && metaOnly.length === 0 && !d.meta_text && <div className="text-ui-xs text-[var(--fg-subtle)]">发一句「在忙什么」可刷新话题</div>}
      </section>
      {(d.children ?? []).length > 0 && (
        <section className="space-y-1">
          {(d.children ?? []).map(c => (
            <div key={c.slot} className="flex items-center gap-2 text-ui-xs">
              <StatusDot tone={c.needs_input ? 'ask' : c.running ? 'running' : 'muted'} label={c.needs_input ? '需要你' : c.running ? '运行' : '空闲'} />
              <span className="min-w-0 flex-1 truncate">{c.title ?? c.slot}</span>
              {openBtn(c.slot, c.title, c.attached_sid)}
            </div>
          ))}
        </section>
      )}
    </div>
  )
}
```

`StatusDot` 的 tone 取值以 `components/ui` 的实际类型为准（`ToneOf` 映射见 `lib/triage.ts:40-48`）。上面用到了 `'running' | 'ask' | 'error' | 'done' | 'muted'`。如果类型里没有其中某个值，就映射到语义最接近的那个，并把 `SUB_TONE` / `ITEM_TONE` 同步改掉。

`lazyPanels.ts` 末尾加：

```ts
export const CrewTasksPanel = lazy(() => import('../crew/CrewTasksPanel'))
```

`useShellState.ts:14` 改为 `export type ContextTab = 'git' | 'files' | 'runs' | 'tasks'`。

`ContextPanel.tsx`：
- `TAB_LABEL` 加 `tasks: '子任务'`。
- `:33` 改为：
  ```tsx
  const tabs: ContextTab[] = session.type === 'crew' ? ['git', 'files', 'runs', 'tasks'] : agent ? ['git', 'files', 'runs'] : ['git', 'files']
  ```
- import 加 `CrewTasksPanel`；props 加 `onOpenSlot?(slot: string, title: string | null, attachedSid: string | null): void`，并在参数解构里加上。
- `runs` 那个 pane 后面加：
  ```tsx
        {session.type === 'crew' && pane('tasks', <CrewTasksPanel sessionId={session.id} conductor={session.crew_agent === 'kirocrew-conductor'}
          showing={showing && tab === 'tasks'} onOpen={(slot, title, sid) => onOpenSlot?.(slot, title, sid)} />)}
  ```

`AppShell.tsx` 的两处 `<ContextPanel …>` 都加：

```tsx
            onOpenSlot={(slot, title, sid) => { if (sid) shell.select(sid); else openPalette({ mode: 'search', text: title ?? slot }) }}
```

（D4：没有接入时打开 ⌘K，并用 slot 标题预填查询词。Task 24 会让 ⌘K 在这个查询词下列出「接入 Crew 会话」行。）

- [ ] **Step 4: 确认通过；首屏不含该面板**

```bash
cd frontend && npm test && npm run lint && npm run build
grep -l 'conductor 尚未记录目标' dist/assets/index-*.js && echo "LEAK into first screen" || echo "lazy OK"
```

Expected: 全绿；输出 `lazy OK`。

- [ ] **Step 5: Commit**

```bash
git add frontend/src
git commit -m "feat(G4/G5): 子任务 tab with goal card, items, subagents, child slots (lazy) (S7-e)"
```

---

### Task 22: G6 后端：`GET /api/crew/slots`（admin，读快照）

**Files:**
- Modify: `src/crew_proxy.rs`（`project_attach_list`、`is_valid_slot_key`、`list_crew_slots`）
- Modify: `src/web.rs`（路由）

**Interfaces:**
- Consumes: `SlotsSnapshot`、`crew_slot_bindings()`。
- Produces:
  - `pub fn is_valid_slot_key(k: &str) -> bool`（Task 23 复用）
  - `pub fn project_attach_list(snap: &SlotsSnapshot, tracked: &HashSet<String>, g3_live: bool) -> Value`
  - HTTP：`GET /api/crew/slots` → `{gateway_ok, refreshed_ms, slots:[{key,title,mode,agent,project,origin,created_by,running,needs_input,last_activity_ts,attachable,reason}]}`

`memory_mode` 不在 S6 `SlotView` 的字段里，所以 spec §3.2 的 `restricted` 标记在本期**不做**，按快照里有的字段处理。这一处已记入「spec 与代码不一致」。

- [ ] **Step 1: 写失败测试**

```rust
    #[test]
    fn attach_list_excludes_tracked_marks_orphans_and_g3() {
        let mut crew_mode = slot("chat-crew", None); crew_mode.mode = Some("crew".into());
        let snap = SlotsSnapshot { gateway_ok: true, refreshed_ms: Some(5), slots: vec![
            slot("zmx-tracked", None), slot("zmx-orphan", None), slot("chat-9", Some("zmx-tracked")), crew_mode,
            slot("bad/key", None),
        ], ..Default::default() };
        let tracked = ["zmx-tracked".to_string()].into_iter().collect();
        let v = project_attach_list(&snap, &tracked, false);
        let rows: Vec<_> = v["slots"].as_array().unwrap().iter().map(|r| (r["key"].as_str().unwrap(), r["attachable"].as_bool().unwrap(), r["reason"].as_str())).collect();
        assert_eq!(rows, vec![("zmx-orphan", true, Some("zmx_orphan")), ("chat-9", true, None), ("chat-crew", false, Some("needs_g3"))]);
        assert_eq!(project_attach_list(&snap, &tracked, true)["slots"].as_array().unwrap().iter()
            .find(|r| r["key"] == "chat-crew").unwrap()["attachable"], true, "G3 live → crew mode attachable");
    }

    #[test]
    fn slot_key_charset() {
        for ok in ["zmx-1a2b3c4d", "chat-1-1721.5", "cron:daily_x"] { assert!(is_valid_slot_key(ok), "{ok}"); }
        for bad in ["", "a/b", "a?b", "a%2f", "a b", &"x".repeat(200)] { assert!(!is_valid_slot_key(bad), "{bad}"); }
    }
```

- [ ] **Step 2: 确认失败**

Run: `cargo test attach_list slot_key_charset`
Expected: 编译失败。

- [ ] **Step 3: 实现**

```rust
/// Keys go into Gateway URL paths; allow only the charset real slot keys use.
pub fn is_valid_slot_key(k: &str) -> bool {
    !k.is_empty() && k.len() <= 128 && k.bytes().all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}

/// Set by S6 G3: whether crew-mode (topics) sessions have correct turn semantics.
/// D13: before G3, attaching a crew-mode slot would count every ack as a turn.
pub const G3_LIVE: bool = /* S7-e 前置检查第 8 条: yes → true, no → false */ false;

pub fn project_attach_list(snap: &SlotsSnapshot, tracked: &std::collections::HashSet<String>, g3_live: bool) -> Value {
    let rows: Vec<Value> = snap.slots.iter()
        .filter(|sv| is_valid_slot_key(&sv.key) && !tracked.contains(&sv.key))
        .map(|sv| {
            let crew_mode = sv.mode.as_deref() == Some("crew");
            let (attachable, reason) = if crew_mode && !g3_live { (false, Some("needs_g3")) }
                else if sv.key.starts_with("zmx-") { (true, Some("zmx_orphan")) }
                else { (true, None) };
            serde_json::json!({ "key": sv.key, "title": sv.title, "mode": sv.mode.clone().unwrap_or_default(), "agent": sv.agent,
                "project": sv.project, "origin": sv.origin, "created_by": sv.created_by, "running": sv.running,
                "needs_input": sv.needs_input || sv.pending_approval, "last_activity_ts": sv.last_activity_ts,
                "attachable": attachable, "reason": reason })
        }).collect();
    serde_json::json!({ "gateway_ok": snap.gateway_ok, "refreshed_ms": snap.refreshed_ms, "slots": rows })
}

/// `GET /api/crew/slots` — admin only (shared Gateway state, same gate as host tmux).
/// Snapshot read only: no upstream request, so opening ⌘K repeatedly costs nothing.
pub async fn list_crew_slots(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
) -> Result<Json<Value>, StatusCode> {
    if !user.is_admin() { return Err(StatusCode::FORBIDDEN); }
    let tracked = state.sessions.crew_slot_bindings().into_keys().collect();
    Ok(Json(project_attach_list(&state.crew_watch.snapshot(), &tracked, G3_LIVE)))
}
```

`G3_LIVE` 按 S7-e 前置检查第 8 条的结果填 `true` 或 `false`。S6 G3 以后上线时，把它改成 `true` 并同步改掉测试断言（一行改动）。

`web.rs` 路由加 `.route("/api/crew/slots", get(crate::crew_proxy::list_crew_slots))`。

- [ ] **Step 4: 确认通过**

Run: `cargo test attach_list slot_key_charset && cargo test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/crew_proxy.rs src/web.rs
git commit -m "feat(G6): admin /api/crew/slots attach list from crew_watch snapshot (S7-e)"
```

---

### Task 23: G6 后端：`crew_attach` 创建 external 会话；resume 不调 `set_project`；关闭不删 slot

**Files:**
- Modify: `src/acp/crew_process.rs`（`CrewProcess::spawn`，以及 S5 的 `SlotInit` 相关分支）
- Modify: `src/session_manager.rs`
  - `spawn_crew`（`:1667`）：新增 `attach_first: bool` 参数，用于发出 `System{attached}`
  - 新增 `pub async fn create_crew_attach_session`
  - `ensure_running`：external 会话 resume 失败时不回落（锚点 `Err(e) if attempted_resume =>`，当前 `:1847`）
- Modify: `src/web.rs`：`CreateSessionReq` 加 `crew_attach`；`create_session` 的 Crew 臂（`:939-943`）
- Test: `src/acp/crew_process.rs` 的 `mod tests`；`src/session_manager.rs` 新模块 `mod crew_attach_tests`

**Interfaces:**
- Consumes: S5 R4：`CrewProcess::spawn(cfg, work_dir, init: SlotInit)`，其中 `SlotInit::New{mode, agent}` / `SlotInit::Resume{key, owns}`；`owns=false` 时跳过 `set_slot_project`，Drop 时不删 slot；`spawn_crew` 从 `Session.crew.origin` 推出 `owns`。Task 16 的 `MockGw`、Task 22 的 `is_valid_slot_key`。
- Produces:
  - `SessionManager::create_crew_attach_session(&self, name: String, slot_key: &str, project: Option<&str>, owner_id: &str) -> Result<String, AttachError>`
  - `pub enum AttachError { BadKey, AlreadyTracked, WorkDir(String), Spawn(String) }`
  - `SessionManager::new_with_crew_http_base(..)` 仅用于测试：用 mock 的端口作为 `crew_port`，`crew_home` 指向 tempdir

Crew 的 HTTP base 由 `CrewConfig::new(crew_home, port)` 固定为 `http://127.0.0.1:{port}`，所以测试里把 manager 的 `crew_port` 设成 MockGw 的端口，`crew_home` 设成 `target_with_secret` 返回的 tempdir。这样可以驱动 `CrewProcess::spawn` 的真实代码路径。WS 连接会失败并进入退避，这不影响 REST 请求的记录。

- [ ] **Step 1: 写失败测试**

`src/session_manager.rs` 末尾追加：

```rust
#[cfg(test)]
mod crew_attach_tests {
    use super::*;
    use crate::mock_gateway::MockGw;
    use serde_json::json;

    /// Every test here reads HOME (work_dir_under_home) — hold the HOME lock with a
    /// temp HOME so the env-mutating tests can't race it (HOME_ENV_LOCK).
    fn home() -> super::sched_parity_tests::Home { super::sched_parity_tests::temp_home() }

    async fn setup(gw: &MockGw) -> (Arc<SessionManager>, tempfile::TempDir, tempfile::TempDir) {
        let (_t, crew_home) = gw.target_with_secret("sec");
        let data = tempfile::tempdir().unwrap();
        let events = Arc::new(crate::events::EventStore::open(data.path()).unwrap());
        let store = Arc::new(crate::session_store::SessionStore::open(data.path()).unwrap());
        let m = SessionManager::new(events, store, "claude".into(), "codex".into(), "off".into(),
            gw.port, crew_home.path().to_string_lossy().into(), "bash".into(), false,
            crate::tmux::TmuxCtl::new(Some("zmx-test-unused".into())));
        (m, data, crew_home)
    }

    fn slot_routes(key: &str) -> Vec<(String, u16, serde_json::Value)> {
        vec![(format!("GET /api/chat/slots/{key}"), 200, json!({"key": key}))]
    }

    async fn settle() { tokio::time::sleep(std::time::Duration::from_millis(150)).await; }

    fn rest_paths(gw: &MockGw) -> Vec<String> {
        gw.requests().into_iter()
            .filter(|r| r.path != "/api/token/local" && r.path != "/api/ws")
            .map(|r| format!("{} {}", r.method, r.path)).collect()
    }

    #[tokio::test]
    async fn attach_external_skips_project_and_never_deletes_slot() {
        let _h = home();
        let routes = slot_routes("chat-7");
        let gw = MockGw::start(routes.iter().map(|(a, b, c)| (a.as_str(), *b, c.clone())).collect()).await;
        let (m, _d, _h) = setup(&gw).await;
        let home = std::env::var("HOME").unwrap();
        let sid = m.create_crew_attach_session("w".into(), "chat-7", Some(&home), "o").await.unwrap();
        assert_eq!(m.crew_binding(&sid).unwrap().origin, "external", "persisted as external (U1)");
        settle().await;
        assert!(m.remove_session(&sid));
        settle().await;
        let p = rest_paths(&gw);
        assert!(p.iter().all(|x| !x.ends_with("/project")), "must not overwrite the external slot's cwd: {p:?}");
        assert!(p.iter().all(|x| !x.starts_with("DELETE")), "closing must not delete someone else's slot: {p:?}");
        assert!(p.iter().any(|x| x == "GET /api/chat/slots/chat-7"));
    }

    #[tokio::test]
    async fn external_session_after_restart_resume_skips_set_project_and_close_keeps_slot() {
        let _h = home();
        let routes = slot_routes("chat-7");
        let gw = MockGw::start(routes.iter().map(|(a, b, c)| (a.as_str(), *b, c.clone())).collect()).await;
        let (m, data, h) = setup(&gw).await;
        let home = std::env::var("HOME").unwrap();
        let sid = m.create_crew_attach_session("w".into(), "chat-7", Some(&home), "o").await.unwrap();
        drop(m);
        settle().await;
        // "restart": a new manager over the same data dir
        let events = Arc::new(crate::events::EventStore::open(data.path()).unwrap());
        let store = Arc::new(crate::session_store::SessionStore::open(data.path()).unwrap());
        let m2 = SessionManager::new(events, store, "claude".into(), "codex".into(), "off".into(),
            gw.port, h.path().to_string_lossy().into(), "bash".into(), false, crate::tmux::TmuxCtl::new(Some("zmx-test-unused".into())));
        m2.load_persisted();
        m2.ensure_running(&sid).await.unwrap();
        settle().await;
        assert!(m2.remove_session(&sid));
        settle().await;
        let p = rest_paths(&gw);
        assert!(p.iter().all(|x| !x.ends_with("/project")), "resume of external must not set_project: {p:?}");
        assert!(p.iter().all(|x| !x.starts_with("DELETE")), "{p:?}");
    }

    #[tokio::test]
    async fn own_session_after_restart_close_still_deletes_slot() {
        let _h = home();
        // S5 R4 regression pinned end-to-end (CTO M2): resume=Some(k) must NOT imply external.
        let gw = MockGw::start(vec![("POST /api/chat/slots", 200, json!({})), ("GET /api/chat/slots/zmx-own", 200, json!({}))]).await;
        let (m, data, h) = setup(&gw).await;
        let mut s = crate::session_manager::tests_support::crew_session("own1", "zmx-own", "zeromux");
        s.work_dir = std::env::var("HOME").unwrap();
        m.store.upsert(&persisted_of(&s)).unwrap();
        drop(m);
        let events = Arc::new(crate::events::EventStore::open(data.path()).unwrap());
        let store = Arc::new(crate::session_store::SessionStore::open(data.path()).unwrap());
        let m2 = SessionManager::new(events, store, "claude".into(), "codex".into(), "off".into(),
            gw.port, h.path().to_string_lossy().into(), "bash".into(), false, crate::tmux::TmuxCtl::new(Some("zmx-test-unused".into())));
        m2.load_persisted();
        m2.ensure_running("own1").await.unwrap();
        settle().await;
        assert!(m2.remove_session("own1"));
        settle().await;
        assert!(rest_paths(&gw).iter().any(|x| x == "DELETE /api/chat/slots/zmx-own"), "own slot is deleted on close");
    }

    #[tokio::test]
    async fn external_resume_failure_never_creates_a_slot() {
        let _h = home();
        // Review Focus 4: slot gone on the Gateway → Ended, never a fresh slot.
        let gw = MockGw::start(vec![("GET /api/chat/slots/chat-7", 200, json!({}))]).await;
        let (m, data, h) = setup(&gw).await;
        let home = std::env::var("HOME").unwrap();
        let sid = m.create_crew_attach_session("w".into(), "chat-7", Some(&home), "o").await.unwrap();
        drop(m);
        let gw2 = MockGw::start(vec![("GET /api/chat/slots/chat-7", 404, json!({}))]).await; // slot deleted
        let events = Arc::new(crate::events::EventStore::open(data.path()).unwrap());
        let store = Arc::new(crate::session_store::SessionStore::open(data.path()).unwrap());
        gw2.set_secret(h.path(), "sec");
        let m2 = SessionManager::new(events, store, "claude".into(), "codex".into(), "off".into(),
            gw2.port, h.path().to_string_lossy().into(), "bash".into(), false, crate::tmux::TmuxCtl::new(Some("zmx-test-unused".into())));
        m2.load_persisted();
        assert!(m2.ensure_running(&sid).await.is_err());
        assert!(gw2.requests().iter().all(|r| !(r.method == "POST" && r.path == "/api/chat/slots")), "no fallback slot");
        assert!(m2.list_sessions(None).into_iter().find(|s| s.id == sid).unwrap().status == SessionMeta::Ended); // SessionMeta has no Debug
        assert!(m2.get_scrollback(&sid).iter().any(|l| l.contains("crew_slot_gone")));
    }

    #[tokio::test]
    async fn attach_rejects_tracked_key_bad_key_and_outside_home() {
        let _h = home();
        let gw = MockGw::start(vec![("GET /api/chat/slots/chat-7", 200, json!({}))]).await;
        let (m, _d, _h) = setup(&gw).await;
        let home = std::env::var("HOME").unwrap();
        m.create_crew_attach_session("w".into(), "chat-7", Some(&home), "o").await.unwrap();
        assert!(matches!(m.create_crew_attach_session("w".into(), "chat-7", Some(&home), "o").await, Err(AttachError::AlreadyTracked)));
        assert!(matches!(m.create_crew_attach_session("w".into(), "a/b", None, "o").await, Err(AttachError::BadKey)));
        assert!(matches!(m.create_crew_attach_session("w".into(), "chat-8", Some("/etc"), "o").await, Err(AttachError::WorkDir(_))));
    }

    #[tokio::test]
    async fn attach_emits_attached_notice_first() {
        let _h = home();
        let gw = MockGw::start(vec![("GET /api/chat/slots/chat-7", 200, json!({}))]).await;
        let (m, _d, _h) = setup(&gw).await;
        let sid = m.create_crew_attach_session("w".into(), "chat-7", None, "o").await.unwrap();
        settle().await;
        let sb = m.get_scrollback(&sid);
        assert!(sb.iter().any(|l| l.contains("\"subtype\":\"attached\"")), "{sb:?}");
    }
}
```

`tests_support::crew_session(id, slot, origin)` 是一个测试 helper，按 S5 的 `Session` 构造一个 Crew 会话：`session_type=Crew`、`resume_token=Some(ResumeToken::Crew(slot))`、`crew=Some(CrewMeta{mode:"",agent:"",origin})`。其余字段照 `mod posture_tests` 里 `fn base_session` 的写法填。把它放进一个新的 `#[cfg(test)] pub(crate) mod tests_support`（文件末尾），并把 `base_session` 的函数体复制进去：

```rust
#[cfg(test)]
pub(crate) mod tests_support {
    use super::*;
    pub fn crew_session(id: &str, slot: &str, origin: &str) -> Session {
        Session {
            id: id.into(), name: "n".into(), session_type: SessionType::Crew, cols: 80, rows: 24,
            work_dir: "/tmp".into(), owner_id: "o".into(), description: String::new(),
            name_is_auto: true, status: SessionMeta::Idle, resume_token: Some(ResumeToken::Crew(slot.into())), tmux_origin: None,
            pending_kill_until: None, worktree_path: None, created_ms: 0, source_task_id: None,
            spawning: false, last_activity_ms: 0, turns_completed: 0, run_metrics: VecDeque::new(),
            lifetime_turns: 0, lifetime_duration_ms: 0, lifetime_cost_usd: 0.0, posture: Posture::default(),
            running: None, scrollback: VecDeque::new(), scrollback_bytes: 0,
            crew: Some(CrewMeta { mode: "".into(), agent: "".into(), origin: origin.into() }),
        }
    }
}
```

（如果 S5 给 `Session` 加的不止一个字段，就按编译器提示补全。）

- [ ] **Step 2: 确认失败**

Run: `cargo test crew_attach_tests`
Expected: 编译失败（缺少 `create_crew_attach_session` / `AttachError`）。

- [ ] **Step 3: 实现**

`session_manager.rs`：

```rust
#[derive(Debug)]
pub enum AttachError { BadKey, AlreadyTracked, WorkDir(String), Spawn(String) }
```

`spawn_crew` 的签名末尾加 `attach_first: bool`。在它构造 `RunningProcess` 之后、`Ok(...)` 之前：

```rust
        if attach_first {
            // D5: no history replay; tell the user where earlier messages live.
            let _ = event_tx.send(serde_json::json!({"type":"system","subtype":"attached"}).to_string());
        }
```

这里只做 broadcast。可靠的投递靠 `create_crew_attach_session` 里的 `push_scrollback`（与 resume_failed 的做法同构）。其他调用点（`create_crew_session`、`ensure_running` 两处）都传 `false`。

新增方法（放在 `create_crew_session` 后面）：

```rust
    /// G6: attach an EXISTING Gateway slot (e.g. a conductor worker) as an external
    /// Crew session. crew_origin=external ⇒ owns_slot=false (U2): resume skips
    /// set_slot_project and Drop never deletes the slot (S5 R4).
    pub async fn create_crew_attach_session(&self, name: String, slot_key: &str, project: Option<&str>, owner_id: &str)
        -> Result<String, AttachError>
    {
        if !crate::crew_proxy::is_valid_slot_key(slot_key) { return Err(AttachError::BadKey); }
        let home = std::env::var("HOME").unwrap_or_else(|_| "/home/ubuntu".into());
        let dir = project.filter(|p| !p.is_empty()).unwrap_or(&home);
        let canonical = work_dir_under_home(dir).map_err(|_| AttachError::WorkDir("该 Crew 会话的 project 不在 HOME 下".into()))?;
        let id = uuid::Uuid::new_v4().to_string();
        // Reserve under the lock (409 on race): insert a placeholder, spawn outside the lock.
        {
            let mut map = self.sessions.lock().unwrap();
            let taken = map.values().any(|s| matches!(&s.resume_token, Some(ResumeToken::Crew(k)) if k == slot_key));
            if taken { return Err(AttachError::AlreadyTracked); }
            let s = Session {
                id: id.clone(), name, session_type: SessionType::Crew, cols: DEFAULT_COLS, rows: DEFAULT_ROWS,
                work_dir: canonical.to_string_lossy().into(), owner_id: owner_id.into(), description: String::new(),
                name_is_auto: false, status: SessionMeta::Idle, resume_token: Some(ResumeToken::Crew(slot_key.into())),
                tmux_origin: None, pending_kill_until: None, worktree_path: None, created_ms: now_millis(),
                source_task_id: None, spawning: true, last_activity_ms: now_millis(), turns_completed: 0,
                run_metrics: VecDeque::new(), lifetime_turns: 0, lifetime_duration_ms: 0, lifetime_cost_usd: 0.0,
                posture: Posture::default(), running: None, scrollback: VecDeque::new(), scrollback_bytes: 0,
                crew: Some(CrewMeta { mode: String::new(), agent: String::new(), origin: "external".into() }),
            };
            map.insert(id.clone(), s);
        }
        let r = self.spawn_crew(&id, &canonical.to_string_lossy(), owner_id, Some(slot_key.to_string()), true).await;
        let mut map = self.sessions.lock().unwrap();
        match r {
            Ok(rp) => {
                let s = map.get_mut(&id).expect("reserved");
                s.spawning = false; s.running = Some(rp); s.status = SessionMeta::Running;
                self.persist_meta(s);
                drop(map);
                self.push_scrollback(&id, serde_json::json!({"type":"system","subtype":"attached"}).to_string());
                tracing::info!(target: "zmx_usage", "crew_attach sid={} slot={}", id, slot_key);
                Ok(id)
            }
            Err(e) => { map.remove(&id); Err(AttachError::Spawn(e)) }
        }
    }
```

S5 的 `spawn_crew` 通过 `Session.crew.origin` 推出 `owns`。由于这里是在锁里先插入占位会话、再调用 `spawn_crew`，读 origin 时就能读到 `external`。如果 S5 的 `spawn_crew` 是把 `SlotInit` 作为参数传入的（而不是自己读 Session），那就在这里显式传 `SlotInit::Resume{ key: slot_key.into(), owns: false }`。`mode`/`agent` 留空：slot 上已经生效，resume 时不重设（S5 §7.2）。

`ensure_running`：resume 失败的回落臂改为：

```rust
            Err(e) if attempted_resume => {
                let external = matches!(self.crew_binding(id), Some(b) if b.origin == "external");
                if stype == SessionType::Crew && external {
                    // G6 §3.5: an attached slot that vanished must NOT fall back to a
                    // fresh slot (that would silently create a new Crew session).
                    tracing::warn!("external crew slot gone for {}: {}", id, e);
                    Err(format!("crew_slot_gone: {e}"))
                } else {
                    tracing::warn!("resume failed for {} ({}), falling back to fresh session", id, e);
                    /* 原有的 fresh 回落代码保持不变 */
                }
            }
```

写法是把原臂的函数体整体包进 `else { … }`，内容不改。`ensure_running` 返回之后，如果错误以 `crew_slot_gone` 开头：

```rust
        if let Err(e) = &outcome {
            if e.starts_with("crew_slot_gone") {
                self.push_scrollback(id, serde_json::json!({"type":"system","subtype":"crew_slot_gone"}).to_string());
                if self.mark_ended(id) { let _ = self.store.upsert(&persisted_of(self.sessions.lock().unwrap().get(id).unwrap())); }
            }
        }
```

这段放在「Post-phase-3 fallback bookkeeping」之后、`outcome` 返回之前。注意 `mark_ended` 要求 `running.is_none() && !spawning`，phase 3 已经清掉了 `spawning`，所以条件满足。持久化 Ended 状态时，照已有的 `mark_ended` 调用方式做（如果 store 没有保存 status 字段，就只保留内存状态，不写库）。

`web.rs`：

- `CreateSessionReq` 加：
  ```rust
      /// G6: attach this existing Crew Gateway slot (admin only, type=crew).
      #[serde(default)]
      crew_attach: Option<String>,
  ```
- `create_session` 的 Crew 臂改为：
  ```rust
          crate::session_manager::SessionType::Crew => match &req.crew_attach {
              Some(key) => {
                  if !user.is_admin() { return Err((StatusCode::FORBIDDEN, "attaching a Crew session requires admin".into())); }
                  let snap = state.crew_watch.snapshot();
                  let sv = snap.slots.iter().find(|s| &s.key == key);
                  let project = sv.and_then(|s| s.project.clone());
                  let nm = req.name.clone().or_else(|| sv.and_then(|s| s.title.clone())).unwrap_or_else(|| key.clone());
                  use crate::session_manager::AttachError::*;
                  let sid = state.sessions.create_crew_attach_session(nm.clone(), key, project.as_deref(), &owner_id).await
                      .map_err(|e| match e {
                          BadKey => (StatusCode::BAD_REQUEST, "invalid slot key".into()),
                          AlreadyTracked => (StatusCode::CONFLICT, "该 Crew 会话已接入".into()),
                          WorkDir(m) => (StatusCode::BAD_REQUEST, m),
                          Spawn(m) => (StatusCode::INTERNAL_SERVER_ERROR, m),
                      })?;
                  return Ok(Json(serde_json::json!({ "id": sid, "name": nm, "type": "crew" })));
              }
              None => state.sessions
                  .create_crew_session(name.clone(), &work_dir, state.default_cols, state.default_rows, &owner_id /* S5 G2 的 mode/agent 参数保持原样 */)
                  .await
                  .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?,
          },
  ```

  接入分支提前 `return`：不发送 initial_prompt，也不做 quick_targets bump（用户没有选目录）。

- [ ] **Step 4: 确认通过**

Run: `cargo test crew_attach_tests && cargo test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/session_manager.rs src/acp/crew_process.rs src/web.rs
git commit -m "feat(G6): attach external Crew slot (origin=external: no set_project, no delete, no fresh fallback) (S7-e)"
```

---

### Task 24: G6 前端：⌘K「接入 Crew 会话」

**Files:**
- Create: `frontend/src/lib/crewSlots.ts`、`frontend/src/lib/__tests__/crewSlots.test.ts`
- Modify: `frontend/src/lib/api/crew.ts`（`CrewSlot`、`listCrewSlots`）
- Modify: `frontend/src/components/shell/useShellState.ts`（`create` 签名，当前 `:29`、`:157-169`）
- Modify: `frontend/src/components/shell/CommandPalette.tsx`（`type Act` `:56`；列表构建 `:188-193`；`runItem` `:195-200`；新 prop `isAdmin`）
- Modify: `frontend/src/components/shell/AppShell.tsx:327`（传 `isAdmin={user?.role === 'admin'}`）
- Modify: `frontend/src/hooks/useAcpSocket.ts`（labelMap，当前 `:325-327`）
- Test: `frontend/src/components/shell/__tests__/CommandPalette.test.tsx`

**Interfaces:**
- Consumes: Task 9 的 `CreateOpts.crewAttach`；Task 22 的 `/api/crew/slots`。
- Produces: `matchCrewSlots(list, q): CrewSlot[]`；`ShellState.create(type, workDir?, tmuxTarget?, prompt?, opts?: CreateOpts)`。

- [ ] **Step 1: 写失败测试**

```ts
// frontend/src/lib/__tests__/crewSlots.test.ts
import { describe, it, expect } from 'vitest'
import { matchCrewSlots, projectTail } from '../crewSlots'
import type { CrewSlot } from '../api'

const S = (key: string, title: string, project = '/home/u/a/b', attachable = true, reason: CrewSlot['reason'] = null): CrewSlot =>
  ({ key, title, project, mode: '', agent: null, origin: 'user', created_by: null, running: false, needs_input: false, last_activity_ts: null, attachable, reason })

describe('matchCrewSlots', () => {
  it('empty query → nothing; matches title/key/project; max 5', () => {
    const l = [S('chat-1', '修复登录'), S('chat-2', 'other', '/home/u/login-svc'), ...Array.from({ length: 8 }, (_, i) => S(`c${i}`, `login ${i}`))]
    expect(matchCrewSlots(l, '')).toEqual([])
    expect(matchCrewSlots(l, '修复').map(s => s.key)).toEqual(['chat-1'])
    expect(matchCrewSlots(l, 'login').length).toBe(5)
  })
  it('projectTail', () => { expect(projectTail('/home/u/a/b')).toBe('a/b'); expect(projectTail(null)).toBe('') })
})
```

`CommandPalette.test.tsx` 追加（用该文件已有的 render helper 和 fake shell；`shell.create` 要是一个 `vi.fn`）：

```tsx
  it('admin: 接入 Crew 会话 rows from /api/crew/slots; greyed needs_g3 not selectable', async () => {
    vi.spyOn(api, 'listCrewSlots').mockResolvedValue({ gateway_ok: true, refreshed_ms: 1, slots: [
      { key: 'chat-7', title: 'worker 修复', project: '/home/u/p/q', mode: '', agent: null, origin: 'user', created_by: 'zmx-1', running: true, needs_input: false, last_activity_ts: null, attachable: true, reason: null },
      { key: 'chat-8', title: 'worker 话题', project: null, mode: 'crew', agent: null, origin: 'user', created_by: null, running: false, needs_input: false, last_activity_ts: null, attachable: false, reason: 'needs_g3' },
    ] })
    const { shell } = renderPalette({ isAdmin: true, initial: { mode: 'search', text: 'worker' } })
    const row = await screen.findByText('接入 Crew 会话:worker 修复')
    expect(screen.getByText('接入 Crew 会话:worker 话题').closest('[aria-disabled="true"]')).not.toBeNull()
    expect(screen.getByText('并行话题需要 G3')).toBeInTheDocument()
    fireEvent.click(row)
    await waitFor(() => expect(shell.create).toHaveBeenCalledWith('crew', undefined, undefined, undefined, { crewAttach: 'chat-7' }))
  })

  it('non-admin never requests crew slots', () => {
    const spy = vi.spyOn(api, 'listCrewSlots')
    renderPalette({ isAdmin: false, initial: { mode: 'search', text: 'worker' } })
    expect(spy).not.toHaveBeenCalled()
  })
```

`renderPalette` 如果还不存在，就在该测试文件里按已有用例的写法抽一个 helper：接收 `{isAdmin, initial}`，返回 `{shell}`。

- [ ] **Step 2: 确认失败**

Run: `cd frontend && npx vitest run src/lib/__tests__/crewSlots.test.ts src/components/shell/__tests__/CommandPalette.test.tsx`
Expected: FAIL。

- [ ] **Step 3: 实现**

`frontend/src/lib/api/crew.ts` 追加：

```ts
export interface CrewSlot {
  key: string; title: string | null; project: string | null; mode: string; agent: string | null
  origin: string | null; created_by: string | null; running: boolean; needs_input: boolean
  last_activity_ts: number | null; attachable: boolean; reason: 'needs_g3' | 'zmx_orphan' | null
}
export async function listCrewSlots(): Promise<{ gateway_ok: boolean; refreshed_ms: number | null; slots: CrewSlot[] }> {
  const res = await api('/api/crew/slots')
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}
```

```ts
// frontend/src/lib/crewSlots.ts
import type { CrewSlot } from './api'
import { rankBy } from './fuzzy'

export function projectTail(p: string | null): string { return (p ?? '').split('/').filter(Boolean).slice(-2).join('/') }

export function matchCrewSlots(list: CrewSlot[], q: string): CrewSlot[] {
  if (!q.trim()) return []
  return rankBy(q, list, s => [s.title ?? '', s.key, projectTail(s.project)]).slice(0, 5)
}
```

`useShellState.ts`：`create` 加第 5 个参数 `opts?: CreateOpts`（从 `../../lib/api` import `type CreateOpts`），透传为 `createSession(type, undefined, workDir, tmuxTarget, initialPrompt, opts)`；`ShellState.create` 的类型同步改掉。

`CommandPalette.tsx`：

- `CommandPaletteProps` 加 `isAdmin?: boolean`，并在 `PaletteBody` 的解构里接收它。
- `type Act` 加 `| { t: 'crew'; key: string }`。
- 在 state 区加：
  ```tsx
    const [crewSlots, setCrewSlots] = useState<CrewSlot[]>([])
    useEffect(() => { if (isAdmin) listCrewSlots().then(r => setCrewSlots(r.slots)).catch(() => {}) }, [isAdmin])
  ```
  只在 ⌘K 打开时（组件挂载时）请求一次，不跟 3s 轮询挂钩。
- 在 `for (const h of matchHostTmux(...))` 循环后面加：
  ```tsx
      for (const c of matchCrewSlots(crewSlots, q)) out.push({
        id: `c:${c.key}`, act: { t: 'crew', key: c.key }, disabled: !c.attachable,
        node: <><CrewIcon size={14} className="shrink-0" /><span className="flex-1 truncate text-ui-sm">{`接入 Crew 会话:${c.title ?? c.key}`}</span>
          <span className="shrink-0 truncate text-ui-2xs text-[var(--fg-subtle)]">{c.reason === 'needs_g3' ? '并行话题需要 G3' : projectTail(c.project)}</span></>,
      })
  ```
  `Item` 类型加上可选字段 `disabled?: boolean`。渲染列表项的地方（`allItems.map`）在 `disabled` 时加 `aria-disabled="true"` 和 `opacity-50`，并且 onClick 和回车都不触发；默认高亮跳过 disabled 项（`hiId` 的计算里 `items.find(i => !i.disabled)`）。
- `runItem`：
  ```tsx
    else if (a.t === 'crew') { if (!it.disabled) runCreate(() => shell.create('crew', undefined, undefined, undefined, { crewAttach: a.key })) }
    else runCreate(() => shell.create('tmux', undefined, a.name))
  ```
- import：`CrewIcon` 从 `../BrandIcons`，`listCrewSlots, type CrewSlot` 从 `../../lib/api`，`matchCrewSlots, projectTail` 从 `../../lib/crewSlots`。

`AppShell.tsx:327` 的 `<CommandPalette …>` 加 `isAdmin={user?.role === 'admin'}`。

`useAcpSocket.ts` 的 labelMap 加：

```ts
          attached: '已接入外部 Crew 会话,更早的消息请到 Crew 仪表板查看',
          crew_slot_gone: 'Crew 会话已不存在',
```

- [ ] **Step 4: 确认通过；首屏体积**

```bash
cd frontend && npm test && npm run lint && npm run build
```

Expected: 全绿；CommandPalette 的首屏增量 < 1.5KB br（记录数值）。

- [ ] **Step 5: Commit**

```bash
git add frontend/src
git commit -m "feat(G6): ⌘K 接入 Crew 会话 (admin, snapshot-backed; needs_g3 greyed) (S7-e)"
```

---

### Task 25: 关闭确认文案 + S7-e 验收部署

**Files:**
- Modify: `frontend/src/lib/closeSession.ts`（新增 `closeCrewMessage`）
- Modify: `frontend/src/components/shell/useShellState.ts`（`close`，当前 `:202-207`）
- Modify: `frontend/src/lib/api/sessions.ts`（`SessionInfo` 确认有 S5 的 `crew_origin?: string`）
- Test: `frontend/src/lib/__tests__/closeSession.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { closeCrewMessage } from '../closeSession'
describe('closeCrewMessage', () => {
  it('external → disconnect-only wording; own conductor → children note; plain own → null', () => {
    expect(closeCrewMessage('w', { crew_origin: 'external', crew_agent: '' })).toBe('只断开接入,Crew 会话本身保留')
    expect(closeCrewMessage('c', { crew_origin: 'zeromux', crew_agent: 'kirocrew-conductor' })).toBe(CONDUCTOR_CLOSE_NOTE)
    expect(closeCrewMessage('x', { crew_origin: 'zeromux', crew_agent: '' })).toBeNull()
  })
})
```

（同时从 `../closeSession` import `CONDUCTOR_CLOSE_NOTE`。）

- [ ] **Step 2: 确认失败**：`cd frontend && npx vitest run src/lib/__tests__/closeSession.test.ts` → FAIL。

- [ ] **Step 3: 实现**

```ts
/** Per K3 spike (S7-e 前置): 200 → children survive; 404 → they close too. */
export const CONDUCTOR_CLOSE_NOTE = '关闭将删除该 Crew 会话;conductor 派出的子会话由 Crew 管理,不会一起删除'

export function closeCrewMessage(_name: string, s: { crew_origin?: string | null; crew_agent?: string | null }): string | null {
  if (s.crew_origin === 'external') return '只断开接入,Crew 会话本身保留'
  if (s.crew_agent === 'kirocrew-conductor') return CONDUCTOR_CLOSE_NOTE
  return null
}
```

`CONDUCTOR_CLOSE_NOTE` 的后半句按 K3 spike 的结果二选一，另一个版本是「…conductor 派出的子会话会一起关闭」。

`useShellState.ts` 的 `close` 里，在 `if (s?.tmux_name) {…}` 后面加：

```ts
    if (s?.type === 'crew') {
      const msg = closeCrewMessage(s.name, s)
      if (msg && !(await confirm({ title: msg, confirmLabel: '关闭', danger: s.crew_origin !== 'external' }))) return
    }
```

- [ ] **Step 4: 全量门 + 手测**

```bash
cargo test && (cd frontend && npm test && npm run lint && npm run build)
```

手测（部署前，在隔离冒烟实例上，本机 Gateway 只读）：⌘K 输入某个 worker 的标题 → 出现「接入 Crew 会话:…」 → 接入后对话区显示「已接入外部 Crew 会话…」 → 关闭并确认「只断开接入…」 → 执行 `curl -s localhost:5476/api/chat/slots/<key> -H "X-Internal-Secret: $(cat ~/.kiro/crew/run/gateway-5476.secret)" -o /dev/null -w '%{http_code}'`，结果为 200。重复 10 次，10 次都是 200（spec §11.2 的 G6 指标）。

- [ ] **Step 5: Commit、push、部署**

```bash
git add frontend/src
git commit -m "feat(G6): close confirm for external / conductor Crew sessions (S7-e)"
git push origin HEAD && ./deploy.sh --build
```


---

# S7-f：Crew fan-out 移植（含 B2 replay 修复）+ G10 定时启动 conductor【T】

**前提：** S7-a（复用 `settle_scheduled_run`）；S5 G2（`create_crew_session` 可以带 `crew_mode` / `crew_agent`）；T 已过。

### 前置已上线（S7-f 开工前执行）

```bash
cd /home/ubuntu/s3-workspace/keith-space/github-search/ai/zeromux
grep -n 'fn settle_scheduled_run' src/session_manager.rs          # S7-a Task 2
grep -n '"codex" => SessionType::Codex' src/session_manager.rs    # S7-a Task 3
grep -n 'mod sched_parity_tests' src/session_manager.rs
grep -n 'T：.*判定通过' docs/superpowers/specs/2026-09-29-s7-crew-cockpit-and-backend-parity-design.md
grep -n 'fn slot_create_body' src/acp/crew_process.rs            # S5 G2：create_slot 带 mode/agent
grep -n 'pub async fn create_crew_session' -A 10 src/session_manager.rs | grep -n 'crew_agent'   # S5 G2 签名
```

### Task 26: Crew fan-out 移植 + `create_crew_session_tagged` + 放行 `"crew-conductor" | "crew"`（B2）

**Files:**
- Modify: `src/acp/crew_process.rs`（`#[cfg(test)] test_handle`，放在 `impl Drop for CrewProcess` 前面）
- Modify: `src/session_manager.rs`
  - `fn spawn_crew_fanout`（锚点 `fn spawn_crew_fanout(`）
  - `create_crew_session` → `create_crew_session_tagged`
  - `fn scheduled_session_type` 及其文档注释
  - `trigger_run` 的 match（Crew 臂）与 goal 拼接（锚点 `let goal = format!(`）
  - 新增 `fn scheduled_goal`
  - `mod sched_parity_tests` 的 `B` / `RELEASED` / `Cmds` / `harness`
  - `mod tests` 的 `scheduled_agent_type_maps_to_session_type`、`snapshot_dispatch_closure_holds_for_every_released_backend`、`scheduled_run_helpers_are_called_by_every_released_fanout`
- Modify: `src/web.rs`（`SCHEDULED_AGENT_TYPES` 加 `"crew-conductor"`；`resolve_agent_type` 的测试断言）
- Test: `mod sched_parity_tests` 新增 `crew_replay_stays_crew_conductor`

**Interfaces:**
- Consumes: Task 2 / Task 3 的 helper 与 harness；Task 16 的 `MockGw`；Task 23 的 `crew_attach_tests::setup` 构造方式。
- Produces:
  - `CrewProcess::test_handle() -> (CrewProcess, mpsc::Sender<AcpEvent>, crew_process::TestCmds)`
  - `pub async fn create_crew_session_tagged(&self, name: String, work_dir: &str, cols: u16, rows: u16, owner_id: &str, source_task_id: Option<String>, crew_mode: &str, crew_agent: &str) -> Result<String, String>`
  - `fn scheduled_goal(stype: SessionType, prompt: &str) -> String`
  - `pub const CONDUCTOR_PREAMBLE: &str`

- [ ] **Step 1: 写失败测试**

(a) `src/acp/crew_process.rs` 的测试句柄。`CrewProcess` 在 `ae5fef7` 的字段是 `cmd_tx, event_rx, cfg, slot_key`，S5 R4 之后多一个 `owns_slot`（字段名以 S5 实际代码为准）。测试句柄把 `owns_slot` 设为 false，这样 Drop 时不会去 DELETE。另外，mock Gateway 不提供 WS，Crew 的事件循环会发出「WS 连接失败」的 `AcpEvent::Error` 并进入退避。所以本 Task 的 replay 测试只断言分派结果、slot 创建请求和 scrollback，**不**断言 run 的终态：

```rust
#[cfg(test)]
pub struct TestCmds(mpsc::Receiver<Cmd>);
#[cfg(test)]
impl TestCmds {
    pub async fn next(&mut self) -> Option<&'static str> {
        self.0.recv().await.map(|c| match c { Cmd::Prompt(_) => "prompt", Cmd::Cancel => "cancel", Cmd::Approval { .. } => "approval", Cmd::Stop => "stop" })
    }
}
#[cfg(test)]
impl CrewProcess {
    pub fn test_handle() -> (Self, mpsc::Sender<AcpEvent>, TestCmds) {
        let (cmd_tx, cmd_rx) = mpsc::channel::<Cmd>(16);
        let (event_tx, event_rx) = mpsc::channel::<AcpEvent>(256);
        let cfg = CrewConfig::new(std::path::PathBuf::from("/nonexistent-crew"), 9);
        (Self { cmd_tx, event_rx, cfg, slot_key: "zmx-test".into(), owns_slot: false }, event_tx, TestCmds(cmd_rx))
    }
}
```

(b) `mod sched_parity_tests` 改为同时覆盖 Crew。以下改动让 Task 3 的 8 个用例**原样**跑在 Crew 上：

```rust
    pub(super) enum B { Codex, Crew }
    pub(super) const RELEASED: &[B] = &[B::Codex, B::Crew];

    pub(super) enum Cmds { Codex(crate::acp::codex_process::TestCmds), Crew(crate::acp::crew_process::TestCmds) }
    impl Cmds {
        pub(super) async fn next(&mut self) -> Option<&'static str> {
            match self { Cmds::Codex(c) => c.next().await, Cmds::Crew(c) => c.next().await }
        }
    }
```

`harness` 的 match 加一个臂：

```rust
            B::Crew => {
                let (p, ev, c) = crate::acp::crew_process::CrewProcess::test_handle();
                spawn_crew_fanout("s1".into(), p, event_tx, input_rx, m.events.clone(), "crew",
                    "/tmp".into(), "o".into(), m.weak());
                (ev, Cmds::Crew(c))
            }
```

`spawn_crew_fanout` 的实际参数列表以 S5/S6 合入后的签名为准。如果 S6 G3 给它加了 topics 之类的参数，这里传普通模式对应的值（`false` / `""`）。

`sched_interrupt_button_finalizes_run` 用例里发的是 `AcpEvent::Error { message: "turn cancelled" }`。Crew 被 `/stop` 之后，Gateway 会发 `chat_done`，也就是一个 `Result`。所以 Crew 分支要在这个用例里改为发 `result("")`，并断言 `r.state` 是一个终态（succeeded 或 failed），而不是固定写 failed：

```rust
            let term = match b { B::Codex => AcpEvent::Error { message: "turn cancelled".into() }, B::Crew => result("") };
            h.ev.send(term).await.unwrap();
            let r = wait_terminal(&h.m, "r1").await;
            assert!(r.state == "failed" || r.state == "succeeded", "{b:?}: {}", r.state);
```

(c) 新增 B2 的 replay 端到端测试（放在 `mod sched_parity_tests` 末尾）：

```rust
    #[tokio::test]
    async fn crew_replay_stays_crew_conductor() {
        // B2 (CTO): the snapshot records Display "crew"; replay_run feeds it back to
        // trigger_run → scheduled_session_type. It must dispatch Crew again, with
        // crew_agent=kirocrew-conductor and the conductor preamble in the goal.
        let _home = temp_home();
        let gw = crate::mock_gateway::MockGw::start(vec![
            ("POST /api/chat/slots", 200, serde_json::json!({})),
        ]).await;
        let (_t, crew_home) = gw.target_with_secret("sec");
        let data = tempfile::tempdir().unwrap();
        let events = Arc::new(crate::events::EventStore::open(data.path()).unwrap());
        let store = Arc::new(crate::session_store::SessionStore::open(data.path()).unwrap());
        let m = SessionManager::new(events, store, "claude".into(), "codex".into(), "off".into(),
            gw.port, crew_home.path().to_string_lossy().into(), "bash".into(), false,
            crate::tmux::TmuxCtl::new(Some("zmx-test-unused".into())));
        let sched = Arc::new(crate::scheduled_tasks::ScheduledStore::open(data.path()).unwrap());
        m.set_scheduled_store(sched.clone());
        let wd = std::env::var("HOME").unwrap();   // temp HOME; passes work_dir_under_home
        seed_run(&m, "r1");
        let sid1 = m.trigger_run("r1", "cond".into(), &wd, "o", "t1", "清零 flaky".into(), "crew-conductor").await.unwrap();
        let snap1 = sched.runs_for_task("t1", 5).unwrap().into_iter().find(|r| r.id == "r1").unwrap().input_snapshot.unwrap();
        assert_eq!(serde_json::from_str::<serde_json::Value>(&snap1).unwrap()["agent_type"], "crew", "snapshot records Display");
        let (new_id, snap) = sched.claim_replay("r1").unwrap();
        let sid2 = m.replay_run(&new_id, "t1", "o", "cond-replay".into(), &snap).await.unwrap();
        for sid in [&sid1, &sid2] {
            assert_eq!(m.session_type(sid), Some(SessionType::Crew), "replay must stay Crew, not fall back to Claude");
            // Read Session.crew directly: the resume token (slot key) may not be backfilled yet.
            let agent = m.sessions.lock().unwrap().get(sid.as_str()).and_then(|s| s.crew.clone()).map(|c| c.agent);
            assert_eq!(agent.as_deref(), Some("kirocrew-conductor"));
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let sb = m.get_scrollback(&sid2);
        assert!(sb.iter().any(|l| l.contains("计划已获授权")), "replayed goal carries the conductor preamble");
        let creates: Vec<_> = gw.requests().into_iter().filter(|r| r.method == "POST" && r.path == "/api/chat/slots").collect();
        assert_eq!(creates.len(), 2);
        assert!(creates.iter().all(|r| r.body.contains("\"agent\":\"kirocrew-conductor\"")), "both slots created as conductors");
        assert!(creates.iter().all(|r| !r.body.contains("\"mode\":\"crew\"")), "G10 uses normal mode (chat_done boundaries)");
    }

    #[test]
    fn scheduled_goal_preamble_only_for_crew() {
        for t in [SessionType::Claude, SessionType::Codex] {
            let g = scheduled_goal(t, "P");
            assert!(g.starts_with("P\n\n完成后") && !g.contains("计划已获授权"), "{t}");
        }
        let g = scheduled_goal(SessionType::Crew, "P");
        assert!(g.starts_with("P\n\n（这是定时触发的无人值守运行"));
        assert!(g.find("计划已获授权").unwrap() < g.find("<<<VERDICT>>>").unwrap(), "preamble before VERDICT note");
    }
```

scrollback 里保存的是 UserPrompt 事件，其中的 `text` 就是拼好的 goal（经 `truncate_prompt_for_scrollback`，64KB 以内不截断），所以能在 scrollback 里断言前言存在。

(d) `mod tests` 里的映射与闭环测试更新到目标状态：

```rust
        // S7-f: crew fan-out finalizes (sched_parity_tests over RELEASED).
        assert!(matches!(scheduled_session_type("crew-conductor"), SessionType::Crew));
        assert!(matches!(scheduled_session_type("crew"), SessionType::Crew), "snapshot Display (B2)");
        assert!(matches!(scheduled_session_type("kiro"), SessionType::Claude));
```

（把 Task 3 写的那两条 `"crew"` / `"crew-conductor"` → Claude 断言替换成上面三行。）`snapshot_dispatch_closure…` 的数组改成 `[SessionType::Claude, SessionType::Codex, SessionType::Crew]`；`scheduled_run_helpers…` 的期望改成 `(3, 3, 6)`，消息改成 `"claude + codex + crew"`。

(e) `web.rs` 的 `resolve_agent_type_whitelist_and_preserve` 最后一条改为：

```rust
        assert_eq!(resolve_agent_type(Some("crew-conductor"), None).unwrap(), "crew-conductor", "released in S7-f");
        assert_eq!(resolve_agent_type(Some("crew"), None).unwrap_err().0, StatusCode::BAD_REQUEST, "snapshot value, never an API label");
```

**已知风险（spec 没有写到，本 Task 不修，只记录）：** Crew 事件循环在 WS 断开时发 `AcpEvent::Error{"Kiro Crew Gateway 连接中断，正在重连"}`（`src/acp/crew_process.rs` 的 `Some(Err(_)) | None =>` 臂）。在 fan-out 眼里这是一个**边界**。如果它恰好落在 conductor 定时 run 的第一轮里，移植之后这个 run 会被记成 `failed/cli_error`，即使 conductor 在 Gateway 侧其实还在正常跑。这与 S4 审计里挂起的 A6（「Crew 中途重连改非边界」）是同一个问题。处理方式：在 Task 27 验收时统计 7 天内 `failure_kind=cli_error` 的 conductor run；只要出现 1 次，就另起一个任务，把重连通知改成非边界的 `ContentBlock{error}`（与 F-CODEX-1 同构），不要在 S7-f 里顺手改。

- [ ] **Step 2: 确认失败**

Run: `cargo test sched_parity_tests; cargo test scheduled_agent_type_maps scheduled_goal_preamble resolve_agent_type`
Expected: Crew 的各个用例报 `stayed running`；映射断言失败；`scheduled_goal` 未定义。

- [ ] **Step 3: 移植 Crew fan-out（与 Task 3 Step 3 逐项相同，对象换成 `spawn_crew_fanout`）**

(1) 在 `let mut boundary_count: u64 = 0;` 下面加 `let mut active_run_id: Option<String> = None;`

(2) 在 `emit(&mgr, &sid, &event_tx, turn_seq, &evt);` 下面加 `tee_scheduled_event(&active_run_id, &evt);`

(3) 边界块里 turn_done 推送那段注释

```rust
                                    // turn_done push (parity with spawn_acp_fanout — F4).
                                    // Crew runs no scheduled tasks yet (trigger_run still
                                    // hardcodes Claude), so every settling turn here is
                                    // interactive (no active_run_id gate needed).
```

替换为下面这段，并把紧随其后的 `let dur …` / `maybe_push_turn_done(…)` 两行包进 `if`：

```rust
                                    // turn_done push: interactive turns only (a scheduled
                                    // turn has active_run_id Some) — parity with spawn_acp_fanout.
                                    if active_run_id.is_none() {
                                        let dur = turn_starts.front().map(|s| now_millis() - s).unwrap_or(0);
                                        maybe_push_turn_done(&mgr, &sid, &owner_id, dur, turn_starts.front_intent());
                                    }
```

(4) 在 `if is_boundary {` 块里、`let term = match &evt {` 前面加：

```rust
                                let intent_aborted = intent_suppresses_push(turn_starts.front_intent());
                                settle_scheduled_run(&mgr, &sid, &owner_id, &mut active_run_id, &evt, intent_aborted);
```

(5) 输入分支：
- `run_id.is_some()` 臂：`queue.clear();` 下面加 `active_run_id = run_id.clone();`，注释改为 `// C3:调度 prompt 绕过 collect,自成干净 turn(S7-f 起 crew 跑调度)`。
- `QueueMode::Interrupt if local_running` 臂：`queue.clear();` 下面加 `finalize_active_run_if_scheduled(&mgr, &mut active_run_id, "interrupted");`
- `QueueMode::Passthrough` 臂的第一行加 `finalize_active_run_if_scheduled(&mgr, &mut active_run_id, "interrupted");`
- collect 臂的「真正空闲」分支：`turn_seq += 1;` 前面加 `active_run_id = None;`

(6) collect flush：`let merged = queue.drain_merged();` 下面加 `active_run_id = None; // 合并 turn 永不携带 run_id(C3)`。

S6 G3 的话题模式分支（topics）不用改：G10 只用普通模式，定时 prompt 不会进入话题模式的会话。

- [ ] **Step 4: tagged 构造、分派、goal**

- 把 S5 的 `create_crew_session(name, work_dir, cols, rows, owner_id, crew_mode, crew_agent)` 改名为 `create_crew_session_tagged`，在参数表中 `owner_id` 后面加 `source_task_id: Option<String>`，函数体里 `source_task_id: None,` 改为 `source_task_id,`。原名保留为薄包装，传 `None` 透传（`web.rs` 的调用点不用动）。
- `pub const CONDUCTOR_PREAMBLE: &str = "（这是定时触发的无人值守运行：计划已获授权，直接执行第 1 轮派发，不要等待确认；派发并开启巡检后结束本轮。）";`
- 新增 `scheduled_goal`（放在 `fn scheduled_input_snapshot` 旁边）：

  ```rust
  /// Scheduled goal text. Keyed on the DISPATCHED SessionType (not the raw label)
  /// so a replay — which passes the snapshot's "crew" — gets the same preamble (V6).
  fn scheduled_goal(stype: SessionType, prompt: &str) -> String {
      let verdict = "完成后，最后单独输出一行：\n<<<VERDICT>>>一句话结论<<<END>>>";
      match stype {
          SessionType::Crew => format!("{prompt}\n\n{CONDUCTOR_PREAMBLE}\n\n{verdict}"),
          _ => format!("{prompt}\n\n{verdict}"),
      }
  }
  ```

- `trigger_run`：把 `let goal = format!(…);` 替换为 `let goal = scheduled_goal(scheduled_session_type(agent_type), &prompt);`。Crew 从共享臂里移出来：

  ```rust
              SessionType::Claude | SessionType::Tmux => self
                  .create_acp_session_tagged(name, &canonical_str, 80, 24, owner_id, Some(task_id.to_string()), self.worktree_isolation)
                  .await?,
              SessionType::Codex => self
                  .create_codex_session_tagged(name, &canonical_str, 80, 24, owner_id, Some(task_id.to_string()), self.worktree_isolation)
                  .await?,
              // G10: the only scheduled Crew variant is the goal conductor, in NORMAL
              // mode (chat_done boundaries; no G3 dependency). Keyed on the dispatched
              // type, so a replay passing "crew" behaves identically (V6).
              SessionType::Crew => self
                  .create_crew_session_tagged(name, &canonical_str, 80, 24, owner_id, Some(task_id.to_string()), "", "kirocrew-conductor")
                  .await?,
  ```

  （如果 Task 9 尚未合入，就把 `self.worktree_isolation` 这个参数去掉。）

- `scheduled_session_type` 改为：

  ```rust
  fn scheduled_session_type(agent_type: &str) -> SessionType {
      match agent_type {
          "codex" => SessionType::Codex,
          // "crew-conductor" = the form/API label; "crew" = SessionType::Crew's Display,
          // i.e. what the input snapshot records — replay must map it back (B2).
          // LIMIT: this holds only while the goal conductor is the SOLE scheduled Crew
          // variant. Adding a second one requires snapshots to record the task label
          // (not the Display) plus a compat mapping for old snapshots.
          "crew-conductor" | "crew" => SessionType::Crew,
          _ => SessionType::Claude,
      }
  }
  ```

  文档注释里「为什么 `"crew"` 目前也回落 Claude」这一整段删掉，换成一句「三个 agent fan-out 均已实现 run 终结（`settle_scheduled_run`），见 `sched_parity_tests`」。

- `web.rs`：`const SCHEDULED_AGENT_TYPES: &[&str] = &["claude", "codex", "crew-conductor"];`

- [ ] **Step 5: 确认通过**

Run: `cargo test sched_parity_tests && cargo test`
Expected: 全部 PASS，包括 `every_fanout_marks_vault_dirty_next_to_turn_done_push` 仍为 3，以及 `crew_replay_stays_crew_conductor`。

- [ ] **Step 6: Commit**

```bash
git add src/session_manager.rs src/acp/crew_process.rs src/web.rs
git commit -m "feat(sched): Crew fan-out finalizes runs; release crew-conductor; replay of 'crew' snapshot stays Crew (S7-f, B2)"
```

---

### Task 27: G10 前端（后端下拉「Crew 目标指挥」+ run 行副文字）+ S7-f 验收部署

**Files:**
- Modify: `frontend/src/lib/scheduledBackend.ts`（`BACKEND_OPTIONS`）
- Modify: `frontend/src/components/ScheduledTasksPanel.tsx`（`RunHistory` 的状态行，当前 `:645-647`；`TaskForm` 在后端选中 conductor 时显示提示）
- Test: `frontend/src/lib/__tests__/scheduledBackend.test.ts`、`frontend/src/components/__tests__/ScheduledTasksPanel.backend.test.tsx`

- [ ] **Step 1: 写失败测试**

`scheduledBackend.test.ts` 的第一个用例改为：

```ts
  it('offers claude + codex + crew conductor', () => {
    expect(BACKEND_OPTIONS.map(o => o.value)).toEqual(['claude', 'codex', 'crew-conductor'])
  })
```

同时把 `normalizeBackend` 的用例里 `'crew'` 那一项保留（仍然 → claude），并加上 `expect(normalizeBackend('crew-conductor')).toBe('crew-conductor')`。

`ScheduledTasksPanel.backend.test.tsx` 追加：

```tsx
  it('conductor backend shows the new-session-per-fire hint', () => {
    render(<TaskForm task={{ ...base, agent_type: 'crew-conductor' }} onCancel={() => {}} onSaved={() => {}} />)
    expect(screen.getByText('每次触发都会新建一个目标指挥会话')).toBeInTheDocument()
  })

  it('succeeded conductor run shows 已派发 sub-line', async () => {
    vi.spyOn(api, 'listScheduledTasks').mockResolvedValue([{ ...base, agent_type: 'crew-conductor' }])
    vi.spyOn(api, 'listConfirmations').mockResolvedValue({ count: 0, runs: [], gate_silent: [] })
    vi.spyOn(api, 'listTaskRuns').mockResolvedValue([{ id: 'r', task_id: 't1', scheduled_for_ms: 1, state: 'succeeded', session_id: 's',
      verdict: null, failure_kind: 'no_verdict', started_ms: 1, ended_ms: 2, input_snapshot: '{}', confirm_status: null, replay_of: null }])
    const { default: Panel } = await import('../ScheduledTasksPanel')
    render(<Panel open onClose={() => {}} />)
    fireEvent.click(await screen.findByTitle('运行历史'))
    expect(await screen.findByText('已派发,目标进度见子任务')).toBeInTheDocument()
  })
```

- [ ] **Step 2: 确认失败**：`cd frontend && npx vitest run src/lib/__tests__/scheduledBackend.test.ts src/components/__tests__/ScheduledTasksPanel.backend.test.tsx` → FAIL。

- [ ] **Step 3: 实现**

- `BACKEND_OPTIONS` 加 `{ value: 'crew-conductor', label: 'Crew 目标指挥' }`。
- `TaskForm` 的「后端」`<select>` 下面加：
  ```tsx
        {backend === 'crew-conductor' && <div className="mt-1 text-ui-2xs text-[var(--fg-subtle)]">每次触发都会新建一个目标指挥会话</div>}
  ```
- `RunHistory` 里 `<span className={`text-ui-xs font-medium ${reason.color}`}>{reason.label}</span>` 那一行后面、`</div>` 之前加（V13）：
  ```tsx
                {task.agent_type === 'crew-conductor' && r.state === 'succeeded' && (
                  <span className="text-ui-2xs text-[var(--fg-subtle)]">已派发,目标进度见子任务</span>
                )}
  ```
  外层 flex 已经是 `justify-between`，把这个 span 放进一个 `flex items-center gap-2` 的包裹 div 里，和状态标签并排。

- [ ] **Step 4: 全量门 + 隔离冒烟**

```bash
cargo test && (cd frontend && npm test && npm run lint && npm run build)
```

冒烟（本机 Gateway 只读 + 一次性 slot；用隔离的 data-dir）：在 18093 实例上建一个 `agent_type:"crew-conductor"` 的任务，prompt 为「列出当前目录文件数，不需要派发子任务」，然后执行 `run now`。conductor 第一轮结束后，run 应为 `succeeded`；打开会话，「子任务」tab 能看到目标卡。接着对这个 run 执行 replay，新会话的类型必须是 crew（spec §11.2 G10 里的 B2 回归项）。结束后在 Crew 仪表板里手动删掉这两个一次性 slot。

- [ ] **Step 5: Commit、push、部署**

```bash
git add frontend/src
git commit -m "feat(G10): scheduled Crew goal-conductor backend + 已派发 run note (S7-f)"
git push origin HEAD && ./deploy.sh --build
```

线上指标（spec §11.2 G10）：连续 7 天，conductor 定时 run 每次都在第一轮之后 finalize，`active_run_count` 归零。


---

# 附录 A（可选 task 组）：③ 串联

**启用条件（spec 附录 A.0，全部满足才开始）：**
1. S7-f（G10）已经上线满 14 天；
2. 在这 14 天里出现过 **≥ 2 次**这样的情况：用户需要「ZeroMux 任务 X 成功后，**在仓库 cwd 里**换一个后端或 prompt 接着跑」，而 conductor 覆盖不了（例如上游 Codex 审查、下游 Claude 修复，需要 E1 门和 cwd，这是 Crew cron 做不到的）；
3. 这 2 次的证据写进了 `docs/superpowers/audits/`（日期、上游任务、为什么 conductor 不够用）。

**任何一条不满足就不做**，本附录保持未执行状态即可，不需要归档动作。T 不过时本附录同样不做（S7-c 已经结束整个计划）。

### 前置已上线（附录 A 开工前执行）

```bash
cd /home/ubuntu/s3-workspace/keith-space/github-search/ai/zeromux
grep -n '"crew-conductor" | "crew" => SessionType::Crew' src/session_manager.rs   # S7-f
ls docs/superpowers/audits/ | grep -i 'chain\|串联'                                # 启用证据
git log --since='14 days ago' --oneline --grep='S7-f' | wc -l                      # 期望 0：S7-f 在 14 天前就已上线
```

### Task A1: 数据模型 + 部分唯一索引 + 启动自检

**Files:**
- Modify: `Cargo.toml`（`[dependencies]` 加 `regex = "1"`；`Cargo.lock:2307` 已经有它作为传递依赖）
- Modify: `src/scheduled_tasks.rs`：ALTER 列表；`ScheduledStore::open` 末尾；`TaskConfig`、`TaskRun`；`query_configs`；`runs_for_task` 的 SELECT；`claim_run`
- Test: `mod store_tests`

**Interfaces:**
- Produces:
  - `TaskConfig.after_task_id: Option<String>`、`TaskConfig.after_when: Option<String>`
  - `TaskRun.upstream_run_id: Option<String>`
  - `claim_run` 在 `upstream_run_id` 撞上唯一约束时返回 `Ok(false)`
  - `pub fn latest_terminal_run(&self, task_id: &str, after_ms: i64) -> Result<Option<TaskRun>, String>`

- [ ] **Step 1: 写失败测试**

```rust
    fn chain_run(id: &str, task: &str, up: Option<&str>) -> TaskRun {
        TaskRun { id: id.into(), task_id: task.into(), scheduled_for_ms: 1000, state: "claimed".into(), session_id: None,
            verdict: None, failure_kind: None, started_ms: Some(1), ended_ms: None, input_snapshot: None,
            confirm_status: None, replay_of: None, upstream_run_id: up.map(String::from) }
    }

    #[test]
    fn upstream_unique_index_exists_and_is_partial_and_open_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        drop(ScheduledStore::open(dir.path()).unwrap());
        let s = ScheduledStore::open(dir.path()).unwrap(); // second open: migrations idempotent
        let n: i64 = s.conn.lock().unwrap().query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='ux_runs_upstream'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        assert!(s.claim_run(&TaskRun { scheduled_for_ms: 1, ..chain_run("a", "down", Some("up1")) }).unwrap());
        assert!(!s.claim_run(&TaskRun { scheduled_for_ms: 2, ..chain_run("b", "down", Some("up1")) }).unwrap(), "same upstream consumed once");
        assert!(s.claim_run(&TaskRun { scheduled_for_ms: 3, ..chain_run("c", "down", None) }).unwrap());
        assert!(s.claim_run(&TaskRun { scheduled_for_ms: 4, ..chain_run("d", "down", None) }).unwrap(), "NULL upstream rows may repeat (partial index)");
    }

    #[test]
    fn open_fails_loudly_when_index_is_missing() {
        // V11: the self-check turns a silently-missing index into a startup error.
        let dir = tempfile::tempdir().unwrap();
        drop(ScheduledStore::open(dir.path()).unwrap());
        let c = rusqlite::Connection::open(dir.path().join("scheduled.db")).unwrap();
        c.execute("DROP INDEX ux_runs_upstream", []).unwrap();
        assert!(verify_upstream_index(&c).is_err());
    }

    #[test]
    fn latest_terminal_run_ignores_history_before_downstream_creation() {
        let (s, _d) = store();
        s.claim_run(&TaskRun { scheduled_for_ms: 1, ..chain_run("old", "up", None) }).unwrap();
        s.set_run_state("old", "succeeded", None, Some("v0"), None, Some(50)).unwrap();
        s.claim_run(&TaskRun { scheduled_for_ms: 2, ..chain_run("new", "up", None) }).unwrap();
        s.set_run_state("new", "failed", None, None, Some("cli_error"), Some(200)).unwrap();
        s.claim_run(&TaskRun { scheduled_for_ms: 3, ..chain_run("live", "up", None) }).unwrap();
        assert_eq!(s.latest_terminal_run("up", 100).unwrap().map(|r| r.id), Some("new".into()));
        assert!(s.latest_terminal_run("up", 300).unwrap().is_none());
    }
```

同时，所有现有的 `TaskRun { … }` 字面量都要加上 `upstream_run_id: None`，`TaskConfig { … }` 字面量都要加上 `after_task_id: None, after_when: None`（`cargo check` 会逐个指出，包括 `session_manager.rs` 里的测试 helper 和 `web.rs`）。

- [ ] **Step 2: 确认失败**：`cargo test upstream_unique latest_terminal open_fails_loudly` → 编译失败。

- [ ] **Step 3: 实现**

- ALTER 列表加：
  ```rust
              "ALTER TABLE agent_runs_config ADD COLUMN after_task_id TEXT",
              "ALTER TABLE agent_runs_config ADD COLUMN after_when TEXT",
              "ALTER TABLE agent_task_runs ADD COLUMN upstream_run_id TEXT",
  ```
- 在 ALTER 循环之后、`Ok(Self { … })` 之前加（**不**走吞错路径）：
  ```rust
          conn.execute(
              "CREATE UNIQUE INDEX IF NOT EXISTS ux_runs_upstream ON agent_task_runs(task_id, upstream_run_id) WHERE upstream_run_id IS NOT NULL",
              params![],
          ).map_err(|e| format!("create ux_runs_upstream: {e}"))?;
          verify_upstream_index(&conn)?;
  ```
  ```rust
  /// Startup self-check (V11): the partial unique index is what makes "one upstream
  /// run → at most one downstream run" hold; if it is ever missing, refuse to start
  /// rather than silently double-consume.
  fn verify_upstream_index(conn: &Connection) -> Result<(), String> {
      let n: i64 = conn.query_row(
          "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='ux_runs_upstream'", [], |r| r.get(0))
          .map_err(|e| e.to_string())?;
      if n == 1 { Ok(()) } else { Err("ux_runs_upstream index missing".into()) }
  }
  ```
- `TaskConfig` 加 `#[serde(default)] pub after_task_id: Option<String>`、`#[serde(default)] pub after_when: Option<String>`。INSERT 与 SET 都加这两列：参数号接在当前最后一个参数（S6 之后是 `?17`）之后，写成 `?18`、`?19`。`query_configs` 的 SELECT 末尾加这两列，下标接在 `last_woken_ms` 后面。
- `TaskRun` 加 `#[serde(default)] pub upstream_run_id: Option<String>`；`runs_for_task` 的 SELECT 末尾加 `,upstream_run_id`，取列 `upstream_run_id: r.get(12)?`。
- `claim_run` 改为：
  ```rust
      pub fn claim_run(&self, run: &TaskRun) -> Result<bool, String> {
          let conn = self.conn.lock().unwrap();
          let n = conn.execute(
              "INSERT OR IGNORE INTO agent_task_runs
               (id,task_id,scheduled_for_ms,state,started_ms,upstream_run_id) VALUES (?1,?2,?3,'claimed',?4,?5)",
              params![run.id, run.task_id, run.scheduled_for_ms, run.started_ms, run.upstream_run_id],
          ).map_err(|e| e.to_string())?;
          Ok(n == 1)
      }
  ```
  `INSERT OR IGNORE` 同时吞掉 `UNIQUE(task_id, scheduled_for_ms)` 和部分唯一索引的冲突，这正是「已经消费过就静默跳过」需要的语义。
- `latest_terminal_run`：
  ```rust
      pub fn latest_terminal_run(&self, task_id: &str, after_ms: i64) -> Result<Option<TaskRun>, String> {
          Ok(self.runs_for_task(task_id, 50)?.into_iter()
              .filter(|r| (r.state == "succeeded" || r.state == "failed") && r.ended_ms.map_or(false, |e| e > after_ms))
              .max_by_key(|r| r.ended_ms))
      }
  ```

- [ ] **Step 4: 确认通过**：`cargo test store_tests && cargo test` → PASS。

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml Cargo.lock src
git commit -m "feat(chain): after_task_id/after_when + partial unique upstream index with startup self-check (附录 A)"
```

---

### Task A2: 条件判定、环检测、模板替换（纯函数）+ API 校验

**Files:**
- Modify: `src/scheduled_tasks.rs`（纯函数 `after_when_matches`、`validate_after_when`、`chain_has_cycle`、`render_chain_prompt`）
- Modify: `src/web.rs`（`ScheduledTaskReq` 加 `after_task_id`、`after_when`；create/update 时校验）
- Test: `mod store_tests`；`src/web.rs` 的 `mod path_safety_tests`

**Interfaces:**
- Produces:
  - `pub fn validate_after_when(s: &str) -> Result<(), String>`
  - `pub fn after_when_matches(when: &str, up: &TaskRun) -> bool`
  - `pub fn chain_has_cycle(start: &str, first_up: &str, up_of: impl Fn(&str) -> Option<String>) -> bool`
  - `pub fn render_chain_prompt(tpl: &str, verdict: Option<&str>, tail: &[String]) -> String`

- [ ] **Step 1: 写失败测试**

```rust
    fn done(state: &str, verdict: Option<&str>) -> TaskRun {
        TaskRun { state: state.into(), verdict: verdict.map(String::from), ended_ms: Some(9), ..chain_run("u", "up", None) }
    }

    #[test]
    fn after_when_truth_table() {
        assert!(after_when_matches("succeeded", &done("succeeded", None)));
        assert!(!after_when_matches("succeeded", &done("failed", None)));
        assert!(after_when_matches("always", &done("failed", None)));
        assert!(after_when_matches("verdict:high|critical", &done("succeeded", Some("2 high issues"))));
        assert!(!after_when_matches("verdict:high", &done("succeeded", None)), "no verdict → false");
        assert!(!after_when_matches("verdict:high", &done("failed", Some("high"))), "verdict requires succeeded");
        assert!(!after_when_matches("verdict:(", &done("succeeded", Some("x"))), "bad regex at tick → false");
        assert!(!after_when_matches("weird", &done("succeeded", None)));
    }

    #[test]
    fn validate_after_when_rejects_bad_regex_and_huge_patterns() {
        assert!(validate_after_when("succeeded").is_ok() && validate_after_when("always").is_ok());
        assert!(validate_after_when("verdict:^ok$").is_ok());
        assert!(validate_after_when("verdict:(").is_err());
        assert!(validate_after_when(&format!("verdict:{}", "a{1000}".repeat(200))).is_err(), "size_limit 64KB");
        assert!(validate_after_when("nope").is_err());
    }

    #[test]
    fn cycle_detection_within_8_hops() {
        let ups: std::collections::HashMap<&str, &str> = [("B", "A"), ("C", "B")].into_iter().collect();
        let f = |t: &str| ups.get(t).map(|s| s.to_string());
        assert!(chain_has_cycle("A", "A", f), "self");
        assert!(chain_has_cycle("A", "C", f), "A→C→B→A");
        assert!(!chain_has_cycle("D", "C", f), "D after C after B after A is fine");
        let long: std::collections::HashMap<String, String> = (0..20).map(|i| (format!("t{i}"), format!("t{}", i + 1))).collect();
        assert!(chain_has_cycle("x", "t0", |t| long.get(t).cloned()), ">8 hops treated as cycle (bounded walk)");
    }

    #[test]
    fn chain_template_substitution() {
        let tail = vec!["line1".to_string(), "line2".to_string()];
        assert_eq!(render_chain_prompt("fix: {{upstream.verdict}}\n{{upstream.output_tail}}", Some("3 high"), &tail), "fix: 3 high\nline1\nline2");
        assert_eq!(render_chain_prompt("v={{upstream.verdict}}", None, &[]), "v=", "missing → empty");
        let big = vec!["界".repeat(3000)];
        assert_eq!(render_chain_prompt("{{upstream.output_tail}}", None, &big).chars().count(), 4096, "4KB cap on char boundary");
    }
```

`web.rs`：

```rust
    #[test]
    fn chain_fields_validate() {
        assert!(validate_chain(Some("t1"), Some("verdict:(")).is_err());
        assert!(validate_chain(Some("t1"), None).is_err(), "after_task_id needs after_when");
        assert!(validate_chain(None, None).is_ok());
        assert!(validate_chain(Some("t1"), Some("succeeded")).is_ok());
    }
```

- [ ] **Step 2: 确认失败**：`cargo test after_when validate_after_when cycle_detection chain_template chain_fields_validate` → 编译失败。

- [ ] **Step 3: 实现**（`scheduled_tasks.rs`，放在 impl 外面）：

```rust
fn verdict_regex(pat: &str) -> Result<regex::Regex, String> {
    // D12: linear-time engine (no ReDoS) + size_limit against huge compiled patterns.
    regex::RegexBuilder::new(pat).size_limit(64 * 1024).build().map_err(|e| format!("invalid verdict regex: {e}"))
}

pub fn validate_after_when(s: &str) -> Result<(), String> {
    match s {
        "succeeded" | "always" => Ok(()),
        _ => match s.strip_prefix("verdict:") { Some(p) => verdict_regex(p).map(|_| ()), None => Err(format!("unknown after_when: {s}")) },
    }
}

pub fn after_when_matches(when: &str, up: &TaskRun) -> bool {
    match when {
        "succeeded" => up.state == "succeeded",
        "always" => up.state == "succeeded" || up.state == "failed",
        _ => match (when.strip_prefix("verdict:"), up.state.as_str(), up.verdict.as_deref()) {
            (Some(p), "succeeded", Some(v)) if !v.is_empty() => match verdict_regex(p) {
                Ok(re) => re.is_match(v),
                Err(e) => { tracing::warn!("chain: {e}"); false }
            },
            _ => false,
        },
    }
}

/// Walk the upstream chain from `first_up` at most 8 hops; reaching `start` (or not
/// terminating within 8) is a cycle (A.3: single chain, bounded).
pub fn chain_has_cycle(start: &str, first_up: &str, up_of: impl Fn(&str) -> Option<String>) -> bool {
    let mut cur = first_up.to_string();
    for _ in 0..8 {
        if cur == start { return true; }
        match up_of(&cur) { Some(n) => cur = n, None => return false }
    }
    true
}

pub fn render_chain_prompt(tpl: &str, verdict: Option<&str>, tail: &[String]) -> String {
    let t: String = tail.join("\n").chars().take(4096).collect();
    tpl.replace("{{upstream.verdict}}", verdict.unwrap_or("")).replace("{{upstream.output_tail}}", &t)
}
```

`web.rs`：

```rust
fn validate_chain(after_task_id: Option<&str>, after_when: Option<&str>) -> Result<(), (StatusCode, String)> {
    match (after_task_id, after_when) {
        (None, _) => Ok(()),
        (Some(_), None) => Err((StatusCode::BAD_REQUEST, "after_when required".into())),
        (Some(_), Some(w)) => crate::scheduled_tasks::validate_after_when(w).map_err(|e| (StatusCode::BAD_REQUEST, e)),
    }
}
```

`ScheduledTaskReq` 加 `#[serde(default)] after_task_id: Option<String>` 和 `#[serde(default)] after_when: Option<String>`。

create/update 两个 handler 在 cron 校验**之前**加：

- 设了 `after_task_id` 时，跳过 cron 解析，令 `trigger_type = "after"`、`trigger_spec = ""`；
- 调用 `validate_chain(...)?`；
- 上游必须属于同一个 owner：`get_config(up)` 返回 None 或 owner 不同时，返回 400「上游任务不存在」；
- 环检测：`chain_has_cycle(&this_id, up, |t| state.scheduled_tasks.get_config(t).ok().flatten().and_then(|c| c.after_task_id))` 为真时，返回 400「串联成环」。新建任务时 `this_id` 用即将写入的新 uuid。

没有设 `after_task_id` 时保持现状：`trigger_type = "cron"`。

- [ ] **Step 4: 确认通过**：`cargo test && cargo test chain` → PASS。

- [ ] **Step 5: Commit**

```bash
git add src/scheduled_tasks.rs src/web.rs
git commit -m "feat(chain): after_when (succeeded|always|verdict:<re>) + cycle guard + template vars (附录 A)"
```

---

### Task A3: tick 内的 `after` 分支

**Files:**
- Modify: `src/scheduled_tasks.rs` 的 scheduler tick：`for task in tasks {` 循环（当前 `:1165-1206`）
- Test: `mod store_tests`（把判定抽成纯函数 `plan_after_fire` 来测）

**Interfaces:**
- Consumes: A1 / A2。
- Produces: `pub fn plan_after_fire(s: &ScheduledStore, task: &TaskConfig) -> Result<Option<(TaskRun, String)>, String>`，返回待 claim 的 run 与渲染好的 prompt；`None` 表示本 tick 不触发。

- [ ] **Step 1: 写失败测试**

```rust
    fn after_cfg(id: &str, up: &str, when: &str, created: i64) -> TaskConfig {
        TaskConfig { trigger_type: "after".into(), trigger_spec: "".into(), after_task_id: Some(up.into()), after_when: Some(when.into()),
            prompt: "fix {{upstream.verdict}}".into(), created_ms: created, ..gated(id, "alice", true, None, None) }
    }

    #[test]
    fn after_fires_once_per_upstream_run_across_ticks() {
        let (s, _d) = store();
        s.upsert_config(&after_cfg("down", "up", "succeeded", 10)).unwrap();
        s.claim_run(&TaskRun { scheduled_for_ms: 1, ..chain_run("u1", "up", None) }).unwrap();
        s.set_run_state("u1", "succeeded", None, Some("3 high"), None, Some(100)).unwrap();
        let t = s.get_config("down").unwrap().unwrap();
        let (run, prompt) = plan_after_fire(&s, &t).unwrap().expect("fires");
        assert_eq!((run.upstream_run_id.as_deref(), run.scheduled_for_ms, prompt.as_str()), (Some("u1"), 100, "fix 3 high"));
        assert!(s.claim_run(&run).unwrap());
        s.set_run_state(&run.id, "failed", None, None, Some("cli_error"), Some(200)).unwrap(); // downstream failed
        let (run2, _) = plan_after_fire(&s, &t).unwrap().expect("plans again");
        assert!(!s.claim_run(&run2).unwrap(), "same upstream never consumed twice, even after a failed downstream");
    }

    #[test]
    fn after_skips_history_before_creation_and_deleted_upstream() {
        let (s, _d) = store();
        s.claim_run(&TaskRun { scheduled_for_ms: 1, ..chain_run("u0", "up", None) }).unwrap();
        s.set_run_state("u0", "succeeded", None, None, None, Some(5)).unwrap();
        s.upsert_config(&after_cfg("down", "up", "always", 10)).unwrap();
        assert!(plan_after_fire(&s, &s.get_config("down").unwrap().unwrap()).unwrap().is_none(), "no retroactive fire");
        s.upsert_config(&after_cfg("orphan", "gone", "always", 10)).unwrap();
        assert!(plan_after_fire(&s, &s.get_config("orphan").unwrap().unwrap()).unwrap().is_none());
    }
```

- [ ] **Step 2: 确认失败**：`cargo test after_fires after_skips` → 编译失败。

- [ ] **Step 3: 实现**

```rust
/// A.2: the next downstream run for an `after` task, or None. Pure over the store
/// (no spawn): the tick then runs the SAME claim_run → claim_won → trigger_run path
/// as cron fires, so overlap/TOCTOU/work_dir/watchdog are all reused.
pub fn plan_after_fire(s: &ScheduledStore, task: &TaskConfig) -> Result<Option<(TaskRun, String)>, String> {
    let (Some(up), Some(when)) = (task.after_task_id.as_deref(), task.after_when.as_deref()) else { return Ok(None) };
    let Some(r) = s.latest_terminal_run(up, task.created_ms)? else { return Ok(None) };
    if !after_when_matches(when, &r) { return Ok(None); }
    let tail = run_output_tail(&r.id, 40);
    let prompt = render_chain_prompt(&task.prompt, r.verdict.as_deref(), &tail);
    let ended = r.ended_ms.unwrap_or(0);
    Ok(Some((TaskRun {
        id: uuid::Uuid::new_v4().to_string(), task_id: task.id.clone(), scheduled_for_ms: ended,
        state: "claimed".into(), session_id: None, verdict: None, failure_kind: None,
        started_ms: Some(chrono::Utc::now().timestamp_millis()), ended_ms: None,
        input_snapshot: None, confirm_status: None, replay_of: None, upstream_run_id: Some(r.id),
    }, prompt)))
}
```

tick 循环里，在 `let fires = match due_fire_points(...)` 前面插入：

```rust
                        if task.trigger_type == "after" {
                            let Ok(Some((run, prompt))) = plan_after_fire(&s, &task) else { continue };
                            let active = s.active_states_for_task(&task.id).unwrap_or_default();
                            let refs: Vec<&str> = active.iter().map(|x| x.as_str()).collect();
                            if should_skip_overlap(&refs) { continue; }
                            if let Ok(true) = s.claim_run(&run) {   // false = upstream already consumed
                                match s.claim_won(&task.id, &run.id) {
                                    Ok(true) => {
                                        let nm = format!("{} · ↑", task.name);
                                        if let Err(err) = m.trigger_run(&run.id, nm, &task.work_dir, &task.owner_id, &task.id, prompt, &task.agent_type).await {
                                            let _ = s.set_run_state(&run.id, "failed", None, None, Some("spawn_failed"), Some(now.timestamp_millis()));
                                            tracing::warn!("chain trigger {} failed: {}", task.id, err);
                                        }
                                    }
                                    _ => { let _ = s.set_run_state(&run.id, "skipped", None, None, Some("overlap"), Some(now.timestamp_millis())); }
                                }
                            }
                            continue;
                        }
```

`due_fire_points("")` 会返回错误，所以 `after` 任务不能走到 cron 分支，这里必须 `continue`。`list_enabled` 已经只返回 enabled 的任务。fan-out 零改动（A.3）。

- [ ] **Step 4: 确认通过**：`cargo test && cargo test after_` → PASS。

- [ ] **Step 5: Commit**

```bash
git add src/scheduled_tasks.rs
git commit -m "feat(chain): scheduler tick fires 'after' tasks once per upstream run (附录 A)"
```

---

### Task A4: 前端「在任务 X 之后」+ RunHistory 上游链接 + 部署

**Files:**
- Modify: `frontend/src/lib/api/scheduler.ts`：`ScheduledTask` 加 `after_task_id?: string | null; after_when?: string | null`；`TaskRun` 加 `upstream_run_id?: string | null`；`ScheduledTaskReq` 加 `after_task_id?: string | null; after_when?: string | null`
- Modify: `frontend/src/components/ScheduledTasksPanel.tsx`：`TaskForm` 的「调度类型」下拉加 `after`；`RunHistory` 行
- Create: `frontend/src/lib/chainForm.ts`、`frontend/src/lib/__tests__/chainForm.test.ts`

**Interfaces:**
- Produces: `buildAfterWhen(kind: 'succeeded'|'always'|'verdict', re: string): string`；`previewVerdictMatch(re: string, verdict: string | null): boolean | 'invalid'`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { buildAfterWhen, previewVerdictMatch } from '../chainForm'
describe('chainForm', () => {
  it('builds after_when', () => {
    expect(buildAfterWhen('succeeded', '')).toBe('succeeded')
    expect(buildAfterWhen('verdict', 'high')).toBe('verdict:high')
  })
  it('local preview (JS regex; server is authoritative)', () => {
    expect(previewVerdictMatch('high', '2 high')).toBe(true)
    expect(previewVerdictMatch('high', null)).toBe(false)
    expect(previewVerdictMatch('(', 'x')).toBe('invalid')
  })
})
```

- [ ] **Step 2: 确认失败**：`cd frontend && npx vitest run src/lib/__tests__/chainForm.test.ts` → FAIL。

- [ ] **Step 3: 实现**

```ts
// frontend/src/lib/chainForm.ts
export type AfterKind = 'succeeded' | 'always' | 'verdict'
export function buildAfterWhen(kind: AfterKind, re: string): string { return kind === 'verdict' ? `verdict:${re}` : kind }
export function previewVerdictMatch(re: string, verdict: string | null): boolean | 'invalid' {
  try { const r = new RegExp(re); return verdict ? r.test(verdict) : false } catch { return 'invalid' }
}
```

`TaskForm`：

- `Kind` 扩成 `ScheduleInput['kind'] | 'after'`。
- 新增 state：`upstream`（初值 `task?.after_task_id ?? ''`）、`afterKind`、`afterRe`。
- 上游候选来自 `listScheduledTasks()`，排除当前任务自身。
- 选中「在任务 X 之后」时，显示三个控件：上游 `<select>`、条件 `<select>`（成功 / 总是 / verdict 匹配）、正则 `<input>`；正则框旁边显示用上游最近一次 verdict 做的本地预览结果：
  ```ts
  listTaskRuns(upstream).then(r => r.find(x => x.verdict)?.verdict ?? null)
  ```
- submit 时，`kind === 'after'` 的请求体为：
  ```ts
  { ...body, schedule: { kind: 'cron', expr: '0 0 0 1 1 *' }, after_task_id: upstream, after_when: buildAfterWhen(afterKind, afterRe) }
  ```
  其中 schedule 是一个占位值，服务端在设了 `after_task_id` 时会忽略它（Task A2）。其余 kind 发 `after_task_id: null`。
- 编辑任务时，`task.trigger_type === 'after'` 的初值：`kind='after'`；`after_when` 以 `verdict:` 开头时 `afterKind='verdict'`，`afterRe` 取冒号后的部分。

`RunHistory` 行：`r.upstream_run_id` 非空时，在状态行下面加一行 `<div className="text-ui-2xs text-[var(--fg-subtle)]">↑ 来自 {upstreamName} #{r.upstream_run_id.slice(0, 8)}</div>`。`upstreamName` 由 `RunHistory` 的新 prop `tasks` 查出（父组件传入 `tasks`）；查不到就显示「上游已删除」。

- [ ] **Step 4: 全量门**：`cargo test && (cd frontend && npm test && npm run lint && npm run build)`。

隔离冒烟：建任务 A（Claude，prompt 让它输出 `<<<VERDICT>>>high<<<END>>>`）和任务 B（`after A`、`verdict:high`）。对 A 执行 run now；下一个 tick（≤ 60s）内 B 恰好产生 1 个 run，`upstream_run_id` 等于 A 那次 run 的 id；再等一个 tick，B 不再产生新的 run。

- [ ] **Step 5: Commit、push、部署**

```bash
git add frontend/src
git commit -m "feat(chain): 在任务 X 之后 trigger + upstream link in run history (附录 A)"
git push origin HEAD && ./deploy.sh --build
```

---

## 附：spec 与代码核实差异（执行者须知）

| # | spec 说法 | `ae5fef7` 与 `KC/` 实际情况 | 本计划的处理 |
|---|---|---|---|
| 1 | §4.2 用 `monitor.objective` 等字段 | `/api/monitors/slot/{k}` 返回的 `monitor` 是**整个 loop 的序列化**，结构化字段嵌套在 `monitor.monitor.*`（`KC/dashboard/handlers/autonudge.py:104-115`）；`cycle_count`、`max_cycles`、`active` 在外层 | Task 17 按嵌套结构解析 |
| 2 | §3.2 标出 `memory_mode != persistent` 的 slot（`restricted`） | S6 `SlotView` 没有 `memory_mode` 字段（S6 §4.2），只读快照就拿不到这个值 | 本期不做 `restricted` 标记；要做得先在 S6 的 SlotView 加字段 |
| 3 | §6.2 第 5 点：update 缺省时「保留原值」 | 现状是 SET 不含 `agent_type`，所以「保留」天然成立，但 codex 也永远写不进去（V7 已记录） | Task 1 + Task 4：两件事一起做 |
| 4 | §9.2 第 4 点：`remove_session` 用 `Handle::try_current()` spawn | 同步单测里没有 runtime | Task 8：没有 runtime 时退回到同步调用 |
| 5 | §7.2 / §6.5：conductor 定时 run 第一轮结束就 finalize | Crew 事件循环在 WS 断开时发 `AcpEvent::Error`，这是一个边界（与 S4 审计挂起的 A6 同源），移植之后可能把第一轮误记为 `failed/cli_error` | Task 26 记为已知风险，Task 27 做 7 天观测，不在 S7 里改 |
| 6 | §8.2：`turn_start_total` 在 turn 开始时取快照 | token_count 是线程累计值；resume 的线程在第一次收到计数之前没有基线 | Task 14：新线程的基线为 0；resume 且没有基线时 tokens 记为 None |
| 7 | §9.2 第 1 点：tokio 1.52.3 | `Cargo.toml` 写的是 `tokio = "1"`（features full），具体版本由 lock 决定；字段方案和版本无关 | 不需要处理 |

---

## Self-Review（写计划时执行过的检查）

- **Spec 覆盖**：§1 → Task 16/17/20/22；§2 G4/G5 → Task 19–21；§3 G6 → Task 22–25；§4 G8 → Task 17/18；§6 ② → Task 1–7；§6.5 → Task 26；§7 G10 → Task 26/27；§8 ⑧ → Task 10/14；§9 F6 → Task 8/9；§9b → Task 11/12；§0.1 T → Task 15；§11.2 指标 → 各期的验收 Task；§13 K3 → S7-e 的 spike；K5 → Task 12/18/24 的体积记录；附录 A → Task A1–A4。§5（G9）和 §10（跨设备已读）已移到 S6，本计划不涉及。
- **要求的关键测试**：`upsert_config` SET 含 `agent_type` → Task 1 `upsert_updates_agent_type_on_conflict`；`scheduled_session_type` 接受 `"crew"`，replay 仍是 Crew conductor → Task 26 `crew_replay_stays_crew_conductor` 与映射断言；自建会话重启后关闭会删 slot / external 关闭不删、resume 不调 set_project → Task 23 `own_session_after_restart_close_still_deletes_slot`、`external_session_after_restart_resume_skips_set_project_and_close_keeps_slot`；ledger 请求带 `X-Internal-Secret` 与 `X-Session-Key: dashboard:<slot>` → Task 20 `tasks_ledger_request_carries_internal_secret_and_dashboard_session_key`；G8 同时查 autonudge 与 monitors → Task 17 `fetch_patrol_queries_both_autonudge_and_monitors`。
- **名称一致性**：`crew_mode` / `crew_agent` / `crew_origin`、`owns_slot`、`persist_posture`、`payload_for(…, body)`、`zmx_usage`、`CrewWatch::snapshot() -> Arc<SlotsSnapshot>`（`SlotView` 字段以 S6 §4.2 为准）在全文中写法一致；`settle_scheduled_run` / `tee_scheduled_event` / `scheduled_input_snapshot` / `replay_inputs` / `scheduled_goal` 的定义和调用签名一致。
