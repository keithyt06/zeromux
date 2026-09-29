# S5「收结果 + Crew 探针」—— 设计

- 日期：2026-09-29
- 状态：v1。已吸收 S6/S7 v2 的交叉评审裁决，本文**定义**跨 spec 的统一约定。
- 基线：`main` @ `33c2236`。下文的 file:line 都在这个提交上亲自核对过。
- 上游文档：
  - 路线图 `docs/superpowers/audits/2026-09-29-kiro-final-roadmap.md` §3「S5」
  - 裁决 `audits/2026-09-29-spec-review-decisions.md`「跨 spec 统一约定」
  - Crew 实测 `audits/2026-09-29-kiro-crew-gap-research.md` §7
- 兄弟 spec：S6 `2026-09-29-s6-gate-review-dispatch-design.md`（v2）、S7 `2026-09-29-s7-crew-cockpit-and-backend-parity-design.md`（v2）。S6/S7 引用的字段和函数都在这里定义。
- 约束：个人项目、all-trust，**不做治理/权限/沙箱/审计**。

---

## 0. 决策记录

### 0.1 范围（8 项）

| # | 项 | Stage | 一句话 |
|---|---|---|---|
| F1 | 态势持久化 | 3 | 重启或部署后，「完成·未读 / 出错 / 待回答」不丢 |
| F2 | 推送带结论 + 定时 `run_done` | 3 | 锁屏就能判断要不要处理；定时任务成功也推 |
| F3 | 离开期间卡 | 3 | 打开分诊时，一眼看到离开这段时间发生了什么 |
| F4 | 记为约定（方案 A） | 调优 | 一次纠正 → 当前 agent 自己追加到 CLAUDE.md / AGENTS.md |
| SP | Crew spike 补测 | — | R1/R2 已实测；补 `crew_result` 形态，并把帧存成夹具 |
| G1 | Crew Mode 结果可见 | 5 | `chat_message` 按 `kind∈crew_*` 白名单放行 |
| G2 | Crew 入口 + 三列持久化 + 埋点 | 5 | `create_slot` 透传 `mode`/`agent`；⌘K 二级 chip；`zmx_usage` 埋点 |
| R4 | `owns_slot` | — | Drop 时只删自己建的 slot，依据是持久化的 `crew_origin` |

### 0.2 跨 spec 统一约定（本文定义，S6/S7 引用）

| # | 约定 | 定义位置 |
|---|---|---|
| U1 | `sessions` 表加三列：`crew_mode TEXT NOT NULL DEFAULT ''`（Gateway 原值 `""\|crew`）、`crew_agent TEXT NOT NULL DEFAULT ''`（原值，如 `kirocrew-conductor`）、`crew_origin TEXT NOT NULL DEFAULT 'zeromux'`（`zeromux\|external`）。三档展示（聊天 / 并行话题 / 目标指挥）由前端从这三列派生 | §7.2、§8.2 |
| U2 | `owns_slot = crew_origin != "external"`。**禁止**用 `resume.is_none()` 推断：自建 slot 重启后同样走 `resume=Some(k)`（`crew_process.rs:596-601`） | §8 |
| U3 | `persist_posture(sid)`：把 `last_outcome / last_outcome_ms / last_snippet / awaiting_input` 写进 `sessions` 表。S5 在 `settle_posture` 末尾调用；S6 在 crew_ask 路径上调用 | §1.3 |
| U4 | `payload_for(kind, name, sid, fk, body: Option<&str>)`：新增 `body` 参数，给出时覆盖默认正文。S6 中「`payload_for(k, n, s, None)` + body = X」的写法即 `payload_for(k, n, s, None, Some(X))`；新 kind `ask` 的默认文案由 S6 定义 | §2.2 |
| U5 | 埋点 target 统一为 `zmx_usage`（`tracing::info!`），门槛 T 和北极星都用 journalctl 统计 | §7.4 |

### 0.3 本文拍板的 taste 决定

