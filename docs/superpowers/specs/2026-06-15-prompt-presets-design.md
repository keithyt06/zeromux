# 常用 Prompt 预设（Prompt Presets）设计

> 承接 startup-prompt（`initial_prompt`，2026-06-14）明确推迟的「prompt 模板 / 历史」项。建立一个**全局 prompt 预设库**，存后端、跨设备同步，在两个高价值入口一键选用：**创建会话的 `pick-prompt` 步骤**，以及**运行中会话的 Composer（消息框）**。

## 背景与目标

startup-prompt 给 agent 会话创建流程加了 `pick-prompt` 步骤：选完目录后弹一个多行框，内容作为 agent 第一条用户消息透传（`SessionInput::Prompt { run_id: None }`，纯透传无标记）。当时 spec 显式列了 `❌ 不做 prompt 模板 / 历史`，留给「Agent 模板」后续项。

本功能补上这一项。**关键洞察（CEO/PM review 抓出）**：prompt 不是只在一个地方敲的——代码里有三个入口：

| 入口 | 文件 | 频率 | 本次接入 |
|---|---|---|---|
| `pick-prompt`（建会话时） | `Sidebar.tsx` | 每会话一次 | ✅ |
| 会话内消息框 Composer | `AcpChatView.tsx` → `Composer.tsx` | **每一轮对话** | ✅ |
| 定时任务 prompt | `ScheduledTasksPanel.tsx` | 很少 | ❌ 记入 TODOS |

只接 `pick-prompt`（最初的草案）等于把「常用 prompt」藏在你走得最少的那道门后。真正高频的复用发生在会话内 Composer——「审查这个 PR」「给这模块写测试」「解释这段」每天敲几十遍。所以本次把预设库同时接入 **pick-prompt + Composer**，定时任务入口边际价值低，记入 TODOS。

目标：把高频指令从「每次手敲」变成「一键填入、可改后再发」，且跨设备共享同一批预设。

## 核心决策（brainstorm + SELECTIVE EXPANSION review 锁定）

1. **类型 = custom 用户消息，不是 system prompt。** 预设就是任务指令，复用现有 `initial_prompt` / Composer `onSend` 透传通道——不碰 `--append-system-prompt`。三个 agent backend 目前**完全没有** system-prompt 通道，那是独立的、更大的后端工作，列入「未来工作」。
2. **存储 = 后端持久化，跨设备同步。** 用户手机 + 桌面两头用 zeromux，localStorage 会割裂体验（手机存的桌面看不到）。镜像 `notes.rs` 的 `NotesStore`：自带独立 SQLite 文件，与 OAuth 用户库无关，**legacy 和 OAuth 两种模式都能用**。
3. **作用域 = 全局共享，不按 owner 隔离。** 即便 OAuth 多用户模式，所有用户看同一批预设（「团队 prompt 库」）。简单，且符合「AI 团队的 tmux」愿景；对单人多设备使用无差别。表**不加 `owner_id`**。
4. **接入两个高频入口：pick-prompt + Composer。** 定时任务表单（`ScheduledTasksPanel`）记入 TODOS，本次不做。
5. **共享单元（CTO）= `usePromptPresets` hook + `<PromptManager>` 组件。** 两入口共用数据/CRUD 逻辑与管理 UI；chips 渲染各自内联（容器形态不同：侧边栏步骤 vs Composer 弹层），不强行抽。
   - **跨模型分歧记录**：codex（outside voice）反对此抽象，认为 2 个调用点过早抽象、应复制。**已驳回**：codex 的规则前提是「两处 flow 不同」——但本例两处的**管理 flow 完全相同**（同一个增删改列表），仅 **chip 选用**不同，而那已明确各自内联、不共享。hook 是 ~30 行 fetch 包装（非 mini-framework），管理 UI 共享避免 ~80 行表单 JSX 复制 + 改一处漏改另一处的漂移。subagent review 验证此设计可行。
