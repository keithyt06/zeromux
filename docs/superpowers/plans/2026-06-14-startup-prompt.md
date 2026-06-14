# 启动 Prompt（Initial Prompt on Session Create）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 创建 agent 会话（claude/kiro/codex）时可顺手填一条初始指令，会话建好即把它作为第一条用户消息透传给 agent，自动开跑。

**Architecture:** `CreateSessionReq` 新增 `initial_prompt: Option<String>`。`create_session` handler 建完 session 后，对非 tmux、非空白的 prompt 调用新方法 `SessionManager::send_initial_prompt`，该方法发一条 `SessionInput::Prompt { run_id: None }`（走 fan-out 的 idle-立即发送路径，不是 trigger_run 的调度分支）。前端在 DirPicker 选完目录后新增 `pick-prompt` 步骤，按输入态切换按钮。

**Tech Stack:** Rust/Axum 后端（`src/web.rs`、`src/session_manager.rs`），React/TS 前端（`frontend/src/lib/api.ts`、`App.tsx`、`components/Sidebar.tsx`）。测试：Rust 内联 `#[cfg(test)]`、前端 vitest。

**Spec:** `docs/superpowers/specs/2026-06-14-startup-prompt-design.md`

---

## File Structure

- `src/session_manager.rs` — 新增 `send_initial_prompt` 方法（可测试接缝，承载 F1 `run_id:None` 不变量）+ 其单测。
- `src/web.rs` — `CreateSessionReq` 加字段；`create_session` handler 在返回前调用 `send_initial_prompt`（tmux/trim/空 gating 在此）。
- `frontend/src/lib/api.ts` — `createSession` 加 `initialPrompt?` 参数 + 其 vitest 测试。
- `frontend/src/App.tsx` — `handleCreate` 透传 `initialPrompt`。
- `frontend/src/components/Sidebar.tsx` — `pick-prompt` step + 按输入态切换按钮。

---

## Task 1: 后端 `send_initial_prompt` 方法（核心逻辑 + F1 不变量）

把"发初始 prompt"做成 `SessionManager` 上一个独立方法，作为可测接缝。F1 不变量（`run_id: None`）在此用单测钉死，无需构造完整 AppState。

**Files:**
- Modify: `src/session_manager.rs`（在 `trigger_run`/`replay_run` 附近，约第 945 行后，加 `send_initial_prompt`）
- Test: `src/session_manager.rs` 内联 `#[cfg(test)] mod tests`（复用现有 `running_session` / `mgr_with` 风格）

- [ ] **Step 1: 写失败测试 —— 发出的 Prompt 必须 run_id=None 且文本透传（测试 1 + F1 护栏 5）**

先看现有测试辅助：`running_session(id, stype, source_task_id, turn)`（约第 3145 行）用 `let (input_tx, _rx) = mpsc::channel(64)` 丢弃了接收端，测不了发送内容。新增一个保留接收端的辅助 + 测试。加到 `session_manager.rs` 的 `#[cfg(test)] mod tests` 里（与 `mgr_with` 同模块）：

```rust
    /// 像 running_session，但返回接收端供断言"发了什么"。
    fn running_session_observable(
        id: &str,
        stype: SessionType,
    ) -> (Session, mpsc::Receiver<SessionInput>) {
        let (event_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        let (input_tx, rx) = mpsc::channel::<SessionInput>(64);
        let s = Session {
            id: id.into(),
            name: "n".into(),
            session_type: stype,
            cols: 80,
            rows: 24,
            work_dir: "/tmp".into(),
            owner_id: "o".into(),
            description: String::new(),
            name_is_auto: true,
            status: SessionMeta::Idle,
            resume_token: None,
            worktree_path: None,
            created_ms: 0,
            source_task_id: None,
            spawning: false,
            last_activity_ms: 0,
            turns_completed: 0,
            running: Some(RunningProcess {
                event_tx,
                input_tx,
                pty_pid: None,
                turn_state: TurnState::Idle,
                turn_started_ms: None,
                turn_seq: 0,
            }),
            scrollback: VecDeque::new(),
            scrollback_bytes: 0,
        };
        (s, rx)
    }

    #[tokio::test]
    async fn send_initial_prompt_passthrough_run_id_none() {
        let (s, mut rx) = running_session_observable("sid", SessionType::Claude);
        let (m, _tmp) = mgr_with(vec![s]);

        m.send_initial_prompt("sid", "查一下登录 bug").await;

        let got = rx.recv().await.expect("a prompt should have been sent");
        match got {
            SessionInput::Prompt { text, run_id, client_id } => {
                assert_eq!(text, "查一下登录 bug", "文本必须原样透传，无 verdict 追加");
                assert!(run_id.is_none(), "F1: 交互式启动 prompt 的 run_id 必须为 None");
                assert!(client_id.is_none());
            }
            other => panic!("expected Prompt, got {:?}", other),
        }
    }
```