| # | 问题 | 决定 | 理由 |
|---|---|---|---|
| D1 | G2 在 S5 开放几个 chip | **「聊天」「目标指挥」两个**。「并行话题」由 S6 T3 与 G3 同期上线 | crew mode 没有 `chat_done`（实测 §7 R2），现有 fan-out 会一直认为 turn 在跑，30 分钟后被交互看门狗 `TimeoutKill`，Drop 连带删掉 slot（S6 §0.1）。后端 S5 就透传 `mode`，前端先不暴露 |
| D2 | G1 中 `crew_ack` 怎么显示 | 映射为 `System{subtype:"crew_ack"}`，前端显示灰色一行「Crew 已接收」 | ack 不是回答，不该进助手气泡 |
| D3 | G1 中 `crew_ask/crew_result/crew_meta` 怎么显示 | 映射为**非边界** `ContentBlock{block_type:"text", summary:Some(kind)}`；**不进 `turn_text`**；前端按 summary 渲染：ask = 问题卡样式（`--attention` 底色 + 「Crew 在问你」），meta = 灰色提示，result = 普通正文 | 实测失败和求助只走 `chat_message`（§7 结论 2）；非边界是为了不打乱现有 turn FIFO |
| D4 | F3 的「离开」怎么界定 | 本设备 `zmx_left_ms`（`pagehide` 或 `visibilitychange→hidden` 时写入 localStorage）到本次打开的间隔 **≥ 30 分钟**才显示；关掉卡片后本次不再出现 | 服务端已读要到 S6 T0 才有（S6 §12）；S5 先用本机口径，S6 上线后改读服务端 `read_ms` |
| D5 | F4 用哪种方式写 | 方案 A：通过 `sessionControls.sendPrompt` 发给**当前会话**一条固定模板 prompt，由 agent 自己追加。不加后端端点 | 文件写 API 会整文件覆盖（`web.rs:2264`），和 agent 并发改文件时有 lost-update 竞态；方案 A 零后端改动（CTO 审 PM 专项 1） |
| D6 | F4 的入口 | AcpChatView composer「＋」菜单（`AcpChatView.tsx:315`）加「记为约定…」。**用户消息气泡的 ⋯ 本期不做** | ＋ 菜单已存在，改动一行；气泡菜单目前不存在，新建它不属于 S5 |
| D7 | F2 的正文长度 | `last_snippet` 截到前 120 个字符（`chars().take`，不按字节切），超出加 `…` | iOS 锁屏大约显示 2–3 行；按字节切会在 CJK 上 panic（07-16 教训） |
| D8 | `run_done` 推送档位 | **routine**（与 turn_done 同档），SW 前台时同样抑制 | 成功属于「知道就好」，不是「必须处理」；失败仍走 `run_failed`（important） |
| D9 | F1 在 turn 失败时的 snippet | 与内存行为一致：Errored/Timeout 时把 snippet 清为 NULL 再持久化（`session_manager.rs:2135-2137`） | A10 语义：失败的 turn 不显示上一轮的摘要 |
| D10 | Spike 补测谁执行 | 实施 S5 G1 的人在第一个 task 执行（需要 POST Gateway 创建一次性 slot，用完 DELETE）；不能执行时先用 §7 已有的帧做夹具，`crew_result` 字段按宽松解析 | spike 不阻塞 G1：G1 只依赖 `kind` 和 `content`/`text` 字段 |

---

## 1. F1 态势持久化

### 1.1 现状

- `Posture` 纯内存存储，注释写明「In-memory only: a restart resets it (accepted, M8)」（`session_manager.rs:3603-3615`）。
- 所有建会话的路径都是 `posture: Posture::default()`（`:1189`、`:1308`、`:1654`、`:1758`），`load_all` 回填时也是（`:2337`）。
- 前端 `newerThanView` 要求 `last_outcome_ms != null`（`frontend/src/lib/triage.ts:21-23`）。重启后恒为 null，所以「完成·未读」和「出错」全部消失。
- 已读侧存在 localStorage `zmx_read`（`lib/readState.ts:4`），不会丢。**丢的只是后端这一侧。**
- `settle_posture` 的实现在 `session_manager.rs:2127-2139`。

### 1.2 数据模型

`session_store.rs` 的 `open()` 沿用已有的 `let _ = conn.execute("ALTER TABLE ... ADD COLUMN ...")` 幂等写法（`:60-66`），追加以下列：

```sql
ALTER TABLE sessions ADD COLUMN last_outcome TEXT;          -- RunOutcome 的 snake_case，NULL=无
ALTER TABLE sessions ADD COLUMN last_outcome_ms INTEGER;
ALTER TABLE sessions ADD COLUMN last_snippet TEXT;
ALTER TABLE sessions ADD COLUMN awaiting_input INTEGER NOT NULL DEFAULT 0;  -- S6 使用
-- G2 / R4（§7、§8）
ALTER TABLE sessions ADD COLUMN crew_mode TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN crew_agent TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN crew_origin TEXT NOT NULL DEFAULT 'zeromux';
```