6. **管理入口 = 就地轻量。** 不新开页面、不动 App.tsx 路由。pick-prompt 内切到 `manage-prompts` 子态；Composer 弹层内嵌同一个 `<PromptManager>`。
7. **排序 = 最低限度。** 新建追加末尾，按 `sort_order, created_at` 排，**不做拖拽重排**。
8. **点 chip = 填入而非直接发**，**整体替换** Composer/textarea 的当前内容（不插入光标处、不 append、不保留选区/undo 栈——最简单且可预期；预设是「换一条指令」不是「往中间塞片段」）。已有内容也直接替换。让用户填入后能改、再发。IME 输入法组合态非关注点（替换是整体 setState，不涉及逐字插入）。
9. **Composer 预设仅在 `AcpChatView`，不在 `TerminalView`。** 预设是 agent 任务指令；注入裸 shell 的 composer 不符合语义。

## 明确不做（YAGNI）

- ❌ **system prompt / `--append-system-prompt`**（独立 feature，见未来工作）。
- ❌ **定时任务表单接入**（记入 TODOS，边际价值低）。
- ❌ **TerminalView Composer 接入**（语义不符——presets 是 agent 指令）。
- ❌ **按 work_dir 作用域**——预设全局通用，不像 notes 绑目录。
- ❌ **按 owner 隔离**（决策 3：全局共享）。
- ❌ **变量插值 / 模板占位符**（`{{file}}` 之类）——先存静态文本。
- ❌ **拖拽重排 UI**。
- ❌ **markdown 文件镜像**——notes 镜像 .md 是为人类可读 + 跨会话；预设无此需求，纯 SQLite 更简单。
- ❌ 失败不加 toast 体系（沿用现有最低限度档）。

## 架构总览

```
                          ┌──────────────────────────────┐
                          │  src/prompts.rs                │
                          │  PromptPresetStore (prompts.db)│  ← 镜像 notes.rs，全局，无 owner
                          └──────────────┬─────────────────┘
                                         │ AppState.prompts
                          ┌──────────────┴─────────────────┐
                          │  src/web.rs  /api/prompts CRUD  │  ← authed /api/* 组
                          └──────────────┬─────────────────┘
                                         │ HTTP
                   ┌─────────────────────┴───────────────────────┐
                   │ frontend/src/lib/api.ts                       │
                   │ PromptPreset + list/create/update/delete      │
                   └─────────────────────┬───────────────────────┘
                                         │
                   ┌─────────────────────┴───────────────────────┐
                   │ usePromptPresets()  hook (shared)             │  ← 数据 + CRUD state
                   │ <PromptManager/>    component (shared)        │  ← 加/改/删列表 UI
                   └──────┬───────────────────────────────┬──────┘
                          │ onPick(body)                   │ onPick(body)
              ┌───────────┴──────────┐          ┌──────────┴────────────┐
              │ Sidebar pick-prompt   │          │ AcpChatView Composer   │
              │  chips + manage 子态  │          │  presets 弹层 (rightSlot)│
              └──────────────────────┘          └────────────────────────┘
                                                   (TerminalView 不接)
```

数据流（点 chip）：`chip click → onPick(preset.body) → setInput/setPromptDraft(body) → 用户编辑 → 既有 onSend/onCreate 透传`。预设只是把文本填进**既有的**输入状态，不新增发送通道。

## 数据模型与存储

新建 `src/prompts.rs`，镜像 `notes.rs` 的 `NotesStore` 形态，但**只用 SQLite、无文件镜像、无 owner 字段**（比 notes 简单）。

```rust
#[derive(Debug, Clone, serde::Serialize)]
pub struct PromptPreset {
    pub id: String,           // short_uuid()
    pub title: String,        // 列表显示的短标签，如「审查 PR」
    pub body: String,         // 填入输入框的指令全文
    pub created_at: String,   // ISO
    pub updated_at: String,   // ISO
    pub sort_order: i64,      // 手动排序，新建默认 = 当前最大 +1
}

pub struct PromptPresetStore {
    conn: Mutex<Connection>,
}
```