注意 `running_session_observable` 需要 `mpsc::Receiver` 在作用域内存活（别让它提前 drop，否则 send 会失败）。

- [ ] **Step 2: 运行测试，确认编译失败**

Run: `cargo test send_initial_prompt_passthrough_run_id_none 2>&1 | tail -20`
Expected: 编译错误 `no method named send_initial_prompt`（方法尚未定义）。

- [ ] **Step 3: 实现 `send_initial_prompt`**

加到 `impl SessionManager`（`replay_run` 之后，约第 957 行后）。注意这里**不做** tmux/空判断——那是 handler 的职责；本方法只负责"有 channel 就发 + 留痕"，保持单一职责：

```rust
    /// 交互式启动 prompt：把 `prompt` 作为第一条用户消息透传给 agent 会话。
    ///
    /// F1: 发 `run_id: None` —— 走 fan-out 的 idle-立即发送路径（QueueMode 默认
    /// Collect 分支对 fresh idle 会话命中"真正空闲:立即发送"），**不是** trigger_run
    /// 的 `run_id: Some` 调度分支。切勿带 run_id，否则会把交互会话误判成调度运行
    /// （污染 active_run_id / 触发 verdict finalize）。
    ///
    /// best-effort：发送失败只记日志（session 已建好可用，用户可手动重发）。
    /// 调用方（web handler）负责 tmux 跳过与空白 prompt 过滤。
    pub async fn send_initial_prompt(&self, id: &str, prompt: &str) {
        if let Some(tx) = self.input_tx(id) {
            if let Err(e) = tx
                .send(SessionInput::Prompt {
                    text: prompt.to_string(),
                    run_id: None,
                    client_id: None,
                })
                .await
            {
                tracing::warn!("initial_prompt send failed for {}: {}", id, e);
            } else {
                // F3: 成功也留痕，否则线上排查"agent 没自动开跑"时，
                // "发了但 agent 没动" 与 "压根没进这段逻辑" 在日志里无法区分。
                tracing::info!("initial_prompt sent for {}", id);
            }
        } else {
            tracing::warn!("initial_prompt: no input channel for {}", id);
        }
    }
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `cargo test send_initial_prompt_passthrough_run_id_none 2>&1 | tail -20`
Expected: PASS（1 passed）。

- [ ] **Step 5: 提交**

```bash
git add src/session_manager.rs
git commit -m "feat(session): send_initial_prompt — interactive first-message passthrough (run_id:None)"
```

---

## Task 2: 后端 handler 接线（`CreateSessionReq` 字段 + gating）

`create_session` 建完 session 后，对非 tmux、非空白 prompt 调 `send_initial_prompt`。

**Files:**
- Modify: `src/web.rs:298`（`CreateSessionReq` 加字段）
- Modify: `src/web.rs:329-386`（`create_session` handler）
- Test: `src/web.rs` 内联 `#[cfg(test)]`（反序列化默认值测试）

- [ ] **Step 1: 写失败测试 —— `initial_prompt` 缺省反序列化为 None（测试 3 的接线护栏）**

`create_session` 需要完整 AppState 难以单测；但请求体的反序列化（缺字段→None）是纯逻辑，可测。加到 `src/web.rs` 末尾的 `#[cfg(test)] mod` 区（新开一个 mod，与 `upload_helpers_tests` 同级）：