- `PersistedSession` 加对应字段：`posture: PersistedPosture { last_outcome: Option<String>, last_outcome_ms: Option<i64>, last_snippet: Option<String>, awaiting_input: bool }` 以及三个 `crew_*: String`。
- **`upsert` 只写三个 `crew_*` 列，不写 posture 列**。posture 是每轮都会变的运行态，不应该跟元数据全量写一起走（CTO 审 PM 专项 2）。
- 新增 `SessionStore::update_posture(id, &PersistedPosture)`，执行一条 `UPDATE sessions SET last_outcome=?2, last_outcome_ms=?3, last_snippet=?4, awaiting_input=?5 WHERE id=?1`。
- `load_all` 的 SELECT 加这 7 列。

### 1.3 `persist_posture(sid)`（U3）

```rust
/// Snapshot the persisted subset of posture under the sessions lock, then write
/// it OUTSIDE the lock (SQLite on JuiceFS can be slow; never hold `sessions`
/// across I/O). Called once per settled turn — low frequency.
fn persist_posture(&self, sid: &str)
```

- 调用点（S5）：`settle_posture` 在释放锁之后调用一次。S6 会在 crew_ask 路径和「用户回答后清除 awaiting_input」处加调用。
- **不在** `apply_posture_delta` 里调用。Snippet delta 每个 Result 都会触发，但 settle 紧跟其后，写一次就够了。`current_step` / `approval_ids` **不持久化**：它们是 turn 内状态，重启后 turn 本来就不在跑。
- 失败处理：`update_posture` 返回 Err 时只记 `tracing::warn!`，不影响 fan-out。持久化是 best-effort。
- `load_all` 回填：`Posture { last_outcome: parse_lenient(..), last_outcome_ms, last_snippet, awaiting_input, current_step: None, approval_ids: vec![] }`。遇到未知 outcome 字符串时回填为 None，不 panic。

### 1.4 不变量与边界情况

- fan-out 不变：`settle_posture` 本来就在 fan-out 线程上调用，这里只是追加一次写库。
- 重启后 `turn_state` 仍然是 Idle，所以 triage 的 `!running && last_outcome==completed && newerThanView` 能正常成立。
- 会话删除时行随之删除，不需要额外清理。
- tmux 会话从不 settle，四列保持 NULL/0。
- 老 DB：新列为 NULL，行为与现在相同。

### 1.5 测试

- `session_store`：
  - 迁移幂等：`open` 两次不报错。
  - `update_posture` 往返：写入后 `load_all` 能读回同样的值。
  - 老 schema 的行 `load_all` 能读出，posture 为空。
- `session_manager`：
  - settle(Completed) 后重建 manager（同一 data_dir）→ `session_info_of` 的 `last_outcome=completed`，`last_outcome_ms` 与重建前一致。
  - settle(Errored) → snippet 持久化为 NULL（D9）。
  - `current_step` 重启后为 None。
- 前端不需要改。

---

## 2. F2 推送带结论 + 定时 `run_done`

### 2.1 现状

- `payload_for` 的 turn_done 正文是固定的「本轮已结束」（`push.rs:343-345`）。
- `maybe_push_turn_done`（`session_manager.rs:2794-2820`）调用 `payload_for("turn_done", &name, &sid2, None)`，拿不到 snippet。
- 调用时机：Claude fan-out 中 `boundary_count >= turn_seq && active_run_id.is_none()`（`:2979-2982`）。此时 `emit` 已经执行，Result 的 snippet 已写入 posture（`emit` → `posture_delta_of` → `Snippet`，`:3651`、`:3670`）。
- 定时 run 走 `active_run_id.take()` → `finalize_run("succeeded", verdict, …)`（`:3007-3013`），**成功时没有任何推送**，失败时有 `run_failed`。
- 档位映射在 `kind_allowed_by_levels`（`push.rs:377-383`）：`turn_done|term_ended` 为 routine，其余为 important。
- SW：`frontend/public/sw.js:23`，只对 `turn_done` 做前台抑制；`:31` 的 tag 规则是 `turn_done → session_id`，其他 kind 为 `session_id:kind`。

### 2.2 设计