表结构（`prompts.db`，在 `~/.zeromux/` 下，与 `notes.db` 并列）：

```sql
CREATE TABLE IF NOT EXISTS prompt_presets (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_prompt_presets_sort ON prompt_presets(sort_order, created_at);
```

### Store 方法（镜像 notes 的存储**范式**，但 notes.rs 本身无单测）

> **注（review 修正）**：本设计镜像的是 `notes.rs` 的**存储形态**（独立 SQLite、`Mutex<Connection>`、双 auth 模式可用），**不是**它的测试——`notes.rs` 没有 `#[cfg(test)]`。真正的 store 测试范式在 `session_store.rs` / `scheduled_tasks.rs`（`fn store() -> (Store, TempDir)`，**必须把 `TempDir` guard 一起返回并在测试中持有**，否则临时目录在 store 用之前就被 drop、DB 凭空消失）。另：`short_uuid()` / `now_iso()` 是 `notes.rs` 的**私有 fn**（notes.rs:173/185），不可跨模块引用——`prompts.rs` 自带一份拷贝（两个小函数，无需为此抽公共 util）。

- `open(data_dir: &Path) -> Result<Self, String>`：`create_dir_all` + `Connection::open(data_dir.join("prompts.db"))` + 建表。与 `NotesStore::open` 同签名同 `data_dir`。
- `list() -> Result<Vec<PromptPreset>, String>`：`ORDER BY sort_order, created_at`。
- `create(title, body) -> Result<PromptPreset, String>`：`title`/`body` 先 `trim`，**两者皆非空才建**（空则 `Err`，handler 映射 400）；各设一个上限（`title` ≤ 200、`body` ≤ 20000 字符，超长截断或 `Err`，防止滥用）。**`sort_order` 的 `SELECT COALESCE(MAX(sort_order),0)+1` 与 `INSERT` 必须在同一次 `conn.lock()` 内连续执行**，否则并发 POST 会争同一 sort 值（非致命——sort 非唯一——但应避免）。**允许重名**（title 不唯一，由用户自行决定；不做去重）。
- `update(id, title: Option<&str>, body: Option<&str>) -> Result<bool, String>`：只改传入字段（同样 trim + 非空 + 上限校验），刷新 `updated_at`。**两字段都为 `None`（空 PUT `{}`）→ 直接返回 `Ok(false)`（无操作，不碰 `updated_at`）**，handler 统一映射 404（见后端接口节）。返回是否命中行。
- `delete(id) -> Result<bool, String>`：返回是否命中行（对齐 `delete_note` 的 `Ok(true/false)`）。
- **错误日志不得包含 `body` 原文**——预设可能含 secret/客户文本。`tracing` 仅记 `id` + 错误类型，不记内容。

## 后端 HTTP 接口（`src/web.rs`）

镜像 notes 路由组，但**不绑 session**（预设全局）。全部挂在已有的 authed `/api/*` 组（自动带认证）。

```
GET    /api/prompts            → { presets: [...] }
POST   /api/prompts            → body { title, body } → 新建的 PromptPreset
PUT    /api/prompts/{id}       → body { title?, body? } → 200 / 404
DELETE /api/prompts/{id}       → 200 / 404
```

Handler 形态对齐 `list_notes`/`create_note`/`delete_note`：

- `list_prompts`：`state.prompts.list()` → `Json({ "presets": ... })`。
- `create_prompt(Json(CreatePromptReq { title, body }))`：`state.prompts.create(&title, &body)`；空校验失败 → `400 BAD_REQUEST`（区别于 notes 的 500，因为这是用户输入校验而非系统错误）。
- `update_prompt(Path(id), Json(UpdatePromptReq { title: Option, body: Option }))`：`Ok(true)→200`、`Ok(false)→404`（id 不存在**或**两字段皆 `None` 的空 PUT，统一当「无事可做」返回 404）、空白/超长校验失败 → `400`。
- `delete_prompt(Path(id))`：`Ok(true)→200`、`Ok(false)→404`、`Err→500`（照搬 `delete_note`）。

