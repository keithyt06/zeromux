# 常用 Prompt 预设（Prompt Presets）设计

> 承接 startup-prompt（`initial_prompt`，2026-06-14）明确推迟的「prompt 模板 / 历史」项。把创建会话时的 `pick-prompt` 自由文本框，升级成「几个常用预设可一键选 + 仍可自由编辑」，预设存后端、跨设备同步。

## 背景与目标

startup-prompt 给 agent 会话创建流程加了 `pick-prompt` 步骤：选完目录后弹一个多行框，内容作为 agent 第一条用户消息透传（`SessionInput::Prompt { run_id: None }`，纯透传无标记）。当时 spec 显式列了 `❌ 不做 prompt 模板 / 历史`，留给「Agent 模板」后续项。

本功能补上这一项：用户能**保存几个常用 prompt**，在 pick-prompt 步骤**一键选用**（填入文本框、仍可微调后再发）。目标是减少重复敲「审查这个 PR」「给这个模块写测试」这类高频指令。

## 核心决策（brainstorm 锁定）

1. **类型 = custom 用户消息，不是 system prompt。** 预设就是任务指令，复用现有 `initial_prompt` 透传通道——不碰 `--append-system-prompt`。三个 agent backend 目前**完全没有** system-prompt 通道，那是独立的、更大的后端工作，列入「未来工作」。
2. **存储 = 后端持久化，跨设备同步。** 用户手机 + 桌面两头用 zeromux，localStorage 会割裂体验（手机存的桌面看不到）。镜像 `notes.rs` 的 `NotesStore`：自带独立 SQLite 文件，与 OAuth 用户库无关，**legacy 和 OAuth 两种模式都能用**。
3. **管理入口 = 就地轻量。** pick-prompt 面板内加「✎ 管理」按钮，点开在**同一侧边栏面板内**切到 `manage-prompts` 子态（加/改/删），不新开页面、不动 App.tsx 路由。符合 Sidebar 既有多步状态机（pick-type→pick-dir→pick-prompt）的延伸。
4. **排序 = 最低限度。** 新建追加末尾，按 `sort_order, created_at` 排，**不做拖拽重排**。常用的排不到前面再说。
5. **点 chip = 填入而非直接发。** 让用户在发之前能微调。已有内容时点 chip **直接替换**（简单、可预期），不追加。

## 明确不做（YAGNI）

- ❌ **不做 system prompt / `--append-system-prompt`**（独立 feature，见未来工作）。
- ❌ **不做按 work_dir 作用域**——预设是全局通用的，不像 notes 绑目录。
- ❌ **不做变量插值 / 模板占位符**（`{{file}}` 之类）——先存静态文本。
- ❌ **不做拖拽重排 UI**。
- ❌ **不做 markdown 文件镜像**——notes 镜像 .md 是为了人类可读 + 跨会话；预设没这需求，纯 SQLite 更简单。
- ❌ 失败不加 toast 体系（沿用现有最低限度档）。

## 数据模型与存储

新建 `src/prompts.rs`，镜像 `notes.rs` 的 `NotesStore` 形态，但**只用 SQLite，无文件镜像**（比 notes 简单）。

```rust
#[derive(Debug, Clone, serde::Serialize)]
pub struct PromptPreset {
    pub id: String,           // short_uuid()
    pub title: String,        // 列表显示的短标签，如「审查 PR」
    pub body: String,         // 注入文本框的指令全文
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

### Store 方法（镜像 notes 的 open / create / list / delete，加 update）

- `open(data_dir: &Path) -> Result<Self, String>`：`create_dir_all` + `Connection::open(data_dir.join("prompts.db"))` + 建表。与 `NotesStore::open` 同签名同 `data_dir`。
- `list() -> Result<Vec<PromptPreset>, String>`：`ORDER BY sort_order, created_at`。
- `create(title, body) -> Result<PromptPreset, String>`：`title`/`body` 先 `trim`，**两者皆非空才建**（空则 `Err`）。`sort_order = SELECT COALESCE(MAX(sort_order),0)+1`。
- `update(id, title: Option<&str>, body: Option<&str>) -> Result<bool, String>`：只改传入的字段（同样 trim + 非空校验），刷新 `updated_at`。返回是否命中行。
- `delete(id) -> Result<bool, String>`：返回是否命中行（对齐 `delete_note` 的 `Ok(true/false)`）。

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
- `create_prompt(Json(CreatePromptReq { title, body }))`：`state.prompts.create(&title, &body)`；store 的空校验失败 → `400 BAD_REQUEST`（区别于 notes 的 500，因为这是用户输入校验而非系统错误）。
- `update_prompt(Path(id), Json(UpdatePromptReq { title: Option, body: Option }))`：`Ok(true)→200`、`Ok(false)→404`、空校验失败 → `400`。
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

## 前端

### `frontend/src/lib/api.ts`

加 interface + 4 函数，照搬 notes 写法（第 230 行附近的 Notes API 区块风格）：

```ts
export interface PromptPreset {
  id: string
  title: string
  body: string
  created_at: string
  updated_at: string
  sort_order: number
}