- **`payload_for` 加参数（U4）**：`pub fn payload_for(kind, name, session_id, fk, body: Option<&str>)`。`body` 为 `Some(非空)` 时覆盖默认正文，否则保持现有文案。现有调用点全部传 `None`（机械修改，编译器会逐个指出）。
- **turn_done**：`maybe_push_turn_done` 在构造 payload 前，在 sessions 锁内读 `posture.last_snippet`，按 D7 截断后作为 body。snippet 为 None 时（例如没有文本的 turn）保持「本轮已结束」。三个后端共用这个函数，天然 parity。
- **run_done（新 kind）**：
  - 位置：`finalize_run` 成功分支。目前只有 Claude fan-out 有这个分支，Codex/Crew 的定时任务由 S7 负责。
  - 在 `m.finalize_run(&rid, "succeeded", …)` 之后，新增 `maybe_push_run_done(&mgr, &sid, &owner_id, verdict.as_deref())`。
  - body 取值：优先用 verdict；没有 verdict 时用 snippet；两者都没有时写「定时任务已完成」。标题为 `⏰ {name} 完成`。
  - `kind_allowed_by_levels`：把 `"run_done"` 加进 routine 分支（D8）。
  - 去抖：复用 turn_done 的 map（同一个 `(uid,sid)`）。定时 run 不会同时触发 turn_done（后者门条件是 `active_run_id.is_none()`），不会重复推送。
- **SW（`sw.js`）**：前台抑制的条件改成 `kind === 'turn_done' || kind === 'run_done'`；tag 规则把 `run_done` 也归到 `session_id`（同一会话只保留最新一条）。`zmx-push` Cache 里的 `levels` 结构不变，run_done 走 routine 位。
- **PushSettings 文案**：routine 的描述里加上「定时任务完成」。

### 2.3 边界情况

- snippet 里含换行：替换成空格后再截断。
- 空白 verdict：视为 None。
- 定时 run 被 Cancelled/Timeout：走现有的 `intent_suppresses_push` 路径（`:3001-3004`），run_done **只在** `"succeeded"` 分支触发。

### 2.4 测试

- `push.rs`：
  - `payload_for("turn_done", …, Some("结论"))` 的 body 为「结论」；传 None 时仍是「本轮已结束」。
  - `kind_allowed_by_levels("run_done", false, true) == true`，`("run_done", true, false) == false`。
- 截断函数：含 CJK 的 200 字输入 → 120 字加 `…`；含 `\n` 的输入 → 换成空格。
- `session_manager`：保留 `maybe_push_run_done` 在 push 未接线时 no-op 的测试，照 `maybe_push_turn_done_is_safe_noop_without_push_service`（`:6483`）的写法。
- SW 手测：前台时 run_done 不弹出；后台时弹出，正文带 verdict。

---

## 3. F3 离开期间卡

### 3.1 现状

- 分诊分组由 `groupTriage`（`lib/triage.ts:57-71`）完成，渲染在 `TriageList`（`components/shell/TriageList.tsx`）。
- 数据全部已有：`SessionInfo.last_outcome/_ms`、`lifetime_cost_usd`，以及 `shell.confirmsBySession`。
- **强依赖 F1**：没有 F1 时，部署后卡片会显示「0 完成」。

### 3.2 交互

- **位置**：`TriageList` 最上方，「需要你」组之前。手机和桌面位置相同，J 键和 FAB 顺序不变。
- **显示条件**：满足 D4 的离开 ≥ 30 分钟，且窗口内至少有一个事件。
- **内容**：
  - 第一行：`离开 7h · 完成 5 · 出错 1 · 待确认 2 · $3.10`。数值为 0 的项不显示。花费只计 `last_outcome_ms` 落在窗口内的会话的 `lifetime_cost_usd`；Codex/Crew 没有 cost，显示「部分未计」。
  - 点击某一项：`onSelect` 跳到该类第一条会话。
  - 右侧 `×` 关闭，本次打开期间不再出现。
- **行数上限**：卡片正文最多 3 行（S6 V21 / PM m2）。S5 只有第一行这一行；S6 追加的 Crew 外部行、预检沉默行按优先级 `出错 > 待回答 > 待确认 > 完成 > 其他` 排序，超出部分收进「更多 (N)」。**排序键在这里定义，S6 只追加条目。**
- 实现为纯函数 `lib/awaySummary.ts`：`summarizeAway(sessions, confirms, leftMs, nowMs) → AwaySummary | null`，渲染组件为 `shell/AwayCard.tsx`。它是**首屏组件，不走 lazy**，体积估算见 §9。
- `zmx_left_ms`：由 `lib/awayClock.ts` 在 `pagehide` 和 `visibilitychange→hidden` 时写入。首次打开（没有这个键）时不显示卡片。

### 3.3 测试