```rust
#[cfg(test)]
mod create_session_req_tests {
    use super::CreateSessionReq;

    #[test]
    fn initial_prompt_defaults_to_none_when_absent() {
        // 老前端不发 initial_prompt 字段 → 必须反序列化为 None（向后兼容）。
        let json = r#"{"type":"claude"}"#;
        let req: CreateSessionReq = serde_json::from_str(json).unwrap();
        assert!(req.initial_prompt.is_none());
    }

    #[test]
    fn initial_prompt_parses_when_present() {
        let json = r#"{"type":"claude","initial_prompt":"hello"}"#;
        let req: CreateSessionReq = serde_json::from_str(json).unwrap();
        assert_eq!(req.initial_prompt.as_deref(), Some("hello"));
    }
}
```

- [ ] **Step 2: 运行测试，确认编译失败**

Run: `cargo test create_session_req_tests 2>&1 | tail -20`
Expected: 编译错误 —— `CreateSessionReq` 无 `initial_prompt` 字段。

- [ ] **Step 3: 加字段 + handler 接线**

改 `src/web.rs:298` 的 `CreateSessionReq`，在 `tmux_target` 后加一行：

```rust
struct CreateSessionReq {
    name: Option<String>,
    #[serde(rename = "type", default = "default_session_type")]
    session_type: crate::session_manager::SessionType,
    work_dir: Option<String>,
    tmux_target: Option<String>,
    initial_prompt: Option<String>,   // 仅 agent 会话有意义；tmux 忽略
}
```

然后在 `create_session`（`src/web.rs:381` 处，`Ok(Json(...))` return 之前）插入：

```rust
    // 启动 Prompt：仅 agent 会话、且 prompt 非空白时，作为第一条用户消息透传。
    // tmux 跳过：PTY fan-out 会静默丢弃 Prompt，显式跳过免得 F3 的成功日志说谎。
    if req.session_type != crate::session_manager::SessionType::Tmux {
        if let Some(prompt) = req.initial_prompt.as_deref() {
            let prompt = prompt.trim();
            if !prompt.is_empty() {
                state.sessions.send_initial_prompt(&id, prompt).await;
            }
        }
    }

    Ok(Json(serde_json::json!({
```

（即把原来的 `Ok(Json(...))` 前面补上这段；`SessionInput` 已在 `send_initial_prompt` 内部使用，handler 无需额外 import。）

- [ ] **Step 4: 运行测试，确认通过 + 全量编译**

Run: `cargo test create_session_req_tests 2>&1 | tail -20`
Expected: PASS（2 passed）。

Run: `cargo build 2>&1 | tail -15`
Expected: 编译成功（仅 pre-existing 警告，无新错误）。

- [ ] **Step 5: 提交**

```bash
git add src/web.rs
git commit -m "feat(web): wire initial_prompt into create_session (tmux/empty gated)"
```

---

## Task 3: 后端边界测试（空白 / tmux gating）

补 spec 测试 2（空白不发）和测试 4（tmux 不发）。这两条验证 gating 逻辑。由于 `create_session` handler 需完整 AppState 难以单测，本任务把 Task 2 写进 handler 的内联 gating（tmux 跳过 + trim + 空判断）**抽成纯函数 `should_send_initial_prompt`** 并单测之。Task 2 的内联版本是临时的——本任务用纯函数调用替换它（见 Step 3）。先做 Task 2 再做本任务。

**Files:**
- Modify: `src/web.rs`（抽一个 `should_send_initial_prompt` 纯函数 + 测试）

- [ ] **Step 1: 写失败测试 —— gating 决策（空白/None/tmux → 不发，非空 agent → 发）**

加到 `src/web.rs` 的 `create_session_req_tests` mod 内：

```rust
    use super::should_send_initial_prompt;
    use crate::session_manager::SessionType;

    #[test]
    fn gating_sends_only_for_nonblank_agent_prompt() {
        // 非空 agent prompt → 发
        assert_eq!(
            should_send_initial_prompt(SessionType::Claude, Some("hi")),
            Some("hi".to_string())
        );
        assert_eq!(
            should_send_initial_prompt(SessionType::Kiro, Some("  x  ")),
            Some("x".to_string()),
            "应 trim 后发送"
        );
        // 空白 / None → 不发
        assert_eq!(should_send_initial_prompt(SessionType::Claude, Some("   ")), None);
        assert_eq!(should_send_initial_prompt(SessionType::Codex, None), None);
        // tmux → 永不发（即使有 prompt）
        assert_eq!(should_send_initial_prompt(SessionType::Tmux, Some("hi")), None);
    }
```

