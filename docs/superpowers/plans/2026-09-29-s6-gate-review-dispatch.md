# S6（P1）预检 · Crew 话题语义与叫醒 · review · 派发 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 spec §15 分期交付 S6：T0 服务端已读 + 等人时长埋点、T1 shell 预检、T2 立即运行后打开会话、T3 Crew 话题模式 turn 语义 + 断连补发、T4 外部 slot 叫醒 / Crew cron 失败推送 / `crew_watch.snapshot()`、T4b G9 只读分段、T5/T6 摘要卡 review 动作与文件定位、T7 待派发、T8 批量派发 + 目标徽标。T9（子会话折叠）受门槛 T 约束，**不在本计划**。

**Architecture:** 后端全部沿用现有模式：新列用吞错式 `ALTER`；调度 tick 内不 `.await` 预检（gate 在 `tokio::spawn` 的独立任务里跑）；话题模式在 Crew fan-out 内开一个专属分支，忙闲只经新增 `set_crew_busy`，`mark_turn`/`apply_turn` 零改动；`crew_watch` 是 Gateway slot/cron 快照的唯一写者，其余读方只调 `snapshot()`；待派发仿 `quick_targets.rs` 单表。前端新增逻辑优先做成纯函数（`lib/*.ts`）再接进组件，首屏增量 ≤ 3KB br。

**Tech Stack:** Rust（axum 0.8 / tokio 1.52 / rusqlite / reqwest / libc）、React 19 + Vite + Tailwind v4 + vitest/happy-dom。

**Spec:** `docs/superpowers/specs/2026-09-29-s6-gate-review-dispatch-design.md`（v2，V1–V22 优先于正文）。S5 统一约定见 `docs/superpowers/specs/2026-09-29-s5-feed-and-crew-probe-design.md` §0.2 U1–U5、§1.3、§2.2、§7、§8。基线 `main @ ae5fef7`（S4 已合入；S4 只动了前端终端相关文件，`src/` 与 spec 基线 `33c2236` 相同）。

## Global Constraints

- **S5 必须先上线**：S6-a 的埋点、S6-c、S6-d 都消费 S5 接口；开工前跑下方「前置：S5 已上线」检查，任何一条无输出就停下，不写替代实现。
- 字段名一律照 S5：`crew_mode`（`""|crew`）、`crew_agent`（原值）、`crew_origin`（`zeromux|external`）、`persist_posture(sid)`、`payload_for(kind, name, sid, fk, body: Option<&str>)`、埋点 target `zmx_usage`。
- 话题模式判定唯一口径：`crew_mode == "crew"`。`owns_slot = crew_origin != "external"`，**禁止**从 `resume.is_none()` 推断。
- D1（V9）：预检 **exit 0 = 唤醒**，**exit 1 = 跳过**，**其他一律 = 预检故障**（含 126/127、信号、超时、spawn 失败）。
- 预检超时默认 60s；stdout/stderr 各保留最后 64KB；注入 prompt 的是 stdout 最后 4KB（按 char 边界）；推送正文截 120 字。
- 调度 tick 内**不** `.await` 预检；gated 分支立即 `continue`。非 gated 分支保持现状（inline `.await trigger_run`）。
- `mark_turn` / `apply_turn` **零改动**；话题忙闲只经 `set_crew_busy`（不带 seq、不改 `turn_seq`、不改 `last_activity_ms`、不清 `approval_ids`）。
- fan-out 仍是进程/WS 的唯一 owner；轮询与补发请求在 process 层 detached task 发出，结果经 `mpsc` 回流同一事件循环；输入只经 `SessionInput`，不增加变体。
- `crew_watch` 是 Gateway slot/cron 快照唯一写者；快照里不含 `secret*`、`script`、`command`、`last_result` 全文。
- secret 每次现读、不缓存；token 不进 URL 以外的任何地方（crew_watch 只做 REST）。
- 首屏 br ≤ 330KB（`npm run build` 内 `check-size.mjs dist 337920`）；S6 首屏增量合计 ≤ 3KB（T0 ≤0.5、T3 ≤0.5、T4 ≤0.3、T5 ≤0.5、T7 ≤0.8、T8 徽标 ≤0.2）；`ScheduledTasksPanel`、`CrewCronList` 在 lazy chunk。
- `frontend/src/__tests__/App.characterization.test.tsx` 每个 task 原样通过，不改断言。
- 文案中文、代码/注释英文；字号只用 `text-ui-*`，颜色只用语义 token，图标只用 lucide，禁 emoji（后端推送标题沿用现有 `payload_for` 的 emoji 风格，这是既有约定），禁原生 `alert/confirm/prompt`；触控目标 ≥ 44px。
- 每个 task 结束都跑：`cargo test`、`cd frontend && npm test`、`npm run lint`、`npm run build`。
- 部署只用 `./deploy.sh --build`，且**先 commit + push 再 deploy**（zeromux 终端在 cgroup 内，deploy 会把本终端一起断开）。冒烟实例必须 `--data-dir $(mktemp -d)` + `--tmux-socket zmx-s6-smoke` + 端口 ≥ 18090。
- 部署前 `find frontend/node_modules -maxdepth 3 -type l -lname '/tmp/*'` 必须为空（2026-09-28 双 React 黑屏教训）。
- 不做：治理/权限/沙箱/审计、human verdict 持久化、「7 天未唤醒」（S7）、Crew cron 编辑、G4、G6、定时任务支持 Codex/Crew、T9。

## Review Focus

1. **待派发的目录含空格、prompt 含换行**：`${type} ${dir} ${prompt}` 预填进 ⌘K 单行 `<input>` 后，`parseNew` 按空白切分会把 `/home/u/My Project` 切成目录 `/home/u/My` + prompt `Project …`，换行也会被抹掉。期望：派发时按存储的 `dir`/`prompt` 原值创建，用户没改文本就不重新解析（Task 20 用例 `dispatch keeps stored dir with spaces and multi-line prompt`）。
2. **3 个 `crew_ask` 在 2 秒内连到，每个都 spawn 了推送任务**：只做「先读再写」的去抖会让 3 个任务都读到「未推过」。期望：去抖用单锁 check-and-mark 原子操作，最终只推 1 次（Task 10 用例 `kind_debounce_claim_is_atomic_across_threads`）。
3. **预检输出含非 UTF-8 字节或 CJK，恰好落在 4KB 截断边界**：期望不 panic、注入的 prompt 是合法 UTF-8（Task 4 用例 `tail_is_char_safe_on_cjk_and_invalid_utf8`）。
4. **话题会话忙时 Gateway 进程退出 / fan-out 收到 `Exit`**：`turn_seq` 从不写入 `rp`，通用边界逻辑的 `mark_turn(Idle, seq)` 不会生效。期望：`Exit` 时 `set_crew_busy(false)`，不会永久停在 Running 挡住 auto-update（Task 10 用例 `topics_exit_clears_busy`）。
5. **已读上报的会话已被删除，或属于他人**：去抖上报迟到后收到 404/204。期望：静默丢弃，不重试、不弹 toast，也不抛出未捕获的 rejection（Task 2 用例 `reporter drops 404 without retry`）。

---

## 前置：S5 已上线（开工前逐条执行，任何一条无输出即停止）

```bash
cd /home/ubuntu/s3-workspace/keith-space/github-search/ai/zeromux
git fetch && git log --oneline origin/main | head -5
grep -n "fn persist_posture" src/session_manager.rs                    # U3
grep -n "awaiting_input" src/session_manager.rs src/session_store.rs  # U3 列 + Posture 字段
grep -n "crew_mode\|crew_agent\|crew_origin" src/session_store.rs      # U1 三列
grep -n "pub crew_mode\|pub crew_origin" src/session_manager.rs        # SessionInfo 三字段
grep -n "pub fn payload_for(kind: &str, name: &str, session_id: &str, fk: Option<&str>, body: Option<&str>)" src/push.rs   # U4
grep -n "enum SlotInit\|owns_slot" src/acp/crew_process.rs             # R4
grep -n "fn crew_message_events" src/acp/crew_process.rs               # G1
grep -rn 'target: *"zmx_usage"' src | head -3                          # U5
grep -n "first_prompt_logged" src/session_manager.rs                   # G2 埋点
ls frontend/src/lib/awaySummary.ts frontend/src/components/shell/AwayCard.tsx frontend/src/lib/crewVariant.ts   # F3 / G2 前端
grep -n "目标指挥" frontend/src/components/shell/CommandPalette.tsx     # G2 二级 chip
```

说明：S6-b（T1/T2）、S6-e（T5/T6）、S6-f（T7/T8）不消费 S5 接口，S5 未上线时可以先做；S6-a 的**已读同步**不依赖 S5，但 `read_wait` 埋点读取的 `last_outcome_ms` 只有 S5 F1 上线后才会在重启后保留。

---

## File Structure

| 文件 | 动作 | 职责 | Task |
|---|---|---|---|
| `src/session_store.rs` | Modify | `read_ms`、`crew_last_mid` 列；`bump_read`、`update_crew_cursor` | 1、9 |
| `src/session_manager.rs` | Modify | `read_ms`/`mark_read`/`ReadOutcome`/`read_wait_ms`；`work_dir_under_home` 改 `pub(crate)`；`crew_topics`、`set_crew_busy`、`set_crew_cursor`、awaiting_input 读写、话题 fan-out 分支、`settle_crew_answer`、`maybe_push_ask`；`record_and_broadcast`/`emit` 返回是否新增审批；crew_watch 用的访问器 | 1、5、9、10、14 |
| `src/web.rs` | Modify | `POST /api/sessions/{id}/read`；`gate_cmd` 字段与 `gate-test`；`/api/crew/attention`、`/api/crew/crons*`；`/api/backlog` | 1、5、14、16、19 |
| `src/scheduled_tasks.rs` | Modify | gate 三列、`set_gate_phase`、`reconcile_orphans` 的 gate_interrupted、`run_gate`、`gated_run_body`、tick 分流 | 3、4、5 |
| `src/push.rs` | Modify | `failure_kind_zh` 增 gate；`ask`/`approval` 文案；`KindDebounce`；`PushPayload.url` | 5、10、14 |
| `src/acp/crew_process.rs` | Modify | `NormState.topics/seen_mids/cursor`；slots 分支；话题回答事件；`catch_up_plan`；30s 兜底轮询 + 连上即补发 | 8、11 |
| `src/crew_watch.rs` | Create | `CrewWatch`、`SlotsSnapshot`、解析、`slot_attention_edges`、`cron_failures`、主循环、`fetch_job_runs` | 13、14、16 |
| `src/backlog.rs` | Create | `BacklogStore`（仿 quick_targets） | 19 |
| `src/main.rs` | Modify | `mod crew_watch; mod backlog;`、`AppState` 两个字段、启动 crew_watch | 13、19 |
| `frontend/src/lib/readState.ts` + `lib/readSync.ts`(new) | Modify/Create | `mergeServerRead`、去抖上报 | 2 |
| `frontend/src/components/shell/useShellState.ts` | Modify | 合并服务端已读 + 上报；`openSession` | 2、7 |
| `frontend/src/lib/api/sessions.ts` / `scheduler.ts` / `crew.ts`(new) / `backlog.ts`(new) | Modify/Create | API 封装 | 2、6、15、16、20 |
| `frontend/src/components/ScheduledTasksPanel.tsx` + `components/crew/CrewCronList.tsx`(new) | Modify/Create | 预检字段 / 测试按钮 / runReason / 打开会话 / Crew 分段 | 6、7、16 |
| `frontend/src/hooks/useAcpSocket.ts`、`components/AcpChatView.tsx` | Modify | `crewTopics` busy 语义；review 动作接线 | 12、17 |
| `frontend/src/lib/triage.ts`、`components/shell/TriageRow.tsx`、`TriageList.tsx` | Modify | `ask` 档、话题运行中、目标徽标、待派发组 | 12、20、21 |
| `frontend/public/sw.js`、`components/shell/useSessionsPoll.ts` | Modify | 推送 `url` 深链 | 15 |
| `frontend/src/components/turn/TurnSummaryCard.tsx`、`TurnView.tsx` | Modify | 采纳 / 打回 / 提交… | 17 |
| `frontend/src/components/GitViewer.tsx`、`shell/ContextPanel.tsx`、`lib/relPath.ts`(new) | Modify/Create | 单文件定位 | 18 |
| `frontend/src/components/shell/CommandPalette.tsx`、`lib/batchDispatch.ts`(new) | Modify/Create | 存入待派发、批量派发 | 20、21 |

---

# S6-a：T0 服务端已读 + 等人时长埋点

### Task 1: 后端 `read_ms` 列、`mark_read` 与 `POST /api/sessions/{id}/read`

**Files:**
- Modify: `src/session_store.rs:28`（`PersistedSession`）、`:66`（ALTER）、`:133`（新方法放在 `update_description` 后）、`load_all`
- Modify: `src/session_manager.rs:297-339`（`Session`）、`:388-414`（`SessionInfo`）、`:667-705`（`session_info_of`）、`:2285-2344`（`load_persisted`）、`:2647`（`persisted_of`）、所有 `Session { … }` 字面量
- Modify: `src/web.rs:25-40`（路由）、handler 放在 `update_session`（`:1254`）之后
- Test: `src/session_store.rs` 的 `mod tests`、`src/session_manager.rs` 新增 `mod read_state_tests`、`src/web.rs` 的 `mod path_safety_tests`

**Interfaces:**
- Consumes: S5 F1：内存 `Posture.last_outcome` / `last_outcome_ms` 在重启后由 `load_all` 回填（仅影响埋点）。
- Produces:
  - `SessionStore::bump_read(&self, id: &str, ms: i64) -> Result<(), String>`
  - `PersistedSession.read_ms: Option<i64>`；`Session.read_ms: Option<i64>`；`SessionInfo.read_ms: Option<i64>`
  - `pub struct ReadOutcome { pub old_read_ms: Option<i64>, pub new_read_ms: i64, pub last_outcome: Option<&'static str>, pub last_outcome_ms: Option<i64>, pub sched: bool }`
  - `SessionManager::mark_read(&self, id: &str, ms: i64) -> Option<ReadOutcome>`
  - `pub fn read_wait_ms(o: &ReadOutcome) -> Option<i64>`、`pub fn clamp_read_ms(ms: i64, now: i64) -> i64`
  - `fn outcome_str(o: RunOutcome) -> &'static str`（`session_info_of` 同步改用它）
  - HTTP：`POST /api/sessions/{id}/read` body `{ms}` → 204 / 404

- [ ] **Step 1: 写 store 失败测试**

在 `src/session_store.rs` 的 `mod tests` 末尾追加：

```rust
    #[test]
    fn bump_read_is_monotonic_and_survives_reload() {
        let (st, _d) = tmp_store();
        st.upsert(&sample("a", None)).unwrap();
        st.bump_read("a", 100).unwrap();
        st.bump_read("a", 50).unwrap();   // a late, older report must not move it back
        let r = st.load_all().unwrap().into_iter().find(|x| x.id == "a").unwrap();
        assert_eq!(r.read_ms, Some(100));
        // upsert (metadata write) must not clobber read_ms
        st.upsert(&sample("a", None)).unwrap();
        let r = st.load_all().unwrap().into_iter().find(|x| x.id == "a").unwrap();
        assert_eq!(r.read_ms, Some(100));
    }

    #[test]
    fn read_ms_is_null_for_old_rows() {
        let (st, _d) = tmp_store();
        st.upsert(&sample("b", None)).unwrap();
        let r = st.load_all().unwrap().into_iter().find(|x| x.id == "b").unwrap();
        assert_eq!(r.read_ms, None);
    }
```

`sample()`（`:195`）的字面量追加 `read_ms: None,`（S5 也会在这里加字段，按实际字面量补齐）。

- [ ] **Step 2: 运行，确认失败**

Run: `cargo test --lib session_store::tests::bump_read_is_monotonic_and_survives_reload`
Expected: 编译失败，`no field read_ms` / `no method bump_read`。

- [ ] **Step 3: 实现 store**

`PersistedSession` 末尾追加字段：

```rust
    /// Server-side "last read" (S6 T0). Only owner reads bump it; monotonic (MAX).
    pub read_ms: Option<i64>,
```

`open()` 在 `pending_kill_until` 的 ALTER（`:66`）之后追加：

```rust
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN read_ms INTEGER", []);
```

在 `update_description` 之后新增：

```rust
    /// Monotonic: a late report from a stale tab can never move read_ms backwards (D21).
    pub fn bump_read(&self, id: &str, ms: i64) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE sessions SET read_ms = MAX(COALESCE(read_ms,0), ?2) WHERE id=?1",
                     params![id, ms])
            .map_err(|e| format!("bump_read failed: {}", e))?;
        Ok(())
    }
```

`load_all`：在 SELECT 列表**末尾**追加 `,read_ms`，行映射里按**列名**读（不依赖 S5 追加后的下标）：

```rust
                read_ms: row.get::<_, Option<i64>>("read_ms")?,
```

`upsert` **不**写 `read_ms`（与 S5 posture 列同理：运行态不搭元数据全量写的车）。

- [ ] **Step 4: 运行 store 测试通过**

Run: `cargo test --lib session_store::tests`
Expected: PASS（含既有用例）。

- [ ] **Step 5: 写 manager 失败测试**

在 `src/session_manager.rs` 文件末尾新增模块：

```rust
#[cfg(test)]
mod read_state_tests {
    use super::*;

    fn mgr_with_session(id: &str, owner: &str) -> (Arc<SessionManager>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let events = Arc::new(crate::events::EventStore::open(dir.path()).unwrap());
        let store = Arc::new(crate::session_store::SessionStore::open(dir.path()).unwrap());
        let m = SessionManager::new(events, store.clone(), "claude".into(), "codex".into(), "off".into(),
            5476, "/tmp/crew".into(), "bash".into(), false,
            crate::tmux::TmuxCtl::new(Some("zmx-test-unused".into())));
        let mut s = lifetime_tests_session(id, owner);
        s.posture.last_outcome = Some(crate::run_metrics::RunOutcome::Completed);
        s.posture.last_outcome_ms = Some(1_000);
        store.upsert(&persisted_of(&s)).unwrap();
        m.sessions.lock().unwrap().insert(id.into(), s);
        (m, dir)
    }

    fn lifetime_tests_session(id: &str, owner: &str) -> Session {
        Session {
            id: id.into(), name: "n".into(), session_type: SessionType::Claude, cols: 80, rows: 24,
            work_dir: "/tmp".into(), owner_id: owner.into(), description: String::new(),
            name_is_auto: true, status: SessionMeta::Idle, resume_token: None, tmux_origin: None,
            pending_kill_until: None, worktree_path: None, created_ms: 0, source_task_id: None,
            spawning: false, last_activity_ms: 0, turns_completed: 0, run_metrics: VecDeque::new(),
            lifetime_turns: 0, lifetime_duration_ms: 0, lifetime_cost_usd: 0.0, posture: Posture::default(),
            read_ms: None,
            running: None, scrollback: VecDeque::new(), scrollback_bytes: 0,
        }
    }

    #[test]
    fn first_read_after_outcome_yields_wait_once() {
        let (m, _d) = mgr_with_session("s", "u");
        let o = m.mark_read("s", 4_000).unwrap();
        assert_eq!(o.old_read_ms, None);
        assert_eq!(o.new_read_ms, 4_000);
        assert_eq!(o.last_outcome, Some("completed"));
        assert_eq!(read_wait_ms(&o), Some(3_000));
        // second read of the same outcome: no metric
        let o2 = m.mark_read("s", 9_000).unwrap();
        assert_eq!(read_wait_ms(&o2), None);
    }

    #[test]
    fn late_stale_read_never_moves_back_or_logs() {
        let (m, _d) = mgr_with_session("s", "u");
        m.mark_read("s", 5_000).unwrap();
        let o = m.mark_read("s", 500).unwrap();       // stale tab, older than the outcome
        assert_eq!(o.new_read_ms, 5_000);
        assert_eq!(read_wait_ms(&o), None);
        assert_eq!(m.list_sessions(None)[0].read_ms, Some(5_000));
    }

    #[test]
    fn read_before_outcome_is_not_a_wait() {
        let o = ReadOutcome { old_read_ms: None, new_read_ms: 500, last_outcome: Some("completed"),
                              last_outcome_ms: Some(1_000), sched: false };
        assert_eq!(read_wait_ms(&o), None);
        let none = ReadOutcome { last_outcome_ms: None, ..o };
        assert_eq!(read_wait_ms(&none), None);
    }

    #[test]
    fn clamp_read_ms_caps_future_and_negative() {
        assert_eq!(clamp_read_ms(-5, 1_000), 0);
        assert_eq!(clamp_read_ms(1_000_000, 1_000), 61_000);
        assert_eq!(clamp_read_ms(900, 1_000), 900);
    }

    #[test]
    fn mark_read_persists_and_reload_keeps_it() {
        let (m, d) = mgr_with_session("s", "u");
        m.mark_read("s", 7_000).unwrap();
        let store = crate::session_store::SessionStore::open(d.path()).unwrap();
        let r = store.load_all().unwrap().into_iter().find(|x| x.id == "s").unwrap();
        assert_eq!(r.read_ms, Some(7_000));
    }

    #[test]
    fn mark_read_unknown_session_is_none() {
        let (m, _d) = mgr_with_session("s", "u");
        assert!(m.mark_read("nope", 1).is_none());
    }
}
```

- [ ] **Step 6: 运行，确认失败**

Run: `cargo test --lib read_state_tests`
Expected: 编译失败（`read_ms`、`mark_read`、`read_wait_ms` 未定义）。

- [ ] **Step 7: 实现 manager**

`Session`（`:297`）在 `posture: Posture,` 之后加：

```rust
    /// Server-side read mark (S6 T0). Owner-only writes, monotonic.
    read_ms: Option<i64>,
```

`SessionInfo`（`:388`）末尾加 `pub read_ms: Option<i64>,`；`session_info_of` 末尾加 `read_ms: s.read_ms,`，并把 `last_outcome` 的 match 改为 `last_outcome: s.posture.last_outcome.map(outcome_str),`。

在 `session_info_of` 前新增：

```rust
fn outcome_str(o: crate::run_metrics::RunOutcome) -> &'static str {
    match o {
        crate::run_metrics::RunOutcome::Completed => "completed",
        crate::run_metrics::RunOutcome::Errored => "errored",
        crate::run_metrics::RunOutcome::Timeout => "timeout",
        crate::run_metrics::RunOutcome::Cancelled => "cancelled",
    }
}

/// What one read did, snapshotted under the sessions lock (spec §12.2).
#[derive(Debug, Clone, PartialEq)]
pub struct ReadOutcome {
    pub old_read_ms: Option<i64>,
    pub new_read_ms: i64,
    pub last_outcome: Option<&'static str>,
    pub last_outcome_ms: Option<i64>,
    pub sched: bool,
}

/// North-star metric: ms from outcome to the FIRST read that saw it; None otherwise.
pub fn read_wait_ms(o: &ReadOutcome) -> Option<i64> {
    let out = o.last_outcome_ms?;
    if out <= o.old_read_ms.unwrap_or(0) || o.new_read_ms < out { return None; }
    Some(o.new_read_ms - out)
}

/// A fast client clock may claim a read in the future; allow 60s of skew.
pub fn clamp_read_ms(ms: i64, now: i64) -> i64 { ms.clamp(0, now + 60_000) }
```

`impl SessionManager` 内（`is_owner` 之后）新增：

```rust
    /// Owner read mark: monotonic in memory, then persisted OUTSIDE the lock.
    pub fn mark_read(&self, id: &str, ms: i64) -> Option<ReadOutcome> {
        let out = {
            let mut map = self.sessions.lock().unwrap();
            let s = map.get_mut(id)?;
            let old = s.read_ms;
            let new = old.map_or(ms, |o| o.max(ms));
            s.read_ms = Some(new);
            ReadOutcome {
                old_read_ms: old, new_read_ms: new,
                last_outcome: s.posture.last_outcome.map(outcome_str),
                last_outcome_ms: s.posture.last_outcome_ms,
                sched: s.source_task_id.is_some(),
            }
        };
        if let Err(e) = self.store.bump_read(id, out.new_read_ms) {
            tracing::warn!("bump_read {} failed: {}", id, e);
        }
        Some(out)
    }
```

所有 `Session { … }` 字面量补 `read_ms: None,`：`:1165`、`:1284`、`:1630`、`:1734`（创建路径），`:2308`（`load_persisted`）写 `read_ms: p.read_ms,`，以及测试字面量 `:4666`、`:4864`、`:5573`、`:5836` 附近、`:6404`、`:7018`、`:7158`（`cargo build --tests` 会逐个指出）。`persisted_of`（`:2647`）追加 `read_ms: s.read_ms,`；`:7049` 的测试 `PersistedSession` 字面量补 `read_ms: None,`。

- [ ] **Step 8: 运行 manager 测试通过**

Run: `cargo test --lib read_state_tests`
Expected: 6 passed。

- [ ] **Step 9: 写 handler 判定的失败测试**

`src/web.rs` 的 `mod path_safety_tests` 末尾追加：

```rust
    #[test]
    fn read_gate_owner_only_and_404() {
        assert_eq!(read_gate(false, false), ReadGate::NotFound);
        assert_eq!(read_gate(true, false), ReadGate::IgnoreNonOwner);
        assert_eq!(read_gate(true, true), ReadGate::Write);
    }
```

Run: `cargo test --lib path_safety_tests::read_gate_owner_only_and_404` → 编译失败。

- [ ] **Step 10: 实现 handler + 路由**

`update_session` 之后新增：

```rust
#[derive(Debug, PartialEq)]
enum ReadGate { NotFound, IgnoreNonOwner, Write }

/// Admin viewing someone else's session must not mark it read for the owner (D21).
fn read_gate(exists: bool, is_owner: bool) -> ReadGate {
    match (exists, is_owner) {
        (false, _) => ReadGate::NotFound,
        (true, false) => ReadGate::IgnoreNonOwner,
        (true, true) => ReadGate::Write,
    }
}

#[derive(serde::Deserialize)]
struct ReadReq { ms: i64 }

/// POST /api/sessions/{id}/read — server-side read mark + north-star `read_wait` (S6 T0).
async fn post_session_read(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(req): Json<ReadReq>,
) -> StatusCode {
    match read_gate(state.sessions.session_exists(&id), state.sessions.is_owner(&id, &user.id)) {
        ReadGate::NotFound => return StatusCode::NOT_FOUND,
        ReadGate::IgnoreNonOwner => return StatusCode::NO_CONTENT,
        ReadGate::Write => {}
    }
    let now = crate::session_manager::now_millis();
    let ms = crate::session_manager::clamp_read_ms(req.ms, now);
    if let Some(o) = state.sessions.mark_read(&id, ms) {
        if let Some(wait) = crate::session_manager::read_wait_ms(&o) {
            tracing::info!(target: "zmx_usage", "read_wait sid={} wait_ms={} kind={} sched={}",
                id, wait, o.last_outcome.unwrap_or("none"), o.sched);
        }
    }
    StatusCode::NO_CONTENT
}
```

路由组在 `.route("/api/sessions/{id}/restore", …)` 之后加：

```rust
        .route("/api/sessions/{id}/read", post(post_session_read))
```

- [ ] **Step 11: 全量后端测试**

Run: `cargo test`
Expected: 全绿。

- [ ] **Step 12: Commit**

```bash
git add src/session_store.rs src/session_manager.rs src/web.rs
git commit -m "feat(T0): server-side read_ms + read_wait zmx_usage metric

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 前端合并服务端已读 + 去抖上报

**Files:**
- Modify: `frontend/src/lib/api/sessions.ts:7-33`（`SessionInfo`）+ 新函数 `postSessionRead`
- Modify: `frontend/src/lib/readState.ts`（`reconcileLastViewed` 增参、`mergeServerRead`）
- Create: `frontend/src/lib/readSync.ts`
- Modify: `frontend/src/components/shell/useShellState.ts:78-105`
- Test: `frontend/src/lib/__tests__/readState.test.ts`、Create `frontend/src/lib/__tests__/readSync.test.ts`

**Interfaces:**
- Consumes: Task 1 `SessionInfo.read_ms`、`POST /api/sessions/{id}/read`。
- Produces:
  - `SessionInfo.read_ms?: number | null`
  - `postSessionRead(id: string, ms: number): Promise<void>`（404 抛 `ApiError(404)`）
  - `reconcileLastViewed(prev, sids, now, firstRun, serverBase?: Record<string, number>)`
  - `mergeServerRead(prev: Record<string, number>, sessions: { id: string; read_ms?: number | null }[]): Record<string, number>`
  - `createReadReporter(post: (sid: string, ms: number) => Promise<void>, delayMs?: number): { report(sid: string, ms: number): void; flush(): void; dispose(): void }`

- [ ] **Step 1: 写失败测试**

`readState.test.ts` 追加：

```ts
import { mergeServerRead } from '../readState'

describe('server read merge (S6 T0)', () => {
  it('takes max(local, server) per sid and keeps identity when unchanged', () => {
    const prev = { a: 100, b: 500 }
    const next = mergeServerRead(prev, [{ id: 'a', read_ms: 300 }, { id: 'b', read_ms: 200 }, { id: 'c', read_ms: null }])
    expect(next).toEqual({ a: 300, b: 500 })
    expect(mergeServerRead(next, [{ id: 'a', read_ms: 300 }])).toBe(next)
  })
  it('first run baselines a new sid at the server value instead of now', () => {
    expect(reconcileLastViewed({}, ['a', 'b'], 1000, true, { a: 40 })).toEqual({ a: 40, b: 1000 })
  })
  it('A3 still holds: not first run, unseen sid baselines at 0 even with no server value', () => {
    expect(reconcileLastViewed({ a: 10 }, ['a', 'n'], 100, false, {})).toEqual({ a: 10, n: 0 })
  })
})
```

新建 `readSync.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createReadReporter } from '../readSync'
import { ApiError } from '../api'