### `AppState`（`src/main.rs:129` 附近）

加字段，和 `notes` 并排：

```rust
pub prompts: prompts::PromptPresetStore,
```

`main.rs:223` 附近初始化（复用同一个 `data_dir_str`）：

```rust
let prompts_store = prompts::PromptPresetStore::open(std::path::Path::new(&data_dir_str))
    .expect("Failed to open prompts store");   // 对齐 notes_store 的处理
...
prompts: prompts_store,
```

`main.rs` 顶部加 `mod prompts;`。

## 前端

### `frontend/src/lib/api.ts`

加 interface + 4 函数，照搬 notes API 区块（第 230 行附近）风格：

```ts
export interface PromptPreset {
  id: string; title: string; body: string
  created_at: string; updated_at: string; sort_order: number
}
export async function listPrompts(): Promise<PromptPreset[]>            // GET → data.presets || []
export async function createPrompt(title: string, body: string): Promise<PromptPreset>  // POST
export async function updatePrompt(id: string, fields: { title?: string; body?: string }): Promise<void>  // PUT，options 对象只带要改的字段
export async function deletePrompt(id: string): Promise<void>          // DELETE
```

- **更新用 options 对象**（`{ title?, body? }`）而非位置可选参数——位置形式下「只改 body」要写 `updatePrompt(id, undefined, body)`，易错。
- **throw/catch 边界**：这 4 个 api 函数**照搬 notes 风格，`!res.ok` 时 `throw`**（api.ts:231 同款）。捕获在**上层 hook**（见下），api 层不静默吞错。
- 所有操作都是**按记录的**（per-record create/update/delete），不存在「PUT 整个数组」——天然避免「tab B 复活已删条目 / 覆盖更新」。

### 共享单元（决策 5）

**`frontend/src/lib/usePromptPresets.ts`（新）** — 一个 hook，封装：
- `presets: PromptPreset[]`、`loading`、`error`
- `reload()`、`add(title, body)`、`edit(id, fields)`、`remove(id)`——各自调 api 后**重新 `list()` 刷新**（不做乐观更新，避免回滚逻辑；写完拉全量最简单且天然修正本机视图）。
- **throw/catch 边界**：api 函数会 `throw`；hook 的 `reload`/`add`/`edit`/`remove` 各自 `try/catch`，失败时置 `error`、保留旧 `presets`，**不向上抛**。加载失败 → `presets` 留空数组。**消费方据此降级（chips 区不显示），绝不抛错阻塞核心流程。**
- **跨设备/多标签陈旧性（明确接受 last-writer-wins，不做实时同步）**：预设是低频写、单人多设备场景，不值得上 WebSocket 推送或 etag 冲突协议。缓解措施仅两条：① **打开即刷新**——pick-prompt 步骤进入、Composer 预设弹层首次打开时各 `reload()` 一次；② 写操作后 `reload()`（上一条）。因此后端 `update`/`delete` 都是**按 id 的幂等操作**：删一个不存在的 id 返回 404 而非报错，改一个已被另一端删掉的 id 返回 404 → hook `reload()` 后该条自然消失。两端并发改同一条 = 后写覆盖（可接受）。**这是显式取舍，不是遗漏。**

**`frontend/src/components/PromptManager.tsx`（新）** — 纯管理 UI，供两入口共用：
- props：`{ presets, onAdd, onEdit, onRemove, onClose }`（全部来自 `usePromptPresets`）。
- 列出每条带 [✎ 改] [🗑 删]；底部 [+ 新建]。编辑/新建态共用 title + body 两输入框 + [保存]；`editingId === null` 走 `onAdd`，否则 `onEdit`。
- 不含「选用」逻辑——选用是各入口自己的 `onPick`。`PromptManager` 只管增删改。

### 入口 1：`Sidebar.tsx`（pick-prompt 升级 + manage 子态）