- `summarizeAway` 单测：
  - 窗口外的事件不计入。
  - 离开时间 < 30 分钟返回 null。
  - 0 值项被省略。
  - Codex 会话标记「部分未计」。
  - 排序键正确。
- `AwayCard` 渲染测试：关闭后不再渲染；点击某项会调用 `onSelect(第一条 sid)`。
- `App.characterization.test.tsx` 必须不改就通过。卡片只在 `zmx_left_ms` 存在时显示，现有 fixture 中没有这个键。

---

## 4. F4 记为约定（方案 A）

### 4.1 现状

- 手机上改 CLAUDE.md 只能开终端，几乎做不到（PM J4）。
- 文件写 API 会整文件覆盖（`web.rs:2264`），不能用来追加。
- composer 的「＋」菜单已经存在（`AcpChatView.tsx:315-322`，目前有「附件」和 Crew 的「记忆」）。

### 4.2 交互

- 在「＋」菜单加「记为约定…」，对三种 agent 都显示。
- 点击后打开 `Dialog`（手机上是 `Sheet side="bottom"`）：
  - 一个多行输入框，预填 composer 当前的文本；如果为空，预填本会话最近一条用户消息。
  - 提示文字：「会让当前 agent 把这条约定追加到仓库根的 CLAUDE.md（若有 AGENTS.md 同步写入）」。
  - 按钮「发送给 agent」。
- 发送：调用 `sessionControls.sendPrompt(conventionPrompt(text), { withAttachments: false })`。模板放在纯函数 `lib/conventionPrompt.ts`：

  ```
  请把下面这条约定追加到仓库根目录 CLAUDE.md 的「## 约定(zeromux)」一节末尾（没有该节就在文件末尾新建；若仓库根存在 AGENTS.md，同样追加一份）。
  只追加，不改动其他内容，保持简洁的一行式表述；完成后回复「已记录」和追加的原文。
  约定：{text}
  ```

- 发送后 toast「已交给 agent 记录」。`sendPrompt` 返回 false（socket 没有 OPEN）时 toast「未连接，稍后再试」，并保留 Dialog 里的文本。
- 手机上的点击数：＋ → 记为约定 → （编辑）→ 发送，共 3 击。

### 4.3 边界情况

- 会话正忙时：遵循当前的 queue mode（Collect 会排队）。不在这里加特殊逻辑。
- worktree 隔离开启时，agent 的 cwd 是 worktree，追加会落在 worktree 的 CLAUDE.md。提示文字加一句「隔离会话写入的是 worktree，合并后生效」。
- tmux 会话不显示这个入口（「＋」菜单只存在于 AcpChatView）。

### 4.4 测试

- `conventionPrompt` 单测：文本被原样嵌入，没有被截断。
- AcpChatView 测试：菜单项存在 → 点击打开 Dialog → 发送时以模板文本调用 `sendPrompt`；`sendPrompt` 返回 false 时 Dialog 不关闭。

---

## 5. Spike 补测（SP）

R1/R2 **已由 zmx-ai-02ca59 实测完成**（调研 §7）：
- R1：普通模式不发 `chat_message`。
- R2：crew mode 立即 ack，之后只有 `chat_message`，没有 `chat_chunk` 和 `chat_done`。

还剩下的补测：

1. **目的**：确认 `crew_result` 的完整形态（字段名是 `content` 还是 `text`，`meta.mid`、`meta.crew_reply` 是否存在）；确认 conductor 普通模式（`agent=kirocrew-conductor`, `mode=""`）有 `chat_done`，这是 D1 开放「目标指挥」的前提。
2. **步骤**（**需要 POST Gateway**，S5 实施者在第一个 task 执行）：
   1. 按 `crew_memory.rs` 的方式现场获取 token 和 secret，**不落盘**。
   2. `POST /api/chat/slots {"name":"zmxprobe-<rand>","mode":"crew"}`，然后 `POST .../project` 指到一个临时目录。
   3. 订阅 WS，`POST /api/chat` 发一个真实的小任务：「在当前目录创建 hello.txt 写入 hi，然后告诉我文件内容」。记录 60 秒内所有带本 slot 的帧。
   4. 另建一个 `{"name":"zmxprobe-<rand2>","agent":"kirocrew-conductor"}` 的 slot，发「只回复 OK」，确认有 `chat_done`。
   5. 两个 slot 都 `DELETE`，再 `GET` 确认返回 404。
