# 消息队列 collect + auto-titler 实现计划

> **实现进度(2026-06-09 code review 后更新):**
> - ✅ **Task 1–4 已合并**:`name_is_auto` 持久化、用户改名锁定、`set_auto_title`/`session_name_is_auto`/`titler_cli_for` 访问器、三个纯函数(`merge_pending`/`is_substantive_prompt`/`sanitize_title`)含单测。
> - ✅ **Task 6/7/9/10 已实现(collect 全功能)**:三个 fanout 接入排队+防抖(500ms)+硬上限(3000ms)+第三 select 臂 flush;`run_id` prompt 绕行(C3);Interrupt 无条件清队列(E5);`queued` 事件 ephemeral(E7,ws_handler 跳过 scrollback);前端「已排队 N 条」提示。
>   - **评审修订(E-collect-window)**:原计划在"入队时(Running 期间)"arm 防抖窗口——但 turn 通常远长于 500ms,窗口会在 turn 进行中到期、把合并 prompt flush 进一个未结束的 turn(等于乱序强打断,正是 collect 要消灭的)。已改为**仅在 turn 结束(翻 Idle)后才 arm 窗口**,不变量:两个 deadline 仅在 `!local_running && !pending.is_empty()` 时为 Some。新增 `queued_event_serializes_to_ephemeral_contract` 测试锁住跨层 JSON 契约。
> - ✅ **Task 5/8 已实现(auto-titler,Claude-only)**:`auto_titler.rs` 后台任务 = 沙箱临时空目录 + Claude 专用无工具 spawn(`AcpProcess::spawn_titler`:`--allowedTools ""` + 不 `--dangerously-skip-permissions`,C1/E10)+ 15s 超时读 Result + `sanitize_title` 清洗 + 二次校验 `name_is_auto` 写回(E12 一生一次)。`process.rs` 的 NDJSON reader 抽成共享 `start_reader`(DRY)。acp/claude fanout 首条实质 prompt 的首个 Result 触发(P1:`first_substantive_prompt` + `titled` 一次性)。
>   - **后端覆盖决策(对应 spec C2 回退)**:仅 Claude 做真正的无工具 spawn。Kiro/Codex 的现有事件循环会 auto-approve / 写死 full-access,无法在不大改的前提下安全降为无工具,故 `run_titler` 对二者按设计返回 `None`——会话保留默认名,不命名也不冒注入风险。这正是 spec 预留的"titler 一律用 claude"回退的安全化版本。
>   - **未验证项(诚实记录)**:titler 对 live `claude` CLI 的端到端命名行为在本环境无法跑(无交互式 CLI);但失败模式安全(spawn 失败/超时/空 → 静默保留原名),且 `titler_prompt` 截断/规则、`sanitize_title` 清洗均有单测。部署后需人工冒烟:起 claude 会话→发实质 prompt→首 turn 结束观察改名一次;重启 resume 不再改名(E12)。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 zeromux agent 会话加两个能力——(1) collect:turn 进行中的追加 prompt 排队、turn 结束后合并发一条;(2) auto-titler:首条实质 prompt 后用沙箱无工具 LLM 调用生成中文标题写回会话名。

**Architecture:** 全部围绕 `session_manager.rs` 的三个 fanout 任务(`spawn_acp_fanout`/`spawn_kiro_fanout`/`spawn_codex_fanout`)。collect 是 fanout loop 内的本地队列 + 防抖/硬上限窗口 + 新 select 臂,不破坏广播扇出不变量(fanout 仍是进程唯一所有者)。titler 是一个独立 `tokio::spawn` 后台任务,起一个**不进 SessionManager** 的临时无工具进程。`name_is_auto` 持久化标志保证"一生只命名一次"且保护用户手改名。

**Tech Stack:** Rust / tokio (broadcast + mpsc + select! + time::Sleep) / rusqlite (SQLite) / React + Vite 前端。

**Spec:** `docs/superpowers/specs/2026-06-09-message-queue-collect-and-auto-titler-design.md`(经 CEO+Eng 双轮评审,C/E/P 编号可追溯)。

---

## 实现顺序与依赖

```
Task 1 (name_is_auto 持久化)  ─┐
Task 2 (用户改名锁 auto)       ─┼─ 都依赖 Task 1
Task 3 (纯函数 helpers, TDD)  ──┘ 独立,可先做
Task 4 (Manager 访问器)  ── 依赖 Task 1
Task 5 (auto_titler.rs)  ── 依赖 Task 3(sanitize) + Task 4
Task 6 (collect → acp fanout)  ── 依赖 Task 3(merge/substantive)
Task 7 (collect → kiro+codex fanout)  ── 依赖 Task 6
Task 8 (titler 触发接入 3 fanout)  ── 依赖 Task 5 + Task 6/7
Task 9 (queued 事件 ephemeral)  ── 依赖 Task 6
Task 10 (前端 queued 提示)  ── 依赖 Task 6/9
```

建议线性执行 1→10。Task 3 是纯函数可最先做(无依赖)。

---

## 文件结构

| 文件 | 职责 | 改动类型 |
|---|---|---|
| `src/session_store.rs` | `name_is_auto` 列 + migration + 读回 + `update_name_is_auto` | 修改 |
| `src/session_manager.rs` | `Session.name_is_auto` 字段;`merge_pending`/`is_substantive_prompt`/`sanitize_title` 自由函数;`session_name_is_auto`/`set_auto_title`/`titler_cli_for` 方法;`update_session_meta_named` 锁 auto;3 fanout collect+titler 接入;`AcpEvent` 新增 queued 计数字段 | 修改 |
| `src/auto_titler.rs` | titler 后台任务:沙箱目录 + 专用无工具 spawn + 读 Result + 写回 | 新建 |
| `src/acp/process.rs` | `AcpEvent::System` 加可选 `count` 字段;新增 titler 专用 spawn 构造器 | 修改 |
| `src/acp/kiro_process.rs` | titler 专用 spawn 构造器 | 修改 |
| `src/acp/codex_process.rs` | titler 专用 spawn 构造器 | 修改 |
| `src/acp/ws_handler.rs` | `System{subtype:"queued"}` 跳过 scrollback(ephemeral) | 修改 |
| `src/web.rs` | 核对 PATCH 改名走 `update_session_meta_named`(自动锁 auto) | 核对 |
| `frontend/src/...AcpChatView` | 渲染"已排队 N 条"提示;replay_done 不残留 | 修改 |