- `NewSessionStep` 联合类型加 `'manage-prompts'`。
- 用 `usePromptPresets()`；进入 `pick-prompt` 时若未加载则 `reload()`。
- **pick-prompt 渲染**（现 `Sidebar.tsx:622`）：在 textarea **上方**加一行——
  - 每个 preset 一个 chip（显示 `title`），点击 = `setPromptDraft(preset.body)`（直接替换）。
  - 行尾「✎ 管理」按钮 → `setStep('manage-prompts')`。
  - `presets` 为空 / 加载失败 → 该行只显示「✎ 管理」，textarea 照常可用。
  - 现有「空/非空按钮切换」「Cmd/Ctrl+Enter」「Esc」逻辑**原样保留**。
- **manage-prompts 渲染**：顶部返回箭头 → `setStep('pick-prompt')`；body 内嵌 `<PromptManager>`，`onClose` 也回 pick-prompt。
- **`close()` 重置**（现 `Sidebar.tsx:182`）：在既有重置里加上 manage-prompts 的子状态（编辑草稿 / editingId）清空——否则 Esc 关闭后再开，可能残留上次编辑态。
- 作用域：chips + manage 只在 agent 类型出现（pick-prompt 本就只对 agent，tmux 不经过）。

### 入口 2：`AcpChatView.tsx` + `Composer`（会话内复用）

- `AcpChatView` 用 `usePromptPresets()`；首次打开 presets 弹层时 `reload()`（懒加载，不拖慢会话首屏）。
- 在 Composer 的 **`rightSlot`** 里（现 `AcpChatView.tsx:417` 那组图片/文件/Mic 按钮**之前**）加一个「预设」按钮（如 `BookMarked`/`ListPlus` 图标）。点击切换一个**锚定在输入框上方的弹层**：
  - 弹层顶部：preset chips，点击 = `setInput(preset.body)`（直接替换 Composer 当前 `input`），并关闭弹层。
  - 弹层底部：「✎ 管理」→ 在同一弹层内切到内嵌的 `<PromptManager>`。
  - 空 / 加载失败 → 弹层只显示「✎ 管理 / + 新建」引导，不影响正常输入。
- `Composer` 本身**不改 props**——它已是受控组件（parent 拥有 `value`），预设通过 parent 的 `setInput` 注入。`rightSlot` 已是既定扩展点（注释明写「a future MicButton」）。
- **不接 `TerminalView`**（决策 9）。

## 错误处理（最低限度，沿用现有风格）

- 预设 CRUD 失败：`usePromptPresets` 置 `error`，`PromptManager` 就地显示一行错误文字；不加全局 toast。
- **预设列表加载失败：chips 区/弹层 chips 留空，输入框照常可用——核心流程（建会话 / 发消息）绝不被预设功能拖累。**

## 测试策略

### 后端（Rust `#[cfg(test)]`，对齐 `session_store.rs` / `scheduled_tasks.rs` 的 store 测试范式，用 `tempfile::TempDir` 并**把 guard 一起返回/持有**）

1. `create` + `list` 往返：建两条 → list 按 `sort_order` 升序，第二条 > 第一条。
2. `create` 空 title 或空 body（含纯空白 `"  "`）→ `Err`，不入库。
3. `create` 超长 title/body → 按设定（截断或 `Err`）；断言上限生效。
4. `update` 改 title-only / body-only（用 options）：未传字段不变，`updated_at` 刷新；命中返回 `true`。
5. `update` 不存在的 id → `Ok(false)`。
6. `update` 两字段皆 `None`（空 PUT）→ `Ok(false)`，不碰 `updated_at`。
7. `update` 把字段改成空白 → `Err`，不落库。
8. `delete` 命中 → `Ok(true)`，再 list 不含它；删不存在 → `Ok(false)`。

### 前端（vitest）