3. **产出**：把帧脱敏（去掉 token、绝对 home 路径）后存为 `src/acp/testdata/crew_frames_{crew_result,crew_ask,crew_meta,crew_ack,normal_turn}.json`，作为 G1 单测的夹具。结论追加到调研 §7。
4. **失败兜底**：如果 conductor 普通模式**没有** `chat_done`，那么「目标指挥」chip 也推迟到 S6 T3，S5 只交付后端透传（D1 的修订条件）。

---

## 6. G1 Crew Mode 结果可见

### 6.1 现状

- `normalize_frame`（`crew_process.rs:39-206`）先做 slot 过滤（`:55-56`），然后 match `kind`；兜底分支会丢弃 `chat_message`（`:201-206`）。
- `NormState.turn_text` 用来累积 `chat_chunk`，`chat_done` 时取出来作为 Result 的 text。

### 6.2 设计

在 match 里加一个分支（在兜底分支之前）：

```rust
// ── chat_message：仅 Crew Mode 的 crew_* 回答（R1 实测：普通模式不发此帧）──
// 白名单 kind，不按 role 放行（KC/state.py:2296-2348 普通模式在无 HTTP reader
// 时也可能发 assistant chat_message → 会与 chat_chunk 双渲染）。
// 非边界：不进 turn_text，不产 Result —— 否则会混进下一轮 chat_done 的正文。
"chat_message" => crew_message_events(data),
```

- `fn crew_message_events(data) -> Vec<AcpEvent>`，纯函数：
  - 读取 `kind = data.kind`，兼容 `data.meta.kind`，宽松解析。
  - 读取正文 `data.content`，没有时回落到 `data.text`。
  - 按 kind 映射：
    - `crew_ack`：`System{subtype:"crew_ack"}`（D2）。
    - `crew_ask`、`crew_result`、`crew_meta`：`ContentBlock{block_type:"text", text, summary:Some(kind), turn_id:0, ..}`（D3）。正文为空时丢弃。
    - 其他 kind，或 `role != "assistant"`：返回空。
- **`st.turn_text` 不变**。
- 前端 `useAcpSocket` 处理 `content_block`：summary 为 `crew_ask` / `crew_meta` 时用对应样式渲染（在 TurnTimeline 或助手文本里加 class 即可）；`System{crew_ack}` 进入 labelMap，显示「Crew 已接收」（`useAcpSocket.ts:324-328` 的 labelMap）。
- **S5 不改 busy 逻辑**。S5 不开放话题模式（D1），所以 `content_block` 的 `setBusy(true)` 不会造成问题；话题模式下的 busy 由 S6 V4/M4 负责。

### 6.3 测试（纯函数，用 §5 的夹具）

- **必须有**：普通模式下一帧 `role=assistant`、没有 kind 的 `chat_message`，映射结果为空（防御回归）。
- `crew_ack` 映射为 System；`crew_ask`、`crew_result`、`crew_meta` 分别映射为带对应 summary 的 ContentBlock。
- 经过 `crew_*` 帧之后，`turn_text` 与之前相同。
- 别的 slot 的 `crew_result` 被过滤（I1 已有，补一条夹具用例）。
- 正文为空时丢弃；`data.text` 回落生效。

---

## 7. G2 Crew 入口 + 三列持久化 + 埋点

### 7.1 现状

- `create_slot` 的请求体只有 `{"name": key}`（`crew_process.rs:319-321`）。
- Gateway 支持在建 slot 时传 `mode`、`agent`（`chat_handlers.py:2271,2389`）。
- `CrewProcess::spawn(cfg, work_dir, resume)`（`crew_process.rs:586`）；`create_crew_session(name, work_dir, cols, rows, owner_id)`（`session_manager.rs:1710-1717`）→ `spawn_crew(id, work_dir, owner_id, None)`（`:1667`）。
- 请求体 `CreateSessionReq`（`web.rs:829-836`）没有 Crew 相关字段；Crew 分支在 `web.rs:940-942`。
- ⌘K：`TYPE_CHOICES`（`CommandPalette.tsx:25`）；关键词解析 `TYPE_WORDS`（`lib/paletteParse.ts:6`）。

### 7.2 后端

- `CreateSessionReq` 加 `#[serde(default)] crew_mode: String`、`#[serde(default)] crew_agent: String`。服务端校验：`crew_mode ∈ {"", "crew"}`，`crew_agent` 在白名单 `{"", "kirocrew-conductor"}` 内，否则返回 400。`pipeline-conductor` 属于 Stage 4，不在 S5 范围。
- `create_crew_session(.., crew_mode: &str, crew_agent: &str)` → `spawn_crew(.., SlotOpts{mode, agent})` → `CrewProcess::spawn(cfg, work_dir, SlotInit::New{mode, agent} | SlotInit::Resume{key, owns})`。
  - `create_slot` 的请求体为 `{"name":k}`，mode/agent 非空时才加入对应字段，所以默认请求与现在逐字相同。