---

## Task 1: `name_is_auto` 持久化标志

**Files:**
- Modify: `src/session_store.rs`(struct `PersistedSession` :13;`open` 建表 :38;`upsert` :58;`load_all` :115;新增 `update_name_is_auto`)
- Modify: `src/session_manager.rs`(`Session` 结构 :149;5 个 `Session {}` 构造点 623/728/914/1015/1370;`PersistedSession {}` 构造点 :505;2 个测试构造点 1913/2050)

- [ ] **Step 1: 给 PersistedSession 加字段 + migration + 读回**

`src/session_store.rs` struct(:13 附近,在 `source_task_id` 后加一行):

```rust
pub struct PersistedSession {
    pub id: String,
    pub name: String,
    pub session_type: SessionType,
    pub work_dir: String,
    pub owner_id: String,
    pub description: String,
    pub resume_token: Option<ResumeToken>,
    pub worktree_path: Option<String>,
    pub created_ms: i64,
    pub source_task_id: Option<String>,
    pub name_is_auto: bool,   // 新增:true=可被自动命名覆盖;false=用户已锁定
}
```

`open()` 末尾,在已有 `source_task_id` migration 那行之后加(:54 附近):

```rust
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN source_task_id TEXT", []);
        // name_is_auto: 1 = 占位名/可自动命名;0 = 用户已锁定。旧行默认 1。
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN name_is_auto INTEGER NOT NULL DEFAULT 1", []);
```

`upsert()`(:58):SQL 列表加 `name_is_auto`,VALUES 加 `?12`,ON CONFLICT 加 `name_is_auto=?12`,params 末尾加 `s.name_is_auto as i64`:

```rust
        conn.execute(
            "INSERT INTO sessions (id,name,type,work_dir,owner_id,description,resume_kind,resume_value,worktree_path,created_ms,source_task_id,name_is_auto)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
             ON CONFLICT(id) DO UPDATE SET
               name=?2, type=?3, work_dir=?4, owner_id=?5, description=?6,
               resume_kind=?7, resume_value=?8, worktree_path=?9, name_is_auto=?12",
            params![s.id, s.session_type.to_string(), /* 注意保持原顺序 */],
        )
```

> 注意:保持原有 params 顺序不变,仅在末尾追加 `s.name_is_auto as i64`。原 `params![s.id, s.name, s.session_type.to_string(), s.work_dir, s.owner_id, s.description, rk, rv, s.worktree_path, s.created_ms, s.source_task_id]` → 末尾加 `, s.name_is_auto as i64`。

`load_all()`(:115 SELECT + :123 build):SELECT 列加 `name_is_auto`,build 加字段:

```rust
        let mut stmt = conn.prepare(
            "SELECT id,name,type,work_dir,owner_id,description,resume_kind,resume_value,worktree_path,created_ms,source_task_id,name_is_auto FROM sessions")
        // ... 在 Ok(PersistedSession { ... }) 末尾加:
                source_task_id: row.get(10)?,
                name_is_auto: row.get::<_, i64>(11)? != 0,
```

新增方法(放在 `update_name` 后):

```rust
    pub fn update_name_is_auto(&self, id: &str, is_auto: bool) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE sessions SET name_is_auto=?2 WHERE id=?1",
                     params![id, is_auto as i64])
            .map_err(|e| format!("update_name_is_auto failed: {}", e))?;
        Ok(())
    }
```

- [ ] **Step 2: 修 session_store.rs 测试构造点**

`src/session_store.rs` 的 `sample()`(:154)在 `source_task_id: None,` 后加 `name_is_auto: true,`。

- [ ] **Step 3: 跑 store 测试确认编译 + 通过**

Run: `cargo test --lib session_store`
Expected: PASS(现有 upsert/load roundtrip 用例通过,新列默认带上)。

- [ ] **Step 4: 给 Session 结构加字段**

`src/session_manager.rs` `Session`(:149),在 `pub description: String,` 后加:

```rust
    pub description: String,
    /// true = 名字是占位名/自动命名,可被 auto-titler 覆盖;
    /// false = 用户已手动改名(或已自动命名一次),永不再自动命名。
    pub name_is_auto: bool,
```

- [ ] **Step 5: 修所有 Session {} 构造点**

5 个生产构造点 623/728/914/1015 创建新会话 → `name_is_auto: true`(新会话用占位名)。
1370(`load_persisted` 重生)→ `name_is_auto: p.name_is_auto`(从持久化读回)。
2 个测试构造点 1913/2050 → `name_is_auto: true`。

`PersistedSession {}` 构造点 :505(`persist_meta` 里把 Session 转 PersistedSession 落库)→ 加 `name_is_auto: s.name_is_auto,`。

> 编译器会逐个报"missing field name_is_auto",照报错位置补齐即可——共 8 处 Session + 1 处 PersistedSession。

- [ ] **Step 6: 编译确认**

Run: `cargo build`
Expected: 编译通过(无 missing-field 错误)。

- [ ] **Step 7: Commit**

```bash
git add src/session_store.rs src/session_manager.rs
git commit -m "feat(session): add name_is_auto persisted flag (E12 基础)"
```

---

## Task 2: 用户改名锁定 `name_is_auto = false`

**Files:**
- Modify: `src/session_manager.rs`(`update_session_meta_named` :1304)
- 核对: `src/web.rs`(PATCH `/api/sessions/{id}` 改名路径)

- [ ] **Step 1: 改 update_session_meta_named,改名时落 auto=false**

`src/session_manager.rs` :1304。当前在 `if let Some(n) = pn { self.store.update_name(...) }` 处,用户路径改名要同步把内存 + 库的 `name_is_auto` 置 false。改为:

```rust
        match persist {
            Some((pn, pd)) => {
                if let Some(n) = pn {
                    let _ = self.store.update_name(id, &n);
                    // 用户显式改名 → 锁定,auto-titler 不再覆盖(E12/P 保护)
                    {
                        let mut map = self.sessions.lock().unwrap();
                        if let Some(s) = map.get_mut(id) {
                            s.name_is_auto = false;
                        }
                    }
                    let _ = self.store.update_name_is_auto(id, false);
                }
                if let Some(d) = pd {
                    let _ = self.store.update_description(id, &d);
                }
                true
            }
            None => false,
        }
```