describe('createReadReporter', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('debounces per sid (2s) and sends only the latest ms', async () => {
    const post = vi.fn().mockResolvedValue(undefined)
    const r = createReadReporter(post)
    r.report('a', 1); r.report('a', 5); r.report('b', 3)
    await vi.advanceTimersByTimeAsync(1999)
    expect(post).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(post.mock.calls).toEqual([['a', 5], ['b', 3]])
  })
  it('flush sends pending immediately (visibilitychange → hidden)', async () => {
    const post = vi.fn().mockResolvedValue(undefined)
    const r = createReadReporter(post)
    r.report('a', 9); r.flush()
    await Promise.resolve()
    expect(post).toHaveBeenCalledWith('a', 9)
  })
  it('reporter drops 404 without retry', async () => {
    const post = vi.fn().mockRejectedValue(new ApiError(404))
    const r = createReadReporter(post)
    r.report('gone', 1)
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(post).toHaveBeenCalledTimes(1)
  })
  it('dispose cancels pending timers', async () => {
    const post = vi.fn().mockResolvedValue(undefined)
    const r = createReadReporter(post)
    r.report('a', 1); r.dispose()
    await vi.advanceTimersByTimeAsync(3000)
    expect(post).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `cd frontend && npx vitest run src/lib/__tests__/readState.test.ts src/lib/__tests__/readSync.test.ts`
Expected: FAIL（`mergeServerRead` / `createReadReporter` 不存在）。

- [ ] **Step 3: 实现**

`lib/api/sessions.ts` 的 `SessionInfo` 末尾加 `read_ms?: number | null`，并追加：

```ts
export async function postSessionRead(id: string, ms: number): Promise<void> {
  const res = await api(`/api/sessions/${id}/read`, { method: 'POST', body: JSON.stringify({ ms: Math.floor(ms) }) })
  if (!res.ok) throw new ApiError(res.status, 'postSessionRead failed')
}
```

`lib/readState.ts`：`reconcileLastViewed` 改为

```ts
export function reconcileLastViewed(prev: Record<string, number>, sids: string[], now: number, firstRun: boolean,
  serverBase: Record<string, number> = {}): Record<string, number> {
  const keep = new Set(sids)
  let changed = Object.keys(prev).some(k => !keep.has(k))
  const next: Record<string, number> = {}
  for (const id of sids) {
    if (id in prev) next[id] = prev[id]
    else { next[id] = firstRun ? (serverBase[id] ?? now) : 0; changed = true }
  }
  return changed ? next : prev
}

/** Cross-device read (S6 T0): server read_ms only ever raises the local mark. */
export function mergeServerRead(prev: Record<string, number>, sessions: { id: string; read_ms?: number | null }[]): Record<string, number> {
  let next: Record<string, number> | null = null
  for (const s of sessions) {
    const v = s.read_ms
    if (v == null || !(s.id in prev) || v <= prev[s.id]) continue
    next ??= { ...prev }
    next[s.id] = v
  }
  return next ?? prev
}
```

新建 `lib/readSync.ts`：

```ts
// Per-sid debounced upload of read marks (S6 T0). Failures are silent: the next
// markViewed re-sends; a 404 (session gone) or any other error is simply dropped.
export function createReadReporter(post: (sid: string, ms: number) => Promise<void>, delayMs = 2000) {
  const pending = new Map<string, { ms: number; t: ReturnType<typeof setTimeout> }>()
  const send = (sid: string) => {
    const p = pending.get(sid)
    if (!p) return
    clearTimeout(p.t)
    pending.delete(sid)
    post(sid, p.ms).catch(() => { /* dropped on purpose (incl. 404) */ })
  }
  return {
    report(sid: string, ms: number) {
      const cur = pending.get(sid)
      if (cur) clearTimeout(cur.t)
      pending.set(sid, { ms: Math.max(ms, cur?.ms ?? 0), t: setTimeout(() => send(sid), delayMs) })
    },
    flush() { for (const sid of [...pending.keys()]) send(sid) },
    dispose() { for (const p of pending.values()) clearTimeout(p.t); pending.clear() },
  }
}
```

`useShellState.ts`：import `mergeServerRead`、`createReadReporter`、`postSessionRead`；把 `:86-93` 的 reconcile effect 改为

```ts
  useEffect(() => {
    if (sessions.length === 0) return
    const server: Record<string, number> = {}
    for (const s of sessions) if (s.read_ms != null) server[s.id] = s.read_ms
    // eslint-disable-next-line react-hooks/set-state-in-effect -- derived bookkeeping on each poll; returns prev when unchanged
    setLastViewedMs(prev => mergeServerRead(reconcileLastViewed(prev, sessions.map(s => s.id), Date.now(), firstRun, server), sessions))
    setReconciled(true)
  }, [sessions, firstRun])
```

并在 `saveLastViewed` effect 之后加上报：

```ts
  // Upload local read marks that the server doesn't know yet (S6 T0).
  const reporterRef = useRef<ReturnType<typeof createReadReporter> | null>(null)
  useEffect(() => {
    const r = createReadReporter(postSessionRead)
    reporterRef.current = r
    const onHide = () => { if (document.visibilityState === 'hidden') r.flush() }
    document.addEventListener('visibilitychange', onHide)
    return () => { document.removeEventListener('visibilitychange', onHide); r.dispose() }
  }, [])
  useEffect(() => {
    if (!reconciled) return
    for (const s of sessionsRef.current) {
      const local = lastViewedMs[s.id]
      if (local != null && local > (s.read_ms ?? 0)) reporterRef.current?.report(s.id, local)
    }
  }, [lastViewedMs, reconciled])
```

（`sessionsRef` 已在 `:107` 定义；把这两个 effect 放在它之后。）

- [ ] **Step 4: 运行测试通过**

Run: `cd frontend && npx vitest run src/lib/__tests__/readState.test.ts src/lib/__tests__/readSync.test.ts src/__tests__/App.characterization.test.tsx`
Expected: PASS（characterization 不改）。

- [ ] **Step 5: 全量前端检查**

Run: `cd frontend && npm test && npm run lint && npm run build`
Expected: 全绿；`check-size` 首屏增量 ≤ 0.5KB（记下 build 输出的 br 数值）。

- [ ] **Step 6: Commit + 上线（S6-a）**

```bash
git add frontend/src/lib/api/sessions.ts frontend/src/lib/readState.ts frontend/src/lib/readSync.ts frontend/src/components/shell/useShellState.ts frontend/src/lib/__tests__/readState.test.ts frontend/src/lib/__tests__/readSync.test.ts
git commit -m "feat(T0): merge server read_ms and debounce-upload read marks

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push
./deploy.sh --build
journalctl -u zeromux --since "10 min ago" | grep 'zmx_usage.*read_wait' | head -3
```

退出标准：生产日志出现 `read_wait`；M6 手测（两台设备 10 次，手机读过后电脑 ≤3s 不再显示「完成·未读」）。

---

# S6-b：T1 shell 预检 + T2 立即运行后打开会话

### Task 3: 预检数据模型（三列、`upsert_config` SET、`set_gate_phase`、重启 orphan 处理）

**Files:**
- Modify: `src/scheduled_tasks.rs:380-399`（`TaskConfig`）、`:448-455`（ALTER 列表）、`:476-486`（`upsert_config`）、`:495-505`（`query_configs`）、`:543-554`（`set_run_state` 后新增 `set_gate_phase`）、`:670-719`（`reconcile_orphans`）
- Modify: 所有 `TaskConfig { … }` 字面量：`src/scheduled_tasks.rs:233,262,289,322,1356,1419,1460,1534,1568,1591,1621,1644,1714`，`src/web.rs:3434,3477`
- Test: `src/scheduled_tasks.rs` 的 `mod store_tests`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `TaskConfig.gate_cmd: Option<String>`、`TaskConfig.gate_since_ms: Option<i64>`（均 `#[serde(default)]`）
  - `ScheduledStore::set_gate_phase(&self, run_id: &str, on: bool) -> Result<(), String>`
  - `reconcile_orphans(None)`：`gate_phase=1` 的在途行 → `failed/gate_interrupted`，不进确认队列、不推送

- [ ] **Step 1: 写失败测试**

`mod store_tests` 末尾追加（`cfg()` 助手放在测试模块内）：

```rust
    fn gate_cfg(id: &str, se: bool, gate: Option<&str>) -> TaskConfig {
        TaskConfig { id: id.into(), owner_id: "u".into(), name: id.into(), trigger_type: "cron".into(),
            trigger_spec: "0 0 * * * *".into(), tz: "Asia/Shanghai".into(), agent_type: "claude".into(),
            work_dir: ".".into(), prompt: "p".into(), enabled: true, retention_n: 20, created_ms: 1,
            side_effects: se, max_runtime_min: None, idle_timeout_min: None,
            gate_cmd: gate.map(String::from), gate_since_ms: gate.map(|_| 10) }
    }
    fn claimed(id: &str, task: &str) -> TaskRun {
        TaskRun { id: id.into(), task_id: task.into(), scheduled_for_ms: 1, state: "claimed".into(),
            session_id: None, verdict: None, failure_kind: None, started_ms: Some(1), ended_ms: None,
            input_snapshot: None, confirm_status: None, replay_of: None }
    }

    // V10: ON CONFLICT SET must include the new columns, or an edit never lands.
    #[test]
    fn upsert_config_set_includes_gate_cmd_and_gate_since_ms() {
        let (s, _d) = store();
        s.upsert_config(&gate_cfg("t", false, Some("gh issue list | jq -e 'length>0'"))).unwrap();
        let mut c = gate_cfg("t", false, Some("test -s inbox.txt"));
        c.gate_since_ms = Some(99);
        s.upsert_config(&c).unwrap();
        let got = s.get_config("t").unwrap().unwrap();
        assert_eq!(got.gate_cmd.as_deref(), Some("test -s inbox.txt"));
        assert_eq!(got.gate_since_ms, Some(99));
        // and clearing it (Some → None) also lands
        s.upsert_config(&gate_cfg("t", false, None)).unwrap();
        let got = s.get_config("t").unwrap().unwrap();
        assert_eq!(got.gate_cmd, None);
        assert_eq!(got.gate_since_ms, None);
    }

    #[test]
    fn gate_phase_orphan_side_effects_1_is_gate_interrupted_not_queued() {
        let (s, _d) = store();
        s.upsert_config(&gate_cfg("t", true, Some("true"))).unwrap();
        s.claim_run(&claimed("r", "t")).unwrap();
        s.set_gate_phase("r", true).unwrap();
        s.reconcile_orphans(None).unwrap();
        let r = s.runs_for_task("t", 5).unwrap().pop().unwrap();
        assert_eq!((r.state.as_str(), r.failure_kind.as_deref()), ("failed", Some("gate_interrupted")));
        assert!(r.ended_ms.is_some());
        assert_eq!(s.confirmation_count("u").unwrap(), 0, "gate never ran the agent → nothing to confirm");
        assert_eq!(s.active_run_count().unwrap(), 0);
    }

    // V20: side_effects=0 lands on the same state (not aborted/orphaned_restart).
    #[test]
    fn gate_phase_orphan_side_effects_0_is_also_gate_interrupted() {
        let (s, _d) = store();
        s.upsert_config(&gate_cfg("t", false, Some("true"))).unwrap();
        s.claim_run(&claimed("r", "t")).unwrap();
        s.set_gate_phase("r", true).unwrap();
        s.reconcile_orphans(None).unwrap();
        let r = s.runs_for_task("t", 5).unwrap().pop().unwrap();
        assert_eq!((r.state.as_str(), r.failure_kind.as_deref()), ("failed", Some("gate_interrupted")));
    }

    // V20: after Wake cleared gate_phase, a crash is an ordinary orphan (agent DID start).
    #[test]
    fn crash_after_wake_is_orphaned_restart_and_queued() {
        let (s, _d) = store();
        s.upsert_config(&gate_cfg("t", true, Some("true"))).unwrap();
        s.claim_run(&claimed("r", "t")).unwrap();
        s.set_gate_phase("r", true).unwrap();
        s.set_gate_phase("r", false).unwrap();
        s.set_run_state("r", "running", Some("sess"), None, None, None).unwrap();
        s.reconcile_orphans(None).unwrap();
        let r = s.runs_for_task("t", 5).unwrap().pop().unwrap();
        assert_eq!((r.state.as_str(), r.failure_kind.as_deref()), ("aborted", Some("orphaned_restart")));
        assert_eq!(s.confirmation_count("u").unwrap(), 1);
    }

    #[test]
    fn gate_migration_is_idempotent() {
        let d = tempfile::tempdir().unwrap();
        { ScheduledStore::open(d.path()).unwrap(); }
        ScheduledStore::open(d.path()).unwrap();
    }
```

- [ ] **Step 2: 运行，确认失败**

Run: `cargo test --lib store_tests::upsert_config_set_includes_gate_cmd_and_gate_since_ms`
Expected: 编译失败（`gate_cmd` 字段不存在）。

- [ ] **Step 3: 实现**

`TaskConfig` 末尾追加：

```rust
    /// Shell pre-check (S6 T1). NULL = none. exit 0 wake / 1 skip / else failure.
    #[serde(default)]
    pub gate_cmd: Option<String>,
    /// When gate_cmd last changed (S7 「7 天未唤醒」 reads it; S6 only maintains it).
    #[serde(default)]
    pub gate_since_ms: Option<i64>,
```

ALTER 列表追加三行：

```rust
            "ALTER TABLE agent_runs_config ADD COLUMN gate_cmd TEXT",
            "ALTER TABLE agent_runs_config ADD COLUMN gate_since_ms INTEGER",
            "ALTER TABLE agent_task_runs ADD COLUMN gate_phase INTEGER NOT NULL DEFAULT 0",
```

`upsert_config` 整体替换为：

```rust
    pub fn upsert_config(&self, c: &TaskConfig) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO agent_runs_config
             (id,owner_id,name,trigger_type,trigger_spec,tz,agent_type,work_dir,prompt,enabled,retention_n,created_ms,side_effects,max_runtime_min,idle_timeout_min,gate_cmd,gate_since_ms)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)
             ON CONFLICT(id) DO UPDATE SET name=?3,trigger_spec=?5,work_dir=?8,prompt=?9,enabled=?10,retention_n=?11,side_effects=?13,max_runtime_min=?14,idle_timeout_min=?15,gate_cmd=?16,gate_since_ms=?17",
            params![c.id,c.owner_id,c.name,c.trigger_type,c.trigger_spec,c.tz,c.agent_type,
                    c.work_dir,c.prompt,c.enabled as i64,c.retention_n,c.created_ms,
                    c.side_effects as i64, c.max_runtime_min, c.idle_timeout_min,
                    c.gate_cmd, c.gate_since_ms],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }
```

`query_configs`：SELECT 末尾追加 `,gate_cmd,gate_since_ms`；行映射末尾追加 `gate_cmd: r.get(15)?, gate_since_ms: r.get(16)?,`。

`set_run_state` 之后新增：

```rust
    /// Marks a claimed run as "inside its shell pre-check" so a restart can tell a
    /// gate that never woke the agent from a real orphan (failure_kind can't be used:
    /// set_run_state COALESCEs it, so it could never be cleared again).
    pub fn set_gate_phase(&self, run_id: &str, on: bool) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE agent_task_runs SET gate_phase=?2 WHERE id=?1",
                     params![run_id, on as i64]).map_err(|e| e.to_string())?;
        Ok(())
    }
```

`reconcile_orphans`：两条候选 SELECT 的 WHERE 都追加 `AND r.gate_phase=0`；`None` 分支在无条件 UPDATE 之前先执行：

```rust
                None => {
                    // A run still inside its pre-check never started the agent: not an
                    // unknown-side-effect orphan. Not in the confirm-queue kinds → no queue, no push.
                    conn.execute(
                        "UPDATE agent_task_runs SET state='failed', failure_kind='gate_interrupted', ended_ms=?1 \
                         WHERE state IN ('claimed','running') AND gate_phase=1", params![now])
                        .map_err(|e| e.to_string())?;
                    conn.execute(
                        "UPDATE agent_task_runs SET state='aborted', failure_kind='orphaned_restart', ended_ms=?1 \
                         WHERE state IN ('claimed','running')", params![now])
                }
```

（`n` 仍取第二条 UPDATE 的行数；第一条的行数不影响推送判断。）其余 `TaskConfig { … }` 字面量追加 `gate_cmd: None, gate_since_ms: None`（`web.rs` 两处在 Task 5 改为真实值，本 task 先写 `None`）。

- [ ] **Step 4: 运行测试通过**

Run: `cargo test --lib store_tests`
Expected: PASS（含 `reconcile_marks_orphans_aborted`、`reconcile_stamps_failure_kind`）。

- [ ] **Step 5: Commit**

```bash
git add src/scheduled_tasks.rs src/web.rs
git commit -m "feat(T1): gate_cmd/gate_since_ms/gate_phase columns; restart orphan → gate_interrupted

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `run_gate`——执行预检、判定、截断、超时杀进程组

**Files:**
- Modify: `src/scheduled_tasks.rs`（在 `stale_verdict` 之后新增 gate 执行区）
- Test: `src/scheduled_tasks.rs` 新增 `mod gate_tests`

**Interfaces:**
- Consumes: 无（`libc` 已是依赖，`Cargo.toml:48`）。
- Produces:
  - `pub const GATE_TIMEOUT: Duration = 60s`、`GATE_READ_CAP = 64 * 1024`、`GATE_PROMPT_TAIL = 4096`
  - `#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)] #[serde(rename_all = "snake_case")] pub enum GateVerdict { Wake, Clean, Error, Timeout }`
  - `#[derive(Debug, Clone, serde::Serialize)] pub struct GateOutcome { verdict, exit_code: Option<i32>, duration_ms: i64, stdout_tail: String, stderr_tail: String }`
  - `pub fn classify_exit(code: Option<i32>) -> GateVerdict`
  - `pub fn tail_utf8(buf: &[u8], max_bytes: usize) -> String`
  - `pub async fn run_gate(cmd: &str, dir: &Path, timeout: Duration) -> GateOutcome`

- [ ] **Step 1: 写失败测试**

```rust
#[cfg(test)]
mod gate_tests {
    use super::*;
    use std::time::Duration;

    fn dir() -> tempfile::TempDir { tempfile::tempdir().unwrap() }

    #[test]
    fn d1_exit_code_mapping() {
        assert_eq!(classify_exit(Some(0)), GateVerdict::Wake);
        assert_eq!(classify_exit(Some(1)), GateVerdict::Clean);
        for c in [2, 5, 125, 126, 127, 255] { assert_eq!(classify_exit(Some(c)), GateVerdict::Error, "exit {c}"); }
        assert_eq!(classify_exit(None), GateVerdict::Error, "killed by signal");
    }

    #[tokio::test]
    async fn exit_0_wakes_with_stdout() {
        let d = dir();
        let o = run_gate("echo hi", d.path(), GATE_TIMEOUT).await;
        assert_eq!((o.verdict, o.exit_code), (GateVerdict::Wake, Some(0)));
        assert_eq!(o.stdout_tail.trim(), "hi");
    }

    #[tokio::test]
    async fn exit_1_is_clean_exit_2_and_127_are_errors() {
        let d = dir();
        assert_eq!(run_gate("exit 1", d.path(), GATE_TIMEOUT).await.verdict, GateVerdict::Clean);
        assert_eq!(run_gate("exit 2", d.path(), GATE_TIMEOUT).await.verdict, GateVerdict::Error);
        let o = run_gate("nonexistent_zz_cmd", d.path(), GATE_TIMEOUT).await;
        assert_eq!((o.verdict, o.exit_code), (GateVerdict::Error, Some(127)));
        assert!(o.stderr_tail.contains("not found"), "{}", o.stderr_tail);
    }

    #[tokio::test]
    async fn jq_recipe_nonempty_wakes_empty_skips() {
        let d = dir();
        let has_jq = std::process::Command::new("sh").arg("-c").arg("command -v jq").status().map(|s| s.success()).unwrap_or(false);
        let (yes, no) = if has_jq {
            (r#"echo '[1]' | jq -e 'length>0'"#, r#"echo '[]' | jq -e 'length>0'"#)
        } else {
            ("printf x > f && test -s f", ": > f && test -s f")   // same exit semantics
        };
        assert_eq!(run_gate(yes, d.path(), GATE_TIMEOUT).await.verdict, GateVerdict::Wake);
        assert_eq!(run_gate(no, d.path(), GATE_TIMEOUT).await.verdict, GateVerdict::Clean);
    }

    #[test]
    fn tail_is_char_safe_on_cjk_and_invalid_utf8() {
        let s = "预检".repeat(2000);                  // 3 bytes/char
        let t = tail_utf8(s.as_bytes(), 4096);
        assert!(t.len() <= 4096 && t.chars().all(|c| c == '预' || c == '检'));
        let mut raw = vec![0xffu8, 0xfe];
        raw.extend_from_slice("尾".as_bytes());
        assert_eq!(tail_utf8(&raw, 3), "尾");
        assert!(tail_utf8(&raw, 64).ends_with('尾'));   // lossy, no panic
    }

    #[tokio::test]
    async fn five_kb_output_keeps_only_last_4kb_for_prompt() {
        let d = dir();
        let o = run_gate("head -c 5120 /dev/zero | tr '\\0' a; echo END", d.path(), GATE_TIMEOUT).await;
        assert_eq!(o.verdict, GateVerdict::Wake);
        assert!(o.stdout_tail.len() <= GATE_PROMPT_TAIL);
        assert!(o.stdout_tail.trim_end().ends_with("END"));
    }

    #[tokio::test]
    async fn timeout_kills_process_group_and_reaps_sh() {
        let d = dir();
        let o = run_gate("echo $$; sleep 999 & echo $!; wait", d.path(), Duration::from_millis(300)).await;
        assert_eq!(o.verdict, GateVerdict::Timeout);
        let pids: Vec<u32> = o.stdout_tail.lines().filter_map(|l| l.trim().parse().ok()).collect();
        assert_eq!(pids.len(), 2, "sh pid + grandchild pid: {:?}", o.stdout_tail);
        tokio::time::sleep(Duration::from_millis(200)).await;
        for p in pids {
            assert!(!std::path::Path::new(&format!("/proc/{p}/stat")).exists(),
                "pid {p} still present (grandchild alive or sh left as zombie)");
        }
    }

    #[tokio::test]
    async fn infinite_output_is_bounded_and_times_out() {
        let d = dir();
        let o = run_gate("yes", d.path(), Duration::from_millis(300)).await;
        assert_eq!(o.verdict, GateVerdict::Timeout);
        assert!(o.stdout_tail.len() <= GATE_PROMPT_TAIL);
    }
}
```

- [ ] **Step 2: 运行，确认失败**

Run: `cargo test --lib gate_tests`
Expected: 编译失败（`run_gate` 未定义）。

- [ ] **Step 3: 实现**

在 `stale_verdict` 之后加入：

```rust
// ── Shell pre-check (S6 T1, spec §2.3) ──────────────────────────────────────

pub const GATE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
pub const GATE_READ_CAP: usize = 64 * 1024;
pub const GATE_PROMPT_TAIL: usize = 4096;
const GATE_STDERR_TAIL: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GateVerdict { Wake, Clean, Error, Timeout }

#[derive(Debug, Clone, serde::Serialize)]
pub struct GateOutcome {
    pub verdict: GateVerdict,
    pub exit_code: Option<i32>,
    pub duration_ms: i64,
    pub stdout_tail: String,
    pub stderr_tail: String,
}

/// D1 (V9): 0 = condition holds → wake; 1 = nothing to do → skip; anything else
/// (incl. 126/127, a signal = None) is a broken pre-check.
pub fn classify_exit(code: Option<i32>) -> GateVerdict {
    match code {
        Some(0) => GateVerdict::Wake,
        Some(1) => GateVerdict::Clean,
        _ => GateVerdict::Error,
    }
}

/// Last `max_bytes` of `buf` as UTF-8, never splitting a char (07-16 lesson).
pub fn tail_utf8(buf: &[u8], max_bytes: usize) -> String {
    let s = String::from_utf8_lossy(buf);
    if s.len() <= max_bytes { return s.into_owned(); }
    let mut start = s.len() - max_bytes;
    while !s.is_char_boundary(start) { start += 1; }
    s[start..].to_string()
}

/// Drain a pipe to EOF keeping only the last `cap` bytes (bounded memory for `yes`).
async fn read_tail<R: tokio::io::AsyncRead + Unpin>(mut r: R, cap: usize) -> Vec<u8> {
    use tokio::io::AsyncReadExt;
    let mut keep: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match r.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                keep.extend_from_slice(&chunk[..n]);
                if keep.len() > cap * 2 { keep.drain(..keep.len() - cap); }
            }
        }
    }
    if keep.len() > cap { keep.drain(..keep.len() - cap); }
    keep
}

/// Run `sh -c cmd` in `dir` in its own process group. Reusable by the scheduler
/// (spawned task, never the tick) and by POST /api/scheduled-tasks/gate-test.
pub async fn run_gate(cmd: &str, dir: &Path, timeout: std::time::Duration) -> GateOutcome {
    use std::process::Stdio;
    let started = std::time::Instant::now();
    let ms = |t: std::time::Instant| t.elapsed().as_millis() as i64;
    let mut c = tokio::process::Command::new("sh");
    c.arg("-c").arg(cmd).current_dir(dir)
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .process_group(0).kill_on_drop(true);
    let mut child = match c.spawn() {
        Ok(ch) => ch,
        Err(e) => return GateOutcome { verdict: GateVerdict::Error, exit_code: None, duration_ms: ms(started),
                                       stdout_tail: String::new(), stderr_tail: format!("spawn_failed: {e}") },
    };
    let pgid = child.id();
    let so = tokio::spawn(read_tail(child.stdout.take().expect("piped"), GATE_READ_CAP));
    let se = tokio::spawn(read_tail(child.stderr.take().expect("piped"), GATE_READ_CAP));
    let (verdict, exit_code) = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(st)) => (classify_exit(st.code()), st.code()),
        Ok(Err(_)) => (GateVerdict::Error, None),
        Err(_) => {
            // kill_on_drop only reaches `sh`; the pipeline's grandchildren (gh, jq)
            // would linger in the zeromux cgroup. Kill the whole group, then reap sh (V15).
            if let Some(p) = pgid { unsafe { libc::kill(-(p as i32), libc::SIGKILL); } }
            let _ = child.wait().await;
            (GateVerdict::Timeout, None)
        }
    };
    // A backgrounded grandchild may still hold a pipe open: bound the drain.
    let grab = |h: tokio::task::JoinHandle<Vec<u8>>| async move {
        tokio::time::timeout(std::time::Duration::from_secs(2), h).await.ok().and_then(|r| r.ok()).unwrap_or_default()
    };
    let (out, err) = (grab(so).await, grab(se).await);
    GateOutcome {
        verdict, exit_code, duration_ms: ms(started),
        stdout_tail: tail_utf8(&out, GATE_PROMPT_TAIL),
        stderr_tail: tail_utf8(&err, GATE_STDERR_TAIL),
    }
}
```

- [ ] **Step 4: 运行测试通过**

Run: `cargo test --lib gate_tests`
Expected: 7 passed。

- [ ] **Step 5: Commit**

```bash
git add src/scheduled_tasks.rs
git commit -m "feat(T1): run_gate — exit 0 wake / 1 skip / else fault; group kill + reap on timeout

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: gated 执行路径（tick 分流、Wake 复核、推送）+ handler 字段 + `gate-test` 端点

**Files:**
- Modify: `src/session_manager.rs:492`（`work_dir_under_home` 改为 `pub(crate)`）
- Modify: `src/push.rs:332-341`（`failure_kind_zh`）
- Modify: `src/scheduled_tasks.rs`（新增 `GateStep`/`gate_step`/`wake_prompt`/`run_gated`/`spawn_gated_run`；tick `:1190-1197` 分流）
- Modify: `src/web.rs:3388-3402`（`ScheduledTaskReq`）、`:3420-3518`（create/update）、路由 `:64-70`
- Test: `src/scheduled_tasks.rs` `mod gate_tests`、`src/web.rs` `mod path_safety_tests`、`src/push.rs` `mod tests`

**Interfaces:**
- Consumes: Task 3 `set_gate_phase`、`gate_cmd`；Task 4 `run_gate`/`GateOutcome`/`GateVerdict`；**S5 U4** `payload_for(kind, name, sid, fk, body: Option<&str>)`。
- Produces:
  - `pub(crate) enum GateStep { Skip(&'static str), Fail(&'static str), Wake(String) }`
  - `pub(crate) fn gate_step(o: &GateOutcome, cfg_now: Option<&TaskConfig>, base_prompt: &str) -> GateStep`
  - `pub(crate) fn wake_prompt(base: &str, stdout_tail: &str) -> String`
  - `pub(crate) async fn run_gated<F, Fut>(store: &ScheduledStore, run_id: &str, task: &TaskConfig, dir: Result<PathBuf, String>, timeout: Duration, trigger: F) -> GateStep where F: FnOnce(String) -> Fut, Fut: Future<Output = Result<String, String>>`
  - web：`fn normalize_gate_cmd(raw: Option<String>) -> Result<Option<String>, (StatusCode, String)>`、`fn next_gate_since(old: Option<&TaskConfig>, new_cmd: &Option<String>, now: i64) -> Option<i64>`、`POST /api/scheduled-tasks/gate-test`

- [ ] **Step 1: 写失败测试**

`mod gate_tests` 追加：

```rust
    fn cfg(enabled: bool) -> TaskConfig {
        TaskConfig { id: "t".into(), owner_id: "u".into(), name: "夜巡".into(), trigger_type: "cron".into(),
            trigger_spec: "0 0 * * * *".into(), tz: "Asia/Shanghai".into(), agent_type: "claude".into(),
            work_dir: ".".into(), prompt: "处理新 issue".into(), enabled, retention_n: 20, created_ms: 1,
            side_effects: false, max_runtime_min: None, idle_timeout_min: None,
            gate_cmd: Some("true".into()), gate_since_ms: Some(1) }
    }
    fn out(v: GateVerdict, stdout: &str) -> GateOutcome {
        GateOutcome { verdict: v, exit_code: None, duration_ms: 1, stdout_tail: stdout.into(), stderr_tail: String::new() }
    }

    #[test]
    fn gate_step_maps_every_verdict() {
        let c = cfg(true);
        assert!(matches!(gate_step(&out(GateVerdict::Clean, ""), Some(&c), "p"), GateStep::Skip("gate_clean")));
        assert!(matches!(gate_step(&out(GateVerdict::Error, ""), Some(&c), "p"), GateStep::Fail("gate_error")));
        assert!(matches!(gate_step(&out(GateVerdict::Timeout, ""), Some(&c), "p"), GateStep::Fail("gate_timeout")));
        match gate_step(&out(GateVerdict::Wake, "3 new"), Some(&c), "处理新 issue") {
            GateStep::Wake(p) => assert_eq!(p, "处理新 issue\n\n## 预检输出\n```\n3 new\n```"),
            other => panic!("{other:?}"),
        }
    }

    // V16: task deleted or disabled while the gate ran → no spawn.
    #[test]
    fn wake_rechecks_task_still_exists_and_enabled() {
        assert!(matches!(gate_step(&out(GateVerdict::Wake, "x"), None, "p"), GateStep::Skip("gate_task_gone")));
        assert!(matches!(gate_step(&out(GateVerdict::Wake, "x"), Some(&cfg(false)), "p"), GateStep::Skip("gate_task_gone")));
    }

    #[test]
    fn wake_prompt_skips_empty_output() {
        assert_eq!(wake_prompt("p", "  \n"), "p");
    }

    fn seeded(store: &ScheduledStore) {
        store.upsert_config(&cfg(true)).unwrap();
        store.claim_run(&TaskRun { id: "r".into(), task_id: "t".into(), scheduled_for_ms: 1, state: "claimed".into(),
            session_id: None, verdict: None, failure_kind: None, started_ms: Some(1), ended_ms: None,
            input_snapshot: None, confirm_status: None, replay_of: None }).unwrap();
        store.set_gate_phase("r", true).unwrap();
    }

    #[tokio::test]
    async fn run_gated_exit_1_skips_without_trigger() {
        let d = tempfile::tempdir().unwrap();
        let s = ScheduledStore::open(d.path()).unwrap();
        seeded(&s);
        let mut t = cfg(true); t.gate_cmd = Some("exit 1".into());
        let called = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let c2 = called.clone();
        let step = run_gated(&s, "r", &t, Ok(d.path().to_path_buf()), GATE_TIMEOUT, move |_| async move {
            c2.store(true, std::sync::atomic::Ordering::SeqCst); Ok("sid".to_string()) }).await;
        assert!(matches!(step, GateStep::Skip("gate_clean")));
        assert!(!called.load(std::sync::atomic::Ordering::SeqCst));
        let r = s.runs_for_task("t", 1).unwrap().pop().unwrap();
        assert_eq!((r.state.as_str(), r.failure_kind.as_deref()), ("skipped", Some("gate_clean")));
        assert_eq!(s.active_run_count().unwrap(), 0);
    }

    #[tokio::test]
    async fn run_gated_task_deleted_during_gate_never_triggers() {
        let d = tempfile::tempdir().unwrap();
        let s = ScheduledStore::open(d.path()).unwrap();
        seeded(&s);
        let t = cfg(true);
        s.delete_config("t").unwrap();                    // what the user did while the gate ran
        let called = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let c2 = called.clone();
        let step = run_gated(&s, "r", &t, Ok(d.path().to_path_buf()), GATE_TIMEOUT, move |_| async move {
            c2.store(true, std::sync::atomic::Ordering::SeqCst); Ok("sid".to_string()) }).await;
        assert!(matches!(step, GateStep::Skip("gate_task_gone")));
        assert!(!called.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[tokio::test]
    async fn run_gated_wake_clears_phase_then_triggers_with_output() {
        let d = tempfile::tempdir().unwrap();
        let s = ScheduledStore::open(d.path()).unwrap();
        seeded(&s);
        let mut t = cfg(true); t.gate_cmd = Some("echo 2 open".into());
        let got = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let g2 = got.clone();
        let step = run_gated(&s, "r", &t, Ok(d.path().to_path_buf()), GATE_TIMEOUT, move |p| async move {
            *g2.lock().unwrap() = p; Ok("sid".to_string()) }).await;
        assert!(matches!(step, GateStep::Wake(_)));
        assert!(got.lock().unwrap().contains("## 预检输出\n```\n2 open"));
        // gate_phase is 0 now: a crash from here is an ordinary orphan (Task 3 test)
        s.reconcile_orphans(None).unwrap();
        let r = s.runs_for_task("t", 1).unwrap().pop().unwrap();
        assert_eq!(r.failure_kind.as_deref(), Some("orphaned_restart"));
    }

    #[tokio::test]
    async fn run_gated_rejected_dir_fails() {
        let d = tempfile::tempdir().unwrap();
        let s = ScheduledStore::open(d.path()).unwrap();
        seeded(&s);
        let step = run_gated(&s, "r", &cfg(true), Err("outside home".into()), GATE_TIMEOUT,
            |_| async { Ok("sid".to_string()) }).await;
        assert!(matches!(step, GateStep::Fail("work_dir_rejected")));
        let r = s.runs_for_task("t", 1).unwrap().pop().unwrap();
        assert_eq!(r.state, "failed");
    }

    // V20: replay reuses the snapshot's prompt (which already carries the gate output); no gate.
    #[test]
    fn replay_snapshot_keeps_gate_section() {
        let d = tempfile::tempdir().unwrap();
        let s = ScheduledStore::open(d.path()).unwrap();
        seeded(&s);
        let p = wake_prompt("处理新 issue", "#12 crash");
        s.set_input_snapshot("r", &serde_json::json!({"prompt": p, "work_dir": ".", "agent_type": "claude", "secrets": []}).to_string()).unwrap();
        s.set_run_state("r", "succeeded", None, None, None, Some(2)).unwrap();
        let (_new, snap) = s.claim_replay("r").unwrap();
        let v: serde_json::Value = serde_json::from_str(&snap).unwrap();
        assert!(v["prompt"].as_str().unwrap().contains("## 预检输出\n```\n#12 crash"));
    }
```

另在 `replay_run`（`src/session_manager.rs:1512`）的注释里补一行 `// Replay never runs the gate (D2): the snapshot prompt already contains its output.`——实现不变，这是对称性说明。

`src/push.rs` 的 `mod tests` 追加：

```rust
    #[test]
    fn gate_failure_kinds_have_chinese_text() {
        let p = payload_for("run_failed", "夜巡", "r", Some("gate_error"), Some("sh: gh: not found"));
        assert_eq!(p.body, "sh: gh: not found");
        let d = payload_for("run_failed", "夜巡", "r", Some("gate_timeout"), None);
        assert_eq!(d.body, "预检超时");
        assert_eq!(payload_for("run_failed", "夜巡", "r", Some("gate_error"), None).body, "预检命令失败");
    }
```

`src/web.rs` 的 `mod path_safety_tests` 追加：

```rust
    #[test]
    fn gate_cmd_blank_is_null_and_length_capped() {
        assert_eq!(normalize_gate_cmd(None).unwrap(), None);
        assert_eq!(normalize_gate_cmd(Some("   \n".into())).unwrap(), None);
        assert_eq!(normalize_gate_cmd(Some("  test -s f ".into())).unwrap().as_deref(), Some("test -s f"));
        assert_eq!(normalize_gate_cmd(Some("x".repeat(4001))).unwrap_err().0, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn gate_since_resets_only_when_value_changes() {
        let mk = |g: Option<&str>, since: Option<i64>| crate::scheduled_tasks::TaskConfig {
            id: "t".into(), owner_id: "u".into(), name: "n".into(), trigger_type: "cron".into(),
            trigger_spec: "0 0 * * * *".into(), tz: "Asia/Shanghai".into(), agent_type: "claude".into(),
            work_dir: ".".into(), prompt: "p".into(), enabled: true, retention_n: 20, created_ms: 1,
            side_effects: false, max_runtime_min: None, idle_timeout_min: None,
            gate_cmd: g.map(String::from), gate_since_ms: since };
        assert_eq!(next_gate_since(None, &Some("a".into()), 50), Some(50));        // create with gate
        assert_eq!(next_gate_since(None, &None, 50), None);                         // create without
        let old = mk(Some("a"), Some(10));
        assert_eq!(next_gate_since(Some(&old), &Some("a".into()), 50), Some(10));   // unchanged → keep
        assert_eq!(next_gate_since(Some(&old), &Some("b".into()), 50), Some(50));   // changed → now
        assert_eq!(next_gate_since(Some(&old), &None, 50), Some(50));               // removed → now
        assert_eq!(next_gate_since(Some(&mk(None, None)), &None, 50), None);
    }

    #[test]
    fn gate_test_work_dir_outside_home_is_403() {
        assert_eq!(validate_work_dir_under_home("/etc").unwrap_err().0, StatusCode::FORBIDDEN);
    }
```

- [ ] **Step 2: 运行，确认失败**

Run: `cargo test --lib gate_tests && cargo test --lib path_safety_tests::gate && cargo test --lib push::tests::gate_failure_kinds_have_chinese_text`
Expected: 编译失败。

- [ ] **Step 3: 实现 scheduled_tasks.rs**

`src/session_manager.rs:492`：`fn work_dir_under_home` → `pub(crate) fn work_dir_under_home`。

`src/push.rs` `failure_kind_zh` 追加两臂（位于 `_` 之前）：

```rust
        Some("gate_error") => "预检命令失败",
        Some("gate_timeout") => "预检超时",
```

（`run_failed` 的 body 在 S5 U4 下由 `body` 覆盖；无 body 时取 `trim_start_matches('因')` 后的文案——「预检命令失败」不以「因」开头，原样输出。）

`src/scheduled_tasks.rs` 在 `run_gate` 之后追加：

```rust
#[derive(Debug)]
pub(crate) enum GateStep { Skip(&'static str), Fail(&'static str), Wake(String) }

pub(crate) fn wake_prompt(base: &str, stdout_tail: &str) -> String {
    if stdout_tail.trim().is_empty() { return base.to_string(); }
    format!("{base}\n\n## 预检输出\n```\n{}\n```", stdout_tail.trim_end())
}

/// Pure decision after the gate ran. `cfg_now` is the config re-read AFTER the gate
/// (V16: delete_config drops the run rows too, so a stale Wake must not spawn).
pub(crate) fn gate_step(o: &GateOutcome, cfg_now: Option<&TaskConfig>, base_prompt: &str) -> GateStep {
    match o.verdict {
        GateVerdict::Clean => GateStep::Skip("gate_clean"),
        GateVerdict::Error => GateStep::Fail("gate_error"),
        GateVerdict::Timeout => GateStep::Fail("gate_timeout"),
        GateVerdict::Wake => match cfg_now {
            Some(c) if c.enabled => GateStep::Wake(wake_prompt(base_prompt, &o.stdout_tail)),
            _ => GateStep::Skip("gate_task_gone"),
        },
    }
}

fn first_line_120(s: &str) -> String {
    s.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").chars().take(120).collect()
}

/// The whole gated run, OUTSIDE the scheduler tick. Every branch reaches a terminal
/// state (a panic leaves claimed+gate_phase=1 for restart reconcile / idle watchdog).
pub(crate) async fn run_gated<F, Fut>(
    store: &ScheduledStore, run_id: &str, task: &TaskConfig,
    dir: Result<std::path::PathBuf, String>, timeout: std::time::Duration, trigger: F,
) -> GateStep
where F: FnOnce(String) -> Fut, Fut: std::future::Future<Output = Result<String, String>> {
    let now = || chrono::Utc::now().timestamp_millis();
    let fail_push = |kind: &'static str, body: String| async move {
        if let Some(p) = store.push_handle() {
            let payload = crate::push::payload_for("run_failed", &task.name, run_id, Some(kind),
                (!body.is_empty()).then_some(body.as_str()));
            let _ = tokio::time::timeout(std::time::Duration::from_secs(10), p.send_to_user(&task.owner_id, &payload)).await;
        }
    };
    let dir = match dir {
        Ok(d) => d,
        Err(e) => {
            let _ = store.set_gate_phase(run_id, false);
            let _ = store.set_run_state(run_id, "failed", None, None, Some("work_dir_rejected"), Some(now()));
            fail_push("work_dir_rejected", first_line_120(&e)).await;
            return GateStep::Fail("work_dir_rejected");
        }
    };
    let cmd = task.gate_cmd.clone().unwrap_or_default();
    let o = run_gate(&cmd, &dir, timeout).await;
    let cfg_now = if o.verdict == GateVerdict::Wake { store.get_config(&task.id).ok().flatten() } else { None };
    let step = gate_step(&o, cfg_now.as_ref(), &task.prompt);
    let _ = store.set_gate_phase(run_id, false);
    match &step {
        GateStep::Skip(kind) => { let _ = store.set_run_state(run_id, "skipped", None, None, Some(*kind), Some(now())); }
        GateStep::Fail(kind) => {
            let _ = store.set_run_state(run_id, "failed", None, None, Some(*kind), Some(now()));
            let body = if o.verdict == GateVerdict::Timeout { String::new() } else { first_line_120(&o.stderr_tail) };
            fail_push(*kind, body).await;
        }
        GateStep::Wake(prompt) => {
            if let Err(e) = trigger(prompt.clone()).await {
                let _ = store.set_run_state(run_id, "failed", None, None, Some("spawn_failed"), Some(now()));
                tracing::warn!("gated trigger {} failed: {}", task.id, e);
            }
        }
    }
    step
}

fn spawn_gated_run(
    mgr: std::sync::Arc<crate::session_manager::SessionManager>,
    store: std::sync::Arc<ScheduledStore>, run_id: String, task: TaskConfig, name: String,
) {
    tokio::spawn(async move {
        let dir = crate::session_manager::work_dir_under_home(&task.work_dir);
        let (rid, t2) = (run_id.clone(), task.clone());
        run_gated(&store, &run_id, &task, dir, GATE_TIMEOUT, move |prompt| async move {
            mgr.trigger_run(&rid, name, &t2.work_dir, &t2.owner_id, &t2.id, prompt, &t2.agent_type).await
        }).await;
    });
}
```

tick（`:1188-1197` 的 `Ok(true) =>` 臂）替换为：

```rust
                                        Ok(true) => {
                                            let nm = format!("{} · {}", task.name,
                                                fire.with_timezone(&Shanghai).format("%H:%M"));
                                            if task.gate_cmd.is_some() {
                                                // Never .await the gate in the tick (spec §2.7): sync DB
                                                // write, then hand the whole run to a spawned task.
                                                let _ = s.set_gate_phase(&run.id, true);
                                                spawn_gated_run(m.clone(), s.clone(), run.id.clone(), task.clone(), nm);
                                            } else if let Err(err) = m.trigger_run(&run.id, nm, &task.work_dir, &task.owner_id, &task.id, task.prompt.clone(), &task.agent_type).await {
                                                let _ = s.set_run_state(&run.id, "failed", None, None, Some("spawn_failed"), Some(now.timestamp_millis()));
                                                tracing::warn!("trigger {} failed: {}", task.id, err);
                                            }
                                        }
```

- [ ] **Step 4: 实现 web.rs**

`ScheduledTaskReq` 末尾追加 `#[serde(default)] gate_cmd: Option<String>,`。新增：

```rust
const GATE_CMD_MAX_CHARS: usize = 4000;

fn normalize_gate_cmd(raw: Option<String>) -> Result<Option<String>, (StatusCode, String)> {
    let Some(s) = raw else { return Ok(None) };
    let t = s.trim();
    if t.is_empty() { return Ok(None); }
    if t.chars().count() > GATE_CMD_MAX_CHARS {
        return Err((StatusCode::BAD_REQUEST, "gate_cmd too long".into()));
    }
    Ok(Some(t.to_string()))
}

/// gate_since_ms moves only when gate_cmd changes (incl. NULL↔non-NULL).
fn next_gate_since(old: Option<&crate::scheduled_tasks::TaskConfig>, new_cmd: &Option<String>, now: i64) -> Option<i64> {
    match old {
        None => new_cmd.as_ref().map(|_| now),
        Some(o) if &o.gate_cmd == new_cmd => o.gate_since_ms,
        Some(_) => Some(now),
    }
}
```

`create_scheduled` 在 `validate_work_dir_under_home` 之后：`let gate_cmd = normalize_gate_cmd(req.gate_cmd)?; let now = chrono::Utc::now().timestamp_millis();`，字面量里 `created_ms: now,`、`gate_since_ms: next_gate_since(None, &gate_cmd, now), gate_cmd,`（注意先算 `gate_since_ms` 再 move `gate_cmd`：写成 `let gate_since_ms = next_gate_since(None, &gate_cmd, now);`）。`update_scheduled` 同理：`let gate_since_ms = next_gate_since(Some(&existing), &gate_cmd, now);`，此行必须放在 `existing.id` 被 move 之前。

gate-test 端点：

```rust
#[derive(serde::Deserialize)]
struct GateTestReq { work_dir: String, gate_cmd: String }

/// POST /api/scheduled-tasks/gate-test — dry-run a pre-check. HTTP handler, not the
/// tick, so blocking up to 60s is fine. Saves nothing, writes no run row.
async fn gate_test(
    _user: axum::Extension<CurrentUser>,
    Json(req): Json<GateTestReq>,
) -> Result<Json<crate::scheduled_tasks::GateOutcome>, (StatusCode, String)> {
    validate_work_dir_under_home(&req.work_dir)?;
    let cmd = normalize_gate_cmd(Some(req.gate_cmd))?.ok_or((StatusCode::BAD_REQUEST, "empty gate_cmd".to_string()))?;
    let dir = std::path::Path::new(&req.work_dir).canonicalize()
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok(Json(crate::scheduled_tasks::run_gate(&cmd, &dir, crate::scheduled_tasks::GATE_TIMEOUT).await))
}
```

路由：在 `.route("/api/scheduled-tasks/confirmations", …)` 之后加 `.route("/api/scheduled-tasks/gate-test", post(gate_test))`（静态段必须在 `{id}` 路由之前注册以免歧义；axum 0.8 静态段优先，放这里也便于阅读）。

- [ ] **Step 5: 运行测试通过**

Run: `cargo test`
Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add src/scheduled_tasks.rs src/session_manager.rs src/push.rs src/web.rs
git commit -m "feat(T1): gated runs off the tick, Wake re-check, gate pushes, gate-test endpoint

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: 前端预检表单、测试按钮、run 原因、任务徽标

**Files:**
- Modify: `frontend/src/lib/api/scheduler.ts:9-26,47-57`（类型）+ `testGate`
- Modify: `frontend/src/components/ScheduledTasksPanel.tsx:56-63`（`runReason`）、`:87-104`（`handleToggle`）、`:302-330`（`TaskRow` 徽标）、`:386-560`（`TaskForm`）
- Modify: `frontend/src/components/__tests__/ScheduledTasksPanel.toggle.test.tsx`（期望体追加 `gate_cmd`）
- Test: `frontend/src/components/__tests__/ScheduledTasksPanel.test.tsx`、Create `frontend/src/components/__tests__/ScheduledTasksPanel.gate.test.tsx`

**Interfaces:**
- Consumes: Task 5 `POST /api/scheduled-tasks/gate-test`、`gate_cmd`/`gate_since_ms` 字段。
- Produces: `ScheduledTask.gate_cmd: string | null`、`gate_since_ms: number | null`；`ScheduledTaskReq.gate_cmd?: string | null`；`export interface GateResult { verdict: 'wake' | 'clean' | 'error' | 'timeout'; exit_code: number | null; duration_ms: number; stdout_tail: string; stderr_tail: string }`；`testGate(work_dir: string, gate_cmd: string): Promise<GateResult>`；`export function gateSummary(r: GateResult): string`（纯函数，导出供单测）。

- [ ] **Step 1: 写失败测试**

`ScheduledTasksPanel.test.tsx` 的 `describe('runReason')` 追加：

```tsx
  it('labels gate outcomes (S6 T1)', () => {
    expect(runReason({ ...base, state: 'skipped', failure_kind: 'gate_clean' } as TaskRun).label).toBe('预检未满足，未唤醒')
    expect(runReason({ ...base, state: 'skipped', failure_kind: 'gate_clean' } as TaskRun).color).toBe('text-[var(--fg-subtle)]')
    expect(runReason({ ...base, state: 'skipped', failure_kind: 'gate_task_gone' } as TaskRun).label).toBe('任务已删除或停用')
    expect(runReason({ ...base, state: 'failed', failure_kind: 'gate_error' } as TaskRun).label).toBe('预检失败')
    expect(runReason({ ...base, state: 'failed', failure_kind: 'gate_timeout' } as TaskRun).label).toBe('预检超时')
    expect(runReason({ ...base, state: 'failed', failure_kind: 'gate_interrupted' } as TaskRun).label).toBe('预检中断（重启）')
  })
```

`ScheduledTasksPanel.toggle.test.tsx`：`task` 追加 `gate_cmd: "test -s f", gate_since_ms: 5`，期望体追加 `gate_cmd: 'test -s f'`。

新建 `ScheduledTasksPanel.gate.test.tsx`：

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { TaskForm, gateSummary } from '../ScheduledTasksPanel'
import * as api from '../../lib/api'

describe('gate UI (S6 T1)', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('gateSummary copy for each verdict', () => {
    const r = { exit_code: 0, duration_ms: 400, stdout_tail: 'a\nb\n', stderr_tail: '' }
    expect(gateSummary({ ...r, verdict: 'wake' })).toBe('将唤醒（0.4s）· 输出 2 行')
    expect(gateSummary({ ...r, verdict: 'clean', exit_code: 1 })).toBe('将跳过（exit 1）')
    expect(gateSummary({ ...r, verdict: 'error', exit_code: 127, stderr_tail: 'sh: gh: not found\n' })).toBe('预检故障：exit 127 · sh: gh: not found')
    expect(gateSummary({ ...r, verdict: 'timeout', exit_code: null })).toBe('预检故障：60 秒超时')
  })

  it('submits trimmed gate_cmd; blank → null', async () => {
    const create = vi.spyOn(api, 'createScheduledTask').mockResolvedValue({} as api.ScheduledTask)
    render(<TaskForm task={null} onCancel={() => {}} onSaved={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('每日构建'), { target: { value: '夜巡' } })
    fireEvent.change(screen.getByPlaceholderText('/home/ubuntu/project'), { target: { value: '/home/ubuntu/w' } })
    fireEvent.change(screen.getByPlaceholderText('要执行的任务...'), { target: { value: 'p' } })
    fireEvent.change(screen.getByLabelText('预检命令（可选）'), { target: { value: "  gh issue list | jq -e 'length>0'  " } })
    fireEvent.click(screen.getByRole('button', { name: /保存/ }))
    await waitFor(() => expect(create).toHaveBeenCalled())
    expect(create.mock.calls[0][0].gate_cmd).toBe("gh issue list | jq -e 'length>0'")
  })

  it('测试预检 is disabled while the request is in flight and shows the result', async () => {
    let resolve!: (r: api.GateResult) => void
    vi.spyOn(api, 'testGate').mockImplementation(() => new Promise(r => { resolve = r }))
    render(<TaskForm task={null} onCancel={() => {}} onSaved={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('/home/ubuntu/project'), { target: { value: '/home/ubuntu/w' } })
    fireEvent.change(screen.getByLabelText('预检命令（可选）'), { target: { value: 'exit 1' } })
    const btn = screen.getByRole('button', { name: '测试预检' })
    fireEvent.click(btn)
    expect(btn).toBeDisabled()
    resolve({ verdict: 'clean', exit_code: 1, duration_ms: 10, stdout_tail: '', stderr_tail: '' })
    expect(await screen.findByText('将跳过（exit 1）')).toBeInTheDocument()
    expect(btn).not.toBeDisabled()
  })
})
```

（保存按钮的实际文案以 `TaskForm` 现有按钮为准；若不是「保存」，改正则。）

- [ ] **Step 2: 运行，确认失败**

Run: `cd frontend && npx vitest run src/components/__tests__/ScheduledTasksPanel.test.tsx src/components/__tests__/ScheduledTasksPanel.gate.test.tsx src/components/__tests__/ScheduledTasksPanel.toggle.test.tsx`
Expected: FAIL。

- [ ] **Step 3: 实现**

`scheduler.ts`：`ScheduledTask` 追加 `gate_cmd: string | null; gate_since_ms: number | null`；`ScheduledTaskReq` 追加 `gate_cmd?: string | null`；追加

```ts
export interface GateResult { verdict: 'wake' | 'clean' | 'error' | 'timeout'; exit_code: number | null; duration_ms: number; stdout_tail: string; stderr_tail: string }

export async function testGate(work_dir: string, gate_cmd: string): Promise<GateResult> {
  const res = await api('/api/scheduled-tasks/gate-test', { method: 'POST', body: JSON.stringify({ work_dir, gate_cmd }) })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}
```

`ScheduledTasksPanel.tsx`：

`runReason` 开头插入：

```tsx
  if (r.state === 'skipped' && r.failure_kind === 'gate_clean') return { label: '预检未满足，未唤醒', color: 'text-[var(--fg-subtle)]' }
  if (r.state === 'skipped' && r.failure_kind === 'gate_task_gone') return { label: '任务已删除或停用', color: 'text-[var(--fg-subtle)]' }
  if (r.state === 'failed') {
    if (r.failure_kind === 'gate_error') return { label: '预检失败', color: 'text-[var(--danger)]' }
    if (r.failure_kind === 'gate_timeout') return { label: '预检超时', color: 'text-[var(--danger)]' }
    if (r.failure_kind === 'gate_interrupted') return { label: '预检中断（重启）', color: 'text-[var(--danger)]' }
  }
```

新增导出纯函数（放在 `runReason` 之后，同样加 `// eslint-disable-next-line react-refresh/only-export-components`）：

```tsx
export function gateSummary(r: GateResult): string {
  if (r.verdict === 'wake') {
    const n = r.stdout_tail.split('\n').filter(l => l.trim()).length
    return `将唤醒（${(r.duration_ms / 1000).toFixed(1)}s）· 输出 ${n} 行`
  }
  if (r.verdict === 'clean') return '将跳过（exit 1）'
  if (r.verdict === 'timeout') return '预检故障：60 秒超时'
  const first = r.stderr_tail.split('\n').map(l => l.trim()).find(Boolean) ?? ''
  const code = r.exit_code == null ? '无法执行' : `exit ${r.exit_code}`
  return `预检故障：${code}${first ? ` · ${first}` : ''}`
}
```

`handleToggle` 请求体追加 `gate_cmd: t.gate_cmd,`（注释：`// Same B1 trap: omitting gate_cmd would clear the pre-check on every toggle.`）。

`TaskRow` 名称后（`{!task.enabled && …}` 之前）加：

```tsx
          {task.gate_cmd && <span className="text-ui-2xs text-[var(--fg-muted)] font-normal border border-[var(--border)] rounded px-1">预检</span>}
```

`TaskForm`：state `const [gateCmd, setGateCmd] = useState(task?.gate_cmd ?? '')`、`const [gateTesting, setGateTesting] = useState(false)`、`const [gateResult, setGateResult] = useState<GateResult | null>(null)`、`const [gateErr, setGateErr] = useState<string | null>(null)`；`body` 追加 `gate_cmd: gateCmd.trim() || null`；在 Prompt 块（`:541-544`）之后插入：

```tsx
      <div>
        <label htmlFor="gate-cmd" className={labelCls}>预检命令（可选）</label>
        <textarea id="gate-cmd" value={gateCmd} onChange={e => { setGateCmd(e.target.value); setGateResult(null) }} rows={2}
          className={`${inputCls} font-mono resize-y`} placeholder="gh issue list --json number | jq -e 'length>0'" />
        <p className="text-ui-2xs text-[var(--fg-subtle)] mt-1">条件成立（退出 0）→ 唤醒 agent，输出会附在 prompt 后；退出 1 → 跳过本次；其他退出码、找不到命令或 60 秒超时 → 预检故障并推送</p>
        <div className="flex items-center gap-2 mt-1.5">
          <button type="button" disabled={gateTesting || !gateCmd.trim() || !workDir.trim()}
            onClick={async () => {
              setGateTesting(true); setGateErr(null)
              try { setGateResult(await testGate(workDir.trim(), gateCmd.trim())) }
              catch (e) { setGateErr((e as Error).message) }
              finally { setGateTesting(false) }
            }}
            className="ctl min-h-[44px] px-3 text-ui-xs text-[var(--accent)] border border-[var(--border)] rounded disabled:opacity-50">测试预检</button>
          {gateResult && <span className="flex items-center gap-1.5 text-ui-xs text-[var(--fg-muted)]">
            <StatusDot tone={gateResult.verdict === 'wake' ? 'running' : gateResult.verdict === 'clean' ? 'muted' : 'danger'} label={gateResult.verdict} />
            {gateSummary(gateResult)}</span>}
          {gateErr && <span className="text-ui-xs text-[var(--danger)]">{gateErr}</span>}
        </div>
        {gateResult && gateResult.stdout_tail.trim() && (
          <details className="mt-1"><summary className="text-ui-2xs text-[var(--fg-subtle)] cursor-pointer">输出</summary>
            <pre className="max-h-[20lh] overflow-y-auto text-ui-2xs font-mono text-[var(--fg-muted)] whitespace-pre-wrap">{gateResult.stdout_tail.split('\n').slice(-20).join('\n')}</pre>
          </details>)}
      </div>
```

import 增 `testGate`、`type GateResult`，`./ui` 增 `StatusDot`。

- [ ] **Step 4: 运行测试通过**

Run: `cd frontend && npx vitest run src/components/__tests__/ScheduledTasksPanel.test.tsx src/components/__tests__/ScheduledTasksPanel.gate.test.tsx src/components/__tests__/ScheduledTasksPanel.toggle.test.tsx`
Expected: PASS。

- [ ] **Step 5: 全量 + Commit**

Run: `cd frontend && npm test && npm run lint && npm run build`

```bash
git add frontend/src/lib/api/scheduler.ts frontend/src/components/ScheduledTasksPanel.tsx frontend/src/components/__tests__/ScheduledTasksPanel*.tsx
git commit -m "feat(T1): pre-check field, 测试预检, gate run reasons, 预检 badge

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: F8 立即运行后打开会话

**Files:**
- Modify: `frontend/src/components/shell/useShellState.ts`（`ShellState` 接口 `:25-48`、返回对象 `:247-254`）
- Modify: `frontend/src/components/ScheduledTasksPanel.tsx:18-21`（Props）、`:106-116`（`handleRun`）、run 历史行（`RunHistory`）
- Modify: `frontend/src/components/shell/AppShell.tsx:333`
- Modify: `frontend/src/components/shell/__tests__/CommandPalette.test.tsx` 的 `shell()` 工厂（补 `openSession: vi.fn()`，否则 TS 报缺字段）
- Test: Create `frontend/src/components/__tests__/ScheduledTasksPanel.run.test.tsx`、`frontend/src/components/shell/__tests__/openSession.test.tsx`

**Interfaces:**
- Consumes: 既有 `runScheduledTaskNow` 返回的 `session_id`（`web.rs:3629`）。
- Produces: `ShellState.openSession(id: string): Promise<void>`；`ScheduledTasksPanel` prop `onOpenSession?: (id: string) => void`。

- [ ] **Step 1: 写失败测试**

`ScheduledTasksPanel.run.test.tsx`：

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ScheduledTasksPanel from '../ScheduledTasksPanel'
import { Toaster } from '../ui'
import * as api from '../../lib/api'

const task = { id: 't1', owner_id: 'u', name: '夜巡', trigger_type: 'cron', trigger_spec: '0 0 9 * * *', tz: 'Asia/Shanghai',
  agent_type: 'claude', work_dir: '/w', prompt: 'p', enabled: true, retention_n: 20, created_ms: 1, side_effects: false,
  max_runtime_min: null, idle_timeout_min: null, gate_cmd: null, gate_since_ms: null } as api.ScheduledTask

describe('F8 run now → open session', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(api, 'listScheduledTasks').mockResolvedValue([task])
    vi.spyOn(api, 'listConfirmations').mockResolvedValue({ count: 0, runs: [] })
  })
  it('success toast carries 打开会话 which calls onOpenSession(session_id)', async () => {
    vi.spyOn(api, 'runScheduledTaskNow').mockResolvedValue({ session_id: 'S9', run_id: 'r' })
    const onOpen = vi.fn()
    render(<><ScheduledTasksPanel open onClose={() => {}} onOpenSession={onOpen} /><Toaster /></>)
    fireEvent.click(await screen.findByTitle('立即运行'))
    fireEvent.click(await screen.findByRole('button', { name: '打开会话' }))
    expect(onOpen).toHaveBeenCalledWith('S9')
  })
  it('no session_id → no action button', async () => {
    vi.spyOn(api, 'runScheduledTaskNow').mockResolvedValue({ run_id: 'r' })
    render(<><ScheduledTasksPanel open onClose={() => {}} onOpenSession={vi.fn()} /><Toaster /></>)
    fireEvent.click(await screen.findByTitle('立即运行'))
    expect(await screen.findByText('「夜巡」已启动')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '打开会话' })).toBeNull()
  })
  it('skipped keeps the note path', async () => {
    vi.spyOn(api, 'runScheduledTaskNow').mockResolvedValue({ skipped: true, reason: 'overlap' })
    render(<ScheduledTasksPanel open onClose={() => {}} onOpenSession={vi.fn()} />)
    fireEvent.click(await screen.findByTitle('立即运行'))
    expect(await screen.findByText('「夜巡」已跳过：overlap')).toBeInTheDocument()
  })
})
```

`openSession.test.tsx`：

```tsx
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useShellState } from '../useShellState'
import * as api from '../../../lib/api'
import { mkSession } from '../../../test/appHarness'

describe('openSession', () => {
  it('reloads the list BEFORE selecting (so the pane exists)', async () => {
    const order: string[] = []
    vi.spyOn(api, 'listSessionsWithHost').mockImplementation(async () => { order.push('reload'); return { sessions: [mkSession('S9')], host_tmux: [] } })
    vi.spyOn(api, 'listConfirmations').mockResolvedValue({ count: 0, runs: [] })
    vi.spyOn(api, 'getSchedulerHealth').mockResolvedValue({ heartbeat_ms: 0, healthy: true })
    const { result } = renderHook(() => useShellState(true, () => {}, { narrow: true }))
    order.length = 0
    await act(async () => { await result.current.openSession('S9'); order.push('select') })
    expect(order).toEqual(['reload', 'select'])
    expect(result.current.activeId).toBe('S9')
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `cd frontend && npx vitest run src/components/__tests__/ScheduledTasksPanel.run.test.tsx src/components/shell/__tests__/openSession.test.tsx`
Expected: FAIL。

- [ ] **Step 3: 实现**

`useShellState.ts`：接口加 `/** F8: reload first so a just-created session exists, then focus it. */ openSession(id: string): Promise<void>`；在 `openHistory` 之后：

```ts
  const openSession = useCallback(async (id: string) => { await reload(); select(id) }, [reload, select])
```

返回对象追加 `openSession`。

`ScheduledTasksPanel.tsx`：Props 加 `onOpenSession?: (id: string) => void`，组件解构；import `toast`；`handleRun` 改为

```tsx
  const handleRun = async (t: ScheduledTask) => {
    setNote(null)
    try {
      const r = await runScheduledTaskNow(t.id)
      if (r.skipped) { setNote(`「${t.name}」已跳过：${r.reason || '重叠'}`); return }
      const sid = r.session_id
      toast.push({ message: `「${t.name}」已启动`, durationMs: 6000,
        ...(sid && onOpenSession ? { action: { label: '打开会话', onClick: () => onOpenSession(sid) } } : {}) })
    } catch (e) {
      setNote(`运行失败：${(e as Error).message}`)
    }
  }
```

`RunHistory` 接收 `onOpenSession` 并在每行「重放」按钮旁加：

```tsx
              {r.session_id && onOpenSession && (
                <button onClick={() => onOpenSession(r.session_id!)} className="px-2 py-1 text-ui-xs font-medium text-[var(--fg-muted)] hover:bg-[var(--surface-3)] rounded">打开会话</button>
              )}
```

`AppShell.tsx:333`：

```tsx
      {panel === 'scheduled' && <ErrorBoundary><Suspense fallback={null}><ScheduledTasksPanel open onClose={() => setPanel(null)}
        onOpenSession={id => { setPanel(null); void shell.openSession(id) }} /></Suspense></ErrorBoundary>}
```

- [ ] **Step 4: 运行测试通过 + 全量**

Run: `cd frontend && npx vitest run src/components/__tests__/ScheduledTasksPanel.run.test.tsx src/components/shell/__tests__/openSession.test.tsx && npm test && npm run lint && npm run build`
Expected: PASS。

- [ ] **Step 5: Commit + 上线（S6-b）**

```bash
git add frontend/src/components frontend/src/lib
git commit -m "feat(F8): run-now toast opens the session after a reload

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push
./deploy.sh --build
```

退出标准：§2.8 全绿；在一个生产任务上配 `gh issue list --json number | jq -e 'length>0'`，run 历史出现一次 `预检未满足，未唤醒` 或一次唤醒。

---

# S6-c：T3 Crew 话题模式 turn 语义 + §3.9 断连补发

> 本期与 S5 G2 的「并行话题」chip **同日上线**，当天记为门槛 T 起点（spec §0.1、§9.1）。Task 8 之前先做 spec §3.2 列为「实施时第一个验证步骤」的 `/stop` 实测：
>
> ```bash
> # 用 crew_memory.rs 同样的方式现读 secret（不落盘），建一次性 crew 模式 slot，发一条长任务，
> # 2s 后 POST /api/chat/slots/<k>/stop，观察 60s 内 slots 帧里本 slot 的 running/queue_depth/subagents_running
> # 是否回落为 false/0。结论追加到 docs/superpowers/audits/2026-09-29-kiro-crew-gap-research.md §7。用完 DELETE slot。
> ```
>
> 若 `/stop` 不能停止话题：Task 13 的 `TriageRow` 与 `TurnStatusBar` 对 `crew_mode==='crew'` 隐藏中断按钮（该分支已写在 Task 13 Step 3，用常量 `CREW_TOPICS_STOPPABLE` 控制）。

### Task 8: `normalize_frame` 话题分支（slots 忙闲、回答成组、mid 去重、游标事件）

**Files:**
- Modify: `src/acp/crew_process.rs:21-33`（`NormState`）、`:39-56`（`normalize_frame` 入口）、`chat_message` 分支（S5 G1 加的 `crew_message_events` 调用处）
- Test: `src/acp/crew_process.rs` 的 `mod tests`

**Interfaces:**
- Consumes: S5 G1 `fn crew_message_events(data: &Value) -> Vec<AcpEvent>`（普通模式下的 `chat_message` 分支，保持不变）。
- Produces:
  - `NormState::for_topics(cursor: Option<String>) -> NormState`；字段 `topics: bool`、`seen_mids`（有界 256）、`last_busy: Option<bool>`、`last_needs: bool`
  - 话题模式下的新事件（`AcpEvent::System.subtype`）：`crew_busy`（`count: Some(0|1)`）、`crew_cursor`（`session_id: Some(mid)`）、`crew_needs_input`（needs_input 上升沿）；回答产出 `[ContentBlock{block_type:"text", summary:Some(kind)}, Result{text, session_id: my_slot}]`
  - `pub fn topics_slot_state(data: &serde_json::Value, my_slot: &str) -> Option<(bool, bool)>`（`(busy, needs_input)`）

- [ ] **Step 1: 写失败测试**

`mod tests` 末尾追加（帧取自 `/tmp/zmx-crew-probe/result.json` 的 `crew_frames`，已脱敏）：

```rust
    fn slots(slot: &str, running: bool, q: u32, sub: bool, needs: bool, waiting: bool) -> serde_json::Value {
        json!({"type":"slots","data":[
            {"key":"weixin_x","running":true,"needs_input":true},
            {"key":slot,"running":running,"orchestrating":false,"queue_depth":q,"subagents_running":sub,
             "needs_input":needs,"pending_approval":false,"waiting_for_input":waiting,"mode":"crew"}]})
    }
    fn cmsg(slot: &str, kind: &str, content: &str, mid: &str) -> serde_json::Value {
        json!({"type":"chat_message","data":{"slot":slot,"role":"assistant","content":content,
            "cls":"msg msg-a crew-reply","meta":{"crew_reply":true,"mid":mid},"kind":kind}})
    }
    fn subtypes(ev: &[AcpEvent]) -> Vec<String> {
        ev.iter().map(|e| match e {
            AcpEvent::System { subtype, .. } => format!("sys:{subtype}"),
            AcpEvent::ContentBlock { summary, .. } => format!("block:{}", summary.as_deref().unwrap_or("")),
            AcpEvent::Result { .. } => "result".into(),
            other => format!("{other:?}"),
        }).collect()
    }

    #[test]
    fn topics_real_sequence_ack_ask3_meta() {
        let s = "zmxprobeea36db";
        let mut st = NormState::for_topics(None);
        let frames = vec![
            json!({"type":"chat_message","data":{"slot":s,"role":"assistant","content":"On it.","meta":{"mid":"m-ack"},"kind":"crew_ack"}}),
            slots(s, false, 0, false, false, true),
            cmsg(s, "crew_ask", "Couldn't start that one — say the word and I'll retry.", "m-1"),
            cmsg(s, "crew_ask", "Couldn't start that one — say the word and I'll retry.", "m-2"),
            cmsg(s, "crew_ask", "Couldn't start that one — say the word and I'll retry.", "m-3"),
            cmsg(s, "crew_meta", "I could not work out how to route this request", "m-4"),
        ];
        let ev = run(&frames, s, &mut st);
        let t = subtypes(&ev);
        assert_eq!(t.iter().filter(|x| *x == "sys:crew_ack").count(), 1);
        assert_eq!(t.iter().filter(|x| *x == "block:crew_ask").count(), 3);
        assert_eq!(t.iter().filter(|x| *x == "block:crew_meta").count(), 1);
        assert_eq!(t.iter().filter(|x| *x == "result").count(), 4, "each answer is its own complete group");
        assert_eq!(t.iter().filter(|x| *x == "sys:crew_cursor").count(), 4);
        // waiting_for_input=true after every reply must NOT be read as needs_input (spec §3.2)
        assert!(!t.contains(&"sys:crew_needs_input".to_string()));
        // first slots frame establishes busy=false once
        assert_eq!(t.iter().filter(|x| *x == "sys:crew_busy").count(), 1);
    }

    #[test]
    fn topics_busy_emits_only_on_change_and_reads_all_four_signals() {
        let s = "k";
        let mut st = NormState::for_topics(None);
        let busy_of = |ev: &[AcpEvent]| ev.iter().find_map(|e| match e {
            AcpEvent::System { subtype, count, .. } if subtype == "crew_busy" => *count, _ => None });
        assert_eq!(busy_of(&normalize_frame(&slots(s, true, 0, false, false, false), s, &mut st)), Some(1));
        assert_eq!(busy_of(&normalize_frame(&slots(s, false, 2, false, false, false), s, &mut st)), None, "still busy (queue)");
        assert_eq!(busy_of(&normalize_frame(&slots(s, false, 0, true, false, false), s, &mut st)), None, "still busy (subagents)");
        assert_eq!(busy_of(&normalize_frame(&slots(s, false, 0, false, false, true), s, &mut st)), Some(0));
    }

    #[test]
    fn topics_needs_input_rising_edge_only() {
        let s = "k";
        let mut st = NormState::for_topics(None);
        let n = |st: &mut NormState, needs| subtypes(&normalize_frame(&slots(s, false, 0, false, needs, true), s, st))
            .iter().filter(|x| *x == "sys:crew_needs_input").count();
        assert_eq!(n(&mut st, true), 1);
        assert_eq!(n(&mut st, true), 0);
        assert_eq!(n(&mut st, false), 0);
        assert_eq!(n(&mut st, true), 1);
    }

    #[test]
    fn topics_slots_without_my_slot_or_with_missing_fields_is_silent_after_first() {
        let s = "k";
        let mut st = NormState::for_topics(None);
        assert!(normalize_frame(&json!({"type":"slots","data":[{"key":"other"}]}), s, &mut st).is_empty());
        assert!(normalize_frame(&json!({"type":"slots","data":7}), s, &mut st).is_empty());
        // present but every field missing → treated as false, emits the initial busy=0 once
        let ev = normalize_frame(&json!({"type":"slots","data":[{"key":"k"}]}), s, &mut st);
        assert_eq!(subtypes(&ev), vec!["sys:crew_busy"]);
    }

    #[test]
    fn non_topics_slots_frame_still_dropped() {
        let mut st = NormState::new();
        assert!(normalize_frame(&slots("k", true, 1, true, true, false), "k", &mut st).is_empty());
    }

    #[test]
    fn topics_same_mid_twice_renders_once() {
        let s = "k";
        let mut st = NormState::for_topics(None);
        let a = run(&[cmsg(s, "crew_result", "done", "m-9"), cmsg(s, "crew_result", "done", "m-9")], s, &mut st);
        assert_eq!(subtypes(&a).iter().filter(|x| *x == "result").count(), 1);
    }

    #[test]
    fn topics_answer_without_mid_is_not_deduped_and_emits_no_cursor() {
        let s = "k";
        let mut st = NormState::for_topics(None);
        let f = json!({"type":"chat_message","data":{"slot":s,"role":"assistant","content":"x","kind":"crew_result"}});
        let ev = run(&[f.clone(), f], s, &mut st);
        let t = subtypes(&ev);
        assert_eq!(t.iter().filter(|x| *x == "result").count(), 2);
        assert!(!t.contains(&"sys:crew_cursor".to_string()));
    }

    #[test]
    fn topics_answer_not_accumulated_into_turn_text() {
        let s = "k";
        let mut st = NormState::for_topics(None);
        let _ = run(&[cmsg(s, "crew_result", "ANSWER", "m-1")], s, &mut st);
        let r = run(&[chunk(s, "chat", 1), done(s)], s, &mut st);
        match r.last().unwrap() { AcpEvent::Result { text, .. } => assert_eq!(text, "chat"), o => panic!("{o:?}") }
    }

    #[test]
    fn topics_empty_or_non_string_content_dropped() {
        let s = "k";
        let mut st = NormState::for_topics(None);
        let bad = json!({"type":"chat_message","data":{"slot":s,"role":"assistant","content":42,"kind":"crew_result","meta":{"mid":"m"}}});
        assert!(run(&[bad, cmsg(s, "crew_result", "", "m2")], s, &mut st).is_empty());
    }

    #[test]
    fn seen_mids_is_bounded() {
        let mut st = NormState::for_topics(None);
        for i in 0..300 { let _ = normalize_frame(&cmsg("k", "crew_result", "x", &format!("m{i}")), "k", &mut st); }
        assert!(st.seen_len() <= 256);
    }
```

- [ ] **Step 2: 运行，确认失败**

Run: `cargo test --lib acp::crew_process::tests::topics`
Expected: 编译失败（`for_topics` 等未定义）。

- [ ] **Step 3: 实现**

`NormState` 增加字段（`#[derive(Default)]` 保持）：

```rust
    /// crew_mode=="crew" (S6 G3). Only then are `slots` frames and answer groups handled.
    pub topics: bool,
    /// Durable-forward dedupe (at-least-once): bounded FIFO of processed meta.mid.
    seen_order: std::collections::VecDeque<String>,
    seen_set: std::collections::HashSet<String>,
    /// Last emitted Gateway busy state; None = never reported.
    last_busy: Option<bool>,
    last_needs: bool,
    /// Persisted cursor (sessions.crew_last_mid) handed in at spawn; read by catch-up (Task 11).
    pub cursor: Option<String>,
```

实现：

```rust
const SEEN_MIDS_CAP: usize = 256;

impl NormState {
    pub fn for_topics(cursor: Option<String>) -> Self { Self { topics: true, cursor, ..Self::default() } }
    /// True if `mid` was new (and is now remembered).
    fn remember_mid(&mut self, mid: &str) -> bool {
        if self.seen_set.contains(mid) { return false; }
        self.seen_set.insert(mid.to_string());
        self.seen_order.push_back(mid.to_string());
        while self.seen_order.len() > SEEN_MIDS_CAP {
            if let Some(old) = self.seen_order.pop_front() { self.seen_set.remove(&old); }
        }
        true
    }
    #[cfg(test)] pub fn seen_len(&self) -> usize { self.seen_order.len() }
}

/// (busy, needs_input) of my slot from a `slots` payload; lenient (missing = false).
/// `waiting_for_input` is ignored on purpose: it is true after every reply (R2 capture).
pub fn topics_slot_state(data: &serde_json::Value, my_slot: &str) -> Option<(bool, bool)> {
    let me = data.as_array()?.iter().find(|x| x.get("key").and_then(|v| v.as_str()) == Some(my_slot))?;
    let b = |k: &str| me.get(k).and_then(|v| v.as_bool()).unwrap_or(false);
    let q = me.get("queue_depth").and_then(|v| v.as_u64()).unwrap_or(0);
    Some((b("running") || b("orchestrating") || b("subagents_running") || q > 0,
          b("needs_input") || b("pending_approval")))
}

fn sys(subtype: &'static str, session_id: Option<String>, count: Option<u32>) -> AcpEvent {
    AcpEvent::System { subtype: Cow::Borrowed(subtype), session_id, count }
}

fn topics_slots_events(data: Option<&serde_json::Value>, my_slot: &str, st: &mut NormState) -> Vec<AcpEvent> {
    let Some((busy, needs)) = data.and_then(|d| topics_slot_state(d, my_slot)) else { return vec![] };
    let mut out = vec![];
    if st.last_busy != Some(busy) {
        st.last_busy = Some(busy);
        out.push(sys("crew_busy", None, Some(busy as u32)));
    }
    if needs && !st.last_needs { out.push(sys("crew_needs_input", None, None)); }
    st.last_needs = needs;
    out
}

/// One answer = one complete group: a non-turn_text ContentBlock + its own Result.
fn topics_answer_events(data: &serde_json::Value, my_slot: &str, st: &mut NormState) -> Vec<AcpEvent> {
    if data.get("role").and_then(|v| v.as_str()) != Some("assistant") { return vec![] }
    let kind = data.get("kind").or_else(|| data.get("meta").and_then(|m| m.get("kind"))).and_then(|v| v.as_str()).unwrap_or("");
    let summary: &'static str = match kind {
        "crew_ack" => return vec![sys("crew_ack", None, None)],
        "crew_result" => "crew_result",
        "crew_meta" => "crew_meta",
        "crew_ask" => "crew_ask",
        _ => return vec![],
    };
    let Some(text) = data.get("content").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) else { return vec![] };
    let mid = data.get("meta").and_then(|m| m.get("mid")).and_then(|v| v.as_str()).map(str::to_string);
    if let Some(m) = &mid { if !st.remember_mid(m) { return vec![] } }
    let mut out = vec![
        AcpEvent::ContentBlock { block_type: Cow::Borrowed("text"), turn_id: 0, text: Some(text.to_string()),
            name: None, input: None, streaming: None, summary: Some(summary.to_string()) },
        AcpEvent::Result { text: text.to_string(), turn_id: 0, session_id: my_slot.to_string(),
            cost_usd: None, tokens_in: None, tokens_out: None },
    ];
    if let Some(m) = mid { out.push(sys("crew_cursor", Some(m), None)); }
    out
}
```

`normalize_frame`：在取 `data` 之前插入

```rust
    // G3 topics: `slots` carries no data.slot (it's an array), so it must be handled
    // BEFORE the I1 slot filter — only for topics sessions; chat/goal sessions unchanged.
    if st.topics && kind == "slots" { return topics_slots_events(frame.get("data"), my_slot, st); }
```

在 `match kind` 的 `"chat_message"` 臂改为

```rust
        "chat_message" if st.topics => topics_answer_events(data, my_slot, st),
        "chat_message" => crew_message_events(data),
```

（第二臂即 S5 G1 原样保留。）

- [ ] **Step 4: 运行测试通过**

Run: `cargo test --lib acp::crew_process::tests`
Expected: PASS（含 S5 G1 与 t1–t8 既有用例）。

- [ ] **Step 5: Commit**

```bash
git add src/acp/crew_process.rs
git commit -m "feat(G3): topics normalize — slots busy/needs edges, answer groups, mid dedupe, cursor

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: 会话层话题状态：`set_crew_busy`、游标列、看门狗/stuck/E1 豁免、ephemeral

**Files:**
- Modify: `src/session_store.rs`（`crew_last_mid` 列、`update_crew_cursor`、`PersistedSession.crew_last_mid`、`load_all`）
- Modify: `src/session_manager.rs:268-287`（`RunningProcess.crew_topics`）、`Session.crew_last_mid`、`SessionInfo.awaiting_input`、`:948-972`（两个看门狗）、`:1374-1377`（`running_summary`）、`:3678-3683`（`is_ephemeral_event`）、`:3740-3744`（bump 谓词）、`SpawnPlan`/`decide_spawn`、`spawn_crew`
- Modify: `src/acp/crew_process.rs` `CrewProcess::spawn` 签名（S5 后的形态上追加 `topics: bool, cursor: Option<String>`），`run_event_loop` 用 `NormState::for_topics`
- Test: `src/session_manager.rs` 新增 `mod crew_topics_tests`；`src/session_store.rs` `mod tests`

**Interfaces:**
- Consumes: S5 U1 `Session.crew: Option<CrewMeta { mode, agent, origin }>`；S5 R4 `CrewProcess::spawn(cfg, work_dir, SlotInit)`；S5 U3 `Posture.awaiting_input`。
- Produces:
  - `SessionStore::update_crew_cursor(&self, id: &str, mid: &str) -> Result<(), String>`；`PersistedSession.crew_last_mid: Option<String>`
  - `RunningProcess.crew_topics: bool`；`Session.crew_last_mid: Option<String>`；`SessionInfo.awaiting_input: bool`
  - `SessionManager::set_crew_busy(&self, sid: &str, busy: bool)`
  - `SessionManager::set_crew_cursor(&self, sid: &str, mid: &str)`
  - `fn is_crew_topics(s: &Session) -> bool`
  - `CrewProcess::spawn(cfg, work_dir, init: SlotInit, topics: bool, cursor: Option<String>)`

- [ ] **Step 1: 写失败测试**

```rust
#[cfg(test)]
mod crew_topics_tests {
    use super::*;

    fn topics_session(id: &str, topics: bool) -> Session {
        let (event_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        let (input_tx, _rx) = mpsc::channel::<SessionInput>(8);
        Session {
            id: id.into(), name: "话题".into(), session_type: SessionType::Crew, cols: 80, rows: 24,
            work_dir: "/tmp".into(), owner_id: "u".into(), description: String::new(),
            name_is_auto: true, status: SessionMeta::Running, resume_token: Some(ResumeToken::Crew("zmx-k".into())),
            tmux_origin: None, pending_kill_until: None, worktree_path: None, created_ms: 0, source_task_id: None,
            spawning: false, last_activity_ms: 0, turns_completed: 0, run_metrics: VecDeque::new(),
            lifetime_turns: 0, lifetime_duration_ms: 0, lifetime_cost_usd: 0.0, posture: Posture::default(),
            read_ms: None, crew_last_mid: None,
            crew: Some(CrewMeta { mode: if topics { "crew" } else { "" }.into(), agent: String::new(), origin: "zeromux".into() }),
            running: Some(RunningProcess { event_tx, input_tx, pty_pid: None, turn_state: TurnState::Idle,
                turn_started_ms: None, turn_seq: 0, queue_mode: QueueMode::Collect, crew_topics: topics }),
            scrollback: VecDeque::new(), scrollback_bytes: 0,
        }
        // S5 may add further Session fields: fill them exactly as S5's own test literals do.
    }
    pub(super) fn mgr(sessions: Vec<Session>) -> (Arc<SessionManager>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let events = Arc::new(crate::events::EventStore::open(dir.path()).unwrap());
        let store = Arc::new(crate::session_store::SessionStore::open(dir.path()).unwrap());
        let m = SessionManager::new(events, store.clone(), "claude".into(), "codex".into(), "off".into(),
            5476, "/tmp/crew".into(), "bash".into(), false, crate::tmux::TmuxCtl::new(Some("zmx-test-unused".into())));
        for s in sessions { store.upsert(&persisted_of(&s)).unwrap(); m.sessions.lock().unwrap().insert(s.id.clone(), s); }
        (m, dir)
    }

    #[test]
    fn set_crew_busy_then_idle_is_not_running_and_touches_nothing_else() {
        let (m, _d) = mgr(vec![topics_session("t", true)]);
        m.sessions.lock().unwrap().get_mut("t").unwrap().posture.approval_ids.push("ap".into());
        m.set_crew_busy("t", true);
        assert!(m.turn_is_running("t"));
        {
            let map = m.sessions.lock().unwrap();
            let s = map.get("t").unwrap();
            assert_eq!(s.last_activity_ms, 0, "busy flip is not agent progress");
            assert_eq!(s.running.as_ref().unwrap().turn_seq, 0, "no seq involved");
            assert!(s.running.as_ref().unwrap().turn_started_ms.is_some());
            assert_eq!(s.posture.approval_ids, vec!["ap".to_string()], "approvals untouched");
        }
        m.set_crew_busy("t", false);
        assert!(!m.turn_is_running("t"));
        assert_eq!(m.sessions.lock().unwrap().get("t").unwrap().turns_completed, 0);
    }

    #[test]
    fn busy_three_answers_then_idle_is_idle_regardless_of_seq() {
        // The CTO-R B1 case: mark_turn's Idle requires seq equality and would wedge.
        let (m, _d) = mgr(vec![topics_session("t", true)]);
        m.set_crew_busy("t", true);
        for seq in 1..=3u64 { m.sessions.lock().unwrap().get_mut("t").unwrap().running.as_mut().unwrap().turn_seq = seq; }
        m.set_crew_busy("t", false);
        assert!(!m.turn_is_running("t"));
    }

    #[test]
    fn topics_session_exempt_from_watchdog_stuck_and_e1_gate() {
        let (m, _d) = mgr(vec![topics_session("t", true), topics_session("chat", false)]);
        m.set_crew_busy("t", true);
        m.sessions.lock().unwrap().get_mut("chat").unwrap().running.as_mut().unwrap().turn_state = TurnState::Running;
        let now = 40 * 60_000;
        assert_eq!(m.running_idle_too_long(now, 30 * 60_000), vec!["chat".to_string()]);
        assert_eq!(m.stuck_push_candidates(now, 600_000).into_iter().map(|x| x.0).collect::<Vec<_>>(), vec!["chat".to_string()]);
        assert_eq!(m.running_summary().interactive, 1, "only the chat turn blocks auto-update");
    }

    #[test]
    fn crew_busy_is_ephemeral_and_does_not_bump() {
        let busy = AcpEvent::System { subtype: std::borrow::Cow::Borrowed("crew_busy"), session_id: None, count: Some(1) };
        assert!(is_ephemeral_event(&busy));
        let (m, _d) = mgr(vec![topics_session("t", true)]);
        let tx = m.sessions.lock().unwrap().get("t").unwrap().running.as_ref().unwrap().event_tx.clone();
        emit(&Arc::downgrade(&m), "t", &tx, 1, &busy);
        let s = m.sessions.lock().unwrap();
        assert_eq!(s.get("t").unwrap().last_activity_ms, 0);
        assert!(s.get("t").unwrap().scrollback.is_empty(), "never replayed on reconnect");
    }

    #[test]
    fn crew_answer_block_does_bump() {
        let (m, _d) = mgr(vec![topics_session("t", true)]);
        let tx = m.sessions.lock().unwrap().get("t").unwrap().running.as_ref().unwrap().event_tx.clone();
        emit(&Arc::downgrade(&m), "t", &tx, 1, &AcpEvent::ContentBlock { block_type: std::borrow::Cow::Borrowed("text"),
            turn_id: 1, text: Some("ok".into()), name: None, input: None, streaming: None, summary: Some("crew_result".into()) });
        assert!(m.last_activity_ms("t").unwrap() > 0);
    }

    #[test]
    fn set_crew_cursor_persists_and_reloads() {
        let (m, d) = mgr(vec![topics_session("t", true)]);
        m.set_crew_cursor("t", "m-42");
        let st = crate::session_store::SessionStore::open(d.path()).unwrap();
        assert_eq!(st.load_all().unwrap().into_iter().find(|p| p.id == "t").unwrap().crew_last_mid.as_deref(), Some("m-42"));
        assert_eq!(m.sessions.lock().unwrap().get("t").unwrap().crew_last_mid.as_deref(), Some("m-42"));
    }

    #[test]
    fn decide_spawn_carries_topics_and_cursor() {
        let mut s = topics_session("t", true);
        s.running = None;
        s.crew_last_mid = Some("m-7".into());
        match decide_spawn(&mut s) {
            SpawnDecision::Spawn(p) => { assert!(p.crew_topics); assert_eq!(p.crew_cursor.as_deref(), Some("m-7")); }
            _ => panic!("expected spawn"),
        }
    }
}
```

`src/session_store.rs` `mod tests` 追加：

```rust
    #[test]
    fn crew_cursor_single_column_update_survives_upsert() {
        let (st, _d) = tmp_store();
        st.upsert(&sample("c", None)).unwrap();
        st.update_crew_cursor("c", "m-1").unwrap();
        st.upsert(&sample("c", None)).unwrap();
        assert_eq!(st.load_all().unwrap()[0].crew_last_mid.as_deref(), Some("m-1"));
    }
```

- [ ] **Step 2: 运行，确认失败**

Run: `cargo test --lib crew_topics_tests`
Expected: 编译失败。

- [ ] **Step 3: 实现 store**

ALTER：`let _ = conn.execute("ALTER TABLE sessions ADD COLUMN crew_last_mid TEXT", []);`；`PersistedSession` 加 `pub crew_last_mid: Option<String>,`；`load_all` SELECT 追加 `,crew_last_mid`，映射 `crew_last_mid: row.get::<_, Option<String>>("crew_last_mid")?,`；`upsert` 不写它；新方法

```rust
    /// §3.9 cursor: last processed Crew answer mid. Single-column, never via upsert.
    pub fn update_crew_cursor(&self, id: &str, mid: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE sessions SET crew_last_mid=?2 WHERE id=?1", params![id, mid])
            .map_err(|e| format!("update_crew_cursor failed: {}", e))?;
        Ok(())
    }
```

- [ ] **Step 4: 实现 manager**

`RunningProcess` 末尾：

```rust
    /// crew_mode=="crew" (S6 G3): Gateway owns busy/idle; exempt from the interactive
    /// watchdog, stuck push and the auto-update E1 interactive count (D7).
    crew_topics: bool,
```

所有 `RunningProcess { … }` 字面量（`:1108,1234,1595` 为 `crew_topics: false`；`:1699` 在 `spawn_crew` 内为 `crew_topics: topics`；测试 `:4728,4881,5598,6440,6952,7179` 为 `false`）。`Session` 加 `crew_last_mid: Option<String>,`（创建路径 `None`，`load_persisted` 为 `p.crew_last_mid`，`persisted_of` 追加 `crew_last_mid: s.crew_last_mid.clone(),`）。`SessionInfo` 加 `pub awaiting_input: bool,`，`session_info_of` 加 `awaiting_input: s.posture.awaiting_input,`。

新增：

```rust
fn is_crew_topics(s: &Session) -> bool { s.running.as_ref().map(|rp| rp.crew_topics).unwrap_or(false) }
```

`running_idle_too_long` 与 `stuck_push_candidates` 各在 `.filter(|s| !scheduled_owned(...))` 后加 `.filter(|s| !is_crew_topics(s))`；`running_summary` 循环里 `let Some(rp) = …` 之后加 `if rp.crew_topics { continue; }`。

`impl SessionManager`（`mark_turn` 旁）：

```rust
    /// Topics busy/idle straight from the Gateway (V6). Deliberately NOT mark_turn:
    /// apply_turn's Idle needs a matching seq and would wedge a topics turn Running.
    /// No seq, no last_activity bump, no approval clearing, no turns_completed.
    fn set_crew_busy(&self, sid: &str, busy: bool) {
        let mut map = self.sessions.lock().unwrap();
        if let Some(rp) = map.get_mut(sid).and_then(|s| s.running.as_mut()) {
            rp.turn_state = if busy { TurnState::Running } else { TurnState::Idle };
            if busy { rp.turn_started_ms.get_or_insert_with(now_millis); } else { rp.turn_started_ms = None; }
        }
    }

    fn set_crew_cursor(&self, sid: &str, mid: &str) {
        if let Some(s) = self.sessions.lock().unwrap().get_mut(sid) { s.crew_last_mid = Some(mid.to_string()); }
        if let Err(e) = self.store.update_crew_cursor(sid, mid) { tracing::warn!("crew cursor {} failed: {}", sid, e); }
    }
```

（两者给 `#[cfg(test)]` 以外的调用方是 Task 10 的 fan-out；在那之前加 `#[allow(dead_code)]`，Task 10 删除。）

`is_ephemeral_event` 改为 `matches!(evt, AcpEvent::System { subtype, .. } if subtype == "queued" || subtype == "crew_busy")`，注释补一句 crew_busy 由 `replay_done.running` 提供重连状态。bump 谓词追加 `&& !matches!(evt, AcpEvent::System { subtype, .. } if subtype == "crew_busy")`。

`SpawnPlan` 加 `crew_topics: bool, crew_cursor: Option<String>`；`decide_spawn` 填 `crew_topics: s.crew.as_ref().map(|c| c.mode == "crew").unwrap_or(false), crew_cursor: s.crew_last_mid.clone(),`；`ensure_running` 解构时一并取出，两处 `spawn_crew` 调用（`:1830` 附近主路径与 `:1864` fresh fallback）传入 `crew_topics`、`crew_cursor`（fallback 传 `None` 游标：新 slot 没有历史）。`spawn_crew` 签名在 S5 版本末尾追加 `topics: bool, cursor: Option<String>`，转给 `CrewProcess::spawn(cfg, work_dir, init, topics, cursor)` 与 `spawn_crew_fanout(…, topics)`（fan-out 参数在 Task 10 使用；本 task 先加参数，函数体内 `let _ = topics;`，Task 10 删除这一行）。`create_crew_session` 调用处传 `crew_mode == "crew", None`。

`src/acp/crew_process.rs`：`spawn` 追加两参，`tokio::spawn(run_event_loop(cfg.clone(), http, slot_key.clone(), event_tx, cmd_rx, topics, cursor))`；`run_event_loop` 签名同步，`let mut st = if topics { NormState::for_topics(cursor) } else { NormState::new() };`。

- [ ] **Step 5: 运行测试通过**

Run: `cargo test`
Expected: 全绿（含 `running_summary_tests`、`emit_tests::is_ephemeral_event_only_matches_queued`——该用例断言 `init` 非 ephemeral，仍成立）。

- [ ] **Step 6: Commit**

```bash
git add src/session_store.rs src/session_manager.rs src/acp/crew_process.rs
git commit -m "feat(G3): set_crew_busy, crew_last_mid cursor, topics exempt from watchdog/stuck/E1

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: 话题 fan-out 分支、`settle_crew_answer`、ask 推送与按 kind 分 key 的去抖

**Files:**
- Modify: `src/push.rs`（`payload_for` 的 `ask`/`approval` 默认文案、`KindDebounce`、`forget_session`）
- Modify: `src/session_manager.rs:3897-4202`（`spawn_crew_fanout` 增加 `topics` 分支）；新增 `TopicsFanout`、`topics_on_event`、`topics_on_prompt`、`settle_crew_answer`、`maybe_push_ask`、`set_awaiting_input`
- Test: `src/push.rs` `mod tests`、`src/session_manager.rs` `mod crew_topics_tests`

**Interfaces:**
- Consumes: Task 8 事件（`crew_busy`/`crew_cursor`/`crew_needs_input`/`crew_ack`、回答 ContentBlock+Result）；Task 9 `set_crew_busy`/`set_crew_cursor`；**S5 U3** `fn persist_posture(&self, sid: &str)`；**S5 U4** `payload_for(…, body: Option<&str>)`；**S5 F2** `maybe_push_turn_done` 自带 snippet body；**S5 G2** `first_prompt_logged` 与 `crew_first_prompt` 埋点（话题分支的 Prompt 臂保留它）。
- Produces:
  - `push::KindDebounce`：`claim(&self, user: &str, key: &str, kind: &str, now_ms: i64, window_ms: i64) -> bool`（单锁 check-and-mark）、`forget(&self, key: &str)`；`PushService.kind_debounce: KindDebounce`
  - `pub const ASK_DEBOUNCE_MS: i64 = 5 * 60_000`
  - `payload_for("ask", name, …)` → 标题 `❓ {name} 等你回答`，默认正文「有问题等你回答」；`payload_for("approval", …)` → `🛡 {name} 待审批`，默认正文「有操作等你批准」
  - `struct TopicsFanout { turn_seq: u64, last_prompt_ms: Option<i64>, pending_answer: Option<String>, quiet_left: u32 }`
  - `fn topics_on_event(mgr: &Weak<SessionManager>, sid: &str, owner: &str, tx: &broadcast::Sender<String>, tf: &mut TopicsFanout, evt: &AcpEvent)`
  - `fn topics_on_prompt(mgr: &Weak<SessionManager>, sid: &str, tx: &broadcast::Sender<String>, tf: &mut TopicsFanout, text: &str, client_id: Option<String>)`
  - `SessionManager::settle_crew_answer(&self, sid: &str, kind: &str)`、`SessionManager::set_awaiting_input(&self, sid: &str, on: bool, snippet: Option<String>)`
  - `fn maybe_push_ask(mgr: &Weak<SessionManager>, sid: &str, owner: &str, kind: &'static str, body: String)`

- [ ] **Step 1: 写 push 失败测试**

```rust
    #[test]
    fn ask_and_approval_debounce_are_keyed_by_kind() {
        let d = KindDebounce::default();
        assert!(d.claim("u", "s1", "ask", 1_000, ASK_DEBOUNCE_MS));
        assert!(d.claim("u", "s1", "approval", 2_000, ASK_DEBOUNCE_MS), "an ask must not swallow the approval that follows");
        assert!(!d.claim("u", "s1", "ask", 3_000, ASK_DEBOUNCE_MS));
        assert!(d.claim("u", "s1", "ask", 1_000 + ASK_DEBOUNCE_MS, ASK_DEBOUNCE_MS));
        assert!(d.claim("u", "s2", "ask", 3_000, ASK_DEBOUNCE_MS), "per session");
        d.forget("s1");
        assert!(d.claim("u", "s1", "approval", 4_000, ASK_DEBOUNCE_MS));
    }

    #[test]
    fn kind_debounce_claim_is_atomic_across_threads() {
        let d = std::sync::Arc::new(KindDebounce::default());
        let wins: usize = (0..8).map(|_| { let d = d.clone(); std::thread::spawn(move || d.claim("u", "s", "ask", 10, ASK_DEBOUNCE_MS)) })
            .collect::<Vec<_>>().into_iter().map(|h| h.join().unwrap() as usize).sum();
        assert_eq!(wins, 1);
    }

    #[test]
    fn ask_payload_and_level() {
        let p = payload_for("ask", "话题", "s", None, Some("要部署到 prod 吗？"));
        assert_eq!(p.title, "❓ 话题 等你回答");
        assert_eq!(p.body, "要部署到 prod 吗？");
        assert_eq!(payload_for("ask", "话题", "s", None, None).body, "有问题等你回答");
        assert!(kind_allowed_by_levels("ask", true, false));
        assert!(!kind_allowed_by_levels("ask", false, true));
        assert!(kind_allowed_by_levels("approval", true, false));
    }
```

- [ ] **Step 2: 运行，确认失败**

Run: `cargo test --lib push::tests::ask`
Expected: 编译失败。

- [ ] **Step 3: 实现 push**

```rust
pub const ASK_DEBOUNCE_MS: i64 = 5 * 60_000;

/// (user, key, kind) → last push ms. key = session id, or "crew:<slot>" for external
/// slots (Task 15). One lock for check+mark, so N concurrent spawned pushes claim once.
#[derive(Default)]
pub struct KindDebounce { map: Mutex<std::collections::HashMap<(String, String, String), i64>> }

impl KindDebounce {
    pub fn claim(&self, user: &str, key: &str, kind: &str, now_ms: i64, window_ms: i64) -> bool {
        let mut m = self.map.lock().unwrap();
        let k = (user.to_string(), key.to_string(), kind.to_string());
        if let Some(&last) = m.get(&k) { if now_ms - last < window_ms { return false; } }
        m.insert(k, now_ms);
        true
    }
    pub fn forget(&self, key: &str) { self.map.lock().unwrap().retain(|(_, k, _), _| k != key); }
}
```

`PushService` 加 `pub kind_debounce: KindDebounce,`（`new` 里 `kind_debounce: KindDebounce::default(),`）；`forget_session` 末尾加 `self.kind_debounce.forget(session_id);`。`payload_for` 的 match 增加（S5 的 body 覆盖逻辑位于 match 之后，不变）：

```rust
        "ask" => (format!("❓ {name} 等你回答"), "有问题等你回答".to_string()),
        "approval" => (format!("🛡 {name} 待审批"), "有操作等你批准".to_string()),
```

`kind_allowed_by_levels` 不改（`_` 臂即 important），测试锁定行为。

- [ ] **Step 4: 写 fan-out 失败测试**

`mod crew_topics_tests` 追加：

```rust
    fn tx_of(m: &SessionManager, id: &str) -> broadcast::Sender<String> {
        m.sessions.lock().unwrap().get(id).unwrap().running.as_ref().unwrap().event_tx.clone()
    }
    fn sysev(sub: &'static str, count: Option<u32>, sid: Option<&str>) -> AcpEvent {
        AcpEvent::System { subtype: std::borrow::Cow::Borrowed(sub), session_id: sid.map(String::from), count }
    }
    fn answer(kind: &str, text: &str) -> [AcpEvent; 2] {
        [AcpEvent::ContentBlock { block_type: std::borrow::Cow::Borrowed("text"), turn_id: 0, text: Some(text.into()),
            name: None, input: None, streaming: None, summary: Some(kind.into()) },
         AcpEvent::Result { text: text.into(), turn_id: 0, session_id: "zmx-k".into(), cost_usd: None, tokens_in: None, tokens_out: None }]
    }
    fn drive(m: &Arc<SessionManager>, tf: &mut TopicsFanout, evs: &[AcpEvent]) {
        let tx = tx_of(m, "t");
        for e in evs { topics_on_event(&Arc::downgrade(m), "t", "u", &tx, tf, e); }
    }

    #[tokio::test]
    async fn fanout_busy_answer_idle_ends_not_running_with_completed_outcome() {
        let (m, _d) = mgr(vec![topics_session("t", true)]);
        let mut tf = TopicsFanout::default();
        let mut evs = vec![sysev("crew_busy", Some(1), None)];
        evs.extend(answer("crew_result", "已合并 PR #12"));
        evs.push(sysev("crew_busy", Some(0), None));
        drive(&m, &mut tf, &evs);
        assert!(!m.turn_is_running("t"));
        let info = session_info_of(m.sessions.lock().unwrap().get("t").unwrap());
        assert_eq!(info.last_outcome, Some("completed"));
        assert_eq!(info.last_snippet.as_deref(), Some("已合并 PR #12"));
        assert_eq!(tf.turn_seq, 1, "one group per answer");
    }

    #[tokio::test]
    async fn fanout_real_sequence_sets_awaiting_and_persists_it() {
        let (m, d) = mgr(vec![topics_session("t", true)]);
        let mut tf = TopicsFanout::default();
        let mut evs = vec![sysev("crew_ack", None, None)];
        for _ in 0..3 { evs.extend(answer("crew_ask", "要重试吗？")); }
        evs.extend(answer("crew_meta", "nothing was started"));
        drive(&m, &mut tf, &evs);
        let info = session_info_of(m.sessions.lock().unwrap().get("t").unwrap());
        assert!(info.awaiting_input, "meta does not clear awaiting (D5)");
        assert_eq!(info.last_outcome, Some("completed"));
        // restart round-trip (V2): persisted via S5 persist_posture
        let st = crate::session_store::SessionStore::open(d.path()).unwrap();
        let p = st.load_all().unwrap().into_iter().find(|x| x.id == "t").unwrap();
        assert!(p.posture.awaiting_input);
    }

    #[tokio::test]
    async fn fanout_ask_restart_keeps_question_as_snippet() {
        let (m, d) = mgr(vec![topics_session("t", true)]);
        let mut tf = TopicsFanout::default();
        drive(&m, &mut tf, &answer("crew_ask", "部署到 prod 还是 staging？"));
        let st = crate::session_store::SessionStore::open(d.path()).unwrap();
        let p = st.load_all().unwrap().into_iter().find(|x| x.id == "t").unwrap();
        assert!(p.posture.awaiting_input);
        assert_eq!(p.posture.last_snippet.as_deref(), Some("部署到 prod 还是 staging？"));
    }

    #[tokio::test]
    async fn user_prompt_clears_awaiting_and_persists() {
        let (m, d) = mgr(vec![topics_session("t", true)]);
        let mut tf = TopicsFanout::default();
        drive(&m, &mut tf, &answer("crew_ask", "?"));
        topics_on_prompt(&Arc::downgrade(&m), "t", &tx_of(&m, "t"), &mut tf, "staging", None);
        assert!(!session_info_of(m.sessions.lock().unwrap().get("t").unwrap()).awaiting_input);
        let st = crate::session_store::SessionStore::open(d.path()).unwrap();
        assert!(!st.load_all().unwrap().into_iter().find(|x| x.id == "t").unwrap().posture.awaiting_input);
        assert!(!m.turn_is_running("t"), "a prompt alone does not mark busy; crew_busy does");
        assert_eq!(tf.turn_seq, 2);
    }

    #[tokio::test]
    async fn crew_result_clears_awaiting_crew_meta_does_not() {
        let (m, _d) = mgr(vec![topics_session("t", true)]);
        let mut tf = TopicsFanout::default();
        drive(&m, &mut tf, &answer("crew_ask", "?"));
        drive(&m, &mut tf, &answer("crew_meta", "x"));
        assert!(session_info_of(m.sessions.lock().unwrap().get("t").unwrap()).awaiting_input);
        drive(&m, &mut tf, &answer("crew_result", "done"));
        assert!(!session_info_of(m.sessions.lock().unwrap().get("t").unwrap()).awaiting_input);
    }

    #[tokio::test]
    async fn needs_input_edge_sets_awaiting_only() {
        let (m, _d) = mgr(vec![topics_session("t", true)]);
        let mut tf = TopicsFanout::default();
        drive(&m, &mut tf, &[sysev("crew_needs_input", None, None)]);
        assert!(session_info_of(m.sessions.lock().unwrap().get("t").unwrap()).awaiting_input);
    }

    #[tokio::test]
    async fn cursor_event_advances_persisted_cursor_and_is_not_broadcast() {
        let (m, _d) = mgr(vec![topics_session("t", true)]);
        let mut rx = tx_of(&m, "t").subscribe();
        let mut tf = TopicsFanout::default();
        drive(&m, &mut tf, &[sysev("crew_cursor", None, Some("m-5"))]);
        assert_eq!(m.sessions.lock().unwrap().get("t").unwrap().crew_last_mid.as_deref(), Some("m-5"));
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn topics_exit_clears_busy() {
        let (m, _d) = mgr(vec![topics_session("t", true)]);
        let mut tf = TopicsFanout::default();
        drive(&m, &mut tf, &[sysev("crew_busy", Some(1), None), AcpEvent::Exit { code: -1 }]);
        assert!(!m.turn_is_running("t"));
    }

    #[tokio::test]
    async fn gateway_reconnect_error_is_a_notice_not_a_settle() {
        let (m, _d) = mgr(vec![topics_session("t", true)]);
        let mut tf = TopicsFanout::default();
        drive(&m, &mut tf, &[AcpEvent::Error { message: "Kiro Crew Gateway 连接中断，正在重连".into() }]);
        assert_eq!(session_info_of(m.sessions.lock().unwrap().get("t").unwrap()).last_outcome, None);
    }
}
```

（`p.posture.awaiting_input` 是 S5 `PersistedPosture` 的字段名，S5 §1.2。）

- [ ] **Step 5: 运行，确认失败**

Run: `cargo test --lib crew_topics_tests`
Expected: 编译失败（`TopicsFanout` 未定义）。

- [ ] **Step 6: 实现 fan-out 分支**

`impl SessionManager`：

```rust
    /// Topics answer settlement (spec §3.2). Every branch persists (V2 / CTO-R M5).
    fn settle_crew_answer(&self, sid: &str, kind: &str) {
        if kind == "crew_ask" {
            let q = { self.sessions.lock().unwrap().get(sid).and_then(|s| s.posture.last_snippet.clone()) };
            self.set_awaiting_input(sid, true, q);
            return;
        }
        self.settle_posture(sid, crate::run_metrics::RunOutcome::Completed);   // S5 persists at its tail
        if kind == "crew_result" { self.set_awaiting_input(sid, false, None); }
    }

    /// Set/clear 「待回答」, optionally with the question as snippet, and persist (S5 U3).
    fn set_awaiting_input(&self, sid: &str, on: bool, snippet: Option<String>) {
        let changed = {
            let mut map = self.sessions.lock().unwrap();
            let Some(s) = map.get_mut(sid) else { return };
            let was = (s.posture.awaiting_input, s.posture.last_snippet.clone());
            s.posture.awaiting_input = on;
            if let Some(q) = snippet { s.posture.last_snippet = Some(q); }
            was != (s.posture.awaiting_input, s.posture.last_snippet.clone())
        };
        if changed { self.persist_posture(sid); }
    }
```

模块级：

```rust
/// Topics fan-out local state (crew_mode=="crew"). Parity with the other backends is
/// only required in normal mode (CTO final §2): topics have no turn boundary.
#[derive(Default)]
struct TopicsFanout {
    turn_seq: u64,
    last_prompt_ms: Option<i64>,
    /// summary kind of the ContentBlock just emitted; its Result settles it.
    pending_answer: Option<String>,
    /// catch-up burst (Task 11): answers still to arrive without their own turn_done push.
    quiet_left: u32,
}

fn maybe_push_ask(mgr: &Weak<SessionManager>, sid: &str, owner: &str, kind: &'static str, body: String) {
    let Some(m) = mgr.upgrade() else { return };
    let Some(p) = m.push_handle() else { return };
    let name = m.session_name(sid).unwrap_or_default();
    let (uid, sid2) = (owner.to_string(), sid.to_string());
    tokio::spawn(async move {
        if !p.kind_debounce.claim(&uid, &sid2, kind, now_millis(), crate::push::ASK_DEBOUNCE_MS) { return; }
        let body: String = body.chars().take(120).collect();
        p.send_to_user(&uid, &crate::push::payload_for(kind, &name, &sid2, None, Some(&body))).await;
    });
}

fn topics_on_event(mgr: &Weak<SessionManager>, sid: &str, owner: &str, tx: &broadcast::Sender<String>,
                   tf: &mut TopicsFanout, evt: &AcpEvent) {
    let m = mgr.upgrade();
    match evt {
        AcpEvent::System { subtype, count, .. } if subtype == "crew_busy" => {
            if let Some(m) = &m { m.set_crew_busy(sid, count.unwrap_or(0) > 0); }
            emit(mgr, sid, tx, tf.turn_seq, evt);
        }
        AcpEvent::System { subtype, session_id: Some(mid), .. } if subtype == "crew_cursor" => {
            if let Some(m) = &m { m.set_crew_cursor(sid, mid); }
        }
        AcpEvent::System { subtype, .. } if subtype == "crew_needs_input" => {
            if let Some(m) = &m { m.set_awaiting_input(sid, true, None); }
        }
        AcpEvent::ContentBlock { summary: Some(k), .. } if k.starts_with("crew_") => {
            tf.turn_seq += 1;
            tf.pending_answer = Some(k.clone());
            emit(mgr, sid, tx, tf.turn_seq, evt);
        }
        AcpEvent::Result { text, .. } => {
            emit(mgr, sid, tx, tf.turn_seq, evt);           // posture_delta_of → snippet
            let Some(kind) = tf.pending_answer.take() else { return };
            if let Some(m) = &m { m.settle_crew_answer(sid, &kind); }
            if kind == "crew_ask" {
                maybe_push_ask(mgr, sid, owner, "ask", text.clone());
            } else if tf.quiet_left > 0 {
                tf.quiet_left -= 1;
            } else {
                let dur = tf.last_prompt_ms.map(|s| now_millis() - s).unwrap_or(0);
                maybe_push_turn_done(mgr, sid, owner, dur, None);
            }
        }
        AcpEvent::Exit { .. } => {
            if let Some(m) = &m { m.set_crew_busy(sid, false); }
            emit(mgr, sid, tx, tf.turn_seq, evt);
        }
        // crew_ack / crew_gap / Gateway-reconnect Error: shown, never settles (no turn to settle).
        _ => emit(mgr, sid, tx, tf.turn_seq, evt),
    }
}

fn topics_on_prompt(mgr: &Weak<SessionManager>, sid: &str, tx: &broadcast::Sender<String>,
                    tf: &mut TopicsFanout, text: &str, client_id: Option<String>) {
    tf.turn_seq += 1;
    emit(mgr, sid, tx, tf.turn_seq, &AcpEvent::UserPrompt {
        text: truncate_prompt_for_scrollback(text), turn_id: tf.turn_seq, client_id });
    tf.last_prompt_ms = Some(now_millis());
    if let Some(m) = mgr.upgrade() { m.set_awaiting_input(sid, false, None); }
}
```

注：`dur` 用「距最近一次用户 prompt」，没有 prompt（例如纯外部触发）时为 0，按 `should_push_turn_done` 的 ≥60s 规则不推——这是 spec §3.2 `unwrap_or(now)` 的等价写法。

`spawn_crew_fanout` 签名追加 `topics: bool`（删除 Task 9 的 `let _ = topics;`），循环前 `let mut tf = TopicsFanout::default();`。在事件臂 `Some(evt) => {` 内、`let is_boundary = …` **之前**：

```rust
                            // ── G3 topics branch (crew_mode=="crew") ── Crew-only: no turn
                            // boundary exists, so busy comes only from the Gateway via
                            // set_crew_busy (NOT mark_turn — apply_turn's Idle needs a
                            // matching seq and would wedge Running forever, CTO-R B1).
                            if topics {
                                topics_on_event(&mgr, &sid, &owner_id, &event_tx, &mut tf, &evt);
                                continue;
                            }
```

（`continue` 作用于外层 `loop`；上面的 token 回填与 `log_result_event` 仍先执行。）输入臂 `Some(SessionInput::Prompt { text, run_id, client_id })` 开头：

```rust
                            if topics && run_id.is_none() {
                                // S5 G2 first-prompt metric stays here (same flag as the normal path).
                                if !first_prompt_logged {
                                    first_prompt_logged = true;
                                    tracing::info!(target: "zmx_usage", "crew_first_prompt sid={sid}");
                                }
                                topics_on_prompt(&mgr, &sid, &event_tx, &mut tf, &text, client_id);
                                // Crew keeps its own durable queue: bypass collect, no mark_turn.
                                if let Err(e) = process.send_prompt(&text).await {
                                    tracing::warn!("Crew send_prompt failed for {}: {}", sid, e);
                                }
                                continue;
                            }
```

（`first_prompt_logged` 是 S5 G2 在本 fan-out 里的局部变量；若 S5 把埋点写在 Prompt 臂别处，把上面三行删掉并确认 S5 的埋点位于 `if topics` 之前。）

`Some(SessionInput::Cancel)` 与 `Some(SessionInput::Interrupt)` 臂开头各加：

```rust
                            if topics {
                                // /stop only; never kill the WS (that would Drop → delete the slot).
                                if let Err(e) = process.interrupt().await { tracing::warn!("crew topics stop {}: {}", sid, e); }
                                continue;
                            }
```

`Some(SessionInput::TimeoutKill { .. })` 开头加 `if topics { tracing::warn!("TimeoutKill reached topics session {} (filtered upstream); ignored", sid); continue; }`。删除 Task 9 中 `set_crew_busy`/`set_crew_cursor` 的 `#[allow(dead_code)]`。

- [ ] **Step 7: 运行测试通过**

Run: `cargo test --lib crew_topics_tests && cargo test`
Expected: 全绿。

- [ ] **Step 8: Commit**

```bash
git add src/push.rs src/session_manager.rs
git commit -m "feat(G3): topics fan-out branch, settle_crew_answer, ask push with per-kind debounce

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: §3.9 断连补发 + 30s 兜底轮询

**Files:**
- Modify: `src/acp/crew_process.rs`（`catch_up_plan`、`fetch_slot_messages`、`fetch_slot_list`、`run_event_loop` 内的 detached 请求与回流臂）
- Modify: `src/session_manager.rs`（`topics_on_event` 处理 `crew_catchup`）
- Test: `src/acp/crew_process.rs` `mod tests`、`src/session_manager.rs` `mod crew_topics_tests`

**Interfaces:**
- Consumes: Task 8 `NormState.cursor`/`remember_mid`/`topics_answer_events`；Task 10 `TopicsFanout.quiet_left`。
- Produces:
  - `pub struct CatchUp { pub seed: Vec<String>, pub replay: Vec<serde_json::Value>, pub gap: bool }`
  - `pub fn catch_up_plan(messages: &[serde_json::Value], cursor: Option<&str>) -> CatchUp`
  - `pub fn synth_answer_frame(slot: &str, row: &serde_json::Value) -> serde_json::Value`
  - 事件：`System{subtype:"crew_catchup", count: Some(n), session_id: Some("gap"|"ok")}`（fan-out 消费、不转发）、`System{subtype:"crew_gap"}`（转发并持久化，前端显示提示）
  - `zmx_usage crew_catchup sid=… n=… gap={bool}`

- [ ] **Step 1: 写失败测试**

```rust
    fn row(mid: &str, reply: bool, role: &str) -> serde_json::Value {
        json!({"role":role,"content":format!("c-{mid}"),"meta": if reply { json!({"crew_reply":true,"mid":mid}) } else { json!({"mid":mid}) }})
    }

    #[test]
    fn catch_up_empty_cursor_only_seeds() {
        let msgs = vec![row("m1", true, "assistant"), row("u1", false, "user"), row("m2", true, "assistant")];
        let p = catch_up_plan(&msgs, None);
        assert_eq!(p.seed, vec!["m1", "m2"]);
        assert!(p.replay.is_empty() && !p.gap);
    }

    #[test]
    fn catch_up_replays_only_after_cursor_in_order() {
        let msgs = vec![row("m1", true, "assistant"), row("m2", true, "assistant"), row("u", false, "user"), row("m3", true, "assistant")];
        let p = catch_up_plan(&msgs, Some("m1"));
        let mids: Vec<_> = p.replay.iter().map(|r| r["meta"]["mid"].as_str().unwrap()).collect();
        assert_eq!(mids, vec!["m2", "m3"]);
        assert!(!p.gap);
    }

    #[test]
    fn catch_up_cursor_outside_window_replays_all_with_gap() {
        let msgs = vec![row("m8", true, "assistant"), row("m9", true, "assistant")];
        let p = catch_up_plan(&msgs, Some("m1"));
        assert_eq!(p.replay.len(), 2);
        assert!(p.gap);
    }

    #[test]
    fn catch_up_skips_rows_without_meta_or_not_replies() {
        let msgs = vec![json!({"role":"assistant","content":"x"}), row("m2", false, "assistant"), json!(7)];
        let p = catch_up_plan(&msgs, Some("zz"));
        assert!(p.replay.is_empty());
    }

    #[test]
    fn catch_up_then_live_frame_same_mid_renders_once() {
        let s = "k";
        let mut st = NormState::for_topics(Some("m1".into()));
        let p = catch_up_plan(&[row("m1", true, "assistant"), row("m2", true, "assistant")], st.cursor.as_deref());
        let mut ev = vec![];
        for r in &p.replay { ev.extend(normalize_frame(&synth_answer_frame(s, r), s, &mut st)); }
        ev.extend(normalize_frame(&cmsg(s, "crew_result", "c-m2", "m2"), s, &mut st));   // live duplicate
        assert_eq!(subtypes(&ev).iter().filter(|x| *x == "result").count(), 1);
    }

    #[test]
    fn same_process_reconnect_keeps_seen_so_catch_up_only_fills_gap() {
        let s = "k";
        let mut st = NormState::for_topics(None);
        let _ = normalize_frame(&cmsg(s, "crew_result", "a", "m1"), s, &mut st);   // seen live before the drop
        let p = catch_up_plan(&[row("m1", true, "assistant"), row("m2", true, "assistant")], Some("m1"));
        let ev: Vec<_> = p.replay.iter().flat_map(|r| normalize_frame(&synth_answer_frame(s, r), s, &mut st)).collect();
        assert_eq!(subtypes(&ev).iter().filter(|x| *x == "result").count(), 1);
    }
```

`mod crew_topics_tests` 追加：

```rust
    #[tokio::test]
    async fn catchup_burst_of_three_quiets_turn_done_and_is_not_broadcast() {
        let (m, _d) = mgr(vec![topics_session("t", true)]);
        let mut rx = tx_of(&m, "t").subscribe();
        let mut tf = TopicsFanout::default();
        drive(&m, &mut tf, &[sysev("crew_catchup", Some(3), Some("ok"))]);
        assert_eq!(tf.quiet_left, 3);
        assert!(rx.try_recv().is_err());
        let mut evs = vec![];
        for i in 0..3 { evs.extend(answer("crew_result", &format!("r{i}"))); }
        drive(&m, &mut tf, &evs);
        assert_eq!(tf.quiet_left, 0);
    }
```

- [ ] **Step 2: 运行，确认失败**

Run: `cargo test --lib acp::crew_process::tests::catch_up && cargo test --lib crew_topics_tests::catchup`
Expected: 编译失败。

- [ ] **Step 3: 实现纯函数**

```rust
pub struct CatchUp { pub seed: Vec<String>, pub replay: Vec<serde_json::Value>, pub gap: bool }

/// §3.9: persisted rows carry no `kind` (only meta.crew_reply), so every replayed row is
/// treated as a crew_result. Empty cursor = first open: seed only, never flood history.
pub fn catch_up_plan(messages: &[serde_json::Value], cursor: Option<&str>) -> CatchUp {
    let replies: Vec<&serde_json::Value> = messages.iter().filter(|m| {
        m.get("role").and_then(|v| v.as_str()) == Some("assistant")
            && m.get("meta").and_then(|x| x.get("crew_reply")).and_then(|v| v.as_bool()) == Some(true)
            && m.get("meta").and_then(|x| x.get("mid")).and_then(|v| v.as_str()).is_some()
    }).collect();
    let mid = |m: &serde_json::Value| m["meta"]["mid"].as_str().unwrap_or("").to_string();
    let Some(c) = cursor else {
        return CatchUp { seed: replies.iter().map(|m| mid(m)).collect(), replay: vec![], gap: false };
    };
    match replies.iter().position(|m| mid(m) == c) {
        Some(i) => CatchUp { seed: vec![], replay: replies[i + 1..].iter().map(|m| (*m).clone()).collect(), gap: false },
        None => CatchUp { seed: vec![], replay: replies.iter().map(|m| (*m).clone()).collect(), gap: !replies.is_empty() },
    }
}

pub fn synth_answer_frame(slot: &str, row: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({"type":"chat_message","data":{"slot":slot,"role":"assistant",
        "content": row.get("content").cloned().unwrap_or(serde_json::Value::Null),
        "meta": row.get("meta").cloned().unwrap_or(serde_json::Value::Null), "kind":"crew_result"}})
}
```

`NormState` 增加 `pub fn seed(&mut self, mids: &[String]) { for m in mids { self.remember_mid(m); } }`。

- [ ] **Step 4: 实现 I/O 接线（process 层，detached + mpsc）**

```rust
const TOPICS_POLL: std::time::Duration = std::time::Duration::from_secs(30);

enum Fetched { Messages(Vec<serde_json::Value>), SlotList(serde_json::Value) }

async fn get_json_secret(http: &reqwest::Client, base: &str, secret: &str, path: &str) -> Option<serde_json::Value> {
    let r = http.get(format!("{base}{path}")).header("X-Internal-Secret", secret).timeout(REST_TIMEOUT).send().await.ok()?;
    if !r.status().is_success() { return None; }
    r.json().await.ok()
}

/// Detached: the select loop must never await HTTP (same reason as prompt_worker).
fn spawn_fetch(cfg: &CrewConfig, http: &reqwest::Client, slot: &str, list: bool, tx: mpsc::Sender<Fetched>) {
    let (cfg, http, slot) = (cfg.clone(), http.clone(), slot.to_string());
    tokio::spawn(async move {
        let Ok(secret) = read_gateway_secret(&cfg.crew_home, cfg.port) else { return };
        let out = if list {
            get_json_secret(&http, &cfg.http_base, &secret, "/api/chat/slots").await.map(Fetched::SlotList)
        } else {
            get_json_secret(&http, &cfg.http_base, &secret, &format!("/api/chat/slots/{slot}?limit=200")).await
                .and_then(|v| v.get("messages").and_then(|m| m.as_array()).cloned()).map(Fetched::Messages)
        };
        if let Some(o) = out { let _ = tx.send(o).await; }
    });
}
```

`run_event_loop`：在 `'outer` 之前 `let (fetch_tx, mut fetch_rx) = mpsc::channel::<Fetched>(4); let mut poll = tokio::time::interval(TOPICS_POLL); poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);`。`slot_alive` 检查通过、进入内层 loop 之前：`if st.topics { spawn_fetch(&cfg, &http, &slot_key, false, fetch_tx.clone()); }`。内层 `select!` 增加两臂：

```rust
                _ = poll.tick(), if st.topics => { spawn_fetch(&cfg, &http, &slot_key, true, fetch_tx.clone()); }
                Some(f) = fetch_rx.recv(), if st.topics => {
                    let evts: Vec<AcpEvent> = match f {
                        Fetched::SlotList(v) => normalize_frame(&serde_json::json!({"type":"slots","data":v}), &slot_key, &mut st),
                        Fetched::Messages(msgs) => {
                            let plan = catch_up_plan(&msgs, st.cursor.as_deref());
                            st.seed(&plan.seed);
                            if plan.seed.is_empty() && plan.replay.is_empty() { vec![] } else {
                                let mut ev = vec![AcpEvent::System { subtype: Cow::Borrowed("crew_catchup"),
                                    session_id: Some(if plan.gap { "gap" } else { "ok" }.into()),
                                    count: Some(plan.replay.len() as u32) }];
                                if plan.gap { ev.push(AcpEvent::System { subtype: Cow::Borrowed("crew_gap"), session_id: None, count: None }); }
                                for r in &plan.replay { ev.extend(normalize_frame(&synth_answer_frame(&slot_key, r), &slot_key, &mut st)); }
                                ev
                            }
                        }
                    };
                    for e in evts { if event_tx.send(e).await.is_err() { return; } }
                }
```

把最新 cursor 也记在 `st` 上：`topics_answer_events` 在产出 `crew_cursor` 时同时 `st.cursor = Some(m.clone())`（Task 8 代码补一行）。

- [ ] **Step 5: fan-out 消费 `crew_catchup`**

`topics_on_event` 增加（放在 `crew_needs_input` 臂之后）：

```rust
        AcpEvent::System { subtype, count, session_id } if subtype == "crew_catchup" => {
            let n = count.unwrap_or(0);
            let gap = session_id.as_deref() == Some("gap");
            tracing::info!(target: "zmx_usage", "crew_catchup sid={sid} n={n} gap={gap}");
            if n >= 3 {
                tf.quiet_left = n;
                if let Some(m) = &m {
                    if let Some(p) = m.push_handle() {
                        let (uid, sid2, name) = (owner.to_string(), sid.to_string(), m.session_name(sid).unwrap_or_default());
                        let body = format!("{name} 断连期间有 {n} 条新回答");
                        tokio::spawn(async move {
                            p.send_to_user(&uid, &crate::push::payload_for("turn_done", &name, &sid2, None, Some(&body))).await;
                        });
                    }
                }
            }
        }
```

前端对 `crew_gap` 的提示在 Task 12 的 labelMap 里加。

- [ ] **Step 6: 运行测试通过**

Run: `cargo test`
Expected: 全绿。

- [ ] **Step 7: Commit**

```bash
git add src/acp/crew_process.rs src/session_manager.rs
git commit -m "feat(G3): crew_last_mid catch-up on (re)connect + 30s slots poll, burst push collapse

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: 前端 `useAcpSocket` 话题 busy 语义

**Files:**
- Modify: `frontend/src/hooks/useAcpSocket.ts:57-71`（选项）、`:316-332`（`system`）、`:377-411`（`content_block`/`result`）
- Modify: `frontend/src/components/AcpChatView.tsx:22-50,58,119-126`（`crewTopics` prop 透传）
- Modify: `frontend/src/components/shell/AppShell.tsx:180`
- Modify: `frontend/src/lib/api/sessions.ts`（`SessionInfo` 追加 S5 字段的前端类型若 S5 未加：`crew_mode?: string; crew_agent?: string; crew_origin?: string`，以及本 task 的 `awaiting_input?: boolean`）
- Test: Create `frontend/src/components/__tests__/crewTopicsBusy.test.tsx`

**Interfaces:**
- Consumes: Task 8/10 事件 `system{subtype:'crew_busy', count}`、`system{subtype:'crew_ack'}`、`system{subtype:'crew_gap'}`、`replay_done.running`；S5 `SessionInfo.crew_mode`。
- Produces: `AcpSocketOptions.crewTopics?: boolean`；`AcpChatView` prop `crewTopics?: boolean`。

- [ ] **Step 1: 写失败测试**

```tsx
import { render, screen, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import AcpChatView from '../AcpChatView'
import { installFakeWebSocket } from '../../test/fakeWs'

describe('topics busy semantics (V7)', () => {
  const origWs = (globalThis as unknown as { WebSocket?: unknown }).WebSocket
  let ws: ReturnType<typeof installFakeWebSocket>
  beforeEach(() => {
    vi.restoreAllMocks()
    ws = installFakeWebSocket()
    globalThis.fetch = vi.fn(async () => new Response('{"runs":[],"lifetime":{"turns":0,"duration_ms":0,"cost_usd":0}}')) as unknown as typeof fetch
  })
  afterEach(() => { (globalThis as unknown as { WebSocket?: unknown }).WebSocket = origWs })
  const busyShown = () => screen.queryByText('中断') !== null
  const block = (kind: string, text: string, turn: number) => ({ type: 'content_block', block_type: 'text', text, summary: kind, turn_id: turn })

  it('crewTopics: content_block does not set busy; only crew_busy does; result does not clear it', () => {
    render(<AcpChatView sessionId="s1" active agentType="crew" crewTopics />)
    act(() => { ws.latest().emit(block('crew_result', '回答一', 1)) })
    expect(busyShown()).toBe(false)
    act(() => { ws.latest().emit({ type: 'system', subtype: 'crew_busy', count: 1 }) })
    expect(busyShown()).toBe(true)
    act(() => { ws.latest().emit({ type: 'result', text: '回答一', turn_id: 1 }) })
    expect(busyShown()).toBe(true)
    act(() => { ws.latest().emit({ type: 'system', subtype: 'crew_busy', count: 0 }) })
    expect(busyShown()).toBe(false)
    expect(screen.getByText('回答一')).toBeInTheDocument()
  })

  it('crewTopics: replay_done.running drives busy after reconnect', () => {
    render(<AcpChatView sessionId="s1" active agentType="crew" crewTopics />)
    act(() => { ws.latest().emit({ type: 'replay_done', running: true }) })
    expect(busyShown()).toBe(true)
  })

  it('crewTopics: exit still clears busy', () => {
    render(<AcpChatView sessionId="s1" active agentType="crew" crewTopics />)
    act(() => { ws.latest().emit({ type: 'system', subtype: 'crew_busy', count: 1 }) })
    act(() => { ws.latest().emit({ type: 'exit', code: -1 }) })
    expect(busyShown()).toBe(false)
  })

  it('crew_ack and crew_gap render as notices', () => {
    render(<AcpChatView sessionId="s1" active agentType="crew" crewTopics />)
    act(() => { ws.latest().emit({ type: 'system', subtype: 'crew_ack' }) })
    act(() => { ws.latest().emit({ type: 'system', subtype: 'crew_gap' }) })
    expect(screen.getByText('Crew 已接收')).toBeInTheDocument()
    expect(screen.getByText('断连期间可能有更早的回答，请在 Crew 中查看')).toBeInTheDocument()
  })

  it('normal crew session keeps the old content_block → busy behavior', () => {
    render(<AcpChatView sessionId="s1" active agentType="crew" />)
    act(() => { ws.latest().emit(block('', 'x', 1)) })
    expect(busyShown()).toBe(true)
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `cd frontend && npx vitest run src/components/__tests__/crewTopicsBusy.test.tsx`
Expected: FAIL。

- [ ] **Step 3: 实现**

`AcpSocketOptions` 追加：

```ts
  /** crew_mode==='crew' (S6 G3): busy comes ONLY from system{crew_busy} and replay_done.running. */
  crewTopics?: boolean
```

hook 开头 `const crewTopicsRef = useRef(!!o.crewTopics); useEffect(() => { crewTopicsRef.current = !!o.crewTopics }, [o.crewTopics])`。

`case 'system'`：在 `queued` 分支之后插入

```ts
        if (evt.subtype === 'crew_busy') {
          const on = (evt.count ?? 0) > 0
          setBusy(on)
          const t = Date.now()
          setTurnStartedMs(on ? (prev => prev ?? t) : null)
          if (on) { setNowMs(t); setLastEventMs(t) }
          break
        }
```

`labelMap` 追加 `crew_ack: 'Crew 已接收', crew_gap: '断连期间可能有更早的回答，请在 Crew 中查看',`（S5 G1 若已加 `crew_ack`，保留一处）。

`case 'content_block'`：`appendEvent(...)` 之后加 `if (crewTopicsRef.current) { setLastEventMs(Date.now()); break }`（话题回答仍刷新静默基线，但不动 busy/时钟）。`case 'result'`：`appendEvent(...)` 之后加

```ts
        if (crewTopicsRef.current) { bumpMetrics(); break }   // an answer group completes; busy is the Gateway's
```

（`activeTurnIdRef.current = null` 保持在最前。）

`AcpChatView`：Props 追加 `/** crew_mode==='crew' (S6 G3). */ crewTopics?: boolean`，解构并传 `useAcpSocket({ …, crewTopics })`。`AppShell.tsx:180` 的 `<AcpChatView …>` 追加 `crewTopics={s.crew_mode === 'crew'}`。

- [ ] **Step 4: 运行测试通过 + 回归**

Run: `cd frontend && npx vitest run src/components/__tests__/crewTopicsBusy.test.tsx src/components/__tests__/acpSocket.characterization.test.tsx src/components/__tests__/crewEventCases.test.tsx src/__tests__/App.characterization.test.tsx`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/hooks/useAcpSocket.ts frontend/src/components/AcpChatView.tsx frontend/src/components/shell/AppShell.tsx frontend/src/lib/api/sessions.ts frontend/src/components/__tests__/crewTopicsBusy.test.tsx
git commit -m "feat(G3): topics busy only from crew_busy/replay_done; crew_ack/crew_gap notices

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: 分诊 `ask` 档、「话题运行中」、回答卡与「并行话题」chip

**Files:**
- Modify: `frontend/src/lib/triage.ts:5,14,15,26-36,39-47,49-53`
- Modify: `frontend/src/components/shell/TriageRow.tsx:39,88-94,127-137`
- Modify: `frontend/src/components/turn/TurnView.tsx`、`TurnSummaryCard.tsx`（`crew_ask` 标签 + 「回答」）
- Modify: `frontend/src/components/AcpChatView.tsx`（`onAnswer` → 聚焦 composer）、`frontend/src/components/Composer.tsx`（`focusRef` prop）
- Modify: `frontend/src/components/shell/CommandPalette.tsx`（S5 G2 的 Crew 二级 SegmentedControl 追加「并行话题」选项；`lib/paletteParse.ts` 关键词 `crew:topics`）
- Test: `frontend/src/lib/__tests__/triage.test.ts`、`frontend/src/components/shell/__tests__/TriageList.test.tsx`、`frontend/src/components/turn/__tests__/TurnView.test.tsx`、`frontend/src/lib/__tests__/paletteParse.test.ts`

**Interfaces:**
- Consumes: Task 9 `SessionInfo.awaiting_input`；S5 `crew_mode`、`lib/crewVariant.ts` 的 `variantOf`、S5 `ParsedNew.crewVariant` 与 `CreateSessionReq.crew_mode`（S5 §7.2/§7.3）。
- Produces: `Attention` 增 `'ask'`；`LABELS.ask='待回答'`；`export const CREW_TOPICS_STOPPABLE: boolean`（`lib/triage.ts`，依 Task 8 前的 `/stop` 实测结果定值）；`TurnView` prop `onAnswer?: () => void`；`Composer` prop `focusRef?: React.RefObject<{ focus(): void } | null>`。

- [ ] **Step 1: 写失败测试**

`triage.test.ts` 追加：

```ts
describe('ask (S6 G3)', () => {
  it('awaiting_input → ask, same PRIORITY band as approval, label 待回答', () => {
    const a = s('a', { type: 'crew', awaiting_input: true, last_snippet: '部署到哪？' })
    expect(triage(a, ctx())).toBe('ask')
    expect(labelOf('ask')).toBe('待回答')
    expect(toneOf('ask')).toBe('attention')
    const g = groupTriage([s('d', { last_outcome: 'completed', last_outcome_ms: NOW - 1 }), a,
      s('p', { pending_approvals: 1, last_activity_ms: NOW - 5 })], ctx({ lastViewedMs: { d: 0 } }))
    expect(g.needsYou.map(i => i.attention)).toEqual(['approval', 'ask', 'done_unread'])
  })
  it('ask applies even to the active session (it needs an action)', () => {
    expect(triage(s('a', { type: 'crew', awaiting_input: true }), ctx({ activeId: 'a' }))).toBe('ask')
  })
  it('topics sessions are never stuck', () => {
    const t = s('t', { type: 'crew', crew_mode: 'crew', turn_state: 'running', last_activity_ms: NOW - 3_600_000 })
    expect(triage(t, ctx())).toBe('running')
  })
})
```

`TriageList.test.tsx` 追加：

```tsx
  it('ask row shows the question and no approve button; topics running row says 话题运行中', () => {
    setup([
      mkSession('q', { name: 'crew-q', type: 'crew', awaiting_input: true, last_snippet: '部署到 prod 吗？' }),
      mkSession('t', { name: 'crew-t', type: 'crew', crew_mode: 'crew', turn_state: 'running', turn_started_ms: NOW - 1000, last_activity_ms: NOW }),
    ])
    expect(screen.getByText('部署到 prod 吗？')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /批准/ })).toBeNull()
    expect(screen.getByText('话题运行中')).toBeInTheDocument()
  })
```

`TurnView.test.tsx` 追加：

```tsx
  it('crew_ask answer card shows 待你回答 and 回答 focuses the composer', () => {
    const ask = fold([{ type: 'content_block', block_type: 'text', text: '要部署到 prod 吗？', summary: 'crew_ask', turn_id: 3 },
      { type: 'result', text: '要部署到 prod 吗？', turn_id: 3 }])
    const onAnswer = vi.fn()
    render(<TurnView group={ask} agentName="Crew" onAnswer={onAnswer} />)
    expect(screen.getByText('待你回答')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '回答' }))
    expect(onAnswer).toHaveBeenCalled()
  })
```

`paletteParse.test.ts` 追加：

```ts
  it('crew:topics keyword selects the 并行话题 variant', () => {
    expect(parseNew('crew:topics ~/w 查一下').crewVariant).toBe('topics')
  })
```

- [ ] **Step 2: 运行，确认失败**

Run: `cd frontend && npx vitest run src/lib/__tests__/triage.test.ts src/components/shell/__tests__/TriageList.test.tsx src/components/turn/__tests__/TurnView.test.tsx src/lib/__tests__/paletteParse.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`triage.ts`：

```ts
export type Attention = 'error' | 'approval' | 'ask' | 'stuck' | 'confirm' | 'done_unread' | 'running' | 'idle' | 'ended'
export const NEEDS_YOU: ReadonlySet<Attention> = new Set(['error', 'approval', 'ask', 'stuck', 'confirm', 'done_unread'])
const PRIORITY: Record<Attention, number> = { error: 0, approval: 1, ask: 1, stuck: 2, confirm: 3, done_unread: 4, running: 5, idle: 6, ended: 7 }
/** Set from the /stop spike before S6-c (spec §3.2): false hides 中断 on topics sessions. */
export const CREW_TOPICS_STOPPABLE = true
```

`triage()`：`approval` 行之后插入 `if (s.awaiting_input) return 'ask'`；stuck 行改为 `if (running && s.crew_mode !== 'crew' && ctx.now - s.last_activity_ms > STUCK_SILENCE_MS) return 'stuck'`；`toneOf` 的 attention 分支加 `case 'ask':`；`LABELS` 加 `ask: '待回答'`。

`TriageRow.tsx:39` 改为：

```tsx
  const topicsRunning = s.crew_mode === 'crew' && s.turn_state === 'running'
  const second = attention === 'ask' ? (s.last_snippet ?? s.description)
    : topicsRunning ? '话题运行中'
    : (s.turn_state === 'running' ? (s.current_step ?? s.last_snippet) : s.last_snippet) ?? s.description
  const canInterrupt = agent && (attention === 'running' || attention === 'stuck') && (s.crew_mode !== 'crew' || CREW_TOPICS_STOPPABLE)
```

第二行渲染条件中的 `agent && (attention === 'running' || attention === 'stuck')`（中断按钮）改用 `canInterrupt`。`same()` 追加 `&& !!x.awaiting_input === !!y.awaiting_input && x.crew_mode === y.crew_mode`。

`TurnView`：Props 加 `onAnswer?: () => void`；`const isAsk = group.blocks.some(b => b.type === 'text' && b.summary === 'crew_ask')`；在 `steps.length > 0` 块内 agentName 行之后：

```tsx
          {isAsk && group.complete && (
            <div className="flex items-center gap-2">
              <span className="text-ui-xs font-medium text-[var(--attention)]">待你回答</span>
              {onAnswer && <button type="button" onClick={onAnswer} className="ctl px-2 text-ui-xs text-[var(--accent)]">回答</button>}
            </div>
          )}
```

memo 比较器追加 `&& a.onAnswer === b.onAnswer`。（纯文本回复 `summarisable=false` 仍全文渲染问题，符合预期。）

`Composer`：新增可选 `focusRef?: React.RefObject<{ focus(): void } | null>`，`useEffect(() => { if (focusRef) focusRef.current = { focus: () => inputRef.current?.focus() } }, [focusRef])`。`AcpChatView`：`const composerRef = useRef<{ focus(): void } | null>(null)`；`const onAnswer = useCallback(() => composerRef.current?.focus(), [])`；`<TurnView … onAnswer={agentType === 'crew' ? onAnswer : undefined} />`；`<Composer … focusRef={composerRef} />`。

`paletteParse.ts`：S5 G2 已把 `crew:goal` 映射为 `crewVariant: 'goal'`；在同一映射表追加 `'crew:topics' → 'topics'`。`CommandPalette.tsx`：S5 G2 的 Crew 二级 SegmentedControl options 由 `[{chat,'聊天'},{goal,'目标指挥'}]` 追加 `{ value: 'topics', label: '并行话题' }`；`submitNew` 中 S5 已把 `crewVariant` 转成 `crew_mode`/`crew_agent`，`topics` 映射为 `crew_mode: 'crew', crew_agent: ''`（在 S5 写的 variant→字段映射处追加这一臂）。

- [ ] **Step 4: 运行测试通过 + 全量**

Run: `cd frontend && npm test && npm run lint && npm run build`
Expected: 全绿；首屏增量（Task 12+13）≤ 0.5KB。

- [ ] **Step 5: Commit + 上线（S6-c）**

```bash
git add frontend/src
git commit -m "feat(G3): 待回答 triage band, 话题运行中, answer card, 并行话题 chip

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push
./deploy.sh --build
date -u +%F   # 这一天 = 门槛 T 起点，写进 S6 metrics 审计文档
```

退出标准：§3.8/§3.9 全绿；在生产开一个「并行话题」会话跑 40 分钟以上，`journalctl -u zeromux | grep -c TimeoutKill` 对该 sid 为 0（M4）；把上线日期写进 `docs/superpowers/audits/<日期>-s6-metrics.md` 作为门槛 T 起点。

---

# S6-d：T4 G7 + Crew cron 失败推送 + `snapshot()`，T4b G9 只读分段（同期上线）

### Task 14: `crew_watch` 快照类型、宽松解析、纯函数，以及 G7b 审批推送

**Files:**
- Create: `src/crew_watch.rs`
- Modify: `src/main.rs:1-25`（`mod crew_watch;`）
- Modify: `src/session_manager.rs:2051`（`record_and_broadcast` 返回 `bool`）、`:3693-3764`（`emit` 返回 `bool`）、Crew fan-out 非话题事件臂（`emit` 调用处）
- Test: `src/crew_watch.rs` `mod tests`、`src/session_manager.rs` `mod crew_topics_tests`

**Interfaces:**
- Consumes: Task 10 `maybe_push_ask`、`KindDebounce`。
- Produces（`crew_watch.rs`，后续 Task 15/16 与 S7 代理层只读使用）：
  - `pub struct CrewWatch { snap: std::sync::RwLock<Arc<SlotsSnapshot>> }`，`CrewWatch::new() -> Self`、`pub fn snapshot(&self) -> Arc<SlotsSnapshot>`、`pub(crate) fn replace(&self, s: SlotsSnapshot)`、`pub(crate) fn mark_failed(&self)`
  - `SlotsSnapshot { gateway_ok, refreshed_ms, slots: Vec<SlotView>, cron_jobs: Vec<CronJobView>, cron_runs: Vec<CronRunView>, cron_refreshed_ms, server_tz: Option<String> }`（`Clone, Default, Serialize`）
  - `SlotView`（spec §4.2 字段集）、`CronJobView { id, name, enabled, schedule, timezone, agent, agent_sequence_len: u32, channel, last_status, last_run_ts: Option<f64>, next_run_ts: Option<f64>, is_running, last_error: Option<String>(≤200), prompt_head: Option<String>(≤80) }`、`CronRunView { run_id, job_id, job_name, status, started_at: Option<f64>, finished_at: Option<f64>, duration_ms: Option<i64>, summary: Option<String>(≤300), error: Option<String>(≤300), trigger: Option<String> }`
  - `pub fn parse_slots(v: &Value) -> Vec<SlotView>`、`pub fn parse_cron_jobs(v: &Value) -> (Vec<CronJobView>, Option<String>)`、`pub fn parse_cron_runs(v: &Value) -> Vec<CronRunView>`
  - `pub fn slot_attention_edges(prev: &HashMap<String, bool>, slots: &[SlotView], own: &HashSet<String>) -> (HashMap<String, bool>, Vec<Edge>)`，`pub struct Edge { pub key: String, pub title: String, pub snippet: String }`
  - `pub fn cron_failures(seen: &mut SeenRuns, runs: &[CronRunView]) -> Vec<CronRunView>`，`pub struct SeenRuns`（cap 500）
  - `pub fn external_attention(snap: &SlotsSnapshot, own: &HashSet<String>) -> Vec<Edge>`
  - `pub fn job_id_ok(id: &str) -> bool`（`[A-Za-z0-9_-]{1,64}`）
  - session_manager：`fn record_and_broadcast(...) -> bool`（本次是否**新增**了 approval id）、`fn emit(...) -> bool`

- [ ] **Step 1: 写失败测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn slot(key: &str, needs: bool, appr: bool, waiting: bool) -> serde_json::Value {
        json!({"key":key,"title":format!("T-{key}"),"agent":"kirocrew","mode":"","running":false,"orchestrating":false,
               "queue_depth":0,"subagents_running":false,"needs_input":needs,"pending_approval":appr,
               "pending_approval_info": if appr { json!({"tool":"rm -rf build"}) } else { json!(null) },
               "waiting_for_input":waiting,"last_message":"第一行\n第二行","created_by":"","origin":"weixin",
               "secret_env":{"K":"v"}})
    }

    #[test]
    fn parse_slots_is_lenient_and_normalizes() {
        let v = json!([slot("a", false, false, true), {"key":"b"}, 7, {"no_key":1}]);
        let s = parse_slots(&v);
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].last_message_head.as_deref(), Some("第一行"));
        assert_eq!(s[0].created_by, None, "empty created_by → None");
        assert!(!s[1].needs_input && s[1].title.is_none());
        assert!(parse_slots(&json!({"x":1})).is_empty());
    }

    #[test]
    fn waiting_for_input_alone_never_wakes() {
        let s = parse_slots(&json!([slot("wx", false, false, true)]));
        let (_, e) = slot_attention_edges(&HashMap::new(), &s, &HashSet::new());
        assert!(e.is_empty());
    }

    #[test]
    fn rising_edge_only_and_own_slots_skipped() {
        let own: HashSet<String> = ["zmx-1".to_string()].into();
        let s1 = parse_slots(&json!([slot("wx", true, false, true), slot("zmx-1", true, false, false)]));
        let (p1, e1) = slot_attention_edges(&HashMap::new(), &s1, &own);
        assert_eq!(e1.iter().map(|e| e.key.as_str()).collect::<Vec<_>>(), vec!["wx"]);
        let (p2, e2) = slot_attention_edges(&p1, &s1, &own);
        assert!(e2.is_empty(), "still true → no edge");
        let s3 = parse_slots(&json!([slot("wx", false, false, true)]));
        let (p3, _) = slot_attention_edges(&p2, &s3, &own);
        let (_, e4) = slot_attention_edges(&p3, &s1, &own);
        assert_eq!(e4.len(), 1, "false→true again");
    }

    #[test]
    fn approval_edge_snippet_prefers_tool() {
        let s = parse_slots(&json!([slot("wx", false, true, false)]));
        let (_, e) = slot_attention_edges(&HashMap::new(), &s, &HashSet::new());
        assert_eq!(e[0].snippet, "rm -rf build");
    }

    fn run(id: &str, status: &str) -> serde_json::Value {
        json!({"run_id":id,"job_id":"j1","job_name":"晨报","status":status,"started_at":1.0,"finished_at":2.0,"error":"boom\nstack"})
    }

    #[test]
    fn cron_failures_failure_and_timeout_only_once() {
        let mut seen = SeenRuns::default();
        let runs = parse_cron_runs(&json!({"runs":[run("r1","failure"), run("r2","timeout"), run("r3","cancelled"), run("r4","success")]}));
        let f = cron_failures(&mut seen, &runs);
        assert_eq!(f.iter().map(|r| r.run_id.as_str()).collect::<Vec<_>>(), vec!["r1", "r2"]);
        assert!(cron_failures(&mut seen, &runs).is_empty());
    }

    #[test]
    fn seen_runs_is_capped() {
        let mut seen = SeenRuns::default();
        for i in 0..600 { seen.insert(&format!("r{i}")); }
        assert!(seen.len() <= 500);
    }

    #[test]
    fn cron_job_view_drops_secrets_and_truncates() {
        let (jobs, tz) = parse_cron_jobs(&json!({"server_tz":"Asia/Shanghai","jobs":[
            {"id":"j1","name":"晨报","message":"总结昨天\n细节","enabled":true,"schedule":"0 8 * * *","secret_env":{"T":"x"},
             "script":"curl evil","command":"rm","last_result":"LONG","last_error":"e".repeat(500),"agent_sequence":["a","b"]},
            7, {"name":"no id"}]}));
        assert_eq!(tz.as_deref(), Some("Asia/Shanghai"));
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].prompt_head.as_deref(), Some("总结昨天"));
        assert_eq!(jobs[0].last_error.as_ref().unwrap().chars().count(), 200);
        assert_eq!(jobs[0].agent_sequence_len, 2);
        let ser = serde_json::to_string(&SlotsSnapshot { cron_jobs: jobs, slots: parse_slots(&json!([slot("a", false, false, false)])), ..Default::default() }).unwrap();
        for bad in ["secret", "script", "command", "last_result"] { assert!(!ser.contains(bad), "{bad} leaked: {ser}"); }
    }

    #[test]
    fn snapshot_read_during_replace_keeps_old_arc_intact() {
        let w = CrewWatch::new();
        assert!(!w.snapshot().gateway_ok);
        w.replace(SlotsSnapshot { gateway_ok: true, refreshed_ms: Some(1), ..Default::default() });
        let held = w.snapshot();
        w.replace(SlotsSnapshot { gateway_ok: true, refreshed_ms: Some(2), ..Default::default() });
        assert_eq!(held.refreshed_ms, Some(1));
        assert_eq!(w.snapshot().refreshed_ms, Some(2));
    }

    #[test]
    fn failed_round_keeps_previous_data() {
        let w = CrewWatch::new();
        w.replace(SlotsSnapshot { gateway_ok: true, refreshed_ms: Some(5), slots: parse_slots(&json!([slot("a", true, false, false)])), ..Default::default() });
        w.mark_failed();
        let s = w.snapshot();
        assert!(!s.gateway_ok);
        assert_eq!((s.refreshed_ms, s.slots.len()), (Some(5), 1));
    }

    #[test]
    fn external_attention_excludes_own_and_quiet_slots() {
        let snap = SlotsSnapshot { gateway_ok: true, slots: parse_slots(&json!([slot("wx", true, false, false), slot("zmx-1", true, false, false), slot("c", false, false, true)])), ..Default::default() };
        let own: HashSet<String> = ["zmx-1".to_string()].into();
        assert_eq!(external_attention(&snap, &own).iter().map(|e| e.key.as_str()).collect::<Vec<_>>(), vec!["wx"]);
    }

    #[test]
    fn job_id_whitelist() {
        assert!(job_id_ok("cron-daily_01"));
        for bad in ["", "../x", "a/b", &"a".repeat(65), "a b"] { assert!(!job_id_ok(bad), "{bad}"); }
    }
}
```

`mod crew_topics_tests` 追加（G7b）：

```rust
    #[test]
    fn record_and_broadcast_reports_only_a_new_approval_id() {
        let (m, _d) = mgr(vec![topics_session("t", false)]);
        let ap = |id: &str| posture_delta_of(&AcpEvent::Approval { id: id.into(), tool: "rm".into(), tool_input: None, tool_purpose: None, slot: "zmx-k".into() });
        assert!(m.record_and_broadcast("t", "{}".into(), true, ap("a1")));
        assert!(!m.record_and_broadcast("t", "{}".into(), true, ap("a1")), "same id twice → no second push");
        assert!(m.record_and_broadcast("t", "{}".into(), true, ap("a2")));
        assert!(!m.record_and_broadcast("t", "{}".into(), true, None));
    }
```

- [ ] **Step 2: 运行，确认失败**

Run: `cargo test --lib crew_watch && cargo test --lib crew_topics_tests::record_and_broadcast_reports_only_a_new_approval_id`
Expected: 编译失败。

- [ ] **Step 3: 实现 `src/crew_watch.rs`（类型 + 解析 + 纯函数）**

```rust
//! Gateway slot / cron watcher (S6 T4). The ONLY writer of the Gateway snapshot;
//! G7 away card, G9 and S7's proxy layer read it through `snapshot()` (spec §4.2, V19).
//! Never holds a session process, never sends a session input.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, RwLock};
use serde_json::Value;

fn s_opt(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(|x| x.as_str()).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}
fn b(v: &Value, k: &str) -> bool { v.get(k).and_then(|x| x.as_bool()).unwrap_or(false) }
fn f64o(v: &Value, k: &str) -> Option<f64> { v.get(k).and_then(|x| x.as_f64()) }
fn cap(s: Option<String>, n: usize) -> Option<String> { s.map(|x| x.chars().take(n).collect()) }
fn head(s: Option<String>, n: usize) -> Option<String> {
    cap(s.and_then(|x| x.lines().map(str::trim).find(|l| !l.is_empty()).map(str::to_string)), n)
}

#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct SlotView {
    pub key: String,
    pub title: Option<String>,
    pub agent: Option<String>,
    pub mode: Option<String>,
    pub project: Option<String>,
    pub origin: Option<String>,
    pub created_by: Option<String>,
    pub running: bool,
    pub orchestrating: bool,
    pub subagents_running: bool,
    pub queue_depth: u32,
    pub needs_input: bool,
    pub pending_approval: bool,
    pub pending_approval_tool: Option<String>,
    pub last_message_head: Option<String>,
    pub last_activity_ts: Option<f64>,
}

#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct CronJobView {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub schedule: Option<String>,
    pub timezone: Option<String>,
    pub agent: Option<String>,
    pub agent_sequence_len: u32,
    pub channel: Option<String>,
    pub last_status: Option<String>,
    pub last_run_ts: Option<f64>,
    pub next_run_ts: Option<f64>,
    pub is_running: bool,
    pub last_error: Option<String>,
    pub prompt_head: Option<String>,
}

#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct CronRunView {
    pub run_id: String,
    pub job_id: String,
    pub job_name: Option<String>,
    pub status: String,
    pub started_at: Option<f64>,
    pub finished_at: Option<f64>,
    pub duration_ms: Option<i64>,
    pub summary: Option<String>,
    pub error: Option<String>,
    pub trigger: Option<String>,
}

#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct SlotsSnapshot {
    pub gateway_ok: bool,
    pub refreshed_ms: Option<i64>,
    pub slots: Vec<SlotView>,
    pub cron_jobs: Vec<CronJobView>,
    pub cron_runs: Vec<CronRunView>,
    pub cron_refreshed_ms: Option<i64>,
    pub server_tz: Option<String>,
}

pub struct CrewWatch { snap: RwLock<Arc<SlotsSnapshot>> }

impl CrewWatch {
    pub fn new() -> Self { Self { snap: RwLock::new(Arc::new(SlotsSnapshot::default())) } }
    /// Read-only; never blocks on I/O (clones an Arc).
    pub fn snapshot(&self) -> Arc<SlotsSnapshot> { self.snap.read().unwrap().clone() }
    pub(crate) fn replace(&self, s: SlotsSnapshot) { *self.snap.write().unwrap() = Arc::new(s); }
    /// A failed round keeps the last data + refreshed_ms; consumers judge freshness.
    pub(crate) fn mark_failed(&self) {
        let mut g = self.snap.write().unwrap();
        if g.gateway_ok { let mut s = (**g).clone(); s.gateway_ok = false; *g = Arc::new(s); }
    }
}

pub fn parse_slots(v: &Value) -> Vec<SlotView> {
    let Some(arr) = v.as_array() else { return vec![] };
    arr.iter().filter_map(|x| {
        let key = s_opt(x, "key")?;
        Some(SlotView {
            key, title: s_opt(x, "title"), agent: s_opt(x, "agent"), mode: x.get("mode").and_then(|m| m.as_str()).map(str::to_string),
            project: s_opt(x, "project"), origin: s_opt(x, "origin"), created_by: s_opt(x, "created_by"),
            running: b(x, "running"), orchestrating: b(x, "orchestrating"), subagents_running: b(x, "subagents_running"),
            queue_depth: x.get("queue_depth").and_then(|q| q.as_u64()).unwrap_or(0) as u32,
            needs_input: b(x, "needs_input"), pending_approval: b(x, "pending_approval"),
            pending_approval_tool: x.get("pending_approval_info").and_then(|i| s_opt(i, "tool")),
            last_message_head: head(s_opt(x, "last_message"), 120),
            last_activity_ts: f64o(x, "last_activity_ts"),
        })
    }).collect()
}

pub fn parse_cron_jobs(v: &Value) -> (Vec<CronJobView>, Option<String>) {
    let jobs = v.get("jobs").and_then(|j| j.as_array()).map(|arr| arr.iter().filter_map(|x| {
        Some(CronJobView {
            id: s_opt(x, "id")?, name: s_opt(x, "name").unwrap_or_default(), enabled: b(x, "enabled"),
            schedule: s_opt(x, "schedule").or_else(|| s_opt(x, "cron_expr")), timezone: s_opt(x, "timezone"),
            agent: s_opt(x, "agent"),
            agent_sequence_len: x.get("agent_sequence").and_then(|a| a.as_array()).map(|a| a.len() as u32).unwrap_or(0),
            channel: s_opt(x, "channel"), last_status: s_opt(x, "last_status"),
            last_run_ts: f64o(x, "last_run_ts"), next_run_ts: f64o(x, "next_run_ts"), is_running: b(x, "is_running"),
            last_error: cap(s_opt(x, "last_error"), 200), prompt_head: head(s_opt(x, "message"), 80),
            // secret_env* / script / command / last_result are never read (spec §13.2)
        })
    }).collect()).unwrap_or_default();
    (jobs, s_opt(v, "server_tz"))
}

pub fn parse_cron_runs(v: &Value) -> Vec<CronRunView> {
    v.get("runs").and_then(|r| r.as_array()).map(|arr| arr.iter().filter_map(|x| Some(CronRunView {
        run_id: s_opt(x, "run_id")?, job_id: s_opt(x, "job_id").unwrap_or_default(), job_name: s_opt(x, "job_name"),
        status: s_opt(x, "status").unwrap_or_default(), started_at: f64o(x, "started_at"), finished_at: f64o(x, "finished_at"),
        duration_ms: x.get("duration_ms").and_then(|d| d.as_i64()),
        summary: cap(s_opt(x, "summary"), 300), error: cap(s_opt(x, "error"), 300), trigger: s_opt(x, "trigger"),
    })).collect()).unwrap_or_default()
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct Edge { pub key: String, pub title: String, pub snippet: String }

fn attn(s: &SlotView) -> bool { s.needs_input || s.pending_approval }
fn edge_of(s: &SlotView) -> Edge {
    let snip = s.pending_approval_tool.clone().or_else(|| s.last_message_head.clone()).unwrap_or_default();
    Edge { key: s.key.clone(), title: s.title.clone().unwrap_or_else(|| s.key.clone()), snippet: snip.chars().take(100).collect() }
}

/// false→true of (needs_input || pending_approval) for slots NOT owned by a zeromux session.
pub fn slot_attention_edges(prev: &HashMap<String, bool>, slots: &[SlotView], own: &HashSet<String>)
    -> (HashMap<String, bool>, Vec<Edge>) {
    let mut next = HashMap::new();
    let mut edges = vec![];
    for s in slots.iter().filter(|s| !own.contains(&s.key)) {
        let a = attn(s);
        if a && !prev.get(&s.key).copied().unwrap_or(false) { edges.push(edge_of(s)); }
        next.insert(s.key.clone(), a);
    }
    (next, edges)
}

pub fn external_attention(snap: &SlotsSnapshot, own: &HashSet<String>) -> Vec<Edge> {
    snap.slots.iter().filter(|s| !own.contains(&s.key) && attn(s)).map(edge_of).collect()
}

const SEEN_RUNS_CAP: usize = 500;
#[derive(Default)]
pub struct SeenRuns { order: VecDeque<String>, set: HashSet<String> }
impl SeenRuns {
    pub fn insert(&mut self, id: &str) -> bool {
        if !self.set.insert(id.to_string()) { return false; }
        self.order.push_back(id.to_string());
        while self.order.len() > SEEN_RUNS_CAP { if let Some(o) = self.order.pop_front() { self.set.remove(&o); } }
        true
    }
    pub fn len(&self) -> usize { self.order.len() }
}

/// New failure|timeout runs (cancelled is a human action, not a failure).
pub fn cron_failures(seen: &mut SeenRuns, runs: &[CronRunView]) -> Vec<CronRunView> {
    runs.iter().filter(|r| seen.insert(&r.run_id) && matches!(r.status.as_str(), "failure" | "timeout")).cloned().collect()
}

pub fn job_id_ok(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
```

注意 `cron_failures` 先 `insert` 再判状态：非失败的 run 也要进 seen，否则之后不会重复处理（它们本就不推），行为一致。

`src/main.rs` 在 `mod crew_memory;` 后加 `mod crew_watch;`（主循环在 Task 15 接线；本 task 在 `crew_watch.rs` 第一行加 `#![allow(dead_code)]`（仅限本模块），Task 15 删除）。

- [ ] **Step 4: 实现 G7b 返回值**

`record_and_broadcast` 签名改为 `-> bool`，函数体：`let mut added = false;` …`if let Some(d) = delta { added = matches!(&d, PostureDelta::ApprovalAdded(id) if !s.posture.approval_ids.contains(id)); apply_posture_delta(&mut s.posture, d); }` … 结尾 `added`（session 不存在时返回 `false`）。`emit` 签名改为 `-> bool`：ephemeral 与 manager-gone 分支返回 `false`，`record_and_broadcast` 分支返回其结果；`serde_json::to_string` 失败提前 `return false`。现有调用点忽略返回值无需改动（`bool` 非 `#[must_use]`）；测试里直接调用 `record_and_broadcast` 的 5 处（`:6004,6027,6048,6056,7193-7205`）写成 `let _ = m.record_and_broadcast(...)` 或保持语句形式均可编译。

Crew fan-out 普通模式的 `emit(&mgr, &sid, &event_tx, turn_seq, &evt);`（`:3934`）改为：

```rust
                            let new_approval = emit(&mgr, &sid, &event_tx, turn_seq, &evt);
                            // G7b (scope addition, V18): zeromux never pushed for approvals.
                            // Crew only this round; other backends ignore emit's return.
                            if new_approval {
                                if let AcpEvent::Approval { tool, tool_purpose, .. } = &evt {
                                    maybe_push_ask(&mgr, &sid, &owner_id, "approval", tool_purpose.clone().unwrap_or_else(|| tool.clone()));
                                }
                            }
```

- [ ] **Step 5: 运行测试通过**

Run: `cargo test`
Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add src/crew_watch.rs src/main.rs src/session_manager.rs
git commit -m "feat(G7): crew_watch snapshot types + lenient parse + edge/failure fns; G7b approval push

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: crew_watch 主循环、外部 slot / cron 推送、推送深链、重启拉起话题会话、离开卡 Crew 行

**Files:**
- Modify: `src/crew_watch.rs`（`spawn`、`round`、`backoff_ms`、推送、`GET /api/crew/attention` handler）
- Modify: `src/main.rs:193-226`（`AppState.crew_watch`）、`:513-552`（构造）、`:572` 之后（`crew_watch::spawn`）
- Modify: `src/push.rs:324-330`（`PushPayload.url`）及所有构造点（`payload_for`、`confirm_batch_payload`）
- Modify: `src/session_manager.rs`（`crew_slot_keys()`、`topics_sessions_to_revive()`、`admin_or_legacy_recipients` 由 web 侧提供）
- Modify: `src/web.rs`（路由 `/api/crew/attention`）
- Modify: `frontend/public/sw.js:31-51`、`frontend/src/components/shell/useSessionsPoll.ts:124-148`、`frontend/src/components/shell/AppShell.tsx`（深链回调）、S5 `frontend/src/components/shell/AwayCard.tsx`（Crew 行）
- Create: `frontend/src/lib/api/crew.ts`、`frontend/src/lib/pushLink.ts`
- Test: `src/crew_watch.rs` `mod tests`、`src/push.rs` `mod tests`、`src/session_manager.rs` `mod crew_topics_tests`、Create `frontend/src/lib/__tests__/pushLink.test.ts`、`frontend/src/components/shell/__tests__/AwayCard.crew.test.tsx`

**Interfaces:**
- Consumes: Task 14 全部；Task 10 `KindDebounce`/`ASK_DEBOUNCE_MS`；**S5 U4** `payload_for(..., body)`；**S5 F3** `AwayCard` 组件与 `summarizeAway` 的行排序（本 task 只追加一行，遵守 ≤3 行 +「更多 (N)」）。
- Produces:
  - `PushPayload.url: Option<String>`（`skip_serializing_if = "Option::is_none"`）；`pub fn with_url(mut self, url: String) -> PushPayload`
  - `crew_watch::spawn(state: Arc<AppState>)`；`pub fn backoff_ms(fails: u32) -> u64`；`pub fn cron_failure_url(job_id: &str) -> String`
  - `SessionManager::crew_slot_keys(&self) -> HashSet<String>`、`SessionManager::topics_sessions_to_revive(&self) -> Vec<String>`
  - HTTP：`GET /api/crew/attention`（admin）→ `{items:[{key,title,snippet}], gateway_ok, refreshed_ms}`
  - 前端：`getCrewAttention()`；`parsePushLink(search: string): { session?: string; panel?: 'scheduled' | 'away'; seg?: 'crew'; job?: string; crew?: boolean } | null`；`AwayCard` prop `crew?: { items: {key:string;title:string;snippet:string}[] } | null`

- [ ] **Step 1: 写失败测试（后端）**

`crew_watch.rs` `mod tests` 追加：

```rust
    #[test]
    fn backoff_doubles_from_30s_and_caps_at_5min() {
        assert_eq!(backoff_ms(0), 30_000);
        assert_eq!(backoff_ms(1), 60_000);
        assert_eq!(backoff_ms(3), 240_000);
        assert_eq!(backoff_ms(10), 300_000);
    }

    #[test]
    fn external_push_body_ends_with_where_to_answer_and_url_is_constant() {
        let e = Edge { key: "wx".into(), title: "微信".into(), snippet: "要订哪天？".into() };
        let p = external_payload(&e);
        assert_eq!(p.kind, "ask");
        assert!(p.title.contains("Crew · 微信"));
        assert!(p.body.ends_with(" · 在 Crew/微信回答"), "{}", p.body);
        assert_eq!(p.url.as_deref(), Some("/?panel=away&crew=1"));
    }

    #[test]
    fn cron_failure_payload_deeplinks_to_g9_segment() {
        let r = CronRunView { run_id: "r".into(), job_id: "j_1".into(), job_name: Some("晨报".into()), status: "failure".into(),
                              error: Some("boom\nstack".into()), ..Default::default() };
        let p = cron_payload(&r).unwrap();
        assert_eq!(p.kind, "run_failed");
        assert_eq!(p.body, "boom");
        assert_eq!(p.url.as_deref(), Some("/?panel=scheduled&seg=crew&job=j_1"));
        let bad = CronRunView { job_id: "../x".into(), ..r };
        assert_eq!(cron_payload(&bad).unwrap().url.as_deref(), Some("/?panel=scheduled&seg=crew"), "unsafe job id dropped");
    }

    #[test]
    fn first_round_seeds_silently() {
        let mut st = WatchState::default();
        let slots = parse_slots(&json!([slot("wx", true, false, false)]));
        let runs = parse_cron_runs(&json!({"runs":[run("r1","failure")]}));
        let (e, f) = st.diff(&slots, &runs, &HashSet::new());
        assert!(e.is_empty() && f.is_empty(), "no pushes on the startup round (D11)");
        let slots2 = parse_slots(&json!([slot("wx", false, false, false)]));
        let _ = st.diff(&slots2, &runs, &HashSet::new());
        let (e3, f3) = st.diff(&slots, &parse_cron_runs(&json!({"runs":[run("r1","failure"), run("r2","timeout")]})), &HashSet::new());
        assert_eq!(e3.len(), 1);
        assert_eq!(f3.iter().map(|r| r.run_id.as_str()).collect::<Vec<_>>(), vec!["r2"]);
    }

    #[tokio::test]
    async fn hung_gateway_round_times_out() {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move { let _keep = l.accept().await; tokio::time::sleep(std::time::Duration::from_secs(60)).await; });
        let http = reqwest::Client::new();
        let t = std::time::Instant::now();
        let r = fetch_round(&http, &format!("http://127.0.0.1:{port}"), "s", false, std::time::Duration::from_millis(300)).await;
        assert!(r.is_none());
        assert!(t.elapsed() < std::time::Duration::from_secs(2));
    }
```

`push.rs` `mod tests` 追加：

```rust
    #[test]
    fn url_is_optional_on_the_wire() {
        let p = payload_for("turn_done", "a", "s", None, None);
        assert!(!serde_json::to_string(&p).unwrap().contains("url"));
        let q = p.with_url("/?panel=away&crew=1".into());
        assert!(serde_json::to_string(&q).unwrap().contains("\"url\":\"/?panel=away&crew=1\""));
    }
```

`mod crew_topics_tests` 追加：

```rust
    #[test]
    fn own_slot_keys_and_revive_list() {
        let mut idle = topics_session("idle", true); idle.running = None;
        let mut chat = topics_session("chat", false); chat.running = None;
        let (m, _d) = mgr(vec![topics_session("live", true), idle, chat]);
        assert!(m.crew_slot_keys().contains("zmx-k"));
        assert_eq!(m.topics_sessions_to_revive(), vec!["idle".to_string()]);
    }
```

- [ ] **Step 2: 运行，确认失败**

Run: `cargo test --lib crew_watch && cargo test --lib push::tests::url_is_optional_on_the_wire && cargo test --lib crew_topics_tests::own_slot_keys_and_revive_list`
Expected: 编译失败。

- [ ] **Step 3: 实现 push `url`**

`PushPayload` 追加 `#[serde(default, skip_serializing_if = "Option::is_none")] pub url: Option<String>,`；`payload_for` 与 `confirm_batch_payload` 构造处加 `url: None,`；

```rust
impl PushPayload {
    /// Only server-built constants go here (job ids pass crew_watch::job_id_ok first).
    pub fn with_url(mut self, url: String) -> Self { self.url = Some(url); self }
}
```

- [ ] **Step 4: 实现 manager 访问器**

```rust
    /// Slot keys owned by zeromux Crew sessions: their attention is handled by their own fan-out.
    pub fn crew_slot_keys(&self) -> std::collections::HashSet<String> {
        self.sessions.lock().unwrap().values().filter_map(|s| match &s.resume_token {
            Some(ResumeToken::Crew(k)) if !k.is_empty() => Some(k.clone()), _ => None }).collect()
    }

    /// §3.9: after a restart nobody may open the browser; topics sessions must still listen.
    pub fn topics_sessions_to_revive(&self) -> Vec<String> {
        self.sessions.lock().unwrap().values()
            .filter(|s| s.running.is_none() && s.pending_kill_until.is_none()
                && s.crew.as_ref().map(|c| c.mode == "crew").unwrap_or(false))
            .map(|s| s.id.clone()).collect()
    }
```

- [ ] **Step 5: 实现 crew_watch 循环（删除 Task 14 的 `#![allow(dead_code)]`）**

```rust
use crate::acp::crew_process::read_gateway_secret;

const ROUND_EVERY: std::time::Duration = std::time::Duration::from_secs(30);
const ROUND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
const JOBS_EVERY_N: u32 = 5;
const CRON_PUSH_WINDOW_MS: i64 = 30 * 60_000;

pub fn backoff_ms(fails: u32) -> u64 { (30_000u64 << fails.min(4)).min(300_000) }

pub fn cron_failure_url(job_id: &str) -> String {
    if job_id_ok(job_id) { format!("/?panel=scheduled&seg=crew&job={job_id}") } else { "/?panel=scheduled&seg=crew".into() }
}

fn external_payload(e: &Edge) -> crate::push::PushPayload {
    let body = format!("{} · 在 Crew/微信回答", e.snippet);
    crate::push::payload_for("ask", &format!("Crew · {}", e.title), "", None, Some(&body)).with_url("/?panel=away&crew=1".into())
}

fn cron_payload(r: &CronRunView) -> Option<crate::push::PushPayload> {
    let name = format!("Crew 定时 · {}", r.job_name.clone().unwrap_or_else(|| r.job_id.clone()));
    let body: String = head(r.error.clone(), 120).unwrap_or_default();
    Some(crate::push::payload_for("run_failed", &name, "", None, (!body.is_empty()).then_some(body.as_str()))
        .with_url(cron_failure_url(&r.job_id)))
}

#[derive(Default)]
pub(crate) struct WatchState { seeded: bool, prev: HashMap<String, bool>, seen: SeenRuns }
impl WatchState {
    pub(crate) fn diff(&mut self, slots: &[SlotView], runs: &[CronRunView], own: &HashSet<String>) -> (Vec<Edge>, Vec<CronRunView>) {
        let (next, edges) = slot_attention_edges(&self.prev, slots, own);
        self.prev = next;
        let fails = cron_failures(&mut self.seen, runs);
        if !self.seeded { self.seeded = true; return (vec![], vec![]); }   // D11: startup seeds silently
        (edges, fails)
    }
}

pub(crate) struct Round { slots: Vec<SlotView>, runs: Vec<CronRunView>, jobs: Option<(Vec<CronJobView>, Option<String>)> }

async fn get(http: &reqwest::Client, base: &str, secret: &str, path: &str) -> Option<Value> {
    let r = http.get(format!("{base}{path}")).header("X-Internal-Secret", secret).send().await.ok()?;
    if !r.status().is_success() { return None; }
    r.json().await.ok()
}

pub(crate) async fn fetch_round(http: &reqwest::Client, base: &str, secret: &str, with_jobs: bool,
                                budget: std::time::Duration) -> Option<Round> {
    tokio::time::timeout(budget, async {
        let (slots, runs) = tokio::join!(get(http, base, secret, "/api/chat/slots"),
                                         get(http, base, secret, "/api/crons/history?limit=20"));
        let slots = parse_slots(&slots?);
        let runs = runs.map(|v| parse_cron_runs(&v)).unwrap_or_default();
        let jobs = if with_jobs { get(http, base, secret, "/api/crons").await.map(|v| parse_cron_jobs(&v)) } else { None };
        Some(Round { slots, runs, jobs })
    }).await.ok().flatten()
}

/// Recipients (D8): legacy → "legacy"; OAuth → every active admin.
fn recipients(state: &crate::AppState) -> Vec<String> {
    match &state.db {
        None => vec!["legacy".into()],
        Some(db) => db.list_users().unwrap_or_default().into_iter()
            .filter(|u| u.role == "admin" && u.status == "active").map(|u| u.id).collect(),
    }
}

pub fn spawn(state: Arc<crate::AppState>) {
    tokio::spawn(async move {
        loop {   // panic supervisor (mirror spawn_scheduler)
            let st = state.clone();
            let inner = tokio::spawn(async move { run_loop(st).await });
            if inner.await.is_ok() { break; }
            tracing::error!("crew_watch panicked; respawning");
            tokio::time::sleep(ROUND_EVERY).await;
        }
    });
}

async fn run_loop(state: Arc<crate::AppState>) {
    let Ok(http) = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build() else { return };
    let base = format!("http://127.0.0.1:{}", state.crew_port);
    let home = std::path::PathBuf::from(&state.crew_home);
    let mut ws = WatchState::default();
    let mut cron_last: HashMap<String, i64> = HashMap::new();
    let (mut fails, mut n, mut revived) = (0u32, 0u32, false);
    loop {
        if !revived {
            revived = true;
            for id in state.sessions.topics_sessions_to_revive() {
                let m = state.sessions.clone();
                if let Err(e) = tokio::time::timeout(std::time::Duration::from_secs(5), m.ensure_running(&id)).await
                    .unwrap_or_else(|_| Err("timeout".into())) {
                    tracing::warn!("revive topics session {} failed: {}", id, e);
                }
            }
        }
        let secret = read_gateway_secret(&home, state.crew_port).ok();
        let with_jobs = n % JOBS_EVERY_N == 0;
        let round = match &secret { Some(s) => fetch_round(&http, &base, s, with_jobs, ROUND_TIMEOUT).await, None => None };
        n = n.wrapping_add(1);
        let Some(r) = round else {
            state.crew_watch.mark_failed();
            tracing::debug!("crew_watch: gateway round failed ({fails})");
            tokio::time::sleep(std::time::Duration::from_millis(backoff_ms(fails))).await;
            fails = fails.saturating_add(1);
            continue;
        };
        fails = 0;
        let now = crate::session_manager::now_millis();
        let prev = state.crew_watch.snapshot();
        let (jobs, tz, jobs_ms) = match r.jobs { Some((j, tz)) => (j, tz, Some(now)), None => (prev.cron_jobs.clone(), prev.server_tz.clone(), prev.cron_refreshed_ms) };
        let own = state.sessions.crew_slot_keys();
        let (edges, cron_fails) = ws.diff(&r.slots, &r.runs, &own);
        state.crew_watch.replace(SlotsSnapshot { gateway_ok: true, refreshed_ms: Some(now), slots: r.slots,
            cron_jobs: jobs, cron_runs: r.runs, cron_refreshed_ms: jobs_ms, server_tz: tz });
        if let Some(push) = state.push.clone() {
            let to = recipients(&state);
            for e in &edges {
                for u in &to {
                    if push.kind_debounce.claim(u, &format!("crew:{}", e.key), "ask", now, crate::push::ASK_DEBOUNCE_MS) {
                        let _ = tokio::time::timeout(std::time::Duration::from_secs(10), push.send_to_user(u, &external_payload(e))).await;
                    }
                }
            }
            for f in &cron_fails {
                if cron_last.get(&f.job_id).is_some_and(|t| now - t < CRON_PUSH_WINDOW_MS) { continue; }
                cron_last.insert(f.job_id.clone(), now);
                if let Some(p) = cron_payload(f) {
                    for u in &to { let _ = tokio::time::timeout(std::time::Duration::from_secs(10), push.send_to_user(u, &p)).await; }
                }
            }
        }
        tokio::time::sleep(ROUND_EVERY).await;
    }
}

/// GET /api/crew/attention — admin; external slots needing you, for the away card.
pub async fn get_attention(
    axum::extract::State(state): axum::extract::State<Arc<crate::AppState>>,
    user: axum::Extension<crate::auth::CurrentUser>,
) -> Result<axum::Json<Value>, axum::http::StatusCode> {
    if !user.is_admin() { return Err(axum::http::StatusCode::FORBIDDEN); }
    let snap = state.crew_watch.snapshot();
    let items = external_attention(&snap, &state.sessions.crew_slot_keys());
    Ok(axum::Json(serde_json::json!({ "items": items, "gateway_ok": snap.gateway_ok, "refreshed_ms": snap.refreshed_ms })))
}
```

`main.rs`：`AppState` 加 `pub crew_watch: Arc<crew_watch::CrewWatch>,`，构造 `crew_watch: Arc::new(crew_watch::CrewWatch::new()),`；在 `scheduled_tasks::spawn_scheduler(...)` 之后加 `crew_watch::spawn(state.clone());`。`web.rs` 路由在 crew memory 之后加 `.route("/api/crew/attention", get(crate::crew_watch::get_attention))`。

（`crate::AppState` 与 `crate::auth::CurrentUser` 路径以 `crew_memory.rs` 的 import 写法为准；若它用 `use crate::{AppState, auth::CurrentUser};`，照抄。）

- [ ] **Step 6: 运行后端测试通过**

Run: `cargo test`
Expected: 全绿。

- [ ] **Step 7: 写前端失败测试**

`pushLink.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { parsePushLink } from '../pushLink'

describe('parsePushLink', () => {
  it('session', () => expect(parsePushLink('?session=abc')).toEqual({ session: 'abc' }))
  it('scheduled crew segment with job', () =>
    expect(parsePushLink('?panel=scheduled&seg=crew&job=j_1')).toEqual({ panel: 'scheduled', seg: 'crew', job: 'j_1' }))
  it('drops an unsafe job id', () =>
    expect(parsePushLink('?panel=scheduled&seg=crew&job=../x')).toEqual({ panel: 'scheduled', seg: 'crew' }))
  it('away crew row', () => expect(parsePushLink('?panel=away&crew=1')).toEqual({ panel: 'away', crew: true }))
  it('nothing → null', () => expect(parsePushLink('')).toBeNull())
})
```

`AwayCard.crew.test.tsx`（`AwayCard` 的其余必填 props 按 S5 组件签名补齐；此处只关心新增 `crew`）：

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { AwayCard } from '../AwayCard'

const base = { summary: null, onSelect: () => {}, onDismiss: () => {} } as unknown as React.ComponentProps<typeof AwayCard>

describe('AwayCard Crew row (S6 G7)', () => {
  it('shows count, expands to title · snippet, not clickable, with the hint', () => {
    render(<AwayCard {...base} crew={{ items: [{ key: 'wx', title: '微信', snippet: '订哪天？' }, { key: 'c', title: 'cron', snippet: 'x' }] }} />)
    fireEvent.click(screen.getByText('Crew 外部 2 项待回答'))
    expect(screen.getByText('微信 · 订哪天？')).toBeInTheDocument()
    expect(screen.getByText('在 Crew/微信中回答；接入功能见后续版本')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /微信 · 订哪天/ })).toBeNull()
  })
  it('hidden when no items or gateway down', () => {
    const { container } = render(<AwayCard {...base} crew={null} />)
    expect(container.textContent).not.toContain('Crew 外部')
  })
})
```

- [ ] **Step 8: 实现前端**

`lib/pushLink.ts`：

```ts
const JOB_RE = /^[A-Za-z0-9_-]{1,64}$/
export interface PushLink { session?: string; panel?: 'scheduled' | 'away'; seg?: 'crew'; job?: string; crew?: boolean }
/** Push deep links (S6 V11). Only server-built shapes are recognised; everything else is ignored. */
export function parsePushLink(search: string): PushLink | null {
  const q = new URLSearchParams(search)
  const session = q.get('session')
  if (session) return { session }
  const panel = q.get('panel')
  if (panel === 'scheduled') {
    const out: PushLink = { panel }
    if (q.get('seg') === 'crew') out.seg = 'crew'
    const job = q.get('job')
    if (job && JOB_RE.test(job)) out.job = job
    return out
  }
  if (panel === 'away') return { panel, crew: q.get('crew') === '1' }
  return null
}
```

`lib/api/crew.ts`：

```ts
import { api } from './core'
export interface CrewAttentionItem { key: string; title: string; snippet: string }
export async function getCrewAttention(): Promise<{ items: CrewAttentionItem[]; gateway_ok: boolean; refreshed_ms: number | null }> {
  const res = await api('/api/crew/attention')
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}
```

并在 `lib/api.ts` 追加 `export * from './api/crew'`。

`useSessionsPoll.ts`：新增选项 `onDeepLink?: (l: PushLink) => void`；`:139-148` 的 `?session=` effect 改为

```ts
  useEffect(() => {
    const l = parsePushLink(location.search)
    if (!l) return
    if (l.session) ref.current.setActiveId(() => l.session!)
    else ref.current.onDeepLink?.(l)
    history.replaceState(null, '', location.pathname)   // consume (A11)
  }, [])
```

SW 消息 effect（`:125-136`）追加分支：`if (e.data?.type === 'open_url' && typeof e.data.url === 'string') { const l = parsePushLink(new URL(e.data.url, location.origin).search); if (l?.session) ref.current.onOpenFromPush(l.session, 0); else if (l) ref.current.onDeepLink?.(l) }`。`useShellState` 透传 `onDeepLink`（新增 `ShellState.deepLink: PushLink | null` 与 `consumeDeepLink()`：`useShellState` 内 `const [deepLink, setDeepLink] = useState<PushLink | null>(null)`，`onDeepLink: setDeepLink`）。`AppShell`：

```tsx
  useEffect(() => {
    const l = shell.deepLink
    if (!l) return
    if (l.panel === 'scheduled') { setPanel('scheduled'); setScheduledInit({ seg: l.seg, job: l.job }) }
    if (l.panel === 'away' && l.crew) setAwayCrewOpen(true)
    shell.consumeDeepLink()
  }, [shell.deepLink])   // eslint-disable-line react-hooks/exhaustive-deps -- consume-once
```

（`scheduledInit` 在 Task 16 传给 `ScheduledTasksPanel`；`awayCrewOpen` 传给 AwayCard 的 `crewDefaultOpen`。本 task 先声明 `const [scheduledInit, setScheduledInit] = useState<{ seg?: 'crew'; job?: string } | null>(null)` 与 `const [awayCrewOpen, setAwayCrewOpen] = useState(false)`。）

`sw.js` `showNotification` 的 `data` 改为 `{ session_id, url: payload.url || null }`；`notificationclick` 改为

```js
  const data = event.notification.data || {}
  const sid = data.session_id
  const url = typeof data.url === 'string' && data.url.startsWith('/?') ? data.url : null
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    if (wins.length > 0) {
      await wins[0].focus()
      wins[0].postMessage(url ? { type: 'open_url', url } : { type: 'open_session', id: sid })
    } else {
      await self.clients.openWindow(url || `/?session=${encodeURIComponent(sid || '')}`)
    }
  })())
```

`const { kind, session_id, title, body } = payload` 同步解构不变（`url` 从 `payload.url` 取）。

`AwayCard`（S5 组件）追加 props `crew?: { items: CrewAttentionItem[] } | null; crewDefaultOpen?: boolean`；在 S5 的行列表按优先级截断到 3 行的逻辑里把 Crew 行作为优先级最低的一行插入（S5 §3.2 排序键：出错 > 待回答 > 待确认 > 完成 > 其他，Crew 外部行归「其他」）：

```tsx
  const crewRow = crew && crew.items.length > 0 ? (
    <details key="crew" open={crewDefaultOpen} className="text-ui-xs">
      <summary className="row cursor-pointer text-[var(--fg-muted)]">{`Crew 外部 ${crew.items.length} 项待回答`}</summary>
      <ul className="pl-3 space-y-0.5">{crew.items.map(i => <li key={i.key} className="truncate text-[var(--fg-subtle)]">{`${i.title} · ${i.snippet}`}</li>)}</ul>
      <p className="pl-3 text-ui-2xs text-[var(--fg-subtle)]">在 Crew/微信中回答；接入功能见后续版本</p>
    </details>
  ) : null
```

`TriageList` 在渲染 AwayCard 的位置（S5 F3 放在「需要你」之前）为 admin 用户挂载时调用一次 `getCrewAttention()`（失败或 `gateway_ok:false` → `crew=null`），不轮询。

- [ ] **Step 9: 运行前端测试通过 + 全量**

Run: `cd frontend && npx vitest run src/lib/__tests__/pushLink.test.ts src/components/shell/__tests__/AwayCard.crew.test.tsx && npm test && npm run lint && npm run build`
Expected: 全绿；首屏增量 ≤ 0.3KB。

- [ ] **Step 10: Commit**

```bash
git add src frontend/public/sw.js frontend/src
git commit -m "feat(G7): crew_watch loop — external slot + Crew cron failure pushes, push url deep links, away-card Crew row, revive topics on boot

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 16: G9 Crew cron 只读分段（T4b）

**Files:**
- Modify: `src/crew_watch.rs`（`fetch_job_runs`、`get_crons`、`get_job_runs` handler）
- Modify: `src/web.rs`（两条路由）
- Modify: `frontend/src/lib/api/crew.ts`（`getCrewCrons`、`getCrewJobRuns`）
- Modify: `frontend/src/components/ScheduledTasksPanel.tsx:18-21,66,153-190`（`initial` prop、SegmentedControl、局部 lazy）
- Create: `frontend/src/components/crew/CrewCronList.tsx`
- Modify: `frontend/src/components/shell/AppShell.tsx:333`（传 `initial={scheduledInit}`）
- Test: `src/crew_watch.rs` `mod tests`、Create `frontend/src/components/crew/__tests__/CrewCronList.test.tsx`

**Interfaces:**
- Consumes: Task 14 `CrewWatch::snapshot()`、`CronJobView`、`parse_cron_runs`、`job_id_ok`；Task 15 `scheduledInit`。
- Produces:
  - `pub async fn fetch_job_runs(crew_home: &Path, port: u16, job_id: &str) -> Option<Vec<CronRunView>>`
  - HTTP：`GET /api/crew/crons`（admin）→ `{gateway_ok, refreshed_ms, server_tz, jobs}`；`GET /api/crew/crons/{job_id}/runs?limit=20`（admin）→ `{gateway_ok, runs}`；非法 job_id → 400；非 admin → 403；Gateway 不可达 → 200 + `gateway_ok:false`
  - 前端：`getCrewCrons()`、`getCrewJobRuns(jobId)`；`ScheduledTasksPanel` prop `initial?: { seg?: 'crew'; job?: string } | null`；`CrewCronList({ openJob?: string })`

- [ ] **Step 1: 写失败测试**

`crew_watch.rs` `mod tests` 追加：

```rust
    #[test]
    fn crons_response_reads_snapshot_only() {
        let snap = SlotsSnapshot { gateway_ok: false, refreshed_ms: Some(3), server_tz: Some("Asia/Shanghai".into()),
            cron_jobs: vec![CronJobView { id: "j".into(), name: "晨报".into(), ..Default::default() }], ..Default::default() };
        let v = crons_body(&snap);
        assert_eq!(v["gateway_ok"], false);
        assert_eq!(v["jobs"][0]["id"], "j");
        assert_eq!(v["server_tz"], "Asia/Shanghai");
    }

    #[test]
    fn job_runs_gate() {
        assert_eq!(job_runs_gate(false, "j"), Err(axum::http::StatusCode::FORBIDDEN));
        assert_eq!(job_runs_gate(true, "../x"), Err(axum::http::StatusCode::BAD_REQUEST));
        assert_eq!(job_runs_gate(true, &"a".repeat(65)), Err(axum::http::StatusCode::BAD_REQUEST));
        assert_eq!(job_runs_gate(true, ""), Err(axum::http::StatusCode::BAD_REQUEST));
        assert_eq!(job_runs_gate(true, "j_1"), Ok(()));
    }
```

`CrewCronList.test.tsx`：

```tsx
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import CrewCronList from '../CrewCronList'
import * as api from '../../../lib/api'

const job = { id: 'j1', name: '晨报', enabled: true, schedule: '0 8 * * *', timezone: 'Asia/Shanghai', agent: 'kirocrew',
  agent_sequence_len: 0, channel: null, last_status: 'failure', last_run_ts: null, next_run_ts: null, is_running: false,
  last_error: 'boom', prompt_head: '总结' }

describe('CrewCronList (G9)', () => {
  beforeEach(() => vi.restoreAllMocks())
  it('gateway down → 「Crew 未连接」, not an empty list', async () => {
    vi.spyOn(api, 'getCrewCrons').mockResolvedValue({ gateway_ok: false, refreshed_ms: null, server_tz: null, jobs: [] })
    render(<CrewCronList />)
    expect(await screen.findByText('Crew 未连接')).toBeInTheDocument()
  })
  it('read-only row; next_run null shows —; deep link expands the job', async () => {
    vi.spyOn(api, 'getCrewCrons').mockResolvedValue({ gateway_ok: true, refreshed_ms: Date.now(), server_tz: 'Asia/Shanghai', jobs: [job] })
    vi.spyOn(api, 'getCrewJobRuns').mockResolvedValue({ gateway_ok: true, runs: [{ run_id: 'r', job_id: 'j1', status: 'failure', error: 'boom\nstack', summary: null, started_at: 1, finished_at: 2, duration_ms: 1, trigger: 'cron', job_name: '晨报' }] })
    render(<CrewCronList openJob="j1" />)
    expect(await screen.findByText('晨报')).toBeInTheDocument()
    expect(screen.getByText(/下次 —/)).toBeInTheDocument()
    expect(await screen.findByText('boom')).toBeInTheDocument()
    expect(screen.getByText('由 Crew 调度 · 在 Crew 仪表板中编辑')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /编辑|删除|运行/ })).toBeNull()
  })
  it('a stale runs response for a previously expanded job never overwrites the current one', async () => {
    vi.spyOn(api, 'getCrewCrons').mockResolvedValue({ gateway_ok: true, refreshed_ms: Date.now(), server_tz: null,
      jobs: [job, { ...job, id: 'j2', name: '周报' }] })
    let slow!: (v: Awaited<ReturnType<typeof api.getCrewJobRuns>>) => void
    vi.spyOn(api, 'getCrewJobRuns').mockImplementation(id => id === 'j1'
      ? new Promise(r => { slow = r })
      : Promise.resolve({ gateway_ok: true, runs: [{ run_id: 'r2', job_id: 'j2', status: 'success', summary: '周报 OK', error: null, started_at: 1, finished_at: 2, duration_ms: 1, trigger: null, job_name: null }] }))
    render(<CrewCronList />)
    fireEvent.click(await screen.findByText('晨报'))
    fireEvent.click(screen.getByText('周报'))
    expect(await screen.findByText('周报 OK')).toBeInTheDocument()
    await act(async () => { slow({ gateway_ok: true, runs: [{ run_id: 'r1', job_id: 'j1', status: 'failure', summary: 'OLD', error: null, started_at: 1, finished_at: 2, duration_ms: 1, trigger: null, job_name: null }] }) })
    await waitFor(() => expect(screen.queryByText('OLD')).toBeNull())
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `cargo test --lib crew_watch && cd frontend && npx vitest run src/components/crew/__tests__/CrewCronList.test.tsx`
Expected: 编译失败 / FAIL。

- [ ] **Step 3: 实现后端**

```rust
pub(crate) fn crons_body(snap: &SlotsSnapshot) -> Value {
    serde_json::json!({ "gateway_ok": snap.gateway_ok, "refreshed_ms": snap.refreshed_ms,
                        "server_tz": snap.server_tz, "jobs": snap.cron_jobs })
}

pub(crate) fn job_runs_gate(is_admin: bool, job_id: &str) -> Result<(), axum::http::StatusCode> {
    if !is_admin { return Err(axum::http::StatusCode::FORBIDDEN); }
    if !job_id_ok(job_id) { return Err(axum::http::StatusCode::BAD_REQUEST); }
    Ok(())
}

/// On-demand, read-only; never writes the snapshot (crew_watch's loop is the only writer).
pub async fn fetch_job_runs(crew_home: &std::path::Path, port: u16, job_id: &str) -> Option<Vec<CronRunView>> {
    let secret = read_gateway_secret(crew_home, port).ok()?;
    let http = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().ok()?;
    let base = format!("http://127.0.0.1:{port}");
    let v = tokio::time::timeout(std::time::Duration::from_secs(10),
        get(&http, &base, &secret, &format!("/api/crons/history?job_id={job_id}&limit=20"))).await.ok()??;
    Some(parse_cron_runs(&v))
}

pub async fn get_crons(
    axum::extract::State(state): axum::extract::State<Arc<crate::AppState>>,
    user: axum::Extension<crate::auth::CurrentUser>,
) -> Result<axum::Json<Value>, axum::http::StatusCode> {
    if !user.is_admin() { return Err(axum::http::StatusCode::FORBIDDEN); }
    Ok(axum::Json(crons_body(&state.crew_watch.snapshot())))
}

pub async fn get_job_runs(
    axum::extract::State(state): axum::extract::State<Arc<crate::AppState>>,
    user: axum::Extension<crate::auth::CurrentUser>,
    axum::extract::Path(job_id): axum::extract::Path<String>,
) -> Result<axum::Json<Value>, axum::http::StatusCode> {
    job_runs_gate(user.is_admin(), &job_id)?;
    Ok(axum::Json(match fetch_job_runs(std::path::Path::new(&state.crew_home), state.crew_port, &job_id).await {
        Some(runs) => serde_json::json!({ "gateway_ok": true, "runs": runs }),
        None => serde_json::json!({ "gateway_ok": false, "runs": [] }),
    }))
}
```

（`limit` query 固定为 20，前端不传其他值；spec 的 `?limit=20` 语义满足。）路由：`.route("/api/crew/crons", get(crate::crew_watch::get_crons)).route("/api/crew/crons/{job_id}/runs", get(crate::crew_watch::get_job_runs))`。

- [ ] **Step 4: 实现前端**

`lib/api/crew.ts` 追加类型 `CrewCronJob`（字段同 `CronJobView`）、`CrewCronRun`（同 `CronRunView`）及：

```ts
export async function getCrewCrons(): Promise<{ gateway_ok: boolean; refreshed_ms: number | null; server_tz: string | null; jobs: CrewCronJob[] }> {
  const res = await api('/api/crew/crons')
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}
export async function getCrewJobRuns(jobId: string): Promise<{ gateway_ok: boolean; runs: CrewCronRun[] }> {
  const res = await api(`/api/crew/crons/${encodeURIComponent(jobId)}/runs?limit=20`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}
```

`components/crew/CrewCronList.tsx`：

```tsx
import { useEffect, useRef, useState } from 'react'
import type { CrewCronJob, CrewCronRun } from '../../lib/api'
import { getCrewCrons, getCrewJobRuns } from '../../lib/api'
import { useLatestRequest } from '../../lib/useLatestRequest'
import { formatRelative } from '../../lib/format'
import { StatusDot } from '../ui'

const firstLine = (s?: string | null) => (s ?? '').split('\n').map(l => l.trim()).find(Boolean) ?? ''

export default function CrewCronList({ openJob }: { openJob?: string }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof getCrewCrons>> | null>(null)
  const [open, setOpen] = useState<string | null>(openJob ?? null)
  const [runs, setRuns] = useState<CrewCronRun[] | null>(null)
  const runsReq = useLatestRequest()
  const openRef = useRef<HTMLLIElement | null>(null)
  useEffect(() => { getCrewCrons().then(setData).catch(() => setData({ gateway_ok: false, refreshed_ms: null, server_tz: null, jobs: [] })) }, [])
  useEffect(() => {
    if (!open) return
    const t = runsReq.begin()
    setRuns(null)
    getCrewJobRuns(open).then(r => { if (runsReq.isCurrent(t)) setRuns(r.runs) }).catch(() => { if (runsReq.isCurrent(t)) setRuns([]) })
  }, [open, runsReq])
  useEffect(() => { if (open && data) openRef.current?.scrollIntoView?.({ block: 'nearest' }) }, [open, data])
  if (!data) return <div className="text-ui-sm text-[var(--fg-subtle)]">加载中...</div>
  const now = Date.now()
  const stale = data.refreshed_ms != null && now - data.refreshed_ms > 120_000
  return (
    <div className="space-y-1">
      <p className="text-ui-2xs text-[var(--fg-subtle)]">由 Crew 调度 · 在 Crew 仪表板中编辑{stale ? ` · 数据更新于 ${formatRelative(data.refreshed_ms!, now)}` : ''}</p>
      {!data.gateway_ok && data.jobs.length === 0 ? <div className="text-ui-sm text-[var(--fg-subtle)]">Crew 未连接</div> : (
        <ul className="space-y-1">
          {data.jobs.map((j: CrewCronJob) => {
            const tone = !j.enabled ? 'muted' : j.is_running ? 'running' : (j.last_status === 'failure' || j.last_status === 'error') ? 'danger' : 'muted'
            const isOpen = open === j.id
            return (
              <li key={j.id} ref={isOpen ? openRef : undefined} className="px-3 py-2 bg-[var(--surface-2)] rounded-lg border border-[var(--border)]">
                <div role="button" tabIndex={0} onClick={() => setOpen(isOpen ? null : j.id)} className="min-h-[44px] flex items-center gap-2 cursor-pointer">
                  <StatusDot tone={tone} label={j.last_status ?? ''} />
                  <span className="flex-1 min-w-0 truncate text-ui-xs text-[var(--fg)]">{j.name}</span>
                  <span className="shrink-0 text-ui-2xs text-[var(--fg-subtle)]">
                    {[j.schedule, j.timezone].filter(Boolean).join(' · ')}{j.agent_sequence_len > 0 ? ` · 序列 ${j.agent_sequence_len} 个` : ''}
                    {` · 上次 ${j.last_run_ts ? formatRelative(j.last_run_ts * 1000, now) : '—'} / 下次 ${j.next_run_ts ? new Date(j.next_run_ts * 1000).toLocaleTimeString() : '—'}`}
                  </span>
                </div>
                {isOpen && (
                  <ul className="mt-1 space-y-0.5">
                    {runs === null ? <li className="text-ui-2xs text-[var(--fg-subtle)]">加载中...</li>
                      : runs.map(r => <li key={r.run_id} className="text-ui-2xs text-[var(--fg-muted)] truncate">{firstLine(r.error) || firstLine(r.summary) || r.status}</li>)}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
```

（`formatRelative(ms, now)` 的签名以 `lib/format.ts` 为准；TriageRow 已如此调用。）

`ScheduledTasksPanel.tsx`：Props 加 `initial?: { seg?: 'crew'; job?: string } | null`；`const CrewCronList = lazy(() => import('./crew/CrewCronList'))`（顶部 `import { lazy, Suspense } from 'react'`）；`const [seg, setSeg] = useState<'zmx' | 'crew'>(initial?.seg === 'crew' ? 'crew' : 'zmx')`；list 视图顶部插入 `<SegmentedControl label="任务来源" value={seg} onChange={setSeg} options={[{ value: 'zmx', label: 'ZeroMux 任务' }, { value: 'crew', label: 'Crew 任务' }]} />`；`seg === 'crew'` 时渲染 `<Suspense fallback={null}><CrewCronList openJob={initial?.job} /></Suspense>`，否则渲染原列表。`AppShell.tsx:333` 传 `initial={scheduledInit}`，关闭面板时 `setScheduledInit(null)`。

- [ ] **Step 5: 运行测试通过 + 首屏不含 CrewCronList**

Run: `cargo test && cd frontend && npm test && npm run lint && npm run build && ! grep -l "由 Crew 调度" dist/assets/index-*.js`
Expected: 全绿，最后一条 grep 无匹配（CrewCronList 只在 lazy chunk）。

- [ ] **Step 6: Commit + 上线（S6-d）**

```bash
git add src frontend/src
git commit -m "feat(G9): read-only Crew cron segment from crew_watch snapshot + deep link

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push
./deploy.sh --build
```

退出标准：两者同期上线；手测：微信 slot 触发一次 `needs_input` → 手机收到「… · 在 Crew/微信回答」，点开首页 Crew 行展开；人为让一个 Crew cron 失败 → 推送点开落到 Crew 分段并展开该 job。通知 S7 代理层可以开始只读 `CrewWatch::snapshot()`。

---

# S6-e：T5 摘要卡 review 动作 + T6 文件 chip 定位单文件

### Task 17: 摘要卡「采纳 ✓ · 打回 ↩ · 提交…」

**Files:**
- Modify: `frontend/src/components/turn/TurnSummaryCard.tsx:10-15,31-42`
- Modify: `frontend/src/components/turn/TurnView.tsx:9-15,51-52,63-66`
- Modify: `frontend/src/components/AcpChatView.tsx:22-50,58,151,361-362,472-487`
- Modify: `frontend/src/components/shell/AppShell.tsx:180-183`（传 `sendTo`）
- Create: `frontend/src/lib/reviewVerdict.ts`
- Test: `frontend/src/components/turn/__tests__/TurnView.test.tsx`、Create `frontend/src/components/turn/__tests__/TurnSummaryCard.review.test.tsx`、`frontend/src/lib/__tests__/reviewVerdict.test.ts`

**Interfaces:**
- Consumes: 既有 `getSessionRuns`、`postRunVerdict`（`lib/api/sessions.ts:178-202`）、`commitPrompt(workDir)`（`lib/gitviewer.ts`）、`SendToMenu` + `SendToProps`（`components/SendToMenu.tsx:113`，S4 后导出）；Task 13 `TurnView.onAnswer`。
- Produces:
  - `TurnSummaryCard` prop `actions?: { onAccept(anchor: HTMLElement): void; onReject(): void; accepted: boolean; canCommit: boolean }`
  - `TurnView` props `review?: { last: boolean; onAccept(turnId: number, anchor: HTMLElement, hasFiles: boolean): void; onReject(turnId: number): void; accepted: ReadonlySet<number> }`
  - `AcpChatView` prop `sendTo?: SendToProps`
  - `bestEffortVerdict(sid: string, turnId: number, verdict: 'good' | 'bad', api?: { getSessionRuns; postRunVerdict }): Promise<void>`（从不 reject）

- [ ] **Step 1: 写失败测试**

`reviewVerdict.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest'
import { bestEffortVerdict } from '../reviewVerdict'

describe('bestEffortVerdict (V12: silent)', () => {
  it('posts the run whose turn_seq matches', async () => {
    const post = vi.fn().mockResolvedValue(undefined)
    await bestEffortVerdict('s', 3, 'good', { getSessionRuns: vi.fn().mockResolvedValue({ runs: [{ run_id: 'a', turn_seq: 2 }, { run_id: 'b', turn_seq: 3 }] }), postRunVerdict: post })
    expect(post).toHaveBeenCalledWith('s', 'b', 'good')
  })
  it('404 / no run / fetch failure never throws and posts nothing', async () => {
    const post = vi.fn()
    await expect(bestEffortVerdict('s', 9, 'good', { getSessionRuns: vi.fn().mockResolvedValue({ runs: [] }), postRunVerdict: post })).resolves.toBeUndefined()
    await expect(bestEffortVerdict('s', 9, 'good', { getSessionRuns: vi.fn().mockRejectedValue(new Error('404')), postRunVerdict: post })).resolves.toBeUndefined()
    expect(post).not.toHaveBeenCalled()
    await expect(bestEffortVerdict('s', 3, 'bad', { getSessionRuns: vi.fn().mockResolvedValue({ runs: [{ run_id: 'b', turn_seq: 3 }] }), postRunVerdict: vi.fn().mockRejectedValue(new Error('404')) })).resolves.toBeUndefined()
  })
})
```

`TurnSummaryCard.review.test.tsx`：

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { TurnSummaryCard } from '../TurnSummaryCard'

const base = { conclusionText: '改好了', files: [{ path: '/r/a.ts', label: 'r/a.ts' }], steps: 2, onExpand: () => {} }

describe('TurnSummaryCard review actions (F7)', () => {
  it('no actions prop → no action row', () => {
    render(<TurnSummaryCard {...base} />)
    expect(screen.queryByRole('button', { name: /采纳/ })).toBeNull()
  })
  it('accept calls onAccept with its anchor; double tap is a no-op once accepted', () => {
    const onAccept = vi.fn()
    const { rerender } = render(<TurnSummaryCard {...base} actions={{ onAccept, onReject: vi.fn(), accepted: false, canCommit: true }} />)
    fireEvent.click(screen.getByRole('button', { name: '采纳' }))
    expect(onAccept).toHaveBeenCalledWith(expect.any(HTMLElement))
    rerender(<TurnSummaryCard {...base} actions={{ onAccept, onReject: vi.fn(), accepted: true, canCommit: true }} />)
    expect(screen.getByText('已采纳 ✓')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '采纳' })).toBeNull()
  })
  it('提交… only with files; buttons are ≥44px (ctl)', () => {
    const { rerender } = render(<TurnSummaryCard {...base} actions={{ onAccept: vi.fn(), onReject: vi.fn(), accepted: false, canCommit: true }} />)
    expect(screen.getByRole('button', { name: '提交…' }).className).toMatch(/\bctl\b/)
    rerender(<TurnSummaryCard {...base} files={[]} actions={{ onAccept: vi.fn(), onReject: vi.fn(), accepted: false, canCommit: false }} />)
    expect(screen.queryByRole('button', { name: '提交…' })).toBeNull()
  })
})
```

`TurnView.test.tsx` 追加：

```tsx
  it('review actions only on the last complete, non-errored card', () => {
    const r = { last: false, onAccept: vi.fn(), onReject: vi.fn(), accepted: new Set<number>() }
    const { rerender } = render(<TurnView group={done} agentName="Claude" review={r} />)
    expect(screen.queryByRole('button', { name: '采纳' })).toBeNull()
    rerender(<TurnView group={done} agentName="Claude" review={{ ...r, last: true }} />)
    fireEvent.click(screen.getByRole('button', { name: '打回' }))
    expect(r.onReject).toHaveBeenCalledWith(1)
    rerender(<TurnView group={{ ...done, errored: true }} agentName="Claude" review={{ ...r, last: true }} />)
    expect(screen.queryByRole('button', { name: '采纳' })).toBeNull()
  })
  it('memo holds when review callbacks are stable (I-9)', () => {
    let renders = 0
    const Probe = (p: React.ComponentProps<typeof TurnView>) => { renders++; return <TurnView {...p} /> }
    const r = { last: false, onAccept: vi.fn(), onReject: vi.fn(), accepted: new Set<number>() }
    const { rerender } = render(<Probe group={done} agentName="Claude" review={r} />)
    const before = renders
    rerender(<Probe group={done} agentName="Claude" review={r} />)
    expect(renders).toBe(before + 1)   // the probe re-renders; TurnView's memo compares review by identity
  })
```

在 `AcpChatView` 层加集成用例（新建 `frontend/src/components/__tests__/reviewActions.test.tsx`）：

```tsx
import { render, screen, act, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import AcpChatView from '../AcpChatView'
import { installFakeWebSocket } from '../../test/fakeWs'
import { Toaster } from '../ui'
import * as api from '../../lib/api'

describe('F7 wiring', () => {
  const origWs = (globalThis as unknown as { WebSocket?: unknown }).WebSocket
  let ws: ReturnType<typeof installFakeWebSocket>
  beforeEach(() => {
    vi.restoreAllMocks(); ws = installFakeWebSocket()
    vi.spyOn(api, 'getSessionRuns').mockRejectedValue(new Error('404'))
  })
  afterEach(() => { (globalThis as unknown as { WebSocket?: unknown }).WebSocket = origWs })
  const turn = (t: number) => {
    ws.latest().emit({ type: 'content_block', block_type: 'tool_use', name: 'Edit', input: { file_path: '/w/a.ts' }, turn_id: t })
    ws.latest().emit({ type: 'result', text: '改好了', turn_id: t })
  }
  it('打回 prefills the composer with 打回：', () => {
    render(<AcpChatView sessionId="s1" active agentType="claude" />)
    act(() => turn(1))
    fireEvent.click(screen.getByRole('button', { name: '打回' }))
    expect((screen.getByPlaceholderText(/Send a message/) as HTMLTextAreaElement).value).toBe('打回：')
  })
  it('采纳 with files opens the send-to menu (no confirm), 404 is silent', async () => {
    const sendTo = { workDir: '/w', sessions: [], controls: { current: {} }, queueModes: {}, onSelectSession: vi.fn(), onNew: vi.fn(), sameDirOnly: true }
    render(<><AcpChatView sessionId="s1" active agentType="claude" sendTo={sendTo} /><Toaster /></>)
    act(() => turn(1))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '采纳' })) })
    expect(screen.getByText('已采纳 ✓')).toBeInTheDocument()
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.queryByRole('status')).toBeNull()   // no toast from the 404
  })
  it('a new turn removes the actions from the old card', () => {
    render(<AcpChatView sessionId="s1" active agentType="claude" />)
    act(() => turn(1)); act(() => turn(2))
    expect(screen.getAllByRole('button', { name: '采纳' })).toHaveLength(1)
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `cd frontend && npx vitest run src/lib/__tests__/reviewVerdict.test.ts src/components/turn/__tests__ src/components/__tests__/reviewActions.test.tsx`
Expected: FAIL。

- [ ] **Step 3: 实现**

`lib/reviewVerdict.ts`：

```ts
import { getSessionRuns as realGet, postRunVerdict as realPost } from './api'

/** F7: verdicts live only in memory (spec §5.1) → strictly best-effort and silent (V12). */
export async function bestEffortVerdict(sid: string, turnId: number, verdict: 'good' | 'bad',
  deps: { getSessionRuns: typeof realGet; postRunVerdict: typeof realPost } = { getSessionRuns: realGet, postRunVerdict: realPost }): Promise<void> {
  try {
    const { runs } = await deps.getSessionRuns(sid, { limit: 10 })
    const run = runs.find(r => r.turn_seq === turnId)
    if (run) await deps.postRunVerdict(sid, run.run_id, verdict)
  } catch { /* 404 after a restart is expected — say nothing */ }
}
```

`TurnSummaryCard`：props 增加 `actions?`；在 chip 行 `</div>` 之后：

```tsx
      {actions && (
        <div className="flex flex-wrap items-center gap-2">
          {actions.accepted
            ? <span className="text-ui-xs text-[var(--success)]">已采纳 ✓</span>
            : <button type="button" onClick={e => actions.onAccept(e.currentTarget)} className="ctl px-3 rounded-[var(--r-sm)] text-ui-xs text-[var(--fg)] bg-[var(--surface-3)]">采纳</button>}
          <button type="button" onClick={actions.onReject} className="ctl px-3 rounded-[var(--r-sm)] text-ui-xs text-[var(--fg-muted)] hover:text-[var(--fg)]">打回</button>
          {actions.canCommit && <button type="button" onClick={e => actions.onAccept(e.currentTarget)} className="ctl px-3 rounded-[var(--r-sm)] text-ui-xs text-[var(--fg-muted)] hover:text-[var(--fg)]">提交…</button>}
        </div>
      )}
```

说明：「提交…」与「采纳」走同一个回调——`AcpChatView` 在 `hasFiles` 时打开 SendToMenu，且对已采纳的 turn 不再重复打 verdict（见下）。

`TurnView`：Props 加 `review?`；`showCard` 时传

```tsx
            actions={review?.last && !group.errored ? {
              accepted: review.accepted.has(group.turnId), canCommit: files.length > 0,
              onAccept: (el) => review.onAccept(group.turnId, el, files.length > 0),
              onReject: () => review.onReject(group.turnId),
            } : undefined}
```

memo 比较器追加 `&& a.review === b.review`。

`AcpChatView`：Props 加 `/** Shell's SendToMenu wiring (AppShell sendTo(work_dir)). */ sendTo?: SendToProps`；

```tsx
  const [accepted, setAccepted] = useState<ReadonlySet<number>>(() => new Set())
  const [commitMenu, setCommitMenu] = useState<HTMLElement | null>(null)
  const lastDoneId = useMemo(() => [...groups].reverse().find(g => g.complete)?.turnId ?? null, [groups])
  const onAccept = useCallback((turnId: number, anchor: HTMLElement, hasFiles: boolean) => {
    setAccepted(prev => {
      if (prev.has(turnId)) return prev
      void bestEffortVerdict(sessionId, turnId, 'good')
      return new Set(prev).add(turnId)
    })
    if (hasFiles) setCommitMenu(anchor)
  }, [sessionId])
  const onReject = useCallback((turnId: number) => {
    void bestEffortVerdict(sessionId, turnId, 'bad')
    setInput('打回：')
    composerRef.current?.focus()
  }, [sessionId])
  const reviewFor = useMemo(() => new Map<number, NonNullable<React.ComponentProps<typeof TurnView>['review']>>(), [])
  const review = (tid: number) => {
    const last = tid === lastDoneId
    const key = last ? tid : -1
    let r = reviewFor.get(key)
    if (!r || r.accepted !== accepted || r.last !== last) { r = { last, onAccept, onReject, accepted }; reviewFor.set(key, r) }
    return r
  }
```

（`review(tid)` 为非末尾 turn 复用同一个 `-1` 对象，使旧卡 memo 不被新 `accepted` 集合打破；`composerRef` 来自 Task 13。）渲染 `<TurnView … review={review(g.turnId)} />`；在 transcript 容器之后：

```tsx
      {commitMenu && sendTo && (
        <SendToMenu open anchor={commitMenu} onClose={() => setCommitMenu(null)} text={commitPrompt(sendTo.workDir ?? '')} {...sendTo} sameDirOnly />
      )}
```

（**不带** `confirmDanger`，V12。）import `SendToMenu, type SendToProps`、`commitPrompt`、`bestEffortVerdict`、`useMemo`。`AppShell.tsx:180` 的 `<AcpChatView>` 追加 `sendTo={sendTo(s.work_dir)}`（`sendTo` 是 `:135` 的工厂，每次渲染新对象——`AcpChatView` 只在 `commitMenu` 打开时读它，不进 memo 比较，无重渲染成本）。

- [ ] **Step 4: 运行测试通过 + 全量**

Run: `cd frontend && npx vitest run src/lib/__tests__/reviewVerdict.test.ts src/components/turn/__tests__ src/components/__tests__/reviewActions.test.tsx src/__tests__/App.characterization.test.tsx && npm test && npm run lint && npm run build`
Expected: 全绿；首屏增量 ≤ 0.5KB。

- [ ] **Step 5: Commit**

```bash
git add frontend/src
git commit -m "feat(F7): summary-card 采纳/打回/提交…, silent best-effort verdict

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 18: F7b 文件 chip 定位到单个文件

**Files:**
- Create: `frontend/src/lib/relPath.ts`
- Modify: `frontend/src/components/turn/TurnSummaryCard.tsx:31-35`（chip 传 path）、`TurnView.tsx`（`onOpenChanges(path?)`）
- Modify: `frontend/src/components/AcpChatView.tsx:48,149`（`onOpenChanges(sid, file?)`）
- Modify: `frontend/src/components/shell/useShellState.ts:16`（`ContextState.file?`）、`AppShell.tsx:115`
- Modify: `frontend/src/components/shell/ContextPanel.tsx:11-27,57`、`frontend/src/components/GitViewer.tsx:12-21,52,142-148,299-360`
- Test: Create `frontend/src/lib/__tests__/relPath.test.ts`、`frontend/src/components/__tests__/GitViewer.initialFile.test.tsx`

**Interfaces:**
- Consumes: 既有 `getGitWorktree`、`getSessionStatus`（`work_dir`）。
- Produces: `toRelPath(path: string, workDir: string | null): string`；`ContextState.file?: string`；`ContextPanel` prop `gitFile?: string`；`GitViewer` prop `initialFile?: string`；`onOpenChanges?: (sessionId: string, file?: string) => void`。

- [ ] **Step 1: 写失败测试**

`relPath.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { toRelPath } from '../relPath'
describe('toRelPath', () => {
  it('strips the work dir prefix', () => expect(toRelPath('/w/repo/src/a.ts', '/w/repo')).toBe('src/a.ts'))
  it('tolerates a trailing slash on work dir', () => expect(toRelPath('/w/repo/a.ts', '/w/repo/')).toBe('a.ts'))
  it('relative stays relative, ./ dropped', () => expect(toRelPath('./src/a.ts', '/w/repo')).toBe('src/a.ts'))
  it('outside the work dir stays absolute', () => expect(toRelPath('/etc/hosts', '/w/repo')).toBe('/etc/hosts'))
  it('prefix-but-not-dir is not stripped', () => expect(toRelPath('/w/repo2/a.ts', '/w/repo')).toBe('/w/repo2/a.ts'))
})
```

`GitViewer.initialFile.test.tsx`：

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import GitViewer from '../GitViewer'
import * as api from '../../lib/api'

describe('GitViewer initialFile (F7b)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(api, 'getSessionStatus').mockResolvedValue({ work_dir: '/w/repo', git_branch: 'main', git_dirty: 1, is_git: true })
    vi.spyOn(api, 'getGitLog').mockResolvedValue({ entries: [], total: 0 } as never)
  })
  it('selects the file when it is in the worktree list', async () => {
    vi.spyOn(api, 'getGitWorktree').mockResolvedValue({ is_git: true, truncated: false, diff: 'diff --git a/src/a.ts b/src/a.ts\n', files: [{ path: 'src/a.ts', status: 'M', staged: false }] })
    render(<GitViewer sessionId="s" initialTab="worktree" initialFile="/w/repo/src/a.ts" />)
    await waitFor(() => expect(screen.getByRole('button', { name: /src\/a\.ts/ }).className).toMatch(/bg-\[var\(--bg-primary\)\]/))
  })
  it('shows a notice when the file has no uncommitted change', async () => {
    vi.spyOn(api, 'getGitWorktree').mockResolvedValue({ is_git: true, truncated: false, diff: '', files: [{ path: 'b.ts', status: 'M', staged: false }] })
    render(<GitViewer sessionId="s" initialTab="worktree" initialFile="src/a.ts" />)
    expect(await screen.findByText('该文件已无未提交改动')).toBeInTheDocument()
  })
})
```

（`getGitLog` 的返回形状以 `lib/api/git.ts` 为准；这里只需不抛。）

- [ ] **Step 2: 运行，确认失败**

Run: `cd frontend && npx vitest run src/lib/__tests__/relPath.test.ts src/components/__tests__/GitViewer.initialFile.test.tsx`
Expected: FAIL。

- [ ] **Step 3: 实现**

`lib/relPath.ts`：

```ts
/** touchedFiles() yields absolute or relative paths; GitViewer lists repo-relative ones. */
export function toRelPath(path: string, workDir: string | null): string {
  const p = path.replace(/^\.\//, '')
  if (!p.startsWith('/') || !workDir) return p
  const base = workDir.replace(/\/+$/, '') + '/'
  return p.startsWith(base) ? p.slice(base.length) : p
}
```

`TurnSummaryCard`：`onOpenChanges?: (path?: string) => void`，chip `onClick={() => onOpenChanges?.(f.path)}`。`TurnView`：`onOpenChanges?: (path?: string) => void` 透传。`AcpChatView`：Props 类型改 `onOpenChanges?: (sessionId: string, file?: string) => void`，`const openChanges = useCallback((file?: string) => { onOpenChanges?.(sessionId, file) }, [onOpenChanges, sessionId])`。`useShellState` `ContextState` 加 `file?: string`。`AppShell.tsx:115`：`const openChanges = useCallback((sid: string, file?: string) => setContext(sid, { open: true, tab: 'git', nonce: Date.now(), file }), [setContext])`；两处 `<ContextPanel …>` 追加 `gitFile={cc.file}` / `gitFile={activeCtx.file}`。`ContextPanel`：prop `gitFile?: string`，`<GitViewer … initialFile={gitNonce ? gitFile : undefined} />`。

`GitViewer`：Props 加 `/** Summary-card chip (F7b): select this file once the worktree loads. */ initialFile?: string`；state `const [fileGone, setFileGone] = useState(false)`；在 `setWt(d)` 处改为

```tsx
      .then(d => {
        if (wtReqRef.current !== req) return
        setWt(d)
        if (initialFileRef.current) {
          const want = toRelPath(initialFileRef.current, statusDirRef.current)
          initialFileRef.current = undefined            // one-shot
          if (d.files.some(f => f.path === want)) setWtSelected(want); else setFileGone(true)
        }
      })
```

`const initialFileRef = useRef(initialFile)`、`const statusDirRef = useRef<string | null>(null)`，在 `setStatusDir(st.work_dir)` 旁 `statusDirRef.current = st.work_dir`。`WorktreePanel` 增 prop `notice?: string`，在文件列表上方渲染 `{notice && <p className="px-3 py-1 text-ui-2xs text-[var(--fg-subtle)]">{notice}</p>}`，由 `GitViewer` 传 `notice={fileGone ? '该文件已无未提交改动' : undefined}`。

注意时序：status（work_dir）与 worktree 两个请求并发；worktree 先回时 `statusDirRef.current` 为 null，`toRelPath` 对绝对路径原样返回、匹配失败会误报。为此 `loadWorktree` 的 `.then` 在 `initialFileRef.current && initialFile.startsWith('/') && !statusDirRef.current` 时**不消费** ref、只 `setWt(d)`；status effect 在拿到 `work_dir` 后若 `initialFileRef.current` 仍在且 `tab==='worktree'`，调用一次 `loadWorktree()`。

- [ ] **Step 4: 运行测试通过 + 全量**

Run: `cd frontend && npx vitest run src/lib/__tests__/relPath.test.ts src/components/__tests__/GitViewer.initialFile.test.tsx src/components/__tests__/GitViewer.worktree.test.tsx src/components/__tests__/GitViewer.worktreeStale.test.tsx && npm test && npm run lint && npm run build`
Expected: 全绿（`GitViewer` 在 lazy chunk，不计首屏）。

- [ ] **Step 5: Commit + 上线（S6-e）**

```bash
git add frontend/src
git commit -m "feat(F7b): file chip opens Git 改动 on that file

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push
./deploy.sh --build
```

退出标准：手机 review 一轮 2 击（采纳 → 选目标会话）。

---

# S6-f：T7 F5 待派发（服务端单表）+ T8 F6 批量派发 + 目标徽标

### Task 19: `backlog.rs` + `/api/backlog`

**Files:**
- Create: `src/backlog.rs`
- Modify: `src/main.rs:1-25`（`mod backlog;`）、`:193-226`、`:360-363` 之后、`:513-552`
- Modify: `src/web.rs:79`（路由）+ handlers（放在 `forget_quick_target` 之后）
- Test: `src/backlog.rs` `mod tests`、`src/web.rs` `mod path_safety_tests`

**Interfaces:**
- Consumes: `validate_work_dir_under_home`、`sanitize_meta`（`web.rs:864,1247`）。
- Produces:
  - `pub const MAX_ITEMS: usize = 50`；`BacklogItem { id, type_: String (serde rename "type"), dir, prompt, text, created_ms }`；`NewBacklogItem { type_, dir, prompt, text }`
  - `BacklogStore::open(&Path) -> Result<Self, String>`、`list(&self, user) -> Result<Vec<BacklogItem>, String>`、`add(&self, user, NewBacklogItem, now_ms) -> Result<BacklogItem, String>`、`remove(&self, user, id) -> Result<bool, String>`
  - `AppState.backlog: Arc<backlog::BacklogStore>`
  - HTTP：`GET /api/backlog`、`POST /api/backlog`（201）、`DELETE /api/backlog?id=`（204）
  - 埋点：`zmx_usage backlog_add id=…`、`zmx_usage backlog_dispatch id=… age_ms=…`（`DELETE ?id=…&dispatched=1` 时）

- [ ] **Step 1: 写失败测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    fn tmp() -> (BacklogStore, tempfile::TempDir) { let d = tempfile::tempdir().unwrap(); (BacklogStore::open(d.path()).unwrap(), d) }
    fn item(p: &str) -> NewBacklogItem { NewBacklogItem { type_: "claude".into(), dir: "/w".into(), prompt: p.into(), text: format!("claude /w {p}") } }

    #[test]
    fn owner_scoped_list_and_remove() {
        let (s, _d) = tmp();
        let a = s.add("u1", item("a"), 1).unwrap();
        s.add("u2", item("b"), 2).unwrap();
        assert_eq!(s.list("u1").unwrap().len(), 1);
        assert!(!s.remove("u2", &a.id).unwrap(), "u2 cannot delete u1's item");
        assert_eq!(s.list("u1").unwrap().len(), 1);
        assert!(s.remove("u1", &a.id).unwrap());
        assert!(!s.remove("u1", &a.id).unwrap(), "idempotent");
    }

    #[test]
    fn newest_first_and_capped_at_50_dropping_oldest() {
        let (s, _d) = tmp();
        for i in 0..51 { s.add("u", item(&format!("p{i}")), i as i64).unwrap(); }
        let l = s.list("u").unwrap();
        assert_eq!(l.len(), MAX_ITEMS);
        assert_eq!(l[0].prompt, "p50");
        assert!(l.iter().all(|x| x.prompt != "p0"));
    }

    #[test]
    fn open_twice_is_idempotent_and_shares_the_db() {
        let d = tempfile::tempdir().unwrap();
        BacklogStore::open(d.path()).unwrap().add("u", item("x"), 1).unwrap();
        assert_eq!(BacklogStore::open(d.path()).unwrap().list("u").unwrap().len(), 1);
    }

    #[test]
    fn multiline_prompt_and_spaces_in_dir_roundtrip() {
        let (s, _d) = tmp();
        let mut n = item("第一行\n第二行");
        n.dir = "/home/u/My Project".into();
        s.add("u", n, 1).unwrap();
        let got = &s.list("u").unwrap()[0];
        assert_eq!((got.dir.as_str(), got.prompt.as_str()), ("/home/u/My Project", "第一行\n第二行"));
    }
}
```

`web.rs` `mod path_safety_tests` 追加：

```rust
    #[test]
    fn backlog_req_validation() {
        assert!(backlog_type_ok("claude") && backlog_type_ok("tmux") && !backlog_type_ok("vault") && !backlog_type_ok(""));
        assert_eq!(cap_prompt(&"a\n".repeat(5000)).chars().count(), 8000);
        assert!(cap_prompt("x\ny").contains('\n'), "prompt keeps newlines (not sanitize_meta)");
    }
```

- [ ] **Step 2: 运行，确认失败**

Run: `cargo test --lib backlog && cargo test --lib path_safety_tests::backlog_req_validation`
Expected: 编译失败。

- [ ] **Step 3: 实现 `src/backlog.rs`**

```rust
//! 待派发（S6 F5）：⌘K 解析后的 {type, dir, prompt} 显式清单，跨设备（D20）。
//! 与 quick_targets 同库同风格：Mutex<Connection>、所有读写 owner-scoped。
//! 不做 frecency/衰减：这是清单，不是排行。

use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::Mutex;

pub const MAX_ITEMS: usize = 50;

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct BacklogItem {
    pub id: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub dir: String,
    pub prompt: String,
    pub text: String,
    pub created_ms: i64,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct NewBacklogItem {
    #[serde(rename = "type")]
    pub type_: String,
    pub dir: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub text: String,
}

pub struct BacklogStore { conn: Mutex<Connection> }

impl BacklogStore {
    pub fn open(data_dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(data_dir).map_err(|e| format!("Failed to create data dir: {}", e))?;
        let conn = Connection::open(data_dir.join("zeromux.db")).map_err(|e| format!("Failed to open backlog db: {}", e))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS backlog_items (
                id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL, dir TEXT NOT NULL,
                prompt TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', created_ms INTEGER NOT NULL);
             CREATE INDEX IF NOT EXISTS idx_backlog_user ON backlog_items(user_id, created_ms DESC);",
        ).map_err(|e| format!("Failed to create backlog table: {}", e))?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn list(&self, user_id: &str) -> Result<Vec<BacklogItem>, String> {
        let conn = self.conn.lock().unwrap();
        let mut st = conn.prepare("SELECT id,type,dir,prompt,text,created_ms FROM backlog_items WHERE user_id=?1 ORDER BY created_ms DESC, rowid DESC")
            .map_err(|e| e.to_string())?;
        let rows = st.query_map(params![user_id], |r| Ok(BacklogItem { id: r.get(0)?, type_: r.get(1)?, dir: r.get(2)?,
            prompt: r.get(3)?, text: r.get(4)?, created_ms: r.get(5)? })).map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
    }

    /// INSERT then trim this user's oldest rows beyond MAX_ITEMS, under one lock.
    pub fn add(&self, user_id: &str, n: NewBacklogItem, now_ms: i64) -> Result<BacklogItem, String> {
        let item = BacklogItem { id: uuid::Uuid::new_v4().to_string(), type_: n.type_, dir: n.dir, prompt: n.prompt, text: n.text, created_ms: now_ms };
        let conn = self.conn.lock().unwrap();
        conn.execute("INSERT INTO backlog_items (id,user_id,type,dir,prompt,text,created_ms) VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![item.id, user_id, item.type_, item.dir, item.prompt, item.text, item.created_ms]).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM backlog_items WHERE user_id=?1 AND id NOT IN
                        (SELECT id FROM backlog_items WHERE user_id=?1 ORDER BY created_ms DESC, rowid DESC LIMIT ?2)",
            params![user_id, MAX_ITEMS as i64]).map_err(|e| e.to_string())?;
        Ok(item)
    }

    /// Owner-scoped (2026-08-09 lesson: writes mirror reads). Ok(false) = not found / not yours.
    pub fn remove(&self, user_id: &str, id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute("DELETE FROM backlog_items WHERE id=?1 AND user_id=?2", params![id, user_id]).map_err(|e| e.to_string())?;
        Ok(n == 1)
    }

    pub fn created_ms(&self, user_id: &str, id: &str) -> Option<i64> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT created_ms FROM backlog_items WHERE id=?1 AND user_id=?2", params![id, user_id], |r| r.get(0)).ok()
    }
}
```

`main.rs`：`mod backlog;`；`quick_targets_store` 之后

```rust
    let backlog_store = Arc::new(
        backlog::BacklogStore::open(std::path::Path::new(&data_dir_str)).expect("Failed to initialize backlog store"),
    );
```

`AppState` 加 `pub backlog: Arc<backlog::BacklogStore>,`，构造 `backlog: backlog_store,`。

- [ ] **Step 4: 实现 handlers**

```rust
const BACKLOG_TYPES: [&str; 4] = ["claude", "codex", "crew", "tmux"];
fn backlog_type_ok(t: &str) -> bool { BACKLOG_TYPES.contains(&t) }
/// Prompts keep newlines, so NOT sanitize_meta (which strips control chars).
fn cap_prompt(s: &str) -> String { s.chars().take(8000).collect() }

async fn list_backlog(State(state): State<Arc<AppState>>, user: axum::Extension<CurrentUser>)
    -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let items = state.backlog.list(&user.id).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(serde_json::json!({ "items": items })))
}

async fn add_backlog(State(state): State<Arc<AppState>>, user: axum::Extension<CurrentUser>,
    Json(req): Json<crate::backlog::NewBacklogItem>) -> Result<(StatusCode, Json<crate::backlog::BacklogItem>), (StatusCode, String)> {
    if !backlog_type_ok(&req.type_) { return Err((StatusCode::BAD_REQUEST, "bad type".into())); }
    validate_work_dir_under_home(&req.dir)?;
    let item = crate::backlog::NewBacklogItem { prompt: cap_prompt(&req.prompt), text: sanitize_meta(&req.text, 1000), ..req };
    let saved = state.backlog.add(&user.id, item, chrono::Utc::now().timestamp_millis())
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    tracing::info!(target: "zmx_usage", "backlog_add id={}", saved.id);
    Ok((StatusCode::CREATED, Json(saved)))
}

#[derive(serde::Deserialize)]
struct BacklogDeleteQuery { id: String, #[serde(default)] dispatched: Option<u8> }

/// DELETE uses a query param: nginx drops DELETE bodies (see forget_quick_target).
async fn remove_backlog(State(state): State<Arc<AppState>>, user: axum::Extension<CurrentUser>,
    Query(q): Query<BacklogDeleteQuery>) -> Result<StatusCode, (StatusCode, String)> {
    let created = state.backlog.created_ms(&user.id, &q.id);
    let removed = state.backlog.remove(&user.id, &q.id).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    if removed && q.dispatched == Some(1) {
        let age = created.map(|c| chrono::Utc::now().timestamp_millis() - c).unwrap_or(0);
        tracing::info!(target: "zmx_usage", "backlog_dispatch id={} age_ms={}", q.id, age);
    }
    Ok(StatusCode::NO_CONTENT)
}
```

路由（紧挨 `web.rs:79` 的 quick-targets）：`.route("/api/backlog", get(list_backlog).post(add_backlog).delete(remove_backlog))`。

- [ ] **Step 5: 运行测试通过**

Run: `cargo test`
Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add src/backlog.rs src/main.rs src/web.rs
git commit -m "feat(F5): server-side backlog_items (owner-scoped, cap 50) + /api/backlog

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 20: 前端待派发：⌘K 存入、分诊折叠组、派发

**Files:**
- Create: `frontend/src/lib/api/backlog.ts`、`frontend/src/lib/backlogBus.ts`、`frontend/src/lib/useBacklog.ts`
- Modify: `frontend/src/components/shell/useSessionsPoll.ts:75-89`（确认队列 30s `poll()` 顺带 `notifyBacklogChanged()`）
- Modify: `frontend/src/lib/api.ts`（`export * from './api/backlog'`）
- Modify: `frontend/src/components/shell/CommandPalette.tsx:40-50,78-90,223-231,311-316,onKey`
- Modify: `frontend/src/components/shell/AppShell.tsx:31,163`
- Modify: `frontend/src/components/shell/TriageList.tsx:12-27,82-83`
- Test: `frontend/src/components/shell/__tests__/CommandPalette.test.tsx`、`TriageList.test.tsx`、Create `frontend/src/lib/__tests__/useBacklog.test.tsx`、Create `frontend/src/components/shell/__tests__/useSessionsPoll.backlog.test.tsx`

**Interfaces:**
- Consumes: Task 19 API。
- Produces:
  - `BacklogItem { id; type: SessionType; dir; prompt; text; created_ms }`；`listBacklog()`、`addBacklog(i: { type; dir; prompt; text })`、`removeBacklog(id, opts?: { dispatched?: boolean })`
  - `notifyBacklogChanged()`、`subscribeBacklog(f)`
  - `useBacklog(): { items: BacklogItem[]; reload(): void }`（挂载 GET、bus、`visibilitychange→visible`；**不自带 interval**，30s 刷新来自 `useSessionsPoll` 的确认队列轮询经 bus 触发；失败保留旧列表）
  - `PaletteInit = { mode; text?; backlog?: BacklogItem; batch?: BacklogItem[] }`；`CommandPaletteProps.initial` 同型
  - `TriageListProps.backlog?: BacklogItem[]`、`onDispatchBacklog?(item: BacklogItem): void`、`onDeleteBacklog?(id: string): void`、`onBatchBacklog?(items: BacklogItem[]): void`（Task 21 使用）

- [ ] **Step 1: 写失败测试**

`useBacklog.test.tsx`：

```tsx
import { renderHook, act, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useBacklog } from '../useBacklog'
import { notifyBacklogChanged } from '../backlogBus'
import * as api from '../api'

const it1 = { id: 'b1', type: 'claude' as const, dir: '/w', prompt: 'p', text: 't', created_ms: 1 }

describe('useBacklog', () => {
  beforeEach(() => { vi.restoreAllMocks(); vi.useFakeTimers({ shouldAdvanceTime: true }) })
  afterEach(() => vi.useRealTimers())
  it('loads on mount, refreshes on bus / becoming visible; owns no interval; keeps the list on failure', async () => {
    const list = vi.spyOn(api, 'listBacklog').mockResolvedValue([it1])
    const { result } = renderHook(() => useBacklog())
    await waitFor(() => expect(result.current.items).toEqual([it1]))
    act(() => notifyBacklogChanged())
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(list).toHaveBeenCalledTimes(2)   // spec §7.2: no independent interval
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await waitFor(() => expect(list).toHaveBeenCalledTimes(3))
    list.mockRejectedValue(new Error('500'))
    act(() => notifyBacklogChanged())
    await act(async () => {})
    expect(result.current.items).toEqual([it1])
  })
})
```

`useSessionsPoll.backlog.test.tsx`（锁定「搭确认队列轮询的车」）：

```tsx
import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useSessionsPoll } from '../useSessionsPoll'
import { subscribeBacklog } from '../../../lib/backlogBus'
import * as api from '../../../lib/api'

describe('useSessionsPoll → backlog refresh (spec §7.2)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.spyOn(api, 'listSessionsWithHost').mockResolvedValue({ sessions: [], host_tmux: [] })
    vi.spyOn(api, 'getSchedulerHealth').mockResolvedValue({ heartbeat_ms: 0, healthy: true })
  })
  afterEach(() => vi.useRealTimers())
  const opts = () => ({ enabled: true, onAuthLost: vi.fn(), setSessions: vi.fn(), setHostTmux: vi.fn(), setActiveId: vi.fn(),
    docTabIds: () => [], setConfirmRuns: vi.fn(), setSchedulerHealthy: vi.fn(), onOpenFromPush: vi.fn(), activeId: null, autoSelect: false })

  it('every confirmation-queue tick (mount + 30s) also notifies the backlog bus', async () => {
    vi.spyOn(api, 'listConfirmations').mockResolvedValue({ count: 0, runs: [] })
    const seen = vi.fn()
    const off = subscribeBacklog(seen)
    renderHook(() => useSessionsPoll(opts()))
    await act(async () => {})
    expect(seen).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(30_000) })
    expect(seen).toHaveBeenCalledTimes(2)
    off()
  })

  it('a failed confirmations fetch still refreshes the backlog (independent sources)', async () => {
    vi.spyOn(api, 'listConfirmations').mockRejectedValue(new Error('500'))
    const seen = vi.fn()
    const off = subscribeBacklog(seen)
    renderHook(() => useSessionsPoll(opts()))
    await act(async () => {})
    expect(seen).toHaveBeenCalledTimes(1)
    off()
  })

  it('disabled poll (logged out) never notifies', async () => {
    const seen = vi.fn()
    const off = subscribeBacklog(seen)
    renderHook(() => useSessionsPoll({ ...opts(), enabled: false }))
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(seen).not.toHaveBeenCalled()
    off()
  })
})
``````

`TriageList.test.tsx` 追加：

```tsx
  it('待派发 group: hidden when empty, open by default when N>0, row click dispatches, ⋯ 删除', () => {
    const item = { id: 'b1', type: 'codex' as const, dir: '/home/u/My Project', prompt: '修 bug\n细节', text: 'codex …', created_ms: 1 }
    const onDispatch = vi.fn(), onDelete = vi.fn()
    const { rerender } = render(<TriageList sessions={[]} activeId={null} onSelect={vi.fn()} lastViewedMs={{}} confirmsBySession={{}}
      controls={{ current: {} }} actionsFor={() => []} now={NOW} backlog={[]} />)
    expect(screen.queryByText(/待派发/)).toBeNull()
    rerender(<TriageList sessions={[]} activeId={null} onSelect={vi.fn()} lastViewedMs={{}} confirmsBySession={{}}
      controls={{ current: {} }} actionsFor={() => []} now={NOW} backlog={[item]} onDispatchBacklog={onDispatch} onDeleteBacklog={onDelete} />)
    const details = screen.getByText('待派发 (1)').closest('details')!
    expect(details.open).toBe(true)
    expect(screen.getByText('修 bug')).toBeInTheDocument()
    expect(screen.getByText('My Project')).toBeInTheDocument()
    fireEvent.click(screen.getByText('修 bug'))
    expect(onDispatch).toHaveBeenCalledWith(item)
    fireEvent.click(screen.getByRole('button', { name: '待派发菜单' }))
    fireEvent.click(screen.getByText('删除'))
    expect(onDelete).toHaveBeenCalledWith('b1')
  })
```

`CommandPalette.test.tsx` 追加（沿用文件内 `setup`/`shell`/`flush`）：

```tsx
  it('存入待派发 stores the RESOLVED dir, closes, toasts; disabled while the dir is unresolved', async () => {
    const add = vi.spyOn(api, 'addBacklog').mockResolvedValue({ id: 'b', type: 'claude', dir: '/abs/x', prompt: 'hi', text: '', created_ms: 1 })
    const { onClose, type } = setup({ initial: { mode: 'new' } })
    type('claude /abs/x hi')
    fireEvent.click(screen.getByRole('button', { name: '存入待派发' }))
    await flush()
    expect(add).toHaveBeenCalledWith({ type: 'claude', dir: '/abs/x', prompt: 'hi', text: 'claude /abs/x hi' })
    expect(onClose).toHaveBeenCalled()
  })

  it('dispatch keeps stored dir with spaces and multi-line prompt', async () => {
    const item = { id: 'b1', type: 'codex' as const, dir: '/home/u/My Project', prompt: '第一行\n第二行', text: '', created_ms: 1 }
    const remove = vi.spyOn(api, 'removeBacklog').mockResolvedValue()
    const sh = shell()
    setup({ sh, initial: { mode: 'new', backlog: item } })
    expect(screen.getByTestId('palette-preview').textContent).toContain('/home/u/My Project')
    fireEvent.click(screen.getByTestId('palette-preview'))
    await flush()
    expect(sh.create).toHaveBeenCalledWith('codex', '/home/u/My Project', undefined, '第一行\n第二行')
    expect(remove).toHaveBeenCalledWith('b1', { dispatched: true })
  })

  it('failed create keeps the backlog item', async () => {
    const item = { id: 'b1', type: 'claude' as const, dir: '/gone', prompt: 'p', text: '', created_ms: 1 }
    const remove = vi.spyOn(api, 'removeBacklog').mockResolvedValue()
    const sh = shell({ create: vi.fn().mockRejectedValue(new Error('目录不存在')) })
    setup({ sh, initial: { mode: 'new', backlog: item } })
    fireEvent.click(screen.getByTestId('palette-preview'))
    await flush()
    expect(screen.getByRole('alert').textContent).toContain('目录不存在')
    expect(remove).not.toHaveBeenCalled()
  })
```

- [ ] **Step 2: 运行，确认失败**

Run: `cd frontend && npx vitest run src/lib/__tests__/useBacklog.test.tsx src/components/shell/__tests__/useSessionsPoll.backlog.test.tsx src/components/shell/__tests__/TriageList.test.tsx src/components/shell/__tests__/CommandPalette.test.tsx`
Expected: FAIL。

- [ ] **Step 3: 实现 API + bus + hook**

`lib/api/backlog.ts`：

```ts
import { api } from './core'
import type { SessionType } from './sessions'

export interface BacklogItem { id: string; type: SessionType; dir: string; prompt: string; text: string; created_ms: number }

export async function listBacklog(): Promise<BacklogItem[]> {
  const res = await api('/api/backlog')
  if (!res.ok) throw new Error(await res.text())
  return (await res.json()).items
}
export async function addBacklog(i: { type: SessionType; dir: string; prompt: string; text: string }): Promise<BacklogItem> {
  const res = await api('/api/backlog', { method: 'POST', body: JSON.stringify(i) })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}
export async function removeBacklog(id: string, opts: { dispatched?: boolean } = {}): Promise<void> {
  const q = new URLSearchParams({ id, ...(opts.dispatched ? { dispatched: '1' } : {}) })
  const res = await api(`/api/backlog?${q}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(await res.text())
}
```

`lib/backlogBus.ts`（同 `quickTargetsBus.ts` 形状）：

```ts
const listeners = new Set<() => void>()
export function notifyBacklogChanged(): void { for (const f of Array.from(listeners)) f() }
export function subscribeBacklog(f: () => void): () => void { listeners.add(f); return () => { listeners.delete(f) } }
```

`lib/useBacklog.ts`：

```ts
import { useCallback, useEffect, useState } from 'react'
import { listBacklog, type BacklogItem } from './api'
import { subscribeBacklog } from './backlogBus'
import { useLatestRequest } from './useLatestRequest'

/** Cross-device backlog (D20): mount GET, in-tab bus, and on becoming visible. The 30s
 *  refresh rides useSessionsPoll's confirmation-queue tick via the bus (spec §7.2). */
export function useBacklog(): { items: BacklogItem[]; reload(): void } {
  const [items, setItems] = useState<BacklogItem[]>([])
  const req = useLatestRequest()
  const reload = useCallback(() => {
    const t = req.begin()
    listBacklog().then(l => { if (req.isCurrent(t)) setItems(l) }).catch(() => { /* keep the last list */ })
  }, [req])
  useEffect(() => {
    reload()
    const off = subscribeBacklog(reload)
    const onVis = () => { if (document.visibilityState === 'visible') reload() }
    document.addEventListener('visibilitychange', onVis)
    return () => { off(); document.removeEventListener('visibilitychange', onVis) }
  }, [reload])
  return { items, reload }
}
```

`components/shell/useSessionsPoll.ts:75-89` 的确认队列轮询改为（每次 tick 都通知，不依赖确认队列请求成败；`enabled=false` 时 effect 不运行，自然不通知）：

```ts
  // Poll the confirmation queue so the triage badges stay live (now + every 30s).
  // The same tick refreshes the cross-device backlog (spec §7.2: no separate interval).
  useEffect(() => {
    if (!o.enabled) return
    let cancelled = false
    const poll = async () => {
      notifyBacklogChanged()
      try {
        const r = await listConfirmations()
        if (!cancelled) ref.current.setConfirmRuns(r.runs)
      } catch { /* ignore transient */ }
    }
    poll()
    const id = setInterval(poll, 30_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [o.enabled])
```

import `notifyBacklogChanged` from `'../../lib/backlogBus'`。挂载时 `useBacklog` 自己 GET 一次，`poll()` 的首次调用也会通知一次——首屏最多两次 GET，由 `useLatestRequest` 保证后到的旧响应不覆盖。

- [ ] **Step 4: 实现 ⌘K**

`CommandPaletteProps.initial` 改为 `initial?: { mode: 'search' | 'new'; text?: string; backlog?: BacklogItem; batch?: BacklogItem[] }`。`PaletteBody`：

```tsx
  const fromBacklog = initial?.backlog
  // A backlog item dispatches its STORED fields: the single-line input can't carry a
  // multi-line prompt, and re-parsing a dir with spaces would split it (Review Focus 1).
  const [pristine, setPristine] = useState(!!fromBacklog)
  const [text, setText] = useState(initial?.text ?? (fromBacklog ? `${fromBacklog.type} ${fromBacklog.dir} ${fromBacklog.prompt.replace(/\s+/g, ' ')}` : ''))
```

在 `onChange` 里加 `setPristine(false)`。`resolvedDir` / `newType` / prompt 在 `pristine && fromBacklog` 时取存储值：

```tsx
  const useStored = pristine && !!fromBacklog
  const newType: NewType = useStored ? fromBacklog!.type : (parsed.type ?? loadLastType())
  const storedDir = useStored ? fromBacklog!.dir : null
  const promptText = useStored ? fromBacklog!.prompt : parsed.prompt
```

`resolvedDir` 表达式首项加 `useStored ? storedDir :`；`preview` 与 `submitNew` 使用 `promptText`；`submitNew` 的 `after` 回调在成功时 `if (fromBacklog) void removeBacklog(fromBacklog.id, { dispatched: true }).then(notifyBacklogChanged).catch(() => {})`（失败路径 `runCreate` 不调 `after`，条目保留）。

在 `palette-preview` 按钮之后加：

```tsx
          {newType !== 'vault' && !fromBacklog && (
            <button type="button" onClick={saveToBacklog} disabled={resolvedDir === null || creating}
              className="ctl w-full min-h-[44px] rounded-[var(--r-md)] border border-[var(--border)] text-ui-sm text-[var(--fg-muted)] disabled:opacity-60">存入待派发</button>
          )}
```

```tsx
  const saveToBacklog = async () => {
    if (resolvedDir === null || newType === 'vault') return
    try {
      await addBacklog({ type: newType as SessionType, dir: resolvedDir, prompt: promptText, text })
      notifyBacklogChanged()
      toast.push({ message: '已存入待派发' })
      onClose()
    } catch (e) { toast.push({ message: `无法保存：${(e as Error).message}` }) }
  }
```

`onKey` 的 Enter 分支前加 `if (e.key === 'Enter' && e.altKey && newMode) { e.preventDefault(); void saveToBacklog(); return }`。import `addBacklog, removeBacklog, type BacklogItem`、`notifyBacklogChanged`、`toast`。

说明：`resolvedDir` 为 `''`（「默认目录」）时 `validate_work_dir_under_home('')` 会 400——在 `saveToBacklog` 里对空串直接 `toast.push({ message: '请先指定目录' })` 并返回。

- [ ] **Step 5: 实现分诊组 + AppShell 接线**

`TriageList` props 加 `backlog?`、`onDispatchBacklog?`、`onDeleteBacklog?`；在 `<Group title="空闲" …/>` 之后、host tmux 之前：

```tsx
      {backlog.length > 0 && <BacklogGroup items={backlog} onDispatch={p.onDispatchBacklog} onDelete={p.onDeleteBacklog} />}
```

```tsx
function BacklogGroup({ items, onDispatch, onDelete }: { items: BacklogItem[]; onDispatch?(i: BacklogItem): void; onDelete?(id: string): void }) {
  const [open, setOpen] = useState(true)   // V21: open by default; user collapse remembered for this page life
  return (
    <details className="mx-1 mt-2" open={open} onToggle={e => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="row px-2 flex items-center cursor-pointer text-ui-2xs font-semibold text-[var(--fg-subtle)]">{`待派发 (${items.length})`}</summary>
      <ul role="list" aria-label="待派发">
        {items.map(i => <BacklogRow key={i.id} i={i} onDispatch={onDispatch} onDelete={onDelete} />)}
      </ul>
    </details>
  )
}

function BacklogRow({ i, onDispatch, onDelete }: { i: BacklogItem; onDispatch?(i: BacklogItem): void; onDelete?(id: string): void }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const [menu, setMenu] = useState(false)
  const first = i.prompt.split('\n').find(l => l.trim()) ?? '(无 prompt)'
  const short = i.dir.split('/').filter(Boolean).pop() ?? i.dir
  return (
    <li role="listitem" onClick={() => onDispatch?.(i)}
      className="row min-h-[56px] mx-1 px-2 rounded-[var(--r-md)] cursor-pointer flex items-center gap-2 hover:bg-[var(--surface-hover)]">
      <TypeIcon type={i.type} size={14} className="shrink-0 text-[var(--fg-muted)]" />
      <span className="flex-1 min-w-0 truncate text-ui-sm text-[var(--fg)]">{first}</span>
      <span className="shrink-0 max-w-[35%] truncate text-ui-2xs text-[var(--fg-subtle)]" title={i.dir}>{short}</span>
      <span className="shrink-0" onClick={e => e.stopPropagation()}>
        <IconButton ref={setAnchor} label="待派发菜单" icon={MoreHorizontal} size="sm" onClick={() => setMenu(v => !v)} aria-haspopup="menu" aria-expanded={menu} />
        <Menu open={menu} onClose={() => setMenu(false)} anchor={anchor} title={first} items={[{ label: '删除', danger: true, onSelect: () => onDelete?.(i.id) }]} />
      </span>
    </li>
  )
}
```

import `TypeIcon`、`type BacklogItem`。`AppShell.tsx:31`：`type PaletteInit = { mode: 'search' | 'new'; text?: string; backlog?: BacklogItem; batch?: BacklogItem[] }`；`const backlog = useBacklog()`；`<TriageList …>` 追加：

```tsx
      backlog={backlog.items}
      onDispatchBacklog={item => openPalette({ mode: 'new', backlog: item })}
      onDeleteBacklog={id => { void removeBacklog(id).then(notifyBacklogChanged).catch(() => toast.push({ message: '删除失败' })) }}
```

（`TriageList` 用 `latest` ref 转发回调——新回调需照 `onSelect` 的写法包一层 `useCallback(... latest.current ...)`，否则 BacklogRow 每 3s 重渲染无妨但保持一致：`const onDispatch = useCallback((i: BacklogItem) => latest.current.onDispatchBacklog?.(i), [])`。）

- [ ] **Step 6: 运行测试通过 + 全量**

Run: `cd frontend && npx vitest run src/lib/__tests__/useBacklog.test.tsx src/components/shell/__tests__ && npm test && npm run lint && npm run build`
Expected: 全绿；首屏增量 ≤ 0.8KB。

- [ ] **Step 7: Commit**

```bash
git add frontend/src
git commit -m "feat(F5): 存入待派发 in ⌘K, 待派发 triage group, dispatch uses stored dir/prompt

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 21: F6 批量派发 + 目标徽标

**Files:**
- Create: `frontend/src/lib/batchDispatch.ts`
- Modify: `frontend/src/lib/triage.ts`（`goalLabel`）
- Modify: `frontend/src/components/shell/TriageRow.tsx:67-68`（徽标）
- Modify: `frontend/src/components/shell/TriageList.tsx`（`BacklogGroup` 选择模式）
- Modify: `frontend/src/components/shell/CommandPalette.tsx`（`batch` 预览 + `runBatch`）
- Modify: `frontend/src/components/shell/AppShell.tsx`（`onBatchBacklog`）
- Test: Create `frontend/src/lib/__tests__/batchDispatch.test.ts`；`triage.test.ts`、`TriageList.test.tsx`、`CommandPalette.test.tsx`

**Interfaces:**
- Consumes: Task 20 `BacklogItem`、`removeBacklog`、`PaletteInit.batch`；既有 `createSession(type, name?, workDir?, tmuxTarget?, initialPrompt?)`、`updateSession(id, { description })`、`shell.reload` 经 `openSession` 不适用——批量结束调用 `ShellState` 新增的 `reload(): Promise<void>`（在 `useShellState` 返回对象里导出现有 `reload`）。
- Produces:
  - `export const BATCH_MAX = 6`
  - `export type BatchStatus = 'queued' | 'creating' | 'done' | 'failed'`
  - `runBatch(items: BacklogItem[], opts: { label: string; aborted: () => boolean; onStatus(id: string, s: BatchStatus, err?: string): void }, deps: { create; describe; remove; sleep }): Promise<{ ok: number; failed: number }>`
  - `goalLabel(description: string): string | null`
  - `ShellState.reload(): Promise<void>`

- [ ] **Step 1: 写失败测试**

`batchDispatch.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest'
import { runBatch } from '../batchDispatch'

const mk = (id: string, type = 'claude' as const) => ({ id, type, dir: `/w/${id}`, prompt: `p-${id}`, text: '', created_ms: 1 })

describe('runBatch', () => {
  it('serial with 200ms gaps, labels, removes only successes, keeps failures', async () => {
    const log: string[] = []
    const deps = {
      create: vi.fn(async (t: string, dir: string, p?: string) => { log.push(`create ${dir}`); if (dir === '/w/b') throw new Error('boom'); return { id: `s-${dir}` } }),
      describe: vi.fn(async (id: string, d: string) => { log.push(`desc ${id} ${d}`) }),
      remove: vi.fn(async (id: string) => { log.push(`rm ${id}`) }),
      sleep: vi.fn(async (ms: number) => { log.push(`sleep ${ms}`) }),
    }
    const st: Record<string, string> = {}
    const r = await runBatch([mk('a'), mk('b'), mk('c')], { label: '发布', aborted: () => false, onStatus: (id, s) => { st[id] = s } }, deps)
    expect(r).toEqual({ ok: 2, failed: 1 })
    expect(log).toEqual(['create /w/a', 'desc s-/w/a 目标：发布', 'rm a', 'sleep 200', 'create /w/b', 'sleep 200', 'create /w/c', 'desc s-/w/c 目标：发布', 'rm c'])
    expect(st).toEqual({ a: 'done', b: 'failed', c: 'done' })
  })
  it('stops when aborted; already-sent requests stand', async () => {
    let n = 0
    const deps = { create: vi.fn(async () => ({ id: 's' })), describe: vi.fn(), remove: vi.fn(async () => {}), sleep: vi.fn(async () => {}) }
    const r = await runBatch([mk('a'), mk('b'), mk('c')], { label: '', aborted: () => n++ >= 1, onStatus: () => {} }, deps)
    expect(deps.create).toHaveBeenCalledTimes(1)
    expect(r.ok).toBe(1)
  })
  it('no label → no describe; tmux items get no prompt', async () => {
    const deps = { create: vi.fn(async () => ({ id: 's' })), describe: vi.fn(), remove: vi.fn(async () => {}), sleep: vi.fn(async () => {}) }
    await runBatch([mk('t', 'tmux' as never)], { label: '  ', aborted: () => false, onStatus: () => {} }, deps)
    expect(deps.describe).not.toHaveBeenCalled()
    expect(deps.create).toHaveBeenCalledWith('tmux', '/w/t', undefined)
  })
})
```

`triage.test.ts` 追加：

```ts
import { goalLabel } from '../triage'
describe('goalLabel', () => {
  it('only for 目标： prefix, 8 chars max by char', () => {
    expect(goalLabel('随便写的')).toBeNull()
    expect(goalLabel('目标：')).toBeNull()
    expect(goalLabel('目标：发布 v2')).toBe('发布 v2')
    expect(goalLabel('目标：一二三四五六七八九')).toBe('一二三四五六七八…')
    expect(goalLabel('目标：🚀🚀🚀🚀🚀🚀🚀🚀🚀')).toBe('🚀🚀🚀🚀🚀🚀🚀🚀…')
  })
})
```

`TriageList.test.tsx` 追加：

```tsx
  it('goal badge survives a running step and same() re-renders on description change only', () => {
    let renders = 0
    const s = mkSession('g', { name: 'fe', description: '目标：发布 v2', turn_state: 'running', turn_started_ms: NOW, last_activity_ms: NOW, current_step: 'Edit · a.ts' })
    const props = { activeId: null, onSelect: vi.fn(), lastViewedMs: {}, confirmsBySession: {}, controls: { current: {} }, actionsFor: () => [], now: NOW, onRowRender: () => { renders++ } }
    const { rerender } = render(<TriageList sessions={[s]} {...props} />)
    expect(screen.getByText('发布 v2')).toBeInTheDocument()
    expect(screen.getByText('Edit · a.ts')).toBeInTheDocument()
    const r0 = renders
    rerender(<TriageList sessions={[{ ...s }]} {...props} />)
    expect(renders).toBe(r0)
    rerender(<TriageList sessions={[{ ...s, description: '目标：改名' }]} {...props} />)
    expect(renders).toBe(r0 + 1)
    expect(screen.getByText('改名')).toBeInTheDocument()
  })
  it('backlog select mode: 并行派发 N 项 disabled beyond 6', () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ id: `b${i}`, type: 'claude' as const, dir: '/w', prompt: `p${i}`, text: '', created_ms: i }))
    const onBatch = vi.fn()
    render(<TriageList sessions={[]} activeId={null} onSelect={vi.fn()} lastViewedMs={{}} confirmsBySession={{}} controls={{ current: {} }}
      actionsFor={() => []} now={NOW} backlog={items} onBatchBacklog={onBatch} />)
    fireEvent.click(screen.getByRole('button', { name: '选择' }))
    for (const i of items) fireEvent.click(screen.getByRole('checkbox', { name: i.prompt }))
    expect(screen.getByRole('button', { name: '并行派发 7 项' })).toBeDisabled()
    expect(screen.getByText('最多 6 项')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'p6' }))
    fireEvent.click(screen.getByRole('button', { name: '并行派发 6 项' }))
    expect(onBatch).toHaveBeenCalledWith(items.slice(0, 6))
  })
```

`CommandPalette.test.tsx` 追加：

```tsx
  it('batch preview lists items, marks tmux 无 prompt, runs and toasts 已派发 N 项', async () => {
    vi.spyOn(api, 'createSession').mockResolvedValue(mkSession('n'))
    vi.spyOn(api, 'updateSession').mockResolvedValue(undefined as never)
    vi.spyOn(api, 'removeBacklog').mockResolvedValue()
    const sh = shell({ reload: vi.fn().mockResolvedValue(undefined) } as Partial<ShellState>)
    const batch = [{ id: 'a', type: 'claude' as const, dir: '/w/a', prompt: '修 a', text: '', created_ms: 1 },
                   { id: 't', type: 'tmux' as const, dir: '/w/t', prompt: 'x', text: '', created_ms: 2 }]
    const { onClose } = setup({ sh, initial: { mode: 'new', batch } })
    expect(screen.getByText('无 prompt')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('目标标签'), { target: { value: '发布' } })
    fireEvent.click(screen.getByRole('button', { name: '派发 2 项' }))
    await flush(1000)
    expect(api.updateSession).toHaveBeenCalledWith('n', { description: '目标：发布' })
    expect(sh.reload).toHaveBeenCalledTimes(1)
    expect(sh.select).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })
```

- [ ] **Step 2: 运行，确认失败**

Run: `cd frontend && npx vitest run src/lib/__tests__/batchDispatch.test.ts src/lib/__tests__/triage.test.ts src/components/shell/__tests__/TriageList.test.tsx src/components/shell/__tests__/CommandPalette.test.tsx`
Expected: FAIL。

- [ ] **Step 3: 实现纯函数**

`lib/batchDispatch.ts`：

```ts
import type { BacklogItem } from './api'

export const BATCH_MAX = 6
export type BatchStatus = 'queued' | 'creating' | 'done' | 'failed'

/** F6 (D14): serial create inside ⌘K. No focus moves (shell.create would setActiveId each time). */
export async function runBatch(
  items: BacklogItem[],
  opts: { label: string; aborted: () => boolean; onStatus(id: string, s: BatchStatus, err?: string): void },
  deps: {
    create(type: string, dir: string, prompt?: string): Promise<{ id: string }>
    describe(id: string, description: string): Promise<unknown>
    remove(id: string): Promise<unknown>
    sleep(ms: number): Promise<void>
  },
): Promise<{ ok: number; failed: number }> {
  let ok = 0, failed = 0
  const label = opts.label.trim()
  for (let i = 0; i < items.length; i++) {
    if (opts.aborted()) break
    const it = items[i]
    opts.onStatus(it.id, 'creating')
    try {
      const s = await deps.create(it.type, it.dir, it.type === 'tmux' ? undefined : (it.prompt || undefined))
      if (label) await deps.describe(s.id, `目标：${label}`)
      await deps.remove(it.id).catch(() => {})
      opts.onStatus(it.id, 'done'); ok++
    } catch (e) {
      opts.onStatus(it.id, 'failed', (e as Error).message); failed++
    }
    if (i < items.length - 1) await deps.sleep(200)
  }
  return { ok, failed }
}
```

`triage.ts`：

```ts
/** V13: 「目标：X」 description → X (≤ 8 chars, by code point). */
export function goalLabel(description: string): string | null {
  if (!description.startsWith('目标：')) return null
  const chars = [...description.slice(3).trim()]
  if (chars.length === 0) return null
  return chars.length > 8 ? chars.slice(0, 8).join('') + '…' : chars.join('')
}
```

- [ ] **Step 4: 实现 UI**

`TriageRow.tsx:67-68` 名称 span 之后：

```tsx
        {goal && <span data-goal className="shrink-0 max-w-[40%] truncate text-ui-2xs text-[var(--fg-subtle)] border border-[var(--border)] rounded-full px-1.5">{goal}</span>}
```

其中 `const goal = goalLabel(s.description)`（组件内）；`same()` 已比较 `description`，不改。

`TriageList` 的 `BacklogGroup` 追加选择模式：state `selecting`、`picked: Set<string>`；summary 行右侧 `<button type="button" onClick={e => { e.preventDefault(); setSelecting(v => !v); setPicked(new Set()) }} className="ctl ml-auto px-2 text-ui-2xs">{selecting ? '取消' : '选择'}</button>`（仅当 `onBatch` 存在）；`BacklogRow` 在 `selecting` 时行首渲染 `<input type="checkbox" aria-label={first} checked={picked.has(i.id)} onChange={…} onClick={e => e.stopPropagation()} className="w-5 h-5" />`，且整行点击改为切换勾选；列表下方：

```tsx
      {selecting && (
        <div className="px-2 py-1 flex items-center gap-2">
          <button type="button" disabled={picked.size === 0 || picked.size > BATCH_MAX} onClick={() => onBatch?.(items.filter(x => picked.has(x.id)))}
            className="ctl min-h-[44px] px-3 rounded-[var(--r-md)] bg-[var(--accent)] text-[var(--on-accent)] text-ui-sm disabled:opacity-50">{`并行派发 ${picked.size} 项`}</button>
          {picked.size > BATCH_MAX && <span className="text-ui-2xs text-[var(--attention)]">最多 6 项</span>}
        </div>
      )}
```

`TriageListProps` 加 `onBatchBacklog?(items: BacklogItem[]): void`。`AppShell`：`onBatchBacklog={items => openPalette({ mode: 'new', batch: items })}`。`useShellState` 的 `ShellState` 接口与返回对象加 `reload`（已存在的 `const { reload } = useSessionsPoll(...)`）；`CommandPalette.test.tsx` 的 `shell()` 工厂补 `reload: vi.fn().mockResolvedValue(undefined), openSession: vi.fn()`。

`CommandPalette` 在 `initial?.batch` 存在时渲染批量预览替代 new mode 主体：

```tsx
function BatchPreview({ items, shell, onClose, onNext }: { items: BacklogItem[]; shell: ShellState; onClose(): void; onNext?(): void }) {
  const [label, setLabel] = useState('')
  const [status, setStatus] = useState<Record<string, { s: BatchStatus; err?: string }>>({})
  const [running, setRunning] = useState(false)
  const abortRef = useRef(false)
  useEffect(() => () => { abortRef.current = true }, [])   // closing stops the remaining items
  const tone = (s?: BatchStatus) => s === 'done' ? 'running' : s === 'failed' ? 'danger' : s === 'creating' ? 'attention' : 'muted'
  const go = async () => {
    if (running) return
    setRunning(true)
    const r = await runBatch(items, { label, aborted: () => abortRef.current, onStatus: (id, s, err) => setStatus(p => ({ ...p, [id]: { s, err } })) }, {
      create: (t, d, p) => createSession(t as SessionType, undefined, d, undefined, p),
      describe: (id, description) => updateSession(id, { description }),
      remove: id => removeBacklog(id, { dispatched: true }),
      sleep: ms => new Promise(res => setTimeout(res, ms)),
    })
    notifyBacklogChanged()
    await shell.reload()
    setRunning(false)
    if (r.failed === 0) {
      toast.push({ message: `已派发 ${r.ok} 项`, action: { label: '下一个', onClick: () => onNext?.() } })
      onClose()
    }
  }
  return (
    <div className="p-2 space-y-2">
      <ul className="space-y-1">
        {items.map(i => (
          <li key={i.id} className="flex items-center gap-2 text-ui-sm">
            <StatusDot tone={tone(status[i.id]?.s)} label={status[i.id]?.s ?? 'queued'} />
            <TypeIcon type={i.type} size={14} />
            <span className="shrink-0 max-w-[30%] truncate text-ui-2xs text-[var(--fg-subtle)]">{i.dir.split('/').filter(Boolean).pop()}</span>
            <span className="flex-1 min-w-0 truncate">{i.type === 'tmux' ? '无 prompt' : (i.prompt.split('\n')[0] || '(无 prompt)')}</span>
            {status[i.id]?.err && <span className="shrink-0 text-ui-2xs text-[var(--danger)] truncate max-w-[30%]">{status[i.id]!.err}</span>}
          </li>
        ))}
      </ul>
      <label className="block text-ui-2xs text-[var(--fg-subtle)]" htmlFor="batch-goal">目标标签</label>
      <input id="batch-goal" value={label} onChange={e => setLabel(e.target.value)} maxLength={40}
        className="w-full min-h-[44px] px-2 bg-[var(--surface-2)] border border-[var(--border)] rounded text-ui-input" />
      <p className="text-ui-2xs text-[var(--fg-subtle)]">若服务端开启了 worktree 隔离，每项约 24 秒</p>
      <button type="button" onClick={go} disabled={running}
        className="ctl w-full min-h-[48px] rounded-[var(--r-md)] bg-[var(--accent)] text-[var(--on-accent)] text-ui-sm disabled:opacity-60">{`派发 ${items.length} 项`}</button>
    </div>
  )
}
```

`PaletteBody` 渲染处：`{initial?.batch ? <BatchPreview items={initial.batch} shell={shell} onClose={onClose} onNext={onNext} /> : newMode ? (…原 new mode…) : (…search…)}`。`CommandPaletteProps` 加 `onNext?(): void`，`AppShell` 的 `<CommandPalette>` 传 `onNext={next}`。

- [ ] **Step 5: 运行测试通过 + 全量**

Run: `cd frontend && npx vitest run src/lib/__tests__/batchDispatch.test.ts src/lib/__tests__/triage.test.ts src/components/shell/__tests__ src/__tests__/App.characterization.test.tsx && npm test && npm run lint && npm run build`
Expected: 全绿；徽标首屏增量 ≤ 0.2KB，S6 首屏累计 ≤ 3KB（记录最终 br 数值并更新 spec §1 预算表）。

- [ ] **Step 6: Commit + 上线（S6-f）**

```bash
git add frontend/src
git commit -m "feat(F6): batch dispatch inside ⌘K + 目标 badge on triage rows

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push
./deploy.sh --build
```

退出标准：手机新增待派发 → 桌面 ≤30s 或切回窗口时可见；批量派发 4 项成功、焦点不跳转、行上带「目标」徽标。

---

## 评估（S6-e 上线满 14 天后，非代码 task）

按 spec §14 跑 M1–M6 的命令（`journalctl -u zeromux --since … | grep zmx_usage`、`zeromux.db`/`scheduled.db` 查询），结果与原始输出写入 `docs/superpowers/audits/<日期>-s6-metrics.md`。T9（子会话折叠）只在 §9.1 门槛 T 满足后另起计划。

---

## Self-Review

**1. Spec 覆盖**

| spec 节 | Task |
|---|---|
| §12 T0 已读 + `read_wait` | 1、2 |
| §2.2 数据模型 / V10 SET / gate_phase orphan | 3 |
| §2.3 `run_gate`、D1、V15、截断 | 4 |
| §2.3 tick 分流、V16 复核、推送、`failure_kind_zh`；§2.5 gate-test；§2.8 replay 不跑 gate | 5 |
| §2.6 前端 | 6 |
| §6 F8 | 7 |
| §3.2 normalize（slots/回答/mid/cursor） | 8 |
| §3.2 `set_crew_busy`、§3.4 豁免、§3.5 列 | 9 |
| §3.2 fan-out 分支、`settle_crew_answer`、§3.3 ask 推送 + V18 分 key 去抖 | 10 |
| §3.9 补发 + 30s 轮询 + 断连 ≥3 条合并推送 + M5 埋点 | 11 |
| §3.6 hook（V7） | 12 |
| §3.6 triage/TriageRow/回答卡；§0.1「并行话题」chip | 13 |
| §4.2 快照类型与纯函数、V19；§4.2 G7b（V18） | 14 |
| §4.2 主循环/推送/深链、§3.9 重启拉起、§4.3 离开卡 | 15 |
| §13 G9 | 16 |
| §5.2 F7 | 17 |
| §5.4 F7b | 18 |
| §7 F5 后端 / 前端 | 19、20 |
| §8 F6 + 目标徽标 | 21 |
| §9 T9 | 门槛未过，按 spec 不写代码 |
| §14 指标 | M1（Task 1）、M3（Task 19）、M5（Task 11）埋点已含；M2/M4/M6 为查询/手测，列在评估节 |

**2. 占位扫描**：无 TBD；无「类似 Task N」；每个代码步骤都给了代码。

**3. 类型一致性**：`ReadOutcome`/`read_wait_ms`（T1）；`GateOutcome`/`GateVerdict`/`GateStep`/`run_gated`（T4–5）；`NormState::for_topics`、`crew_busy/crew_cursor/crew_needs_input/crew_catchup/crew_gap`（T8、T10、T11、T12 同名）；`set_crew_busy`/`set_crew_cursor`/`set_awaiting_input`/`settle_crew_answer`（T9–10）；`KindDebounce::claim` 与 key `"crew:"+slot`（T10、T15）；`SlotsSnapshot`/`CronJobView`/`CronRunView`/`job_id_ok`（T14–16）；`BacklogItem` Rust `type_`（serde rename `type`）与 TS `type`（T19–21）。

**4. Review Focus**：5 条均已在所属 task 写了用例（Task 20 `dispatch keeps stored dir…`、Task 10 `kind_debounce_claim_is_atomic_across_threads`、Task 4 `tail_is_char_safe_on_cjk_and_invalid_utf8`、Task 10 `topics_exit_clears_busy`、Task 2 `reporter drops 404 without retry`）。

**spec 与代码不一致之处（实施时以本计划为准，均已在对应 task 处理）**

1. spec §3.3 写「去抖判定复用 `should_push_stuck` 的形状」（先读后写两步）；现有 stuck 路径在 tick 内同步 mark 所以安全，但 ask 推送来自 fan-out 里 `tokio::spawn` 的多个任务，先读后写会竞态 → 改为单锁 `KindDebounce::claim`（Task 10）。
2. spec §2.8 用「pid 探活确认 `sh` 不是 zombie」；`sh -c 'sleep 999'` 会被 `exec` 优化成 sleep 本身，测不到孙进程 → 测试命令改为 `echo $$; sleep 999 & echo $!; wait`（Task 4）。
3. spec §3.2 的忙闲只由 `crew_busy` 驱动，没有覆盖 `Exit`：话题会话 busy 时 slot 消失（`crew_process.rs` 的 `break 'outer -1`）会发 `Exit`，但不会再有 `crew_busy{0}`，在 `mark_fanout_ended` 清掉 `running` 之前，`turn_is_running` 和 `running_summary` 一直是 Running → `Exit` 时显式 `set_crew_busy(false)`（Task 10）。
4. spec §4.1 的 `payload_for(` 调用点清单（`session_manager.rs:1099,2815,3027,3044`，`scheduled_tasks.rs:1040,1147`，`web.rs:6809`）在 `33c2236` 上成立；S5 U4 给 `payload_for` 加了 `body` 参数后行号会漂移，本计划不依赖这些行号。
5. spec §7.2 派发时预填 `${type} ${dir} ${prompt}` 进 ⌘K 单行输入，目录含空格或 prompt 含换行时会被 `parseNew` 切坏 → 未改动时按存储字段派发（Task 20，Review Focus 1）。
