# 启动 Prompt（Initial Prompt on Session Create）设计

> Roadmap `teamwork_enhanced_tasks.md` P0「开了就不用管」第一项：**创建 Agent 会话时填入初始指令，Agent 自动开始工作**。

## 背景与目标

当前创建 agent 会话（Claude / Kiro / Codex）的流程是：点 ➕ → 选类型 → 选目录（DirPicker）→ 立即创建。会话建好后是空的，用户必须再手动敲第一条消息。

本功能让用户在创建会话时**顺手填一条初始指令**，会话一建好就把这条指令作为第一条用户消息发给 agent，agent 立即开跑。`CreateSessionReq` 目前只有 `name/type/work_dir/tmux_target`，没有 prompt 入参——本功能补上。

**范围**：仅 agent 会话（claude/kiro/codex）。tmux 没有 prompt 概念，不支持。

## 核心决策（brainstorm 锁定）

1. **纯透传**：初始 prompt 一字不改，作为第一条用户消息发出，**不追加任何结构化标记**。这区别于定时任务的 `trigger_run`——后者会追加 `<<<VERDICT>>>...<<<END>>>` 以便无人值守时机器抽取结论；交互式会话用户亲自盯着，无需 verdict。
2. **UI = 方案 A**：DirPicker 选完目录后**新增一步** `pick-prompt`（多行框 + [Skip & create] / [Create & send]），完全向后兼容——不填或跳过即等同老流程。
3. **失败处理 = 最低限度**：发送失败时**保留 session 并正常打开**，仅后端 `tracing::warn!` 记日志，前端不额外提示。session 本身可用，用户可手动重发。

## 实现方案

**方案 1（采纳）：在 `create_session` handler 里发 prompt。** 一个 HTTP 请求完成"建 + 发"，原子、一次往返。复用 `trigger_run`（`session_manager.rs:843`）已验证的 `spawn → input_tx → SessionInput::Prompt` 模式，但剥掉无人值守专属逻辑（run_id / input_snapshot / verdict 标记 / work_dir TOCTOU finalize）。

已否决：
- **方案 2（前端两次调用）**：两次往返、中间 session 空着有竞态窗口、需新端点，复杂度更高。
- **方案 3（复用 `trigger_run`）**：`trigger_run` 深耦合 scheduled store，交互式不需要这些，硬套会污染或大改。

## 后端数据流

### `CreateSessionReq` 新增字段（`src/web.rs:298`）

```rust
initial_prompt: Option<String>,   // 仅对 agent 会话有意义；tmux 忽略
```

### `create_session` handler 改动（`src/web.rs:329`）

现有逻辑建完 session 拿到 `id` 后、返回 JSON 前，插入：

```rust
// 启动 Prompt：仅 agent 会话、且 prompt 非空白时，把它作为第一条用户消息透传。
// 复用 trigger_run 验证过的 spawn→input_tx→Prompt 模式，但不带 run_id/verdict
// 标记——交互式会话由用户亲自盯着，无需机器抽取结论。
if req.session_type != SessionType::Tmux {
    if let Some(prompt) = req.initial_prompt {
        let prompt = prompt.trim();
        if !prompt.is_empty() {
            if let Some(tx) = state.sessions.input_tx(&id) {
                if let Err(e) = tx.send(SessionInput::Prompt {
                    text: prompt.to_string(),
                    run_id: None,
                    client_id: None,
                }).await {
                    // 失败仅记日志：session 已建好可用，用户可手动重发（最低限度档）
                    tracing::warn!("initial_prompt send failed for {}: {}", id, e);
                }
            } else {
                tracing::warn!("initial_prompt: no input channel for {}", id);
            }
        }
    }
}
```

要点：
- `trim()` + 空判断 → 空白 prompt 等同没填，行为回退到老流程。
- tmux 整段跳过（`SessionInput::Prompt` 对 PTY fan-out 本就静默丢弃，显式跳过更清晰）。
- `run_id: None` → 不进 scheduled run-record；`client_id: None` → 不归属某 WS 客户端，让 fan-out 把它当系统注入的首条 prompt（与 `trigger_run` 一致）。
- 失败不回滚 session，只 `warn!`。
- `input_tx` 在 `create_acp_session` 返回前已注册，故建完即可安全取用。

## 前端 UI（方案 A）

### `frontend/src/lib/api.ts`（`createSession`，第 117 行）