> 为何不在 `apply_meta` 里改:`apply_meta` 是 name/description/status 通用应用,description-only 更新不应锁 auto。只有"确实传了 name"(`pn.is_some()`)才锁。

- [ ] **Step 2: 核对 web.rs PATCH 路径**

Run: `grep -n "update_session_meta_named\|fn update_session" src/web.rs`
确认 PATCH `/api/sessions/{id}` 的 handler 调用的是 `update_session_meta_named`(spec 已确认在 :506)。无需改动 web.rs,仅核对。若发现别的改名入口绕过该方法,在此补锁。

- [ ] **Step 3: 写测试:改名后 name_is_auto 变 false**

`src/session_manager.rs` 测试模块加(用已有 `running_session`/`test_session` helper + 内存 store;若 store 是真 SQLite,用 tempdir 构造 manager——参照模块内现有 manager 构造测试):

```rust
    #[test]
    fn user_rename_locks_name_is_auto() {
        let mgr = test_manager();              // 复用模块内已有的测试 manager 构造器
        let id = /* 插入一个 name_is_auto=true 的会话 */;
        assert!(mgr.session_name_is_auto(&id));   // Task 4 提供;若 Task 4 未做,先断言字段
        mgr.update_session_meta_named(&id, Some("我的名字".into()), None, None);
        assert!(!mgr.session_name_is_auto(&id));
    }
```

> 若模块内尚无 `test_manager()` 构造器,用 `SessionManager::new(...)` + tempdir 仿照现有测试;`session_name_is_auto` 在 Task 4 加,可把本测试排在 Task 4 之后跑。实现期二选一,但断言语义不变。

- [ ] **Step 4: 跑测试**

Run: `cargo test --lib session_manager`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/session_manager.rs
git commit -m "feat(session): user rename locks name_is_auto=false (E12 保护)"
```

---

## Task 3: 纯函数 helpers(merge_pending / is_substantive_prompt / sanitize_title)

**Files:**
- Modify: `src/session_manager.rs`(自由函数 + `#[cfg(test)]`),`sanitize_title` 也可放 `auto_titler.rs`;本计划放 `session_manager.rs` 集中测。

- [ ] **Step 1: 写 merge_pending 失败测试**

`src/session_manager.rs` 测试模块加:

```rust
    #[test]
    fn merge_pending_formats_with_header_and_timestamps() {
        let items = vec![
            PendingPrompt { text: "先看安全".into(), ts_ms: 1_700_000_000_000 },
            PendingPrompt { text: "重点 SQL 注入".into(), ts_ms: 1_700_000_060_000 },
        ];
        let out = merge_pending(&items);
        assert!(out.starts_with("[以下是你处理上一条消息期间用户追加发送的内容"));
        assert!(out.contains("先看安全"));
        assert!(out.contains("重点 SQL 注入"));
        // 顺序:先看安全 在 重点 SQL 注入 之前
        assert!(out.find("先看安全").unwrap() < out.find("重点 SQL 注入").unwrap());
        // 每条带 [HH:MM] 形式时间戳
        assert!(out.matches('[').count() >= 3); // 头 + 2 条时间戳
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --lib merge_pending_formats`
Expected: FAIL(`PendingPrompt`/`merge_pending` 未定义)。

- [ ] **Step 3: 实现 PendingPrompt + merge_pending**

`src/session_manager.rs`(放在 fanout 函数附近,顶层):

```rust
/// Running 期间追加、等待合并的一条用户 prompt。
#[derive(Debug, Clone)]
struct PendingPrompt {
    text: String,
    ts_ms: i64,
}

/// 把 Running 期间排队的追加 prompt 合并成一条带语义头的文本。
/// 语义头让模型明确这是"上一条处理期间的追加",而非独立新请求。
fn merge_pending(items: &[PendingPrompt]) -> String {
    use chrono::TimeZone;
    let mut out = String::from("[以下是你处理上一条消息期间用户追加发送的内容,请一并处理]\n");
    for p in items {
        let hhmm = chrono_tz::Asia::Shanghai
            .timestamp_millis_opt(p.ts_ms)
            .single()
            .map(|dt| dt.format("%H:%M").to_string())
            .unwrap_or_else(|| "--:--".into());
        out.push_str(&format!("[{}] {}\n", hhmm, p.text));
    }
    out
}
```

> `chrono` + `chrono_tz` 已是依赖(`scheduled_tasks.rs` 在用)。`timestamp_millis_opt(...).single()` 是 chrono 0.4 的安全转换。

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test --lib merge_pending_formats`
Expected: PASS。

- [ ] **Step 5: 写 is_substantive_prompt 失败测试**

```rust
    #[test]
    fn is_substantive_prompt_filters_trivial_openers() {
        // 琐碎开场 → false
        for t in ["hi", "ls", "继续", "y", "q", "  ", "ok"] {
            assert!(!is_substantive_prompt(t), "expected non-substantive: {:?}", t);
        }
        // 实质 prompt → true
        for t in ["帮我 review 这段代码", "fix the auth bug", "解释一下这个函数的作用"] {
            assert!(is_substantive_prompt(t), "expected substantive: {:?}", t);
        }
    }