- `Session` 加字段 `crew: Option<CrewMeta{mode, agent, origin}>`，只有 Crew 会话才有；持久化到 U1 的三列。`load_all` 回填时，resume 使用持久化的值（mode/agent 在 slot 上已经生效，resume 时不需要重设）。
- `SessionInfo` 加 `crew_mode`、`crew_agent`、`crew_origin`，非 Crew 会话省略这三个字段（`skip_serializing_if`）。

### 7.3 前端

- ⌘K 新建模式选中 `crew` 后，在类型 chip 下方显示二级 SegmentedControl：`聊天 | 目标指挥`（D1）。「并行话题」在 S6 T3 加入。
- 关键词：`crew:goal` 映射为 `{type:'crew', crew_agent:'kirocrew-conductor'}`。在 `paletteParse` 里扩展 `TYPE_WORDS` 的解析，返回 `ParsedNew.crewVariant`。
- 派生展示：新增 `lib/crewVariant.ts`：`variantOf(s) = crew_agent==='kirocrew-conductor' ? 'goal' : crew_mode==='crew' ? 'topics' : 'chat'`。
  - TriageRow 和 FocusHeader 的 TypeIcon 旁边加一个小徽标：goal 显示 `Target` 图标，topics 显示 `Layers`，chat 不显示。
- 移动端不新增顶栏图标，遵守 R22（新建只走 ⌘K）。

### 7.4 埋点（U5，门槛 T 的数据源）

- `create_crew_session` 成功后记录：`tracing::info!(target:"zmx_usage", "crew_create sid={id} mode={mode} agent={agent}")`。
- 每个 Crew 会话的第一条 prompt 发出时（fan-out 的 `SessionInput::Prompt` 分支里，用会话内的 `first_prompt_logged` 布尔控制）记录：`tracing::info!(target:"zmx_usage", "crew_first_prompt sid={sid}")`。
- 判定口径以 S7 §0.1 为准（v2：从 S6 T3 上线日起算，14 天内 ≥ 3 次，且分布在 ≥ 2 个不同日期）。

### 7.5 测试

- `create_slot` 请求体：默认 `{"name":k}` 与现在逐字相同；`mode=crew` 时包含 mode；`agent=…` 时包含 agent。把请求体构造抽成纯函数 `slot_create_body` 来测。
- web 校验：非法的 mode 或 agent 返回 400。
- 持久化往返：建会话 → 重建 manager → `SessionInfo.crew_agent` 仍为 `kirocrew-conductor`。
- `crewVariant` 和 `paletteParse` 单测（`crew:goal`）。
- `App.characterization.test.tsx` 不改就要通过。

---

## 8. R4 `owns_slot`

### 8.1 现状

`impl Drop for CrewProcess`（`crew_process.rs:663-685`）**无条件**执行 `delete_slot`。现在所有 slot 都是自建的，所以这是对的；但一旦 S7 G6 附着外部 slot（例如 conductor 派生出的 worker），关闭标签页就会把别人的 slot 删掉。

### 8.2 设计

- `CrewProcess` 加 `owns_slot: bool`；`Drop` 里 `if !self.owns_slot { return_after_stop }`：仍然 `try_send(Cmd::Stop)`，但不执行 delete。
- 取值（U2）：`SlotInit::New` → true；`SlotInit::Resume{owns}` → `owns = crew_origin != "external"`，由 `spawn_crew` 从 `Session.crew.origin` 传进来。
- S5 里所有会话的 origin 都是 `zeromux`，**行为零变化**。`external` 的写入方在 S7 G6。
- `spawn` 在 resume 时仍会调用 `set_slot_project`（`crew_process.rs:618`）。S7 D-G6 指出，附着外部 slot 时必须跳过这一步，否则会覆盖外部 slot 的 cwd。S5 只预留 `SlotInit::Resume{owns:false}` 时跳过 `set_slot_project` 的分支和单测，不暴露入口。

### 8.3 测试