新增可选参数 `initialPrompt?: string`，序列化为 body 的 `initial_prompt`（无则 `null`）：

```ts
export async function createSession(
  type: SessionType, name?: string, workDir?: string,
  tmuxTarget?: string, initialPrompt?: string
): Promise<SessionInfo> {
  const res = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      type, name: name || null, work_dir: workDir || null,
      tmux_target: tmuxTarget || null,
      initial_prompt: initialPrompt || null,
    }),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}
```

### `frontend/src/App.tsx`（`handleCreate`）

签名加 `initialPrompt?: string`，透传给 `createSession`。建完后切到该 session（沿用现有逻辑），用户立刻看到 agent 开跑。

### `frontend/src/components/Sidebar.tsx`（新增 `pick-prompt` step）

- `NewSessionStep` 联合类型加 `'pick-prompt'`（现为 `'closed' | 'pick-type' | 'pick-terminal-mode' | 'pick-dir' | 'pick-tmux'`）。
- 新增 state：`promptDraft: string`、`pendingDir: string | null`。
- 改 `selectDir(path)`：**按 `pendingType` 分流**——
  - tmux：维持现状，立即 `onCreate('tmux', path)` 并关闭（tmux 零改变）。
  - agent：存下 `pendingDir = path` → `setStep('pick-prompt')`，**不立即创建**。
- 新增 `pick-prompt` 渲染：
  - 标题 "Initial prompt (optional)"
  - 多行 `<textarea>`（绑 `promptDraft`，autoFocus）
  - 按钮 **[Skip & create]** → `onCreate(pendingType, pendingDir)`（不带 prompt，等同老流程）
  - 按钮 **[Create & send]** → `onCreate(pendingType, pendingDir, promptDraft)`，仅当 `promptDraft.trim()` 非空时可点。
  - 键盘：`Cmd/Ctrl+Enter` = Create & send；`Esc` = 关闭。
  - 提交后重置 `promptDraft` / `pendingDir`，`setStep('closed')`。

**作用域**：`pick-prompt` 只在 agent 类型出现。tmux 两条路径（new shell / attach）不经过它。

## 测试策略

### 后端（Rust `#[cfg(test)]`，对齐现有 scheduled 测试风格）

1. **agent + 非空 prompt** → 建完 session 后，`input_tx` 接收端收到 `SessionInput::Prompt { text: <原文透传>, run_id: None, client_id: None }`（验证纯透传 + 无 verdict 追加）。
2. **agent + 空白 prompt（`"   "`）** → 不发送任何 Prompt。
3. **agent + 无 prompt（`None`）** → 不发送。
4. **tmux + 有 prompt** → session 建出，但不发 Prompt。

> 测试需拿到 `input_tx` 接收端断言。写 plan 时先勘察现有 `trigger_run` / scheduled 测试如何注入并观测 `SessionInput`，复用同一 harness，不重造。

### 前端（vitest）

5. `createSession` 带 `initialPrompt` → request body 含 `initial_prompt`；不带时为 `null`。
6. 若 Sidebar step 状态机可单测：`selectDir` 对 agent → step 变 `pick-prompt`；对 tmux → 直接 `onCreate`。若 Sidebar 依赖过多 props/DOM 难以单测，本条降级为手动验收。

### 手动验收清单

- 建 claude 会话填 prompt → 自动开跑，agent 收到原文（无多余 verdict 行）。
- 填 prompt 点 [Skip & create] → 建好但不发。
- tmux new shell → 全程不出现 prompt 步骤。
- 空 prompt 点 [Create & send] → 按钮禁用 / 无操作。

## 明确不做（YAGNI）

- ❌ prompt 不持久化（不存 DB，刷新即弃——它只是首条消息）。
- ❌ 不做 prompt 模板 / 历史（属 Roadmap 另一项「Agent 模板」）。
- ❌ 发送失败不加 toast（最低限度档）。
- ❌ tmux 不支持 initial_prompt。

## 影响的文件

- `src/web.rs` — `CreateSessionReq` 加字段 + `create_session` handler 发 prompt + 后端单测。
- `frontend/src/lib/api.ts` — `createSession` 加参数。
- `frontend/src/App.tsx` — `handleCreate` 透传。
- `frontend/src/components/Sidebar.tsx` — `pick-prompt` step。
- 前端测试文件（`createSession` body 断言）。
