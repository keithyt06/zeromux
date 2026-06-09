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
| collect 前端 queued 提示 | **做最小提示**(前端读 `System{subtype:"queued"}` 显示"已排队 N 条") |
| collect 与 scheduled-run | **携带 `run_id` 的 prompt 绕过 collect**,自成一 turn,绝不参与合并(防 CTO 评审 C3:调度运行被对话追加污染、verdict 失真) |
| titler 执行方式 | 轻量临时进程(复用 `AcpProcess`/`KiroProcess`/`CodexProcess` 的 `spawn`+`send_prompt`+`event_rx`,**不进 SessionManager**,无 worktree、不污染会话列表) |
| titler 沙箱 | **指向系统临时空目录运行 + 尽量关工具**(防 CTO 评审 C1:prompt 注入→在 repo 内 RCE)。质量不受影响,仅多一个 tmpdir |
| titler 后端 | 跟随会话的 agent(claude→claude,codex→codex,kiro→kiro) |
| titler 触发 | **首个"实质" prompt** 的 turn 结束后命名一次(跳过 `hi`/`ls`/`继续` 等琐碎开场,防评审 P1:琐碎开场被永久锁成标题);之后不再自动改 |
| titler 标题语言 | 固定中文 ≤16 字(英文 system 指令锁语义抗注入) |
| titler 超时 | 15s,超时静默放弃 |
| 用户改名保护 | 新增 `name_is_auto` 标记,用户手改名后永不被自动覆盖 |