```

- [ ] **Step 6: 跑确认失败**

Run: `cargo test --lib is_substantive_prompt_filters`
Expected: FAIL(未定义)。

- [ ] **Step 7: 实现 is_substantive_prompt**

```rust
/// 判定一条 prompt 是否"实质"——值得用它生成会话标题。
/// 规则:trim 后,含空白(多词/含说明)即实质;否则要求长度 >= 阈值。
/// 挡掉 hi/ls/继续/y/q 这类单 token 短命令开场(评审 P1)。
fn is_substantive_prompt(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() {
        return false;
    }
    // 含空白 = 多 token,基本是真实意图
    if t.chars().any(|c| c.is_whitespace()) {
        return true;
    }
    // 单 token:按字符数(非字节)要求 >= 6,挡掉 hi/ls/继续/ok/y/q
    t.chars().count() >= 6
}
```

> 阈值 6 是经验值:挡掉 `继续`(2 字)、`hi`/`ls`/`ok`(2)、`y`/`q`(1);放过 `帮我review`(连写也 >=6)。实现期可微调,测试用例锁住行为。

- [ ] **Step 8: 跑确认通过**

Run: `cargo test --lib is_substantive_prompt_filters`
Expected: PASS。

- [ ] **Step 9: 写 sanitize_title 失败测试**

```rust
    #[test]
    fn sanitize_title_cleans_and_truncates() {
        assert_eq!(sanitize_title("  修复登录 bug  "), Some("修复登录 bug".to_string()));
        assert_eq!(sanitize_title("\"带引号标题\""), Some("带引号标题".to_string()));
        assert_eq!(sanitize_title("标题:配置中心重构"), Some("配置中心重构".to_string()));
        assert_eq!(sanitize_title("第一行\n第二行"), Some("第一行".to_string()));
        // 超 16 字符按字符截断
        let long = "一二三四五六七八九十一二三四五六七八";
        assert_eq!(sanitize_title(long).unwrap().chars().count(), 16);
        // 空 → None
        assert_eq!(sanitize_title("   "), None);
        assert_eq!(sanitize_title(""), None);
    }
```

- [ ] **Step 10: 跑确认失败**

Run: `cargo test --lib sanitize_title_cleans`
Expected: FAIL(未定义)。

- [ ] **Step 11: 实现 sanitize_title**

```rust
/// 清洗 LLM 返回的标题:取第一行、去引号/常见前缀、按字符截断 16、空→None。
fn sanitize_title(raw: &str) -> Option<String> {
    // 取第一行
    let first_line = raw.lines().next().unwrap_or("").trim();
    // 去常见前缀
    let stripped = first_line
        .strip_prefix("标题:")
        .or_else(|| first_line.strip_prefix("标题:"))
        .or_else(|| first_line.strip_prefix("Title:"))
        .or_else(|| first_line.strip_prefix("title:"))
        .unwrap_or(first_line)
        .trim();
    // 去首尾引号(中英文)
    let quotes: &[char] = &['"', '\'', '“', '”', '‘', '’', '「', '」', '『', '』', '`'];
    let unquoted = stripped.trim_matches(|c| quotes.contains(&c)).trim();
    if unquoted.is_empty() {
        return None;
    }
    // 按字符截断到 16
    let truncated: String = unquoted.chars().take(16).collect();
    if truncated.trim().is_empty() {
        None
    } else {
        Some(truncated)
    }
}
```

- [ ] **Step 12: 跑确认通过**

Run: `cargo test --lib sanitize_title_cleans`
Expected: PASS。

- [ ] **Step 13: Commit**

```bash
git add src/session_manager.rs
git commit -m "feat(session): merge_pending + is_substantive_prompt + sanitize_title 纯函数 (含单测)"
```

---

## Task 4: SessionManager 访问器(session_name_is_auto / set_auto_title / titler_cli_for)

**Files:**
- Modify: `src/session_manager.rs`(新增 3 个方法 + `TitlerBackend` 解析)

- [ ] **Step 1: 写 set_auto_title 行为测试(E12 核心)**

```rust
    #[test]
    fn set_auto_title_writes_once_then_locks() {
        let mgr = test_manager();
        let id = /* 插入 name_is_auto=true 的会话, 初始名 "claude-1" */;
        // 第一次:写入并锁定
        assert!(mgr.set_auto_title(&id, "修复登录"));
        assert_eq!(mgr.session_name(&id).as_deref(), Some("修复登录")); // session_name 取名字; 若无则用 list/get
        assert!(!mgr.session_name_is_auto(&id));  // E12:命名后锁定
        // 第二次:已锁定,拒绝
        assert!(!mgr.set_auto_title(&id, "另一个名字"));
        assert_eq!(mgr.session_name(&id).as_deref(), Some("修复登录")); // 未变
    }
```

> 若模块没有 `session_name(id)` 只读取名访问器,用现有 list/get_session 取名断言;实现期对齐。

- [ ] **Step 2: 跑确认失败**

Run: `cargo test --lib set_auto_title_writes_once`
Expected: FAIL(方法未定义)。

- [ ] **Step 3: 实现 session_name_is_auto + set_auto_title**

`src/session_manager.rs`(放在 `update_session_meta_named` 附近):

```rust
    /// 只读:该会话名字当前是否仍可被自动命名覆盖。
    pub fn session_name_is_auto(&self, id: &str) -> bool {
        self.sessions.lock().unwrap()
            .get(id)
            .map(|s| s.name_is_auto)
            .unwrap_or(false)
    }

    /// auto-titler 写回标题:仅当仍为 auto 时写入,写入后锁定(E12:一生只一次)。
    /// 返回 true 表示实际写入。与用户改名路径解耦——不复用 update_session_meta_named。
    pub fn set_auto_title(&self, id: &str, title: &str) -> bool {
        let wrote = {
            let mut map = self.sessions.lock().unwrap();
            match map.get_mut(id) {
                Some(s) if s.name_is_auto => {
                    s.name = title.to_string();
                    s.name_is_auto = false;   // E12:命名后锁定,重启/resume 不再 re-title
                    true
                }
                _ => false,
            }
        };
        if wrote {
            let _ = self.store.update_name(id, title);
            let _ = self.store.update_name_is_auto(id, false);
            // 名字变化经现有 SessionInfo 下发机制自动广播给客户端
        }
        wrote
    }
```

- [ ] **Step 4: 实现 titler_cli_for**

`AcpEvent` 用 `agent_label: &'static str`(fanout 已持有)。加一个把 label 映射到 (后端类型, CLI path) 的方法:

```rust
    /// 给 auto-titler 解析它该用哪个后端 + CLI 路径(跟随会话 agent)。
    /// 返回 None 表示该会话类型不支持自动命名(如 tmux)。
    pub fn titler_cli_for(&self, agent_label: &str) -> Option<(TitlerBackend, String)> {
        match agent_label {
            "claude" => Some((TitlerBackend::Claude, self.claude_path.clone())),
            "kiro"   => Some((TitlerBackend::Kiro,   self.kiro_path.clone())),
            "codex"  => Some((TitlerBackend::Codex,  self.codex_path.clone())),
            _ => None,
        }
    }
```

加枚举(顶层):

```rust
#[derive(Debug, Clone, Copy)]
pub enum TitlerBackend { Claude, Kiro, Codex }
```