7. `createPrompt(title, body)` → request body 含 `{ title, body }`；`listPrompts` 解析 `data.presets`。
8. `updatePrompt(id, { body })` → PUT body 只含传入字段（`title` 不出现在请求体）。
9. `usePromptPresets`：加载失败时 `presets` 为 `[]` 且 `error` 置位（不抛）。
10. 若可单测：`PromptManager` [保存] 在 `editingId===null` 调 `onAdd`、否则 `onEdit`。
11. 若 Sidebar/AcpChatView 状态机可单测：点 chip → 对应输入状态被设为该 preset 的 body（直接替换）。难单测则降级为手动验收。

### 手动验收清单

- 新建几个预设（审查 PR / 写单测 / 解释代码）。
- **建会话**：pick-prompt 看到 chips；点 chip → textarea 填入 body；编辑后 [Create & send] → agent 收到编辑后原文（无 verdict 行）。
- **会话内**：Composer 预设按钮 → 弹层 chips；点一个 → 填入消息框；改后发送正常。
- 已有内容时点另一 chip → 直接替换（不追加），两入口一致。
- 「✎ 管理」（两入口）→ 改一条 / 删一条 → 另一入口刷新后同步可见（验证共享库 + 后端持久化）。
- **跨设备**：桌面建的预设，手机刷新后可见。
- 预设加载失败（断网模拟）→ chips 空，输入框仍可用，能正常建会话 / 发消息。
- 空 prompt → pick-prompt 仍只显示一个 [Create]（startup-prompt 既有行为不回归）。
- TerminalView Composer **无**预设按钮（决策 9）。

## NOT in scope（明确考虑过并推迟）

- **定时任务表单接入**（决策 4）：同一 API + 一行 chips 即可，但定时任务很少建，边际价值低 → TODOS。
- **TerminalView Composer**（决策 9）：语义不符。
- **system prompt 通道**：见未来工作。
- **owner 隔离**（决策 3）：全局共享已够。

## What already exists（本设计复用的既有代码）

- `src/notes.rs` `NotesStore` — 存储层范式（独立 SQLite、双 auth 模式可用），`prompts.rs` 直接镜像。
- `initial_prompt` 透传链（`web.rs` create_session → `SessionInput::Prompt{run_id:None}`）— pick-prompt 选用后照走，零改动。
- `Composer.tsx` 的 `rightSlot` 扩展点 + 受控 `value/onChange` — Composer 入口零改 props。
- notes 路由组形态（`web.rs:39-41`）— `/api/prompts` 直接对齐。

## 未来工作 / 依赖关系（记录，非本次范围）

- **System prompt（人设/规则）通道**：给 claude/kiro/codex 各加 `--append-system-prompt` 类注入（三 backend 协议不同，工作量大）。届时给预设加 `kind` 字段区分 task-instruction / system-prompt。本次故意不预留该字段——加了也是为不存在的需求加复杂度，真做时再迁移。
- **定时任务表单接入预设**（TODOS / P2）。
- **变量插值**：`{{selection}}`/`{{file}}` 之类占位符，需会话上下文注入。独立 feature。
- **拖拽重排 / 使用频率自动排序**：常用的自动靠前。P3。
- **批量起 agent 跑同一预设**：startup-prompt spec 记录的 CEO 扩展点 2（「AI 团队的 tmux」），需多选 UI + 会话组概念。P2。

## 影响的文件

- `src/prompts.rs`（新）— `PromptPresetStore` + 后端单测，镜像 `notes.rs`。
- `src/main.rs` — `mod prompts;` + `AppState.prompts` 字段 + 初始化。
- `src/web.rs` — 4 路由 + handlers + `CreatePromptReq`/`UpdatePromptReq`。
- `frontend/src/lib/api.ts` — `PromptPreset` interface + 4 函数。
- `frontend/src/lib/usePromptPresets.ts`（新）— 共享 hook。
- `frontend/src/components/PromptManager.tsx`（新）— 共享管理 UI。
- `frontend/src/components/Sidebar.tsx` — chips 行 + `manage-prompts` 子态。
- `frontend/src/components/AcpChatView.tsx` — Composer rightSlot 预设按钮 + 弹层。
- 前端测试文件 — api + hook + （可选）状态机断言。