> **CTO/PM 评审修订(2026-06-09)**:本 spec 经 `/plan-ceo-review` + `/plan-eng-review` 双轮走查后修订。
> - 产品/PM(CEO 评审):titler 加沙箱(C1)、collect `run_id` prompt 绕行(C3)、titler 触发改"首条实质 prompt"(P1)、collect 补最小 queued 提示(P3)。
> - 工程/CTO(Eng 评审):**E12(严重 correctness)** titler 命名后置 `name_is_auto=false`,否则每次重启/resume 都重命名;**E10** 沙箱必须用专用无工具 spawn(会话 spawn 硬编 skip-permissions),否则关工具落空;**E7** queued 事件设 ephemeral(在 WS handler 跳过 scrollback)防重连幻影;**E3** collect 加 `COLLECT_MAX_MS` 硬上限防无限防抖饿死;**E5** Interrupt 无条件清队列(不被 `local_running` guard 挡住)。
> - 取舍记录:本期做 LLM 沙箱 titler;纯启发式版与 session-intelligence 平台化(summary/tags/digest 复用"沙箱化 对话→文本"原语)记入远期 TODO。

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
let mut collect_deadline: Option<Pin<Box<tokio::time::Sleep>>> = None;  // 防抖窗口(每条新 prompt 重置)
let mut collect_hard_deadline: Option<Instant> = None;  // 评审 E3:首条入队起的硬上限,不被重置
// PendingPrompt { text: String, ts_ms: i64 }   // run_id 恒 None(见 C3),可省略该字段
const COLLECT_DEBOUNCE_MS: u64 = 500;   // 防抖窗口
const COLLECT_MAX_MS: u64 = 3000;       // 硬上限:首条入队后最多等这么久必 flush
```

**改造 1 — input 臂(:1593)**:
- `run_id.is_some()`(scheduled-run prompt):**绕过 collect**,无论是否 `local_running` 都走原"立即发送"路径(必要时先 interrupt 再 resend,保持 B-2 现有调度语义)。调度运行必须自成一 turn,绝不被对话追加合并污染,否则其 `run_id` verdict 会 finalize 在一个混入用户闲聊的 turn 上(评审 C3)。
- `!local_running`(普通 prompt,无 run_id):照旧立即发送(`turn_seq += 1`、`mark_turn(Running)`、`send_prompt`)。
- `local_running`(普通 prompt,无 run_id):**入队** `pending.push(PendingPrompt { text, ts_ms: now_millis() })`。不动 turn 状态,不 interrupt。
- 防抖 + 硬上限(评审 E3):每次入队都**重置** `collect_deadline = now + COLLECT_DEBOUNCE_MS`;但 `collect_hard_deadline` **仅在它为 `None` 时**设为 `now + COLLECT_MAX_MS`(首条入队那刻锚定,后续不重置)。实际 flush 触发取两者**较早**者。
- 入队后向客户端发一条 `System{subtype:"queued"}` 事件(携带当前 `pending.len()`),供前端显示"已排队 N 条"。**该事件 ephemeral**(评审 E7:否则 B-1 重连回放会显示早已 flush 的"已排队 N 条"幻影)。
  - **机制核对**:scrollback push 不在 fanout 内,而在 WS handler——`acp/ws_handler.rs:132` 订阅 broadcast 后把每条 event `push_scrollback`。所以"ephemeral"要在 **WS handler 侧**实现:`acp/ws_handler.rs` 收到事件后,若其为 `System{subtype:"queued"}` 则**只转发给客户端、跳过 `push_scrollback`**。fanout 照常 `event_tx.send` 即可。

**改造 2 — turn 结束臂(:1564,`boundary_count >= turn_seq` 处)**:
- 翻 `local_running = false`、`mark_turn(Idle)` 照旧。
- 之后:若 `!pending.is_empty()` 且 `collect_deadline.is_none()`,arm 防抖窗口 `collect_deadline = now + COLLECT_DEBOUNCE_MS`;并在 `collect_hard_deadline.is_none()` 时锚定硬上限 `= now + COLLECT_MAX_MS`。
  - 注:turn 进行中入队的 prompt 已在改造 1 锚定了 hard_deadline;此处覆盖"turn 刚结束才发现 pending 非空"的情况。

**改造 3 — 新增第三个 select! 臂(收集窗口到期 = 防抖 OR 硬上限,取较早者)**:
```rust
// 等待两个 deadline 中较早者;任一为 None 则视为无穷远
_ = wait_earlier(&mut collect_deadline, collect_hard_deadline),
        if collect_deadline.is_some() => {
    collect_deadline = None;
    collect_hard_deadline = None;     // 评审 E3:flush 时一并清掉硬上限
    if !pending.is_empty() {
        let merged = merge_pending(&pending);          // 见下
        pending.clear();
        turn_seq += 1;
        local_running = true;
        active_run_id = None;   // 合并 turn 永不携带 run_id(run_id prompt 已在 input 臂绕过 collect)
        if let Some(m) = mgr.upgrade() { m.mark_turn(&sid, TurnState::Running, turn_seq); }
        if let Err(e) = process.send_prompt(&merged).await {
            tracing::warn!("collect flush send_prompt failed for {}: {}", sid, e);
        }
    }
}
```
> `wait_earlier` 语义:在 `collect_deadline`(防抖 Sleep)与 `collect_hard_deadline`(硬上限 Instant)之间取较早到期者 await。实现可把硬上限也表示为一个 `Sleep`,arm 时同时建两个 Sleep,select 内 `tokio::select!{ _ = &mut debounce => …, _ = &mut hard => … }`,任一触发都走同一 flush 分支。具体写法实现期定,语义以"防抖与硬上限较早者触发 flush"为准。

### 合并格式 `merge_pending`

抄 naozhi 的语义头,让模型明确这是"上一条处理期间的追加"而非独立请求。时间戳用 `chrono_tz::Asia::Shanghai`(`scheduled_tasks.rs` 已引入)格式化为 `HH:MM`:

```
[以下是你处理上一条消息期间用户追加发送的内容,请一并处理]
[HH:MM] 第一条追加文本
[HH:MM] 第二条追加文本
```

> 单条追加(`pending.len() == 1`)时是否仍加语义头:**仍加**,保持格式一致且让模型知道这是追加上下文。

纯函数 `fn merge_pending(pending: &[PendingPrompt]) -> String`,可独立单测。

### run_id 处理(评审 C3)

`run_id` prompt 在 input 臂**直接绕过 collect**(见改造 1),所以 `pending` 里恒为 `None`,合并 turn 也恒 `active_run_id = None`。这保证:scheduled-run 永远独占一个干净 turn,其 verdict 不会 finalize 在混入用户对话追加的合并 turn 上。`PendingPrompt.run_id` 字段因此实际恒 `None`,保留只为结构对称(可简化为不带该字段;实现时二选一,但语义以"合并 turn 无 run_id"为准)。

### Interrupt 与 collect 的关系

用户**显式**中断(B-2 红点/中断键 → `SessionInput::Interrupt`,:1609):
- 若 `local_running`:照旧 `process.interrupt()`。
- **无条件**(不论是否 `local_running`)清空 `pending` + 取消 `collect_deadline` + 取消 `collect_hard_deadline`(评审 E5)。语义:"软停 + 放弃追加队列"。
  - 关键:现有代码的 interrupt 臂是 `if local_running { … }`。若把清队列也放进这个 guard,会漏掉"turn 已结束、收集窗口正等着 flush"这个状态(此时 `local_running == false` 但 pending 非空)——用户中断意图是"别发那批排队的了",必须清。所以清队列放在 guard **之外**。

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

在三个 fanout 的 turn 结束臂,首个**实质** prompt 的 boundary 处触发。新增本地标志 `let mut titled = false;`:

```rust
// 在 is_boundary 分支内,翻 Idle 之后:
if !titled {
    if let AcpEvent::Result { text, .. } = &evt {
        // 仅当本 run 记录到"首条实质 prompt"时才命名(评审 P1):
        // 跳过 hi/ls/继续 等琐碎开场,避免把它们永久锁成标题。
        // resume 等无 prompt 的 turn 也跳过。一旦命中即 titled=true,
        // 无论成功与否只尝试一次。
        if let Some(fp) = first_substantive_prompt.clone() {
            titled = true;
            if let Some(m) = mgr.upgrade() {
                if m.session_name_is_auto(&sid) {
                    // cli_path 经 m.titler_cli_for(agent_label) 解析
                    crate::auto_titler::spawn_titler(
                        sid.clone(), agent_label, fp,
                        text.clone(), mgr.clone(),   // 注意:不再传 work_dir(沙箱)
                    );
                }
            }
        }
    }
}
```

> **记录首条实质 prompt**:fanout 维护 `let mut first_substantive_prompt: Option<String>`。每次发送一条用户 prompt 时,若该字段仍为 `None` 且该 prompt 通过 `is_substantive_prompt(text)` 判定,则记录它(仅记录第一条通过判定的,后续不覆盖)。collect 合并后的文本不参与判定(合并 turn 不触发命名)。
>
> **`is_substantive_prompt(text) -> bool`**(纯函数,可单测):trim 后——长度 ≥ 阈值(如去空白后 ≥ 6 字符)**或** 含空白/换行(多词,非单 token 命令)即为实质;纯单 token 短命令(`hi`、`ls`、`继续`、`y`、`q` 等,trim 后无空白且很短)判为非实质。阈值与规则在实现期可微调,以"放过真实意图、挡住琐碎开场"为准。

> **CLI path 来源**:`SessionManager` 已持有 `claude_path`/`kiro_path`/`codex` 启动配置;titler 需对应后端的 path。通过一个 `mgr` 访问器 `titler_cli_for(agent_label) -> (backend, path)` 取得,避免在 fanout 里硬编码。

### 3. titler 任务(新模块 `src/auto_titler.rs`)

`pub fn spawn_titler(...)` → `tokio::spawn(async move { ... })`,约 60–80 行:

1. **建沙箱临时目录**(评审 C1):`std::env::temp_dir()` 下建一个唯一空目录(如 `zeromux-titler-<rand>/`),titler 进程在此目录运行,**不指向会话 work_dir**。任务结束删除该目录。
2. 起一个**专用 titler 进程**(评审 E10:**不复用会话 spawn**)。原因:`AcpProcess::spawn` 硬编了 `--dangerously-skip-permissions`(process.rs:100)且授予全工具,与"关工具"直接矛盾。需为 titler 写最小 spawn 路径:
   - **Claude**:`claude -p --output-format stream-json --input-format stream-json --allowedTools ""`(或等价的不授予工具 + **不加** `--dangerously-skip-permissions`),work_dir = 沙箱目录。
   - **Codex/Kiro**:各自起进程时按 CLI 支持尽量不授予工具(codex 的 config / kiro 的 trust 参数),work_dir = 沙箱目录。
   - 实现上可在 `auto_titler.rs` 内直接构造 `tokio::process::Command`,或给三个 `*Process` 各加一个 `spawn_titler_variant(path, sandbox_dir)` 构造器,复用其 stdout→`AcpEvent` 解析但换 CLI 参数。**不进 SessionManager**,故无 worktree、不进会话列表、无 scrollback。
3. **关工具是第一层防线,prompt 约束是第二层**(评审 C1):安全目标——即使 prompt 注入让模型尝试动作,它既没有工具可用、又只在一个空临时目录里,无法触及 repo。"reuse spawn" 拿不到这个保证,故必须专用 spawn。
4. `process.send_prompt(&titler_prompt)`(prompt 见下)。
5. 在 15s 超时(`tokio::time::timeout`)内读 `process.event_rx`,直到 `AcpEvent::Result { text, .. }`,取 `text`。
6. `sanitize_title(text)` 清洗 → `Option<String>`。
7. 若 `Some(title)`:再查一次 `mgr.session_name_is_auto(&sid)`(防用户在 titler 跑的几秒内手动改名的竞态)→ 仍为 auto 才写回 `mgr.set_auto_title(&sid, &title)`。
8. `process.kill()` + 删沙箱目录,任务结束。
9. 任一步失败/超时/空 → 静默放弃,保留原名,记 `tracing::debug`。

> **沙箱有效性说明**:`Drop for AcpProcess/KiroProcess/CodexProcess` 都已 `start_kill()`(代码确认),故即使任务 panic,临时进程也会被回收,不留孤儿。沙箱目录用唯一名,多个 titler 并发互不干扰。

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
- 仅当 `name_is_auto == true` 时写入 `name = title`,**写入成功后置 `name_is_auto = false`**(评审 E12 严重修订)。
- 落库 `name` **和** `name_is_auto`(`store.update_name` + 新增 `store.update_name_is_auto` 或合并写),广播给客户端(复用现有 session 列表刷新机制 —— `name` 变化已经过 `SessionInfo` 下发,前端自动更新)。
- **不**调用用户改名路径。

> **E12 修订理由(严重 correctness)**:`titled` 是 fanout 任务内的局部标志,进程每次重启/B-1 resume/重连重生 fanout 都会重置为 `false`。若 `set_auto_title` 保持 `name_is_auto = true`,则重启后下一个实质 turn 会**再次命名**,用一个可能更差的后续 turn 覆盖已有好名字 —— 名字在每次重启时漂移。后置 `name_is_auto = false` 让自动命名"一生只一次",任何重生都无法再触发(因为 `m.session_name_is_auto(&sid)` 返回 false)。这与"首轮命名一次"的产品决策一致,持久化标志是正确的真相来源,而非任务内局部标志。

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

- **collect(最小 queued 提示,评审 P3)**:`AcpChatView` 处理新事件类型 `System{subtype:"queued"}`,在输入区上方显示一行轻量提示"已排队 N 条,本轮结束后合并发送"(N 取事件携带的 `pending.len()`)。合并 turn 实际发出(下一个 `mark_turn(Running)`)时清除该提示。这把 collect 从"看不见的魔法"变成"可信的行为"——手机用户连发后立刻看到反馈,不会误以为卡死而重发或离开。仅一行状态文本,无新组件、无交互。
- **titler**:无改动(`session.name` 变化已通过现有 session 列表广播,标题自动刷新)。

---

## 测试策略(goal-driven)

| 单元 | 测试 | 验证标准 |
|---|---|---|
| `merge_pending` | 多条/单条 prompt 合并 | 语义头存在、`[HH:MM]` 时间戳、顺序正确 |
| `is_substantive_prompt` | hi/ls/继续/y vs "帮我review这段代码" | 琐碎开场→false,实质 prompt→true |
| collect 队列逻辑 | Running 时入队、turn 结束 flush、防抖、**硬上限 flush(E3)**、**run_id 绕过(C3)** | run_id prompt 自成 turn 不入队;连续输入超 COLLECT_MAX_MS 必 flush;select! 集成手动验证 |
| Interrupt 清队列(E5) | turn 已结束+窗口 armed 时中断 | pending 清空、两个 deadline 取消、不发合并 |
| queued ephemeral(E7) | 重连回放 | 回放中无 `System{subtype:"queued"}` |
| `sanitize_title` | 引号/换行/超长/空/前缀 | 截断 ≤16 字符、去引号、空→None |
| titler 一次性(E12) | 命名后查 `name_is_auto`==false;模拟 fanout 重生 | 重启/resume 后不再 re-title |
| 集成 | 起会话→首实质 turn→观察改名;Running 时连发→合并+queued 提示;调度任务 Running 时触发→verdict 不污染;titler 注入串("ignore…rm -rf")→repo 无副作用(E10/C1) | 手动 + `cargo test` 现有用例不回归 |

命令:`cargo test`、`cargo check`(release 慢,迭代用 debug)。

---

## 改动文件清单

| 文件 | 改动 |
|---|---|
| `src/session_manager.rs` | 3 个 fanout 加 collect 队列+防抖窗口+硬上限(E3)+第三 select 臂+`run_id` 绕行(C3)+`queued` 事件;`merge_pending`/`is_substantive_prompt` 自由函数;首条实质 turn 触发 titler(记录 `first_substantive_prompt` + `titled` 标志);`Session.name_is_auto` 字段;`set_auto_title`(命名后置 `name_is_auto=false`,E12)+ `session_name_is_auto` + `titler_cli_for` 方法;`update_session_meta_named` 用户路径锁 `name_is_auto`;Interrupt 无条件清队列(E5) |
| `src/auto_titler.rs`(新) | `spawn_titler` 任务(沙箱临时目录 + **专用无工具 spawn**,E10)+ titler prompt + `sanitize_title`(含单测) |
| `src/session_store.rs` | `name_is_auto` 列(`ALTER TABLE sessions ADD COLUMN name_is_auto INTEGER NOT NULL DEFAULT 1`,沿用 :54 的 `let _ = execute(...)` 幂等模式)+ 读回 + `update_name_is_auto` 写 |
| `src/web.rs` | PATCH 改名路径经 `update_session_meta_named` → 落 `name_is_auto = false`(核对实现) |
| `src/acp/ws_handler.rs` | `System{subtype:"queued"}` 事件**跳过 `push_scrollback`**(E7 ephemeral) |
| `frontend/src/components/.../AcpChatView`(及事件类型) | 处理 `System{subtype:"queued"}` → 显示"已排队 N 条"一行提示 |

---

## 风险与边界

- **collect 窗口与 scheduled-run(C3,已解)**:`run_id` prompt 在 input 臂直接绕过 collect,自成干净 turn,verdict 不会 finalize 在合并 turn 上。
- **titler 注入→RCE(C1,已解)**:沙箱临时空目录 + 尽量关工具,prompt 约束作为第二层。即使模型被注入诱导动作,也触及不到 repo。
- **titler 三后端文本提取复杂度(C2,实现期注意)**:`AcpProcess`(Claude)读到干净 `AcpEvent::Result` 最简单;`KiroProcess`(JSON-RPC 握手)与 `CodexProcess`(MCP server,文本走 notification 而非 call 响应)起进程更重、Result 到达路径更曲折。"读 event_rx 到 Result"对 codex/kiro 要按各自协议落实,不是一行。这是"跟随会话 agent"选择的已知代价;若实现期发现 codex/kiro titler 成本过高,回退选项是"titler 一律用 claude -p"(已在设计讨论中评估过)。
- **titler CLI 缺失**:部署机若某后端 CLI 不存在,titler spawn 失败 → 静默放弃,不影响会话。
- **titler 竞态**:写回前二次校验 `name_is_auto`,防与用户手动改名打架。
- **三 fanout 重复**:collect 逻辑三处近乎复制 —— 与现有 fanout 本就三份复制的风格一致;`merge_pending`/`is_substantive_prompt`/titler 抽公共函数,复制的只是队列内联部分。若未来要去重再统一抽象(本 spec 不做,避免过早抽象)。

---

## NOT in scope / 远期(评审 Think Big,记入 TODO)

本期**不做**,但评审中识别为有价值的演进方向,记此供未来写 spec:

- **纯启发式 titler**(0 进程 0 token):本期选了 LLM 沙箱版以拿更高质量标题;启发式版(取首条实质 prompt 首行清洗截断)作为"零成本兜底/降级路径"留待将来。
- **session-intelligence 平台层**:titler 本质是"沙箱化的 对话→文本 LLM 调用"原语。同一原语可复用做:会话 summary、auto-tags、"本会话改了什么"digest。把 `auto_titler.rs` 的沙箱调用抽象成通用 `conversation_distill(prompt, conv) -> text` 后,这些能力近乎免费。对应 naozhi 的 `system-session` 包。
- **titler 多次重命名**:本期只在首条实质 turn 命名一次。naozhi 支持随对话演进重命名(5min 节流 + `name_is_auto` 已为此预留)。需要时打开。
- **input-intelligence 层**:collect 队列是第一步。未来可加 `/stop`(软停留队列)、`urgent:` 抢占、队列去重——naozhi 的 message-queue 三模式全集。
- **后台自动更新 / 事件持久化第二层**:naozhi 调研 #3/#4,与本两 feature 无关,独立 spec。
