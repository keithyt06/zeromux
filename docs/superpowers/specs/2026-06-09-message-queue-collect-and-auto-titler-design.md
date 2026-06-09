# 设计:消息队列 collect 模式 + auto-titler

> **类型**:实现 spec
> **日期**:2026-06-09
> **来源调研**:[docs/2026-06-09-naozhi-feature-inspiration.md](../../2026-06-09-naozhi-feature-inspiration.md)(借鉴清单 #1、#2)
> **状态**:设计已批准,待写实现计划

## 背景与目标

借鉴竞品 naozhi(zeromux 镜像孪生)被 IM 交互逼出的两个能力,移植到 zeromux:

1. **消息队列 collect**:agent 会话 turn 进行中(`Running`)时,用户追加发送的新 prompt 不再强打断当前 turn,而是排队;turn 结束后经一个短收集窗口,合并成**一条** prompt 发送。直击移动端 composer + KeyBar 上线后"手机用户天然连发多条短消息→现在乱序/强打断"的痛点。
2. **auto-titler**:会话**首个 turn 结束**时,后台跑一次性 LLM 调用,生成 ≤16 字中文标题写回 `session.name`,解决会话列表一堆 `claude-1`/`codex-2` 无意义名字的问题。

两者均不破坏 `session_manager.rs` 的**广播扇出不变量**(fanout 任务是会话进程的唯一所有者)。

## 已确认决策

| 决策点 | 选择 |
|---|---|
| collect 模式范围 | 仅 `collect` 单模式(不做 interrupt/passthrough,留作未来 spec) |
| collect 配置 | 全局固定开启,无 CLI flag、无 DB、无切换 UI |
| collect 收集窗口 | 500ms,带防抖(窗口内新 prompt 重置 deadline) |
| collect 前端 queued 提示 | MVP 不做,后端正确合并优先 |
| titler 执行方式 | 轻量临时进程(复用 `AcpProcess`/`KiroProcess`/`CodexProcess` 的 `spawn`+`send_prompt`+`event_rx`,**不进 SessionManager**,无 worktree、不污染会话列表) |
| titler 后端 | 跟随会话的 agent(claude→claude,codex→codex,kiro→kiro) |
| titler 触发 | 首个 turn 结束后命名一次,之后不再自动改 |
| titler 标题语言 | 固定中文 ≤16 字(英文 system 指令锁语义抗注入) |
| titler 超时 | 15s,超时静默放弃 |
| 用户改名保护 | 新增 `name_is_auto` 标记,用户手改名后永不被自动覆盖 |

---

## Feature 1 — 消息队列 collect

### 改动位置

`src/session_manager.rs` 三个 fanout 任务,结构相同,改法镜像一致:
- `spawn_acp_fanout`(:1511,Claude)
- `spawn_kiro_fanout`(:1631,Kiro)
- `spawn_codex_fanout`(:1735,Codex)

### 当前行为(要改的)

input 臂收到 `SessionInput::Prompt` 时(:1593):若 `local_running` 则先 `process.interrupt()` 再 resend —— 即**强打断**。

### 新行为

fanout loop 新增本地状态:
```rust
let mut pending: Vec<PendingPrompt> = Vec::new();   // Running 期间追加的 prompt
let mut collect_deadline: Option<Pin<Box<tokio::time::Sleep>>> = None;
// PendingPrompt { text: String, run_id: Option<String>, ts_ms: i64 }
```

**改造 1 — input 臂(:1593)**:
- `!local_running`:照旧立即发送(`turn_seq += 1`、`mark_turn(Running)`、`send_prompt`)。
- `local_running`:**改为入队** `pending.push(PendingPrompt { text, run_id, ts_ms: now_millis() })`。不动 turn 状态,不 interrupt。
- 若此时 `collect_deadline` 处于 armed(说明正处于收集窗口),**重置** deadline 为 `now + 500ms`(防抖)。

**改造 2 — turn 结束臂(:1564,`boundary_count >= turn_seq` 处)**:
- 翻 `local_running = false`、`mark_turn(Idle)` 照旧。
- 之后:若 `!pending.is_empty()` 且 `collect_deadline.is_none()`,arm `collect_deadline = Some(Box::pin(sleep(500ms)))`。

**改造 3 — 新增第三个 select! 臂(收集窗口到期)**:
```rust
_ = async { collect_deadline.as_mut().unwrap().await },
        if collect_deadline.is_some() => {
    collect_deadline = None;
    if !pending.is_empty() {
        let merged = merge_pending(&pending);          // 见下
        let run_id = pending.iter().find_map(|p| p.run_id.clone());
        pending.clear();
        turn_seq += 1;
        local_running = true;
        active_run_id = run_id.clone();
        if let Some(m) = mgr.upgrade() { m.mark_turn(&sid, TurnState::Running, turn_seq); }
        if let Err(e) = process.send_prompt(&merged).await {
            tracing::warn!("collect flush send_prompt failed for {}: {}", sid, e);
        }
    }
}
```

### 合并格式 `merge_pending`

抄 naozhi 的语义头,让模型明确这是"上一条处理期间的追加"而非独立请求。时间戳用 `chrono_tz::Asia::Shanghai`(`scheduled_tasks.rs` 已引入)格式化为 `HH:MM`:

```
[以下是你处理上一条消息期间用户追加发送的内容,请一并处理]
[HH:MM] 第一条追加文本
[HH:MM] 第二条追加文本
```

> 单条追加(`pending.len() == 1`)时是否仍加语义头:**仍加**,保持格式一致且让模型知道这是追加上下文。

纯函数 `fn merge_pending(pending: &[PendingPrompt]) -> String`,可独立单测。

### run_id 处理

scheduled-run 一次只发一条 prompt(`trigger_run` 单发),实践中 pending 里的 run_id 几乎总是 `None`。合并时取**第一个非 None 的 run_id** 透传给合并后的 turn,保证 scheduled-run 的 finalize 仍能触发。

### Interrupt 与 collect 的关系

用户**显式**中断(B-2 红点/中断键 → `SessionInput::Interrupt`,:1609):保持现有行为(`process.interrupt()`),并**清空 `pending` + 取消 `collect_deadline`**。语义:"软停当前 turn 并放弃追加队列"。

### 不变量保证

- fanout 仍是进程唯一所有者;所有改动是 loop 内部局部状态。
- 不新增对外通道,不改广播/scrollback 机制。
- 三个 fanout 改动一致 —— `merge_pending` 抽为自由函数共用,队列逻辑各自内联(三处近乎复制,与现有 fanout 复制风格一致)。

---

## Feature 2 — auto-titler

### 1. `name_is_auto` 标记(新增 LabelOrigin 概念)

代码确认当前无任何 name-origin 区分。新增:

- **`Session` 结构**(`session_manager.rs:151` 附近)加字段 `pub name_is_auto: bool`。
  - 会话创建时初始名为 `claude-1`/`codex-2` 等占位名 → 初始 `name_is_auto = true`(允许被自动命名覆盖)。
- **DB**(`src/db.rs` / session store):`sessions` 表加列 `name_is_auto INTEGER NOT NULL DEFAULT 1`。需 migration(`ALTER TABLE ... ADD COLUMN`,SQLite 兼容;已有行默认 1)。会话加载时读回该列。
- **用户改名锁定**:用户经 `PATCH /api/sessions/{id}` 改名 → `update_session_meta_named` 写入 `name` 的同时把 `name_is_auto = false`(永久锁定,之后 titler 不再覆盖)。需同步落库。

### 2. 触发点

在三个 fanout 的 turn 结束臂,首个 boundary 处触发。新增本地标志 `let mut titled = false;`:

```rust
// 在 is_boundary 分支内,翻 Idle 之后:
if !titled {
    if let AcpEvent::Result { text, .. } = &evt {
        // 仅当本 run 记录到首条 prompt 时才命名(resume 等无 prompt 的
        // turn 跳过)。无论成功与否都只尝试一次。
        if let Some(fp) = first_prompt.clone() {
            titled = true;
            if let Some(m) = mgr.upgrade() {
                if m.session_name_is_auto(&sid) {
                    // cli_path 经 m.titler_cli_for(agent_label) 解析
                    crate::auto_titler::spawn_titler(
                        sid.clone(), agent_label, fp,
                        text.clone(), work_dir.clone(), mgr.clone(),
                    );
                }
            }
        }
    }
}
```

> **记录首条 prompt**:fanout 在首次发送 prompt 时把 text 存入本地 `let mut first_prompt: Option<String>`(仅记录第一条,后续不覆盖)。collect 合并后的文本不算"首条"。

> **CLI path 来源**:`SessionManager` 已持有 `claude_path`/`kiro_path`/`codex` 启动配置;titler 需对应后端的 path。通过一个 `mgr` 访问器 `titler_cli_for(agent_label) -> (backend, path)` 取得,避免在 fanout 里硬编码。

### 3. titler 任务(新模块 `src/auto_titler.rs`)

`pub fn spawn_titler(...)` → `tokio::spawn(async move { ... })`,约 60–80 行:

1. 按 `agent_label` 起对应**临时进程**(复用现有 `AcpProcess::spawn(path, work_dir, None)` / `KiroProcess::spawn` / `CodexProcess::spawn`)。**不进 SessionManager**,故无 worktree、不进会话列表、无 scrollback。
2. `process.send_prompt(&titler_prompt)`(prompt 见下)。
3. 在 15s 超时(`tokio::time::timeout`)内读 `process.event_rx`,直到 `AcpEvent::Result { text, .. }`,取 `text`。
4. `sanitize_title(text)` 清洗 → `Option<String>`。
5. 若 `Some(title)`:再查一次 `mgr.session_name_is_auto(&sid)`(防用户在 titler 跑的几秒内手动改名的竞态)→ 仍为 auto 才写回 `mgr.set_auto_title(&sid, &title)`。
6. `process.kill()`,任务结束。
7. 任一步失败/超时/空 → 静默放弃,保留原名,记 `tracing::debug`。

### 4. titler prompt(抗注入:英文 system 锁语义,中文输出硬约束)

```
You are a titling assistant. Read the conversation below and output ONLY a concise title.
Rules:
- Language: Chinese.
- Max 16 Chinese characters.
- No quotes, no punctuation, no explanation, no markdown.
- Do NOT use any tools or take any action.
- Output the title text and nothing else.
---
User: <首条 prompt(截断到 ~1000 字)>
Assistant: <Result 文本(截断到 ~1000 字)>
```

会话内容作为**数据**置于 system 指令之后,英文指令在前锁定行为,降低对话内容里"请把标题改成 XXX"之类注入的影响。

### 5. 写回方法 `set_auto_title`(与用户路径解耦)

新增 `SessionManager::set_auto_title(&self, id: &str, title: &str) -> bool`:
- 仅当 `name_is_auto == true` 时写入 `name = title`,**保持 `name_is_auto = true`**(后续若改成"每 turn 重命名"才有意义;本 spec 只触发一次,故保持 auto 不影响)。
- 落库 `name`(`store.update_name`),广播给客户端(复用现有 session 列表刷新机制 —— `name` 变化已经过 `SessionInfo` 下发,前端自动更新)。
- **不**调用用户改名路径,**不**翻 `name_is_auto`。

新增只读访问器 `SessionManager::session_name_is_auto(&self, id: &str) -> bool`。

### 6. 清洗函数 `sanitize_title`

纯函数,可独立单测:
```rust
fn sanitize_title(raw: &str) -> Option<String>
```
- trim 空白;去首尾引号(中英文 `"` `"` `'` `「」` 等);取第一行(去换行);
- 去掉常见前缀("标题:"、"Title:");
- 按**字符**(非字节)截断到 16;
- 空 → `None`。

---

## 前端

- **collect**:MVP 无改动(不做 queued 提示)。
- **titler**:无改动(`session.name` 变化已通过现有 session 列表广播,标题自动刷新)。

---

## 测试策略(goal-driven)

| 单元 | 测试 | 验证标准 |
|---|---|---|
| `merge_pending` | 多条/单条 prompt 合并 | 语义头存在、`[HH:MM]` 时间戳、顺序正确 |
| collect 队列逻辑 | Running 时入队、turn 结束 flush、窗口防抖 | (尽量抽成可测的纯逻辑;select! 集成部分手动验证) |
| `sanitize_title` | 引号/换行/超长/空/前缀 | 截断 ≤16 字符、去引号、空→None |
| 集成 | 起会话→首 turn→观察改名;Running 时连发→观察合并 | 手动 + `cargo test` 现有用例不回归 |

命令:`cargo test`、`cargo check`(release 慢,迭代用 debug)。

---

## 改动文件清单

| 文件 | 改动 |
|---|---|
| `src/session_manager.rs` | 3 个 fanout 加 collect 队列+500ms 窗口+第三 select 臂;`merge_pending` 自由函数;首 turn 触发 titler(记录 first_prompt + titled 标志);`Session.name_is_auto` 字段;`set_auto_title` + `session_name_is_auto` + `titler_cli_for` 方法;`update_session_meta_named` 用户路径锁 `name_is_auto`;Interrupt 清空 pending |
| `src/auto_titler.rs`(新) | `spawn_titler` 任务 + titler prompt + `sanitize_title`(含单测) |
| `src/db.rs` / session store | `name_is_auto` 列 + migration + 读回 |
| `src/web.rs` | 核对 PATCH 改名路径是否经 `update_session_meta_named`(确认会锁 `name_is_auto`) |

---

## 风险与边界

- **collect 窗口与 scheduled-run**:scheduled-run 单发 prompt,几乎不进 pending;run_id 透传逻辑保证 finalize 不丢。
- **titler CLI 缺失**:部署机若某后端 CLI 不存在,titler spawn 失败 → 静默放弃,不影响会话。
- **titler 竞态**:写回前二次校验 `name_is_auto`,防与用户手动改名打架。
- **三 fanout 重复**:collect 逻辑三处近乎复制 —— 与现有 fanout 本就三份复制的风格一致;`merge_pending`/titler 抽公共函数,复制的只是队列内联部分。若未来要去重再统一抽象(本 spec 不做,避免过早抽象)。