> 核对 fanout 传给各自的 `agent_label` 字面量(spec 引用 `agent_label: &'static str`);用 `grep -n 'spawn_acp_fanout\|spawn_kiro_fanout\|spawn_codex_fanout' src/session_manager.rs` 找调用点确认传入的 label 字符串("claude"/"kiro"/"codex"),与 match 对齐。

- [ ] **Step 5: 跑测试确认通过**

Run: `cargo test --lib set_auto_title_writes_once`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/session_manager.rs
git commit -m "feat(session): session_name_is_auto + set_auto_title(锁定) + titler_cli_for"
```

---

## Task 5: `auto_titler.rs` 模块(沙箱 + 专用无工具 spawn)

**Files:**
- Create: `src/auto_titler.rs`
- Modify: `src/main.rs` 或 `src/lib.rs`(加 `mod auto_titler;`)
- Modify: `src/acp/process.rs`(加 titler 专用 spawn 构造器 `spawn_titler`)
- Modify: `src/acp/kiro_process.rs` + `src/acp/codex_process.rs`(同上)

- [ ] **Step 1: 给三个 *Process 加专用无工具 spawn 构造器(E10)**

`src/acp/process.rs`,在现有 `spawn`(:90)旁加一个不带 `--dangerously-skip-permissions`、不授予工具的变体:

```rust
    /// 专供 auto-titler:无工具、无 skip-permissions,在沙箱 work_dir 运行。
    /// 即使 prompt 注入诱导动作,模型既无工具可用、又只在空临时目录,触及不到 repo(C1/E10)。
    pub async fn spawn_titler(
        claude_path: &str,
        sandbox_dir: &str,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let args: Vec<String> = vec![
            "-p".into(),
            "--output-format".into(), "stream-json".into(),
            "--input-format".into(), "stream-json".into(),
            "--verbose".into(),
            "--allowedTools".into(), "".into(),   // 空工具集:不授予任何工具
            // 注意:绝不加 --dangerously-skip-permissions
        ];
        let mut child = tokio::process::Command::new(claude_path)
            .args(&args)
            .current_dir(sandbox_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel::<AcpEvent>(256);
        // 复用现有 stdout→AcpEvent 读取逻辑(把 spawn() 里 :119 起的读取 task 抽成
        // 一个私有 fn start_reader(stdout, tx) 并在两处调用,避免复制 NDJSON 解析)。
        Self::start_reader(stdout, tx);
        Ok(Self { child, stdin, event_rx: rx })
    }
```

> DRY:把 `spawn()` 里的 NDJSON 读取 task 抽成私有 `fn start_reader(stdout, tx: mpsc::Sender<AcpEvent>)`,`spawn` 和 `spawn_titler` 都调用它。避免两份解析逻辑。
>
> Kiro/Codex 的 `spawn_titler` 同理:`KiroProcess::spawn_titler(kiro_path, sandbox_dir)` 起 `kiro-cli acp`(去掉 `--trust-all-tools`,或换成 trust-nothing 等价参数);`CodexProcess::spawn_titler(codex_path, sandbox_dir)` 起 codex 时 config 不授予工具。各后端按其 CLI 实际支持的"无工具"开关落实——核对各 `spawn` 现有参数,移除授予工具的那个开关。

- [ ] **Step 2: 写 auto_titler.rs**

`src/auto_titler.rs`:

```rust
//! 自动会话标题:首条实质 prompt 后,用一个沙箱化、无工具的临时 LLM 进程
//! 读对话出 <=16 字中文标题写回 session.name。一生只命名一次(见 set_auto_title)。
//!
//! 安全(C1/E10):临时进程在系统临时空目录运行 + 不授予工具 + 不 skip-permissions。
//! 即使对话内容含 prompt 注入,也触及不到用户 repo。

use std::sync::Weak;
use std::time::Duration;

use crate::acp::process::{AcpEvent, AcpProcess};
use crate::acp::kiro_process::KiroProcess;
use crate::acp::codex_process::CodexProcess;
use crate::session_manager::{SessionManager, TitlerBackend, sanitize_title};

const TITLER_TIMEOUT_SECS: u64 = 15;

fn titler_prompt(first_prompt: &str, result_text: &str) -> String {
    let up = first_prompt.chars().take(1000).collect::<String>();
    let asst = result_text.chars().take(1000).collect::<String>();
    format!(
"You are a titling assistant. Read the conversation below and output ONLY a concise title.
Rules:
- Language: Chinese.
- Max 16 Chinese characters.
- No quotes, no punctuation, no explanation, no markdown.
- Do NOT use any tools or take any action.
- Output the title text and nothing else.
---
User: {up}
Assistant: {asst}")
}

/// 在后台尝试为 sid 生成并写回标题。失败/超时/空 → 静默放弃,保留原名。
pub fn spawn_titler(
    sid: String,
    backend: TitlerBackend,
    cli_path: String,
    first_prompt: String,
    result_text: String,
    mgr: Weak<SessionManager>,
) {
    tokio::spawn(async move {
        // 1. 建唯一沙箱临时目录
        let sandbox = match tempfile::Builder::new().prefix("zeromux-titler-").tempdir() {
            Ok(d) => d,
            Err(e) => { tracing::debug!("titler tempdir failed: {}", e); return; }
        };
        let sandbox_path = sandbox.path().to_string_lossy().to_string();
        let prompt = titler_prompt(&first_prompt, &result_text);

        // 2. 起专用无工具进程 + 发 prompt + 等 Result(带超时)
        let title = match backend {
            TitlerBackend::Claude => run_acp_titler(
                AcpProcess::spawn_titler(&cli_path, &sandbox_path).await, prompt).await,
            TitlerBackend::Kiro => run_kiro_titler(
                KiroProcess::spawn_titler(&cli_path, &sandbox_path).await, prompt).await,
            TitlerBackend::Codex => run_codex_titler(
                CodexProcess::spawn_titler(&cli_path, &sandbox_path).await, prompt).await,
        };

        // 3. 清洗 + 竞态二次校验 + 写回
        let Some(raw) = title else { return; };
        let Some(clean) = sanitize_title(&raw) else { return; };
        if let Some(m) = mgr.upgrade() {
            if m.session_name_is_auto(&sid) {   // 防用户在这几秒内手动改名
                m.set_auto_title(&sid, &clean);
            }
        }
        // sandbox 在此 drop → 临时目录删除;进程已 kill(见各 run_* / Drop)
    });
}

/// 读 AcpProcess 的 event_rx 直到 Result,取其 text。15s 超时。
async fn run_acp_titler(
    proc: Result<AcpProcess, Box<dyn std::error::Error + Send + Sync>>,
    prompt: String,
) -> Option<String> {
    let mut proc = proc.ok()?;
    if proc.send_prompt(&prompt).await.is_err() { return None; }
    let fut = async {
        while let Some(evt) = proc.event_rx.recv().await {
            match evt {
                AcpEvent::Result { text, .. } => return Some(text),
                AcpEvent::Error { .. } | AcpEvent::Exit { .. } => return None,
                _ => continue,
            }
        }
        None
    };
    let out = tokio::time::timeout(Duration::from_secs(TITLER_TIMEOUT_SECS), fut).await.ok().flatten();
    proc.kill().await;
    out
}
// run_kiro_titler / run_codex_titler 同构(KiroProcess/CodexProcess 各自的 event_rx + Result)。
// Codex 注意:文本走 notification,Result 到达路径见 codex_process.rs;沿用其既有
// event_rx 语义即可——run_* 只关心拿到第一个携带最终文本的 Result/等价事件。
```

> 依赖:`tempfile` crate。核对 `Cargo.toml` 是否已有(`session_store.rs` 测试用了 `tempfile::tempdir`,大概率已是 dev 依赖——titler 用在**非 test 代码**,需把 `tempfile` 从 `[dev-dependencies]` 提升到 `[dependencies]`)。Step 3 处理。

- [ ] **Step 3: 把 tempfile 提为正式依赖 + 注册模块**

Run: `grep -n "tempfile" Cargo.toml`
若 `tempfile` 只在 `[dev-dependencies]`,在 `[dependencies]` 加一行 `tempfile = "3"`(版本对齐现有)。
`src/main.rs`(或 lib 根)加 `mod auto_titler;`。

- [ ] **Step 4: 编译确认(titler 暂未被调用,仅确认模块编译)**

Run: `cargo build`
Expected: 编译通过。若 Kiro/Codex 的 `spawn_titler` 或 `run_*_titler` 未写全会报错——补齐三后端对称实现。

- [ ] **Step 5: Commit**

```bash
git add src/auto_titler.rs src/acp/process.rs src/acp/kiro_process.rs src/acp/codex_process.rs src/main.rs Cargo.toml
git commit -m "feat(titler): auto_titler 模块 + 三后端专用无工具 spawn (C1/E10 沙箱)"
```

---

## Task 6: collect 队列接入 `spawn_acp_fanout`(参考实现)

**Files:**
- Modify: `src/session_manager.rs`(`spawn_acp_fanout` :1511;`AcpEvent` 在 `src/acp/process.rs` 加 queued 计数字段)

- [ ] **Step 1: 给 AcpEvent::System 加可选 count 字段**

`src/acp/process.rs` `System` 变体(:30):

```rust
    System {
        subtype: StaticOrOwnedStr,
        #[serde(skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        /// 仅 subtype=="queued" 填充:当前排队条数,供前端显示"已排队 N 条"。
        #[serde(skip_serializing_if = "Option::is_none")]
        count: Option<u32>,
    },
```

> 编译器会要求所有构造 `System {}` 的地方补 `count: None`。grep `System {` / `System{` across `src/acp/` 补齐(translate_event 等),其余一律 `count: None`。

- [ ] **Step 2: 在 spawn_acp_fanout 加 collect 状态变量**

`src/session_manager.rs` :1522 起,在现有 `let mut active_run_id` 等之后加:

```rust
        let mut pending: Vec<PendingPrompt> = Vec::new();
        let mut collect_deadline: Option<std::pin::Pin<Box<tokio::time::Sleep>>> = None;
        let mut collect_hard_deadline: Option<std::pin::Pin<Box<tokio::time::Sleep>>> = None;
        const COLLECT_DEBOUNCE_MS: u64 = 500;
        const COLLECT_MAX_MS: u64 = 3000;
```

- [ ] **Step 3: 改 input 臂 Prompt 分支(run_id 绕行 + 入队 + queued 事件)**

`src/session_manager.rs` :1593,把现有 `Some(SessionInput::Prompt { text, run_id })` 分支整体替换为:

```rust
                        Some(SessionInput::Prompt { text, run_id }) => {
                            if run_id.is_some() {
                                // C3:调度运行 prompt 绕过 collect,自成干净 turn。
                                active_run_id = run_id.clone();
                                if local_running {
                                    if let Err(e) = process.interrupt().await {
                                        tracing::warn!("interrupt before resend failed for {}: {}", sid, e);
                                    }
                                }
                                turn_seq += 1;
                                local_running = true;
                                if let Some(m) = mgr.upgrade() {
                                    m.mark_turn(&sid, TurnState::Running, turn_seq);
                                }
                                if let Err(e) = process.send_prompt(&text).await {
                                    tracing::warn!("ACP send_prompt failed for {}: {}", sid, e);
                                }
                            } else if !local_running {
                                // 空闲:立即发送(原行为)
                                if first_substantive_prompt.is_none() && is_substantive_prompt(&text) {
                                    first_substantive_prompt = Some(text.clone());  // Task 8 用
                                }
                                active_run_id = None;
                                turn_seq += 1;
                                local_running = true;
                                if let Some(m) = mgr.upgrade() {
                                    m.mark_turn(&sid, TurnState::Running, turn_seq);
                                }
                                if let Err(e) = process.send_prompt(&text).await {
                                    tracing::warn!("ACP send_prompt failed for {}: {}", sid, e);
                                }
                            } else {
                                // Running:入队,不打断
                                if first_substantive_prompt.is_none() && is_substantive_prompt(&text) {
                                    first_substantive_prompt = Some(text.clone());
                                }
                                pending.push(PendingPrompt { text, ts_ms: now_millis() });
                                // 防抖窗口每次重置;硬上限仅首条锚定
                                collect_deadline = Some(Box::pin(tokio::time::sleep(
                                    std::time::Duration::from_millis(COLLECT_DEBOUNCE_MS))));
                                if collect_hard_deadline.is_none() {
                                    collect_hard_deadline = Some(Box::pin(tokio::time::sleep(
                                        std::time::Duration::from_millis(COLLECT_MAX_MS))));
                                }
                                // ephemeral queued 提示(E7:不入 scrollback,见 Task 9)
                                let _ = event_tx.send(serde_json::to_string(&AcpEvent::System {
                                    subtype: std::borrow::Cow::Borrowed("queued"),
                                    session_id: None,
                                    count: Some(pending.len() as u32),
                                }).unwrap_or_default());
                            }
                        }
```

> `first_substantive_prompt` 变量在 Task 8 声明;若先单独跑 Task 6,临时把这两处 `first_substantive_prompt` 赋值删掉,Task 8 再补。建议 Task 6 与 Task 8 连做。

- [ ] **Step 4: 改 Interrupt 臂(E5:无条件清队列)**

:1609 的 Interrupt 分支替换为:

```rust
                        Some(SessionInput::Interrupt) => {
                            if local_running {
                                if let Err(e) = process.interrupt().await {
                                    tracing::warn!("interrupt failed for {}: {}", sid, e);
                                }
                            }
                            // E5:无条件清队列 + 取消窗口(turn 已结束、窗口正等 flush 时也要清)
                            pending.clear();
                            collect_deadline = None;
                            collect_hard_deadline = None;
                        }
```

- [ ] **Step 5: 加第三个 select! 臂(窗口到期 → flush 合并)**

在 `tokio::select! { ... }` 内,`input = input_rx.recv() => { ... }` 臂之后加:

```rust
                _ = async {
                    // 等防抖与硬上限中较早者;任一为 None 视为不触发
                    match (collect_deadline.as_mut(), collect_hard_deadline.as_mut()) {
                        (Some(d), Some(h)) => { tokio::select! { _ = d => {}, _ = h => {} } }
                        (Some(d), None) => { d.await }
                        (None, Some(h)) => { h.await }
                        (None, None) => { std::future::pending::<()>().await }
                    }
                }, if collect_deadline.is_some() || collect_hard_deadline.is_some() => {
                    collect_deadline = None;
                    collect_hard_deadline = None;
                    if !pending.is_empty() {
                        let merged = merge_pending(&pending);
                        pending.clear();
                        active_run_id = None;   // 合并 turn 无 run_id(C3)
                        turn_seq += 1;
                        local_running = true;
                        if let Some(m) = mgr.upgrade() {
                            m.mark_turn(&sid, TurnState::Running, turn_seq);
                        }
                        if let Err(e) = process.send_prompt(&merged).await {
                            tracing::warn!("collect flush send_prompt failed for {}: {}", sid, e);
                        }
                    }
                }
```

> turn 结束臂(:1564)无需显式 arm window——pending 只在 Running 时入队,入队时已 arm。若担心"turn 刚结束才发现 pending 非空"(理论上入队都发生在 Running,turn 未结束),当前 arm-on-enqueue 已覆盖。保持简单,不在 :1564 额外 arm。

- [ ] **Step 6: 编译 + 现有测试不回归**

Run: `cargo build && cargo test --lib`
Expected: 编译通过;现有 session_manager 测试(turn-state/boundary 等)全过。

- [ ] **Step 7: Commit**

```bash
git add src/session_manager.rs src/acp/process.rs
git commit -m "feat(collect): spawn_acp_fanout 排队+防抖+硬上限+run_id绕行+queued事件 (C3/E3/E5)"
```

---

## Task 7: collect 接入 kiro + codex fanout

**Files:**
- Modify: `src/session_manager.rs`(`spawn_kiro_fanout` :1631;`spawn_codex_fanout` :1735)

- [ ] **Step 1: 把 Task 6 的 4 处改动镜像到 kiro fanout**

`spawn_kiro_fanout`(:1631)结构与 acp 完全相同。照 Task 6 Step 2/3/4/5 把:
- collect 状态变量(Step 2)
- input 臂 Prompt 分支(Step 3,含 run_id 绕行 + 入队 + queued 事件 + first_substantive_prompt 记录)
- Interrupt 臂清队列(Step 4)
- 第三个 select 臂(Step 5)
逐字镜像进 kiro fanout。`merge_pending`/`is_substantive_prompt`/`PendingPrompt`/常量都是共享自由函数/类型,直接用。

- [ ] **Step 2: 镜像到 codex fanout**

`spawn_codex_fanout`(:1735)同样镜像 4 处改动。

- [ ] **Step 3: 编译 + 测试**

Run: `cargo build && cargo test --lib`
Expected: 通过。

- [ ] **Step 4: Commit**

```bash
git add src/session_manager.rs
git commit -m "feat(collect): 镜像 collect 到 kiro + codex fanout"
```

---

## Task 8: titler 触发接入三个 fanout

**Files:**
- Modify: `src/session_manager.rs`(三个 fanout:声明 `first_substantive_prompt` + `titled`;turn 结束臂触发)

- [ ] **Step 1: 三个 fanout 各加两个本地变量**

每个 fanout 的状态变量区(Task 6 Step 2 同位置)加:

```rust
        let mut first_substantive_prompt: Option<String> = None;
        let mut titled = false;
```

> Task 6/7 的 input 臂已写 `first_substantive_prompt` 赋值;此处补声明。

- [ ] **Step 2: 三个 fanout 的 turn 结束臂加触发**

在 `is_boundary` 分支内、`mark_turn(Idle)` 之后(:1567 之后),加:

```rust
                                // auto-titler:首条实质 prompt 的首个 Result 触发一次
                                if !titled {
                                    if let AcpEvent::Result { text, .. } = &evt {
                                        if let Some(fp) = first_substantive_prompt.clone() {
                                            titled = true;
                                            if let Some(m) = mgr.upgrade() {
                                                if m.session_name_is_auto(&sid) {
                                                    if let Some((backend, path)) = m.titler_cli_for(agent_label) {
                                                        crate::auto_titler::spawn_titler(
                                                            sid.clone(), backend, path,
                                                            fp, text.clone(), mgr.clone(),
                                                        );
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
```

> 三个 fanout 完全相同。`agent_label` 是各 fanout 的 `&'static str` 参数;`titler_cli_for` 按它选后端。`mgr.clone()` 是 `Weak<SessionManager>` 的 clone。

- [ ] **Step 3: 编译**

Run: `cargo build`
Expected: 通过。

- [ ] **Step 4: 集成手测(命名一次 + 重启不再命名)**

Run: `cargo build && ./target/debug/zeromux --port 8099 --password test`(或现有启动方式)
- 起一个 claude 会话,发一条实质 prompt(如"帮我看看这个函数"),等首 turn 结束 → 观察会话名从 `claude-1` 变成中文标题。
- 再发第二条实质 prompt,turn 结束 → 名字**不变**(titled 守住)。
- 手动改名 → 之后任何 turn 不再自动命名(name_is_auto=false)。
- 重启 zeromux,resume 该会话再发 prompt → 名字**不变**(E12:name_is_auto 已 false)。

Expected: 命名恰好一次,重启/二次 turn 都不覆盖。

- [ ] **Step 5: Commit**

```bash
git add src/session_manager.rs
git commit -m "feat(titler): 三 fanout 首条实质 turn 触发 auto-titler (P1/E12)"
```

---

## Task 9: queued 事件 ephemeral(不进 scrollback)

**Files:**
- Modify: `src/acp/ws_handler.rs`(:131 push_scrollback 处)

- [ ] **Step 1: 在 ws_handler 跳过 queued 事件的 scrollback push**

`src/acp/ws_handler.rs` :131-132,当前对每条广播事件 `push_scrollback`。改为:若该 json 是 `System{subtype:"queued"}` 则只转发客户端、跳过 push。最稳的判断是解析 type/subtype:

```rust
                        // E7:queued 提示是 ephemeral,转发但不入 scrollback
                        // (否则重连回放会出现早已 flush 的"已排队 N 条"幻影)
                        let is_ephemeral_queued = serde_json::from_str::<serde_json::Value>(&json)
                            .ok()
                            .map(|v| v.get("type").and_then(|t| t.as_str()) == Some("system")
                                  && v.get("subtype").and_then(|s| s.as_str()) == Some("queued"))
                            .unwrap_or(false);
                        if !is_ephemeral_queued {
                            state.sessions.push_scrollback(&session_id, json.clone());
                        }
                        // 转发给客户端照常(下面已有 send 逻辑)
```

> 核对 :131 上下文:把原来的无条件 `push_scrollback(&session_id, json.clone())` 包进 `if !is_ephemeral_queued`。转发给当前 WS 客户端的逻辑保持不变。注意 AcpEvent serde tag 是 `#[serde(tag="type", rename_all="snake_case")]`,故 `System` 序列化后 `"type":"system"`。

- [ ] **Step 2: 编译 + 手测重连无幻影**

Run: `cargo build`,起会话,Running 时连发制造 queued 提示,断开重连 → 回放中不应再出现"已排队"。
Expected: 重连后无残留 queued 提示。

- [ ] **Step 3: Commit**

```bash
git add src/acp/ws_handler.rs
git commit -m "fix(collect): queued 事件设为 ephemeral，不进 scrollback (E7)"
```

---

## Task 10: 前端"已排队 N 条"提示

**Files:**
- Modify: `frontend/src/`(AcpChatView + 事件类型定义)

- [ ] **Step 1: 定位 AcpEvent 前端类型与 System 渲染**

Run: `cd frontend && grep -rn "subtype\|'system'\|\"system\"\|System" src/ | grep -i acp | head`
找到前端 AcpEvent 联合类型定义处(System 事件含 subtype),加可选 `count?: number`。

- [ ] **Step 2: 在 AcpChatView 渲染 queued 提示**

定位接收 ACP 事件、维护消息列表的组件(AcpChatView)。加一个 ephemeral 状态:收到 `{type:'system', subtype:'queued', count}` 时,在输入区上方显示一行轻量提示:

```tsx
// 伪代码,贴合现有组件状态写法
const [queuedCount, setQueuedCount] = useState(0);

// 事件处理:
if (evt.type === 'system' && evt.subtype === 'queued') {
  setQueuedCount(evt.count ?? 0);
  return; // 不进消息气泡列表
}
// 当下一次进入 Running(合并 turn 发出)或收到新 assistant 内容时清零:
//   在 busy 转为 true / 新 turn 开始处 setQueuedCount(0)

// 渲染(输入区上方):
{queuedCount > 0 && (
  <div className="text-xs text-zinc-400 px-3 py-1">
    已排队 {queuedCount} 条，本轮结束后合并发送
  </div>
)}
```

> 清零时机:合并 turn 实际发出时会进入新 Running/busy 状态,在该状态切换处 `setQueuedCount(0)`。另外 `replay_done` 标记处也 `setQueuedCount(0)`,确保重连不残留(双保险,配合 Task 9 的后端 ephemeral)。

- [ ] **Step 3: lint + 构建**

Run: `cd frontend && npm run lint && npm run build`
Expected: 无 lint 错误;`frontend/dist/` 生成(后端 rust-embed 需要)。

- [ ] **Step 4: 手测**

起 claude 会话,首条 prompt 进 Running,Running 时再连发 2 条 → 输入区上方显示"已排队 2 条";本轮结束合并发出后提示消失;断开重连无残留。

- [ ] **Step 5: Commit**

```bash
git add frontend/src
git commit -m "feat(collect): 前端「已排队 N 条」提示 (P3)"
```

---

## 收尾验证

- [ ] **全量编译 + 测试**

Run: `cargo build && cargo test && cd frontend && npm run lint && npm test`
Expected: 全绿。

- [ ] **release 构建(部署前)**

Run: `cd frontend && npm run build && cd .. && cargo build --release`
Expected: `target/release/zeromux` 生成。部署用 `./deploy.sh`(见 CLAUDE.md,**不要**手动 systemctl stop)。

---

## 备注:为何不抽象三 fanout 的重复

collect 与 titler 触发在三个 fanout 里近乎逐字复制。这与现有 fanout 本就三份复制的风格一致(它们已经各自重复了 select!/boundary/mark_turn 逻辑)。`merge_pending`/`is_substantive_prompt`/`sanitize_title`/`PendingPrompt`/`spawn_titler` 已抽成共享自由函数/类型;复制的只是 loop 内联的队列/触发片段。本期**不**统一抽象 fanout(避免过早抽象);若未来三 fanout 要合并再做。