- [ ] **Step 2: 运行测试，确认编译失败**

Run: `cargo test gating_sends_only_for_nonblank_agent_prompt 2>&1 | tail -20`
Expected: 编译错误 —— `should_send_initial_prompt` 未定义。

- [ ] **Step 3: 抽出 gating 纯函数，handler 改用它**

在 `src/web.rs`（`create_session` 函数上方，约第 328 行 `default_session_type` 附近）加纯函数：

```rust
/// 启动 Prompt 的 gating 决策（纯函数，便于测试）：
/// 返回 Some(trimmed) 表示应发送该文本；None 表示不发（tmux / 缺省 / 空白）。
fn should_send_initial_prompt(
    session_type: crate::session_manager::SessionType,
    prompt: Option<&str>,
) -> Option<String> {
    if session_type == crate::session_manager::SessionType::Tmux {
        return None;
    }
    let trimmed = prompt?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}
```

然后把 Task 2 Step 3 加进 handler 的那段 gating 替换为调用此函数：

```rust
    // 启动 Prompt：gating 决策抽到 should_send_initial_prompt（已单测）。
    if let Some(prompt) = should_send_initial_prompt(req.session_type, req.initial_prompt.as_deref()) {
        state.sessions.send_initial_prompt(&id, &prompt).await;
    }

    Ok(Json(serde_json::json!({
```

- [ ] **Step 4: 运行测试，确认通过 + 全量 Rust 测试**

Run: `cargo test gating_sends_only_for_nonblank_agent_prompt 2>&1 | tail -20`
Expected: PASS。

Run: `cargo test 2>&1 | tail -15`
Expected: 全部通过（原有 143 + 本次新增）。

- [ ] **Step 5: 提交**

```bash
git add src/web.rs
git commit -m "refactor(web): extract should_send_initial_prompt gating fn + tests (blank/tmux)"
```

---

## Task 4: 前端 API 层（`createSession` 加参数）

**Files:**
- Modify: `frontend/src/lib/api.ts:117-124`
- Test: `frontend/src/lib/__tests__/createSession.test.ts`（新建）

- [ ] **Step 1: 写失败测试 —— body 含/不含 initial_prompt（spec 测试 5）**

Create `frontend/src/lib/__tests__/createSession.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSession } from '../api'

describe('createSession initial_prompt', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 's1', name: 'n', type: 'claude' }),
    })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('includes initial_prompt in body when provided', async () => {
    await createSession('claude', undefined, '/tmp/x', undefined, '查 bug')
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.initial_prompt).toBe('查 bug')
  })

  it('sends initial_prompt: null when omitted (backward compat)', async () => {
    await createSession('claude', undefined, '/tmp/x')
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.initial_prompt).toBeNull()
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run src/lib/__tests__/createSession.test.ts 2>&1 | tail -20`
Expected: FAIL（`initial_prompt` undefined，因为 `createSession` 还没这个参数）。

- [ ] **Step 3: 给 `createSession` 加参数**

改 `frontend/src/lib/api.ts:117`：

```ts
export async function createSession(type: SessionType, name?: string, workDir?: string, tmuxTarget?: string, initialPrompt?: string): Promise<SessionInfo> {
  const res = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ type, name: name || null, work_dir: workDir || null, tmux_target: tmuxTarget || null, initial_prompt: initialPrompt || null }),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run src/lib/__tests__/createSession.test.ts 2>&1 | tail -20`
Expected: PASS（2 passed）。

- [ ] **Step 5: 提交**

```bash
git add frontend/src/lib/api.ts frontend/src/lib/__tests__/createSession.test.ts
git commit -m "feat(fe): createSession accepts initialPrompt → body.initial_prompt"
```

---