- 自建会话重启后关闭时，slot 会被删除（关键回归，CTO M2）：用 mock Gateway 或把 Drop 的决策抽成纯函数 `should_delete_on_drop(owns)`，再在 `spawn_crew` 层验证 resume 时 `owns` 取自 origin=zeromux 时为 true。
- origin=external：Drop 不删除，resume 时不调用 `set_slot_project`（纯函数 `resume_plan(owns) -> {set_project: bool}`）。

---

## 9. 首屏体积预算（S5–S7 累计）

- 基线（S6 v2 实测）：首屏 314.0KB br，门限为 330KB（`package.json:8` 的 `check-size.mjs dist 337920`），余量约 16KB。
- 各期分配：

| 期 | 首屏增量上限（br） | 主要来源 |
|---|---|---|
| S5 | **≤ 2.5KB** | AwayCard + awaySummary + awayClock 约 1.5KB；crewVariant 徽标约 0.3KB；F4 的 Dialog 复用 ui primitives，约 0.5KB |
| S6 | ≤ 3KB | 见 S6 V21 |
| S7 | < 2.4KB | 见 S7 v2 |
| 合计 | ≤ 7.9KB，留约 8KB 余量 | — |

- 每个 task 都要跑 `npm run build`（其中包含 check-size）。超出预算时，先把 F4 的 Dialog 改成懒加载。

---

## 10. 成功指标

- **北极星：等人时长**（agent 完成到我查看的间隔）。服务端埋点在 S6 T0（S6 §12，`zmx_usage wait_ms=…`）。S5 上线后，F1 保证 `last_outcome_ms` 在重启后仍然有值，这是该埋点成立的前提。对比窗口：S6 T0 上线后，按 S5 前端部分上线前后各 14 天比较 p50/p90。
- 过程指标（journalctl `zmx_usage` 加手工抽样）：
  - 部署后分诊「完成·未读」保留率 100%。手测：跑一轮 → `./deploy.sh` → 刷新，行仍在。
  - 抽 20 条推送，其中 ≥ 50% 不点开就能判断是否需要处理（自评）。
  - `crew_create agent=kirocrew-conductor` 的计数，作为门槛 T 的输入。
  - 「记为约定」使用情况：本期不埋点（识别 prompt 前缀属于过度设计），在 S5-b 上线 14 天后人工回看 CLAUDE.md 的「约定(zeromux)」节增长了多少

---

## 11. 分期

| 期 | 内容 | 前提 | 可与 S4 并行 |
|---|---|---|---|
| S5-a（后端） | SP 补测（第一个 task）→ F1（含 U1 七列迁移）→ F2（含 SW）→ G1 → R4 → G2 后端 + 埋点 | 无 | **是**，不碰 TerminalView 和键栏 |
| S5-b（前端） | F3 AwayCard → G2 ⌘K 二级 chip 和徽标 → F4 记为约定 | S5-a 已上线；S4 上线稳定 ≥ 2 天 | 否 |

Task 粒度：每一项一个 task，F2 拆成后端和 SW 两个 task。每个 task 都要跑 `cargo test`、`npm test`、`npm run lint`、`npm run build`。部署只用 `./deploy.sh`（CLAUDE.md 的 cgroup 规则），并且要先 push 再 deploy。

---

## 12. 风险

| # | 风险 | 缓解 |
|---|---|---|
| K1 | conductor 普通模式没有 `chat_done` | SP 第 4 步验证；否则按 §5 的兜底推迟「目标指挥」chip |
| K2 | `crew_*` 字段名变化（上游 experimental，调研 R6） | 宽松解析，未知的 kind 丢弃；夹具记录下实测形态 |
| K3 | `persist_posture` 在 JuiceFS 上慢 | 锁外写入，每个 settle 只写一次；失败只记 warn |
| K4 | F4 依赖 agent 听话 | agent 回复「已记录」和追加的原文，用户可以当场核对；落盘不可靠时再做 O_APPEND 端点（路线图备选方案 B） |
| K5 | 推送正文泄露敏感内容到锁屏 | all-trust 单用户，接受这一点；PushSettings 保留关闭 routine 档的选项 |
| K6 | 七列迁移和 S6/S7 的迁移冲突 | 列名在 U1 统一定义；S6/S7 只读不再新增这些列；全部用 `ALTER … ADD COLUMN` 吞掉重复列错误，幂等 |

## 13. 非目标

治理、权限、沙箱、审计；S5 不做话题模式的 busy 语义（S6 G3）；不做外部 slot 的附着入口（S7 G6）；不做服务端已读（S6 T0）；不做用户消息气泡的 ⋯ 菜单；不在 zeromux 里自建协调器或 backlog 表。