export async function listPrompts(): Promise<PromptPreset[]> { /* GET /api/prompts → data.presets || [] */ }
export async function createPrompt(title: string, body: string): Promise<PromptPreset> { /* POST */ }
export async function updatePrompt(id: string, title?: string, body?: string): Promise<void> { /* PUT */ }
export async function deletePrompt(id: string): Promise<void> { /* DELETE */ }
```

### `frontend/src/components/Sidebar.tsx`

**state 扩展：**
- `NewSessionStep` 联合类型加 `'manage-prompts'`（现为 `... | 'pick-prompt'`）。
- 新增 state：`presets: PromptPreset[]`、`editingId: string | null`（管理态正在编辑的条目，`null` 表示新建）、管理态的 `editTitle`/`editBody` 草稿。

**加载时机：** 进入 `pick-prompt` 时 `listPrompts()` 拉一次填 `presets`。**失败则 `presets` 留空、chips 区不渲染，textarea 照常可用——绝不阻塞建会话。**

**pick-prompt 渲染升级**（现 `Sidebar.tsx:622`）：在 textarea **上方**加一行：
- 每个 preset 渲染成一个 chip（显示 `title`），点击 = `setPromptDraft(preset.body)`（直接替换）。
- 行尾一个「✎ 管理」小按钮 → `setStep('manage-prompts')`。
- `presets` 为空时这一行只显示「✎ 管理」（或「+ 新建常用」引导）。
- 现有「空/非空按钮切换」「Cmd/Ctrl+Enter 提交」「Esc 关闭」逻辑**原样保留**。

**新增 `manage-prompts` 渲染：**
- 顶部返回箭头 → `setStep('pick-prompt')`（对齐 pick-prompt 回 pick-dir 的写法）。
- 列出 `presets`，每条带 [✎ 改] [🗑 删]。
  - 改 → 把该条 title/body 填进编辑草稿、`editingId = preset.id`，显示 title + body 两输入框 + [保存]。
  - 删 → `deletePrompt(id)` 后刷新 `presets`。
- 底部 [+ 新建] → `editingId = null` + 清空草稿，同样的 title/body 输入框 + [保存]。
- [保存] → `editingId` 有值走 `updatePrompt`，否则 `createPrompt`；成功后刷新 `presets`、回列表态。
- 全程在侧边栏面板内，不动 App.tsx。

**作用域：** chips 行 + manage-prompts 只在 agent 类型出现（pick-prompt 本就只对 agent 出现，tmux 不经过）。

## 错误处理（最低限度，沿用现有风格）

- 预设 CRUD 失败：`throw new Error`（和 notes 一致），不加额外 toast。管理态可就地显示一行错误文字（可选，低优先）。
- **预设列表加载失败：chips 区留空、textarea 照常可用——核心建会话流程绝不被预设功能拖累。**

## 测试策略

### 后端（Rust `#[cfg(test)]`，对齐 notes 测试风格，用 `tempfile` 建临时 data_dir）

1. `create` + `list` 往返：建两条 → list 按 `sort_order` 升序返回，第二条 sort_order > 第一条。
2. `create` 空 title 或空 body（含纯空白 `"  "`）→ `Err`，不入库。
3. `update` 改 title-only / body-only：未传的字段不变，`updated_at` 刷新；命中返回 `true`。
4. `update` 不存在的 id → `Ok(false)`。
5. `update` 把字段改成空白 → `Err`，不落库。
6. `delete` 命中 → `Ok(true)`，再 list 不含它；删不存在的 id → `Ok(false)`。

### 前端（vitest）

7. `createPrompt(title, body)` → request body 含 `{ title, body }`；`listPrompts` 解析 `data.presets`。
8. `updatePrompt(id, title)` → PUT body 只含传入字段。
9. 若 Sidebar 状态机可单测：点 chip → `promptDraft` 被设为该 preset 的 body（直接替换）。若依赖过多 props/DOM 难单测，本条降级为手动验收。

### 手动验收清单

- 新建几个预设（审查 PR / 写单测 / 解释代码）→ 下次建会话 pick-prompt 步骤看到对应 chips。
- 点 chip → textarea 填入该 body；编辑后 [Create & send] → agent 收到编辑后的原文（无 verdict 行）。
- 已有内容时点另一个 chip → 直接替换（不追加）。
- 「✎ 管理」→ 改一条 title/body → 保存 → 回 pick-prompt 看到更新；删一条 → chip 消失。
- **跨设备**：桌面建的预设，手机刷新后也能看到（验证后端持久化 + 同步）。
- 预设加载失败（可断网模拟）→ chips 区空，textarea 仍可用，能正常建会话。
- 空 prompt → 仍只显示一个 [Create] 按钮（startup-prompt 的既有行为不回归）。

## 未来工作 / 依赖关系（记录，非本次范围）

- **System prompt（人设/规则）通道**：给 claude/kiro/codex 各加 `--append-system-prompt` 类注入（三 backend 协议不同，工作量大）。届时预设可加一个「类型」字段区分 task-instruction / system-prompt。本次故意不预留该字段——加了也是为不存在的需求加复杂度，等真做时再迁移。
- **变量插值**：`{{selection}}`/`{{file}}` 之类模板占位符，需要会话上下文注入。独立 feature。
- **批量起 agent 跑同一预设**：startup-prompt spec 记录的 CEO 扩展点 2（「AI 团队的 tmux」），需要多选 UI + 会话组概念，P2。

## 影响的文件

- `src/prompts.rs`（新）— `PromptPresetStore` + 后端单测，镜像 `notes.rs`。
- `src/main.rs` — `mod prompts;` + `AppState.prompts` 字段 + 初始化。
- `src/web.rs` — 4 路由 + handlers + `CreatePromptReq`/`UpdatePromptReq`。
- `frontend/src/lib/api.ts` — `PromptPreset` interface + 4 函数。
- `frontend/src/components/Sidebar.tsx` — chips 行 + `manage-prompts` 子态。
- 前端测试文件 — `createPrompt`/`listPrompts`/`updatePrompt` body 断言。