## Task 5: 前端 `App.tsx` 透传

**Files:**
- Modify: `frontend/src/App.tsx:140-144`

- [ ] **Step 1: 改 `handleCreate` 签名 + 透传**

`App.tsx:140` 现为：

```tsx
  const handleCreate = useCallback(async (type: SessionType, workDir?: string, tmuxTarget?: string) => {
    const s = await createSession(type, undefined, workDir, tmuxTarget)
    setSessions(prev => [...prev, s])
    setActiveId(s.id)
  }, [])
```

改为：

```tsx
  const handleCreate = useCallback(async (type: SessionType, workDir?: string, tmuxTarget?: string, initialPrompt?: string) => {
    const s = await createSession(type, undefined, workDir, tmuxTarget, initialPrompt)
    setSessions(prev => [...prev, s])
    setActiveId(s.id)
  }, [])
```

（`setActiveId(s.id)` 已使新会话自动打开 —— 用户立刻看到 agent 开跑，无需额外改动。）

- [ ] **Step 2: 编译检查**

Run: `cd frontend && npx tsc -b 2>&1 | tail -15`
Expected: 无新类型错误（`Sidebar` 的 `onCreate` prop 类型下一任务更新；若此时 tsc 报 `onCreate` 签名不匹配，属预期，Task 6 修复后消失。可先继续）。

- [ ] **Step 3: 提交**

```bash
git add frontend/src/App.tsx
git commit -m "feat(fe): handleCreate threads initialPrompt to createSession"
```

---

## Task 6: 前端 `Sidebar.tsx` —— `pick-prompt` step + 按输入态切换按钮

**Files:**
- Modify: `frontend/src/components/Sidebar.tsx`（`onCreate` prop 类型、`NewSessionStep`、state、`selectDir`、渲染）

- [ ] **Step 1: 更新 `onCreate` prop 类型（第 14 行）**

```tsx
  onCreate: (type: SessionType, workDir?: string, tmuxTarget?: string, initialPrompt?: string) => void
```

- [ ] **Step 2: 扩展 step 类型 + 新增 state（第 48、64-66 行附近）**

`NewSessionStep`（第 48 行）加 `'pick-prompt'`：

```tsx
type NewSessionStep = 'closed' | 'pick-type' | 'pick-terminal-mode' | 'pick-dir' | 'pick-tmux' | 'pick-prompt'
```

在 `pendingType` state（第 65 行）附近加：

```tsx
  const [promptDraft, setPromptDraft] = useState('')
  const [pendingDir, setPendingDir] = useState<string | null>(null)
```

- [ ] **Step 3: 改 `selectDir` 按 type 分流（第 168-173 行）**

现为：

```tsx
  const selectDir = (path: string) => {
    if (pendingType) {
      onCreate(pendingType, path)
    }
    setStep('closed')
  }
```

改为：

```tsx
  const selectDir = (path: string) => {
    if (!pendingType) { setStep('closed'); return }
    if (pendingType === 'tmux') {
      // tmux 零改变：选完目录立即创建。
      onCreate('tmux', path)
      setStep('closed')
    } else {
      // agent：进 pick-prompt 步骤，不立即创建。
      setPendingDir(path)
      setPromptDraft('')
      setStep('pick-prompt')
    }
  }
```

- [ ] **Step 4: 加提交辅助 + reset（在 `close` 函数附近，第 175 行后）**

```tsx
  const submitWithPrompt = () => {
    if (!pendingType || !pendingDir) { setStep('closed'); return }
    const trimmed = promptDraft.trim()
    onCreate(pendingType, pendingDir, undefined, trimmed ? promptDraft : undefined)
    setPromptDraft('')
    setPendingDir(null)
    setStep('closed')
  }
  const submitSkip = () => {
    if (!pendingType || !pendingDir) { setStep('closed'); return }
    onCreate(pendingType, pendingDir)
    setPromptDraft('')
    setPendingDir(null)
    setStep('closed')
  }
```

注意：`submitWithPrompt` 传原始 `promptDraft`（保留用户的换行/空格），仅用 `trimmed` 判空决定带不带；后端还会再 trim 一次（无害）。

- [ ] **Step 5: 渲染 `pick-prompt`（在 step 渲染区，参照 `pick-dir` 那段的容器/样式）**

在 `pick-dir` 渲染块后加一个 `step === 'pick-prompt'` 分支。匹配现有面板的 Tailwind 风格（容器 `bg-[var(--bg-secondary)]`、按钮 `text-[var(--text-...)]`）。按输入态切换按钮（CEO 扩展点 3）：

```tsx
{step === 'pick-prompt' && (
  <div className="p-3 flex flex-col gap-2">
    <div className="text-xs text-[var(--text-secondary)]">Initial prompt (optional)</div>
    <textarea
      autoFocus
      value={promptDraft}
      onChange={e => setPromptDraft(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitWithPrompt() }
        else if (e.key === 'Escape') { e.preventDefault(); close() }
      }}
      placeholder="给 agent 的第一条指令，留空则只创建会话"
      className="w-full h-24 resize-none rounded bg-[var(--bg-primary)] border border-[var(--border)] p-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
    />
    <div className="flex justify-end gap-2">
      {promptDraft.trim() ? (
        <>
          <button onClick={submitSkip}
            className="px-3 py-1 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
            Skip &amp; create
          </button>
          <button onClick={submitWithPrompt}
            className="px-3 py-1 text-sm rounded bg-[var(--accent)] text-white hover:opacity-90">
            Create &amp; send
          </button>
        </>
      ) : (
        <button onClick={submitSkip}
          className="px-3 py-1 text-sm rounded bg-[var(--accent)] text-white hover:opacity-90">
          Create
        </button>
      )}
    </div>
  </div>
)}
```

（`var(--accent)` 若项目无此变量，用 `pick-dir`/`pick-type` 现有主按钮的同款类名替换；实现时对齐邻近按钮即可。）

- [ ] **Step 6: 编译 + lint**

Run: `cd frontend && npx tsc -b 2>&1 | tail -15`
Expected: 无类型错误（`onCreate` 四参签名现已对齐 App.tsx）。

Run: `cd frontend && npm run lint 2>&1 | tail -20`
Expected: 无新增 lint 错误（项目有约 27 个 pre-existing 错误，确认未新增即可）。

- [ ] **Step 7: 提交**

```bash
git add frontend/src/components/Sidebar.tsx
git commit -m "feat(fe): pick-prompt step on agent create — input-state button toggle"
```

---

## Task 7: 全量验证 + 前端构建

**Files:** 无（验证任务）

- [ ] **Step 1: Rust 全量测试**

Run: `cargo test 2>&1 | tail -15`
Expected: 全部通过（143 baseline + Task 1/2/3 新增约 4 个）。

- [ ] **Step 2: 前端测试 + 构建**

Run: `cd frontend && npm test 2>&1 | tail -20`
Expected: 全部通过（含 Task 4 新增）。

Run: `cd frontend && npm run build 2>&1 | tail -10`
Expected: 构建成功，产出 `frontend/dist/`（rust-embed 需要）。

- [ ] **Step 3: 手动验收（spec 清单，需本地起服务）**

参照 spec `手动验收清单`：
- 建 claude 会话填 prompt → 自动开跑，agent 收到原文（无 verdict 行）。
- 三种 agent（claude/kiro/codex）各填 prompt → 都能自动开跑（F2）。
- 填 prompt 后点 [Skip & create] → 建好但不发。
- tmux new shell → 全程不出现 prompt 步骤。
- 空 prompt → 只看到 [Create] 单按钮；输入文字后变 [Skip & create] + [Create & send]。
- 后端日志：成功有 `initial_prompt sent`，失败有 `initial_prompt send failed`（F3）。

- [ ] **Step 4: 最终提交（如手动验收触发任何修补）**

```bash
git add -A && git commit -m "test: verify startup-prompt end-to-end"
```

---

## 备注

- **不部署**：本计划只到合并就绪。部署 live 按 [[zeromux-deploy]] 的两阶段防 cgroup 自杀流程单独进行。
- **未来工作**（spec 已记，非本次）：完成通知（P0 闭环后半截）、批量起多 agent（P2 TODO）。
