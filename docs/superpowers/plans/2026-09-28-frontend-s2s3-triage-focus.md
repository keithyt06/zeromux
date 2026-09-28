# 前端重设计 S2+S3「分诊 + Focus」合并期 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用「分诊队列 + 下一个 + ⌘K + Focus 区(FocusHeader / ContextPanel / 新 turn 呈现 / composer / SendToMenu)」的新壳**直接取代**现有 Sidebar + SessionInfoBar + overlay + TurnGroupView,不留新旧开关。

**Architecture:** 先修 Crew 审批 wire 契约、用 `React.lazy` 腾出首屏体积;再上后端「会话态势」只增字段(三 fan-out 在 `emit` 咽喉统一维护),再对**旧 App** 写 App 级 characterization 测试托底;然后把 AcpChatView 的 WS 生命周期原样抽出 `useAcpSocket` 并扩展 `sessionControls`;接着落纯函数库(triage / steps / fuzzy / sessionActions / readState),在旧壳内替换 turn 呈现;最后**一个可整体 revert 的提交**切换到 `AppShell`(分诊 + ⌘K + FocusHeader + ContextPanel)并删除旧路径。composer 改造与 SendToMenu 在壳稳定 ≥ 2 天后另行合并。

**Tech Stack:** Rust axum 0.8 + tokio(`src/session_manager.rs`);React 19 + Vite 8 + Tailwind v4 + vitest/happy-dom 15/testing-library/react;S1 产出的 `components/ui/*` primitives、`lib/format.ts`、`useLatestRequest`/`usePolling`/`usePathSearch`/`useDirBrowser`、`useIsNarrow/useIsTouch`。**零新增运行时依赖**(不引 zustand / Radix / cmdk)。

**Spec:** `docs/superpowers/specs/2026-09-26-frontend-triage-focus-redesign-design.md` —— **§0.5(v3 合并期决议 M1–M28、对位表 §0.5.4、砍单 §0.5.5、护栏 §0.5.6、验收 §0.5.7)优先于一切**,其次 §4(S2 正文)、§3.1 状态表;`docs/superpowers/specs/2026-09-27-focus-session-experience-design.md` §0.3(V1–V17)与 §2–§3(Plan A)。审计 `docs/superpowers/audits/2026-09-26-frontend-ux-audit.md` §7(不变量 I-1~I-19)。

## Global Constraints

- **无新旧开关**:不得出现 `zmx_shell` / `zmx_turn_ui` 或任何 v1/v2 切换;回退 = `git revert` + `./deploy.sh --build`。
- **零新增运行时依赖**;devDependency 也不新增。
- 首屏入口 JS + CSS **br ≤ 330KB**(`npm run build` 内 `check-size.mjs dist 337920`,当前实测 320.0KB)。**每个 Task 结束都跑 `npm run build`**,超限即在本 Task 内用 `React.lazy` 拆分解决,不得抬阈值。
- 审计 §7 **I-1 ~ I-19 全部保持**;Task 4 写下的 App 级 characterization 测试在后续每个 Task 结束时原样通过(只允许改 import 路径 / 渲染入口,不改断言)。
- **不改断言通过的显式清单**(spec §0.5.6-2):`AgentDashboard.stale`、`DirectoryPicker.stale`、`GitViewer.stale`、`MemoryPanel.stale`、`RunMetricsPanel.stale`、`GitViewer.worktreeStale`、`FileBrowser`、`QuickTargets`、`VaultReader`、`crewEventCases`、`crewMemoryWrite`、`acpConnection`、`acpHeaderLifetime`、`transcript`(只允许追加用例)。`crewSessionType` ② 按 Task 11 Step 8 改指新文件。
- 新 UI **不新开 WS**;所有跨会话动作(中断 / 批准 / 发送)经已挂载会话注册的 `sessionControls`;queue_mode / busy / running 取后端权威(I-6)。
- 后端新字段只做预计算,`list_sessions` 锁内零 I/O、零扫描;所有截断用 `chars().take(n)`(禁止字节切片,防多字节 panic)。
- 字号:只用 `text-ui-*`;输入框 16px(`text-ui-input`,I-15);禁 `text-[8-11px]`;颜色只用语义 token(`--fg*`/`--surface-*`/`--danger`/`--stuck`/`--attention`/`--running`/`--accent`/`--success`);图标只用 `lucide-react`,**禁 emoji**;禁原生 `alert/confirm/prompt`(用 `components/ui` 的 `confirm`/`promptText`/`toast`)。`npm run lint` 的 token 棘轮不得增加。
- 触控目标 ≥ 44px(`.row` / IconButton `--hit`);不得有 hover-only 可达的操作。
- 快捷键只有 `⌘K`/`Ctrl+K`、`J`(焦点不在 input/textarea/xterm)、`⌘]`/`Ctrl+]`;**不做** `K`、`⌘[`、`⌘N`、`⌘.`、`⌘1-5`、`Esc Esc`、`⌘⇧Enter`。
- 用户可见文案中文;代码 / 注释英文。
- 每个 Task 结束:`cd frontend && npm test` 全绿、`npx tsc -b` 通过、`npm run lint` 不新增 error(基线 20)、`npm run build` 通过体积门禁;涉及 Rust 的 Task `cargo test` 全绿。
- 部署只用 `./deploy.sh --build`,**先 commit + push 再 deploy**;冒烟 / 截图实例必须 `--data-dir <临时目录>` + `--tmux-socket <专用名>` 隔离,端口 ≥ 18090,绝不碰 8090 与 systemctl。
- `SessionType` 只有 `tmux | claude | codex | crew`(Kiro 已删,M4);三 fan-out = `spawn_acp_fanout`(Claude)、`spawn_crew_fanout`、`spawn_codex_fanout`。

## Review Focus

1. **部署 / 自动更新重启后的分诊**:后端 `turns_completed`、`last_outcome*` 全部归零。刷新页面后不得把所有会话标成「完成·未读」或「出错」,也不得让某会话永远不再进入「需要你」(Task 7 `readState` 测试:`last_outcome_ms == null` → 不未读;新 sid 以 now baseline;重启后新完成的 turn 正常变未读)。
2. **等审批的 Crew 会话静默 > 180s**:分诊必须显示「待审批」而非「可能卡住」,行内动作是「批准」而非「中断」(Task 7 `triage` 测试 `approval beats stuck`)。
3. **3s 轮询在用户正点着分诊行 / ⌘K 列表时整表替换**:焦点(`activeId`)不动、正在展开的行内审批不收起、⌘K 高亮项不跳(Task 4 I-2 测试 + Task 11 TriageList 测试 `poll keeps expanded approval` + Task 11 ⌘K 测试 `results stable across sessions prop change`)。
4. **行内中断 / 批准时目标会话 WS 未连接**:toast「未连接,稍后重试」,本地 state 不变(不清排队计数、不把审批标已解决)(Task 5 `interrupt returns false when closed` / `resolveApproval returns false when closed` + Task 11 行内动作测试)。
5. **手机 390px 宽下 ContextPanel 以 bottom Sheet 打开时再打开 ⌘K / 会话 ⋯ 菜单**:不得出现 Sheet 套 Sheet;先关闭 ContextPanel Sheet 再开新层(Task 11 `opening palette closes context sheet` 测试)。

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/session_manager.rs` | Modify | `Posture`/`PostureDelta`、`posture_delta_of`、`Session` 新字段、`record_and_broadcast` 新参数、`settle_posture`、`approval_resolved`、`SessionInfo` 新字段 |
| `CLAUDE.md` | Modify | 删 Kiro 描述(M4) |
| `frontend/src/lib/api/sessions.ts` | Modify | `SessionInfo` 新字段类型 |
| `frontend/src/__tests__/App.characterization.test.tsx` | Create | I-1/I-2/I-3/I-17/I-18 App 级测试(旧 App 写,新壳原样过) |
| `frontend/src/test/appHarness.tsx` | Create | App 级测试共用 mock(api、WebSocket、xterm) |
| `frontend/src/hooks/useAcpSocket.ts` | Create | AcpChatView 的 WS 生命周期(原样搬迁)+ `interrupt/resolveApproval` 返回 boolean |
| `frontend/src/components/__tests__/acpSocket.characterization.test.tsx` | Create | spec §3.1 六项 |
| `frontend/src/lib/sessionControls.ts` | Create | `SessionControls` 类型 + 注册表 hook |
| `frontend/src/lib/triage.ts` | Create | `triage()`、`groupTriage()`、`nextNeedsYou()` 纯函数 |
| `frontend/src/lib/readState.ts` | Create | `lastViewedMs` 持久化 / baseline / GC |
| `frontend/src/lib/fuzzy.ts` | Create | 会话 / 动作模糊匹配 |
| `frontend/src/lib/steps.ts` | Create | `toSteps` / `touchedFiles` / `conclusion` |
| `frontend/src/lib/sessionActions.ts` | Create | 会话动作注册表 |
| `frontend/src/lib/paletteParse.ts` | Create | ⌘K 新建模式语法解析 |
| `frontend/src/components/ui/StatusDot.tsx` | Create | §3.1 五态形状 + 颜色 |
| `frontend/src/components/turn/TurnView.tsx`、`TurnTimeline.tsx`、`TurnSummaryCard.tsx`、`StepRow.tsx`、`TurnStatusBar.tsx` | Create | 新 turn 呈现(取代 TurnGroupView / density) |
| `frontend/src/components/shell/AppShell.tsx` | Create | 新壳:桌面三栏 / 手机单栏,会话层常驻挂载 |
| `frontend/src/components/shell/useSessionsPoll.ts`、`useShellState.ts` | Create | 从 App 抽出的轮询 / 认证分级 / 焦点 / 已读 |
| `frontend/src/components/shell/TriageList.tsx`、`TriageRow.tsx`、`TriageHeader.tsx` | Create | 分诊队列 |
| `frontend/src/components/shell/CommandPalette.tsx` | Create | ⌘K(搜索 / 动作 / 新建模式) |
| `frontend/src/components/shell/FocusHeader.tsx` | Create | 唯一会话顶栏 |
| `frontend/src/components/shell/ContextPanel.tsx` | Create | 3 tab(Git / 文件 / 运行),右栏或 bottom Sheet |
| `frontend/src/components/shell/useNextKeys.ts` | Create | `J` / `⌘]` / `⌘K` 键盘 |
| `frontend/src/components/SendToMenu.tsx` + `lib/sendTargets.ts` | Create | 「发给…」唯一实现 |
| `frontend/src/App.tsx` | Modify(Task 11 大改) | 只剩认证分级 + `<AppShell/>` |
| `Sidebar.tsx`、`SessionInfoBar.tsx`、`SessionRowMenu.tsx`、`lib/density.ts` 及其测试 | Delete(Task 11 / Task 10) | 被新壳取代;测试先移植 |

---

### Task 1: 修 Crew 审批 wire 契约(M9)

**Files:**
- Modify: `src/acp/process.rs`(测试模块:新增 Approval 序列化形状测试;`AcpEvent::Approval` 定义 :108 **不改**)
- Modify: `frontend/src/components/AcpChatView.tsx:440`(`case 'approval'`)
- Modify: `frontend/src/components/__tests__/crewEventCases.test.tsx`(新增用**真实 wire 形状** `id` 的用例;旧用例保留)

**Interfaces:**
- Produces(wire,锁定现状):`{"type":"approval","id":"…","tool":"…","tool_input"?:"…","tool_purpose"?:"…","slot":"…"}`。
- Produces(前端):`handleEvent` 的 approval 分支读 `evt.approval_id ?? evt.id`。`ServerEvent` 增加 `id?: string`。上行帧不变:`{type:'approval', approval_id, action}`(`ws_handler.rs:35` 期望 `approval_id`)。

- [ ] **Step 1: 后端锁定真实序列化形状(先写,应直接通过——它描述现状)**

在 `src/acp/process.rs` 的测试模块(:734 附近 `serde_json::to_string(&AcpEvent::PeerMessage` 所在模块)追加:

```rust
    #[test]
    fn approval_serializes_id_not_approval_id() {
        // The frontend contract (AcpChatView approval case) depends on this exact
        // shape. rename_all on the enum does NOT rename variant fields. (review 2026-09-28, M9)
        let v: serde_json::Value = serde_json::to_value(&AcpEvent::Approval {
            id: "ap-1".into(), tool: "rm -rf /tmp/b".into(),
            tool_input: None, tool_purpose: Some("cleanup".into()), slot: "s1".into(),
        }).unwrap();
        assert_eq!(v["type"], "approval");
        assert_eq!(v["id"], "ap-1");
        assert!(v.get("approval_id").is_none());
        assert_eq!(v["tool_purpose"], "cleanup");
    }
```

Run: `cargo test approval_serializes_id_not_approval_id` → PASS。

- [ ] **Step 2: 前端写失败测试(真实形状)**

在 `crewEventCases.test.tsx` 的 describe 内追加:

```tsx
  it('real wire shape: backend sends `id`, not `approval_id` (M9)', async () => {
    mount()
    await act(async () => {
      ws().emit({ type: 'approval', id: 'ap9', tool: 'rm -rf /tmp/x', tool_purpose: 'wire', slot: 's1', turn_id: 1 })
    })
    expect(await screen.findByText('需要你批准')).toBeInTheDocument()
    await act(async () => { screen.getByTestId('approval-approve').click() })
    expect(ws().sent.map(s => JSON.parse(s)))
      .toContainEqual({ type: 'approval', approval_id: 'ap9', action: 'approve' })
  })
```

Run: `cd frontend && npx vitest run src/components/__tests__/crewEventCases.test.tsx` → 新用例 FAIL(找不到「需要你批准」)。

- [ ] **Step 3: 修前端**

`AcpChatView.tsx` 的 `ServerEvent` 接口加 `id?: string`(放在 `approval_id?: string` 下一行,注释「backend's Approval variant serializes its id as `id` (process.rs)」);`case 'approval'` 第一行:

```tsx
        const aid = evt.approval_id ?? evt.id
```

Run: `npx vitest run src/components/__tests__/crewEventCases.test.tsx && npm test 2>&1 | tail -3` → 全绿。

- [ ] **Step 4: Commit(可单独上线)**

```bash
git add src/acp/process.rs frontend/src/components/AcpChatView.tsx frontend/src/components/__tests__/crewEventCases.test.tsx
git commit -m "fix(crew): approval cards never rendered — backend sends id, frontend read approval_id"
```

---

### Task 2: 首屏体积腾挪 —— 面板懒载(M27 / M9f)

**Files:**
- Modify: `frontend/src/App.tsx:16-24`(静态 import → `React.lazy`)、挂载处(:465-470 overlay、:487-490 panel Sheets、:478 VaultReader)
- Modify: `frontend/src/components/AcpChatView.tsx:15`(`RunMetricsPanel` 懒载)

**Interfaces:**
- Produces:以下组件改为懒载 chunk,首屏图不再包含它们:`FileBrowser`、`GitViewer`、`AgentDashboard`、`MemoryPanel`、`VaultReader`、`AdminPanel`、`ScheduledTasksPanel`、`PushSettings`、`PromptsSheet`、`RunMetricsPanel`。`Suspense` fallback 统一 `<Skeleton rows={4} />`(`components/ui`)。Task 11 的 ContextPanel 沿用同一批 lazy 引用。

- [ ] **Step 1: 记录基线**

Run: `cd frontend && npm run build 2>&1 | tail -4`
Expected: 打印 `320.0KB / 330KB`(或当前实际值)。把数值写进本 Task 的 commit message。

- [ ] **Step 2: 改懒载**

`App.tsx` 顶部:

```tsx
import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react'
…
// Off the first-screen graph (spec v3 M27): these are opened on demand.
const FileBrowser = lazy(() => import('./components/FileBrowser'))
const GitViewer = lazy(() => import('./components/GitViewer'))
const AgentDashboard = lazy(() => import('./components/AgentDashboard'))
const VaultReader = lazy(() => import('./components/VaultReader'))
const MemoryPanel = lazy(() => import('./components/MemoryPanel'))
const AdminPanel = lazy(() => import('./components/AdminPanel'))
const ScheduledTasksPanel = lazy(() => import('./components/ScheduledTasksPanel'))
const PushSettings = lazy(() => import('./components/PushSettings'))
const PromptsSheet = lazy(() => import('./components/PromptsSheet'))
```

删除对应的 9 行静态 import;`import { Toaster, DialogHost, toast, confirm } from './components/ui'` 加 `Skeleton`。把 overlay 四行(`view === 'files' && …` 到 `view === 'memory' && …`)包进一个 `<Suspense fallback={<Skeleton rows={4} />}>…</Suspense>`;docTabs 的 `<VaultReader …/>` 与四个 `panel === … &&` Sheet 各自包 `<Suspense fallback={null}>`(Sheet 自带出场,空 fallback 避免闪骨架)。

`AcpChatView.tsx:15`:

```tsx
const RunMetricsPanel = lazy(() => import('./RunMetricsPanel').then(m => ({ default: m.RunMetricsPanel })))
```

(`import { … lazy, Suspense } from 'react'`),`{showMetrics && (<Suspense fallback={null}><RunMetricsPanel … /></Suspense>)}`。

- [ ] **Step 3: 测试 + 体积**

Run: `npm test 2>&1 | tail -3 && npx tsc -b && npm run build 2>&1 | tail -4`
Expected: 测试全绿(测试直接 import 组件文件,不受 lazy 影响;若某个 App 级 / Sidebar 测试因 Suspense 需要 `await findBy…` 才出现内容,把该断言改为 `findBy`——**只改等待方式,不改断言内容**);`check-size` 打印的新基线 **明显低于** Step 1(预计 ≤ 305KB)。若降幅 < 8KB,检查 `dist/index.html` 的 modulepreload 是否把 lazy chunk 预加载回首屏(`check-size` 计入 modulepreload):若是,在 `vite.config.ts` 的 `build.modulePreload.resolveDependencies` 里过滤掉这些 chunk(参照 7542d8c 对 mermaid 的处理)。

- [ ] **Step 4: Commit**

```bash
git add frontend/src/App.tsx frontend/src/components/AcpChatView.tsx frontend/vite.config.ts
git commit -m "perf(build): lazy-load panels off the first screen (br <before>KB → <after>KB)"
```

---

### Task 3: 后端会话态势字段(三 fan-out parity)

**Files:**
- Modify: `src/session_manager.rs`(`Session` :297-338、`SessionInfo` :385-406、`session_info_of` :656-683、`record_and_broadcast` :2025、`emit` :3555-3622、三个 fan-out 的 settle 处 :3016/:3846/:4142 附近、crew `SessionInput::Approval` 臂 :4007、PTY 调用点 :1034、全部 `Session { … }` 构造点(`grep -n 'Session {$' src/session_manager.rs`,共 11 处,含测试 helper))
- Modify: `CLAUDE.md`(项目根,删除 Kiro 相关描述;「three AI agent CLIs (Claude Code, Kiro, Codex)」→「(Claude Code, Codex, Crew)」,删 `kiro_process.rs` 一节)
- Modify: `frontend/src/lib/api/sessions.ts:7-26`
- Test: `src/session_manager.rs` 新增 `#[cfg(test)] mod posture_tests`

**Interfaces:**
- Produces(Rust):
  ```rust
  #[derive(Default, Clone, Debug, PartialEq)]
  struct Posture {
      last_outcome: Option<crate::run_metrics::RunOutcome>,
      last_outcome_ms: Option<i64>,
      last_snippet: Option<String>,
      current_step: Option<String>,
      /// Unresolved Crew approval ids (dedupe by id, M9b); exported as len().
      approval_ids: Vec<String>,
  }
  enum PostureDelta { Step(String), Snippet(String), ApprovalAdded(String) }
  fn posture_delta_of(evt: &AcpEvent) -> Option<PostureDelta>
  fn apply_posture_delta(p: &mut Posture, d: PostureDelta)
  fn snippet_of(text: &str) -> Option<String>        // 末个非空行,去 markdown,chars().take(120)
  impl SessionManager {
      fn record_and_broadcast(&self, id: &str, data: String, bump_activity: bool, delta: Option<PostureDelta>)
      fn settle_posture(&self, sid: &str, outcome: crate::run_metrics::RunOutcome)
      fn approval_resolved(&self, sid: &str, approval_id: &str)
  }
  ```
- Produces(JSON,`GET /api/sessions` 每项新增,均可缺省):`last_outcome: "completed"|"errored"|"timeout"|"cancelled"|null`、`last_outcome_ms: number|null`、`last_snippet: string|null`、`current_step: string|null`、`pending_approvals: number`、`lifetime_cost_usd: number`。
- Produces(TS):`SessionInfo` 增加 `last_outcome?: RunOutcome | null; last_outcome_ms?: number | null; last_snippet?: string | null; current_step?: string | null; pending_approvals?: number; lifetime_cost_usd?: number`(`RunOutcome` 已在 `sessions.ts:133` 定义)。

- [ ] **Step 1: 写失败测试(纯函数部分)**

在 `src/session_manager.rs` 末尾追加:

```rust
#[cfg(test)]
mod posture_tests {
    use super::*;
    use std::borrow::Cow;

    fn block(bt: &'static str, text: Option<&str>, name: Option<&str>, summary: Option<&str>) -> AcpEvent {
        AcpEvent::ContentBlock {
            block_type: Cow::Borrowed(bt), turn_id: 0,
            text: text.map(String::from), name: name.map(String::from),
            input: None, streaming: None, summary: summary.map(String::from),
        }
    }

    #[test]
    fn snippet_takes_last_nonempty_line_strips_markdown_and_caps_chars() {
        assert_eq!(snippet_of("first\n\n**Done**: fixed `x`\n\n").as_deref(), Some("Done: fixed x"));
        assert_eq!(snippet_of("   \n  ").as_deref(), None);
        let long: String = "中".repeat(300);
        let s = snippet_of(&long).unwrap();
        assert_eq!(s.chars().count(), 120, "cap by chars, never bytes (multi-byte safe)");
        assert_eq!(snippet_of("# Title\n- item one").as_deref(), Some("item one"));
    }

    #[test]
    fn delta_tool_use_is_step_with_name_and_summary_capped_80() {
        let d = posture_delta_of(&block("tool_use", None, Some("Bash"), Some("npx vitest run")));
        assert!(matches!(d, Some(PostureDelta::Step(ref s)) if s == "Bash · npx vitest run"));
        let d = posture_delta_of(&block("tool_use", None, Some("Read"), None));
        assert!(matches!(d, Some(PostureDelta::Step(ref s)) if s == "Read"));
        let long = "x".repeat(200);
        match posture_delta_of(&block("tool_use", None, Some("Bash"), Some(&long))) {
            Some(PostureDelta::Step(s)) => assert_eq!(s.chars().count(), 80),
            _ => panic!("expected Step"),
        }
    }

    #[test]
    fn delta_ignores_streaming_text_and_thinking_takes_result_text() {
        // Codex/Crew stream deltas: taking their "last line" would yield fragments (M3).
        assert!(posture_delta_of(&block("text", Some("partial wo"), None, None)).is_none());
        assert!(posture_delta_of(&block("thinking", Some("hmm"), None, None)).is_none());
        let r = AcpEvent::Result { text: "All green.\nShipped".into(), turn_id: 0, session_id: String::new(),
            cost_usd: None, tokens_in: None, tokens_out: None };
        assert!(matches!(posture_delta_of(&r), Some(PostureDelta::Snippet(ref s)) if s == "Shipped"));
        let empty = AcpEvent::Result { text: "  ".into(), turn_id: 0, session_id: String::new(),
            cost_usd: None, tokens_in: None, tokens_out: None };
        assert!(posture_delta_of(&empty).is_none());
    }

    #[test]
    fn delta_approval_increments() {
        let a = AcpEvent::Approval { id: "a1".into(), tool: "rm".into(), tool_input: None, tool_purpose: None, slot: "s".into() };
        assert!(matches!(posture_delta_of(&a), Some(PostureDelta::ApprovalAdded(ref id)) if id == "a1"));
        let mut p = Posture::default();
        apply_posture_delta(&mut p, PostureDelta::ApprovalAdded("a1".into()));
        apply_posture_delta(&mut p, PostureDelta::ApprovalAdded("a1".into()));   // replayed / duplicate frame
        apply_posture_delta(&mut p, PostureDelta::ApprovalAdded("a2".into()));
        assert_eq!(p.approval_ids, vec!["a1".to_string(), "a2".to_string()], "dedupe by id (M9b)");
    }

    #[test]
    fn user_prompt_and_system_have_no_delta() {
        let u = AcpEvent::UserPrompt { text: "hi".into(), turn_id: 1, client_id: None };
        assert!(posture_delta_of(&u).is_none());
        let s = AcpEvent::System { subtype: Cow::Borrowed("status"), session_id: None, count: None };
        assert!(posture_delta_of(&s).is_none());
    }
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test posture_tests 2>&1 | tail -5`
Expected: 编译失败 `cannot find function snippet_of` / `Posture`。

- [ ] **Step 3: 实现纯函数与类型**

在 `fn is_ephemeral_event`(:3540)之前插入:

```rust
/// Precomputed "at a glance" state for the triage list (spec v3 §0.5.1 M2/M3/M5).
/// Maintained only under the sessions lock from `record_and_broadcast` /
/// `settle_posture` / `approval_resolved`; `session_info_of` just copies it.
/// In-memory only: a restart resets it (accepted, M8).
#[derive(Default, Clone, Debug, PartialEq)]
struct Posture {
    last_outcome: Option<crate::run_metrics::RunOutcome>,
    last_outcome_ms: Option<i64>,
    last_snippet: Option<String>,
    current_step: Option<String>,
    /// Unresolved Crew approval ids, deduped (M9b). Exported as `len()`.
    approval_ids: Vec<String>,
}

/// What one event changes in `Posture`. Computed in `emit` from the typed event,
/// BEFORE serialization, so `record_and_broadcast` never re-parses JSON.
enum PostureDelta {
    Step(String),
    Snippet(String),
    ApprovalAdded(String),
}

fn cap_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Last non-empty line of an agent's final text, with light markdown stripped.
/// Only `Result.text` feeds this: streamed text blocks are deltas (M3).
fn snippet_of(text: &str) -> Option<String> {
    let line = text.lines().rev().map(str::trim).find(|l| !l.is_empty())?;
    let line = line.trim_start_matches(|c| c == '#' || c == '-' || c == '*' || c == '>' || c == ' ');
    let cleaned: String = line.chars().filter(|c| *c != '*' && *c != '`' && *c != '_').collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() { return None; }
    Some(cap_chars(cleaned, 120))
}

fn posture_delta_of(evt: &AcpEvent) -> Option<PostureDelta> {
    match evt {
        AcpEvent::ContentBlock { block_type, name, summary, .. } if block_type.as_ref() == "tool_use" => {
            let name = name.as_deref().unwrap_or("tool");
            let step = match summary.as_deref() {
                Some(s) if !s.is_empty() => format!("{} · {}", name, s),
                _ => name.to_string(),
            };
            Some(PostureDelta::Step(cap_chars(&step, 80)))
        }
        AcpEvent::Result { text, .. } => snippet_of(text).map(PostureDelta::Snippet),
        AcpEvent::Approval { id, .. } => Some(PostureDelta::ApprovalAdded(id.clone())),
        _ => None,
    }
}

fn apply_posture_delta(p: &mut Posture, d: PostureDelta) {
    match d {
        PostureDelta::Step(s) => p.current_step = Some(s),
        PostureDelta::Snippet(s) => p.last_snippet = Some(s),
        PostureDelta::ApprovalAdded(id) => { if !p.approval_ids.contains(&id) { p.approval_ids.push(id) } }
    }
}
```

- [ ] **Step 4: 运行纯函数测试通过**

Run: `cargo test posture_tests 2>&1 | tail -5`
Expected: `test result: ok. 5 passed`

- [ ] **Step 5: 写失败测试(集成:锁内维护 + settle + 审批回执 + 导出)**

在 `posture_tests` 模块内追加(复用 `running_summary_tests` 同款构造;本模块自带最小 helper):

```rust
    fn mgr_one(stype: SessionType) -> (Arc<SessionManager>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let events = Arc::new(crate::events::EventStore::open(dir.path()).unwrap());
        let store = Arc::new(crate::session_store::SessionStore::open(dir.path()).unwrap());
        let m = SessionManager::new(events, store, "claude".into(), "codex".into(), "off".into(),
            5476, "/tmp/crew".into(), "bash".into(), false,
            crate::tmux::TmuxCtl::new(Some("zmx-test-unused".into())));
        let (event_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        let (input_tx, _rx) = mpsc::channel::<SessionInput>(64);
        let mut s = base_session("p", stype);
        s.running = Some(RunningProcess { event_tx, input_tx, pty_pid: None, turn_state: TurnState::Running,
            turn_started_ms: None, turn_seq: 1, queue_mode: QueueMode::Collect });
        m.sessions.lock().unwrap().insert("p".into(), s);
        (m, dir)
    }

    fn info(m: &SessionManager) -> SessionInfo {
        session_info_of(m.sessions.lock().unwrap().get("p").unwrap())
    }

    #[test]
    fn record_applies_delta_under_lock_and_info_exports_it() {
        for stype in [SessionType::Claude, SessionType::Codex, SessionType::Crew] {
            let (m, _d) = mgr_one(stype);
            m.record_and_broadcast("p", "{}".into(), true,
                posture_delta_of(&block("tool_use", None, Some("Edit"), Some("src/a.rs"))));
            assert_eq!(info(&m).current_step.as_deref(), Some("Edit · src/a.rs"), "{:?}", stype);
            m.record_and_broadcast("p", "{}".into(), true, None);
            assert_eq!(info(&m).current_step.as_deref(), Some("Edit · src/a.rs"), "None delta leaves posture");
        }
    }

    #[test]
    fn settle_records_outcome_clears_step_and_approvals() {
        let (m, _d) = mgr_one(SessionType::Crew);
        let a = AcpEvent::Approval { id: "a".into(), tool: "t".into(), tool_input: None, tool_purpose: None, slot: "s".into() };
        m.record_and_broadcast("p", "{}".into(), true, posture_delta_of(&a));
        m.record_and_broadcast("p", "{}".into(), true, posture_delta_of(&block("tool_use", None, Some("Bash"), None)));
        assert_eq!(info(&m).pending_approvals, 1);
        let before = now_millis();
        m.settle_posture("p", crate::run_metrics::RunOutcome::Errored);
        let i = info(&m);
        assert_eq!(i.last_outcome, Some("errored"));
        assert!(i.last_outcome_ms.unwrap() >= before);
        assert_eq!(i.current_step, None, "settled boundary clears the running step");
        assert_eq!(i.pending_approvals, 0, "turn boundary zeroes approvals (Gateway has no receipt, M5)");
    }

    #[test]
    fn approval_resolved_removes_by_id() {
        let (m, _d) = mgr_one(SessionType::Crew);
        for id in ["a", "b"] {
            let ev = AcpEvent::Approval { id: id.into(), tool: "t".into(), tool_input: None, tool_purpose: None, slot: "s".into() };
            m.record_and_broadcast("p", "{}".into(), true, posture_delta_of(&ev));
        }
        m.approval_resolved("p", "a");
        m.approval_resolved("p", "a");      // double click / unknown id is a no-op
        m.approval_resolved("p", "zzz");
        assert_eq!(info(&m).pending_approvals, 1);
    }

    #[test]
    fn info_exports_lifetime_cost_and_defaults() {
        let (m, _d) = mgr_one(SessionType::Claude);
        m.sessions.lock().unwrap().get_mut("p").unwrap().lifetime_cost_usd = 0.42;
        let i = info(&m);
        assert_eq!(i.lifetime_cost_usd, 0.42);
        assert_eq!(i.last_outcome, None);
        assert_eq!(i.last_snippet, None);
        let json = serde_json::to_value(&i).unwrap();
        assert_eq!(json["pending_approvals"], 0);
        assert!(json["last_outcome"].is_null());
    }
```

`mgr_one` 用到的本地 helper(字段列表照 `decide_spawn_tests::test_session()` `:4510-4540`,加 `posture`),放在 `mgr_one` 之前:

```rust
    fn base_session(id: &str, stype: SessionType) -> Session {
        Session {
            id: id.into(), name: "n".into(), session_type: stype, cols: 80, rows: 24,
            work_dir: "/tmp".into(), owner_id: "o".into(), description: String::new(),
            name_is_auto: true, status: SessionMeta::Idle, resume_token: None, tmux_origin: None,
            pending_kill_until: None, worktree_path: None, created_ms: 0, source_task_id: None,
            spawning: false, last_activity_ms: 0, turns_completed: 0, run_metrics: VecDeque::new(),
            lifetime_turns: 0, lifetime_duration_ms: 0, lifetime_cost_usd: 0.0, posture: Posture::default(),
            running: None, scrollback: VecDeque::new(), scrollback_bytes: 0,
        }
    }
```

(即 `let mut s = base_session("p", stype);`。)

- [ ] **Step 6: 运行确认失败**

Run: `cargo test posture_tests 2>&1 | tail -8`
Expected: 编译失败(`no field posture`、`record_and_broadcast` 参数个数、`settle_posture` 不存在)。

- [ ] **Step 7: 实现 Session 字段、导出、锁内维护**

1. `Session`(:297)在 `lifetime_cost_usd: f64,` 之后加:
   ```rust
       /// Triage "at a glance" fields (spec v3 M2). In-memory, lock-only.
       posture: Posture,
   ```
   然后对 `grep -n 'Session {$' src/session_manager.rs` 列出的**每一个** `Session { … }` 构造字面量(含 `:1143 :1261 :1606 :1709 :2253` 与全部测试 helper)在 `lifetime_cost_usd: …,` 后加 `posture: Posture::default(),`。以 `cargo build` 无 `missing field posture` 为准。

2. `SessionInfo`(:385)在 `peer_name` 后加:
   ```rust
       pub last_outcome: Option<&'static str>,
       pub last_outcome_ms: Option<i64>,
       pub last_snippet: Option<String>,
       pub current_step: Option<String>,
       pub pending_approvals: u32,
       pub lifetime_cost_usd: f64,
   ```
   `session_info_of`(:656)在 `peer_name: …,` 后加:
   ```rust
        last_outcome: s.posture.last_outcome.map(|o| match o {
            crate::run_metrics::RunOutcome::Completed => "completed",
            crate::run_metrics::RunOutcome::Errored => "errored",
            crate::run_metrics::RunOutcome::Timeout => "timeout",
            crate::run_metrics::RunOutcome::Cancelled => "cancelled",
        }),
        last_outcome_ms: s.posture.last_outcome_ms,
        last_snippet: s.posture.last_snippet.clone(),
        current_step: s.posture.current_step.clone(),
        pending_approvals: s.posture.approval_ids.len() as u32,
        lifetime_cost_usd: s.lifetime_cost_usd,
   ```
   另一处构造 `SessionInfo` 的地方(:2430 附近,host tmux 合并处)若为字面量,同样补齐(tmux 会话全部 `None`/`0`/`s.lifetime_cost_usd`)。

3. `record_and_broadcast`(:2025)签名改为 `fn record_and_broadcast(&self, id: &str, data: String, bump_activity: bool, delta: Option<PostureDelta>)`,在 `if bump_activity { … }` 之后加:
   ```rust
            if let Some(d) = delta {
                apply_posture_delta(&mut s.posture, d);
            }
   ```
   调用点:`:1034`(PTY)→ 末尾加 `, None`;`emit` 内(:3618)→ `m.record_and_broadcast(sid, json, bump_activity, posture_delta_of(evt));`;既有测试 `:5846 :5869 :5890 :5898` 末尾加 `, None`。

4. 在 `mark_turn`(:2089)之后加:
   ```rust
    /// A turn truly settled (not a Claude SkipBoundary): record its outcome and
    /// clear per-turn posture. Called beside `record_run_metric` in each fan-out.
    fn settle_posture(&self, sid: &str, outcome: crate::run_metrics::RunOutcome) {
        let mut map = self.sessions.lock().unwrap();
        if let Some(s) = map.get_mut(sid) {
            s.posture.last_outcome = Some(outcome);
            s.posture.last_outcome_ms = Some(now_millis());
            s.posture.current_step = None;
            s.posture.approval_ids.clear();
        }
    }

    /// The browser answered one Crew approval (the Gateway sends no receipt).
    fn approval_resolved(&self, sid: &str, approval_id: &str) {
        let mut map = self.sessions.lock().unwrap();
        if let Some(s) = map.get_mut(sid) {
            s.posture.approval_ids.retain(|x| x != approval_id);
        }
    }
   ```

- [ ] **Step 8: 三个 fan-out 接入 settle 与审批回执**

在三个 fan-out 里 `let settled = turn_starts.settle();` 之后(:3016 Claude、:3846 Crew、:4142 Codex)已经算出了 `outcome`(`classify_outcome` 的结果,紧随其后一行)。在每处 `if let Some((started, _)) = settled {` **之前**加:

```rust
                                // Only the boundary that settles the LIVE turn updates posture;
                                // a stale boundary of a superseded interrupt-resend turn
                                // (boundary_count < turn_seq, clamped above) must not clear the
                                // new turn's current_step or stamp its outcome.
                                if boundary_count >= turn_seq {
                                    if let Some(m) = mgr.upgrade() {
                                        m.settle_posture(&sid, outcome);
                                    }
                                }
```

该代码块位于 `if is_boundary && !skip_boundary`(Claude)/ `if is_boundary`(Crew、Codex)分支内,因此 Claude `SkipBoundary` 不会清空 `current_step`(M3);`boundary_count` 在上方(:2906 / :3816 / :4113)已被钳到 `turn_seq`,此处 `>=` 与 `mark_turn(Idle)` 的判定一致。打开这三处核对 `outcome` 变量名与作用域(Claude 在 :3018 `let outcome = crate::run_metrics::classify_outcome(`);若某处变量名不同,用该处实际名字。

Crew `SessionInput::Approval` 臂(:4007),在 `if let Err(e) = process.resolve_approval(...)` 之前加:

```rust
                            if let Some(m) = mgr.upgrade() {
                                m.approval_resolved(&sid, &approval_id);
                            }
```

进程退出路径:`s.running = None;`(:2635)所在函数在同一锁内加 `s.posture.current_step = None; s.posture.approval_ids.clear();`。

- [ ] **Step 9: 运行全部 Rust 测试**

Run: `cargo test 2>&1 | tail -5`
Expected: 全绿(原 532 + 新 9)。

- [ ] **Step 10: 前端类型 + CLAUDE.md**

`frontend/src/lib/api/sessions.ts` 的 `SessionInfo` 在 `peer_name?: string | null` 后加:

```ts
  // Triage posture (spec v3 M8). All reset to null/0 on a backend restart.
  last_outcome?: RunOutcome | null
  last_outcome_ms?: number | null
  last_snippet?: string | null
  current_step?: string | null
  pending_approvals?: number
  lifetime_cost_usd?: number
```

`RunOutcome` 定义在同文件 :133,TS 允许先用后定义(类型提升)。项目根 `CLAUDE.md`:把「three AI agent CLIs (Claude Code, Kiro, Codex)」改为「three AI agent backends (Claude Code, Codex, Crew)」;「The three agent backends」一节删除 **Kiro** 条目,补一句「**Crew** (`crew_process.rs`): Gateway WebSocket; approvals via `SessionInput::Approval` → `POST /api/approvals/{id}/{action}`.」;`SessionType` 描述改为 `Tmux`/`Claude`/`Codex`/`Crew`。

Run: `cd frontend && npx tsc -b && npm test 2>&1 | tail -3`
Expected: 通过。

- [ ] **Step 11: Commit**

```bash
git add src/session_manager.rs frontend/src/lib/api/sessions.ts CLAUDE.md
git commit -m "feat(sessions): triage posture fields maintained at the emit chokepoint (3 fan-outs)"
```

---

### Task 4: App 级 characterization 测试(对旧 App 写)

**Files:**
- Create: `frontend/src/test/xtermMock.ts`、`frontend/src/test/appHarness.tsx`
- Create: `frontend/src/__tests__/App.characterization.test.tsx`

**Interfaces:**
- Produces: `setupApp(opts?: { sessions?: SessionInfo[] }): { ws: ReturnType<typeof installFakeWebSocket>; list: MockInstance; del: MockInstance; setSessions(s: SessionInfo[]): void }`;`mkSession(id: string, over?: Partial<SessionInfo>): SessionInfo`;`test/xtermMock.ts` 导出 `xtermInstances: unknown[]`(每次 `new Terminal()` push,供 I-1 断言)与 `xtermModule`/`fitModule`/`webglModule`/`searchModule`/`clipboardModule`。**`vi.mock` 只能写在测试文件里**(vitest 只提升测试文件自身的 `vi.mock`),测试文件用 `vi.mock('@xterm/xterm', async () => (await import('../test/xtermMock')).xtermModule)` 形式引用。
- Produces(测试契约,Task 11 必须原样通过):五个 `describe`:`I-1 switching keeps views mounted`、`I-2 poll never moves focus`、`I-3 auth errors`、`I-17 deep links`、`I-18 undo close toast`。测试只通过**可见文本 / role / aria-label** 与 `data-session-pane="<id>"` 属性定位会话层——Task 11 的 AppShell 必须在每个会话层根元素上保留 `data-session-pane`。

- [ ] **Step 1: 给旧 App 的会话层加定位属性(唯一允许的旧 App 改动)**

`frontend/src/App.tsx` 会话层 `<div key={s.id} className={`absolute inset-0 ${isActive ? '' : 'hidden'}`}>`(约 :454)改为:

```tsx
              <div key={s.id} data-session-pane={s.id} data-active={isActive ? '1' : '0'} className={`absolute inset-0 ${isActive ? '' : 'hidden'}`}>
```

- [ ] **Step 2: 写 xterm mock 与 harness**

`frontend/src/test/xtermMock.ts`(沿用 `TerminalView.mobileLayout.test.tsx:5-14` 的 mock 形态,补 I-1 计数):

```ts
export const xtermInstances: unknown[] = []
const disp = { dispose() {} }
export const xtermModule = {
  Terminal: class {
    cols = 80; rows = 24; options: Record<string, unknown> = {}
    element = document.createElement('div')
    buffer = { active: { length: 0, getLine: () => undefined, viewportY: 0, baseY: 0 } }
    constructor() { xtermInstances.push(this) }
    open() {} write() {} reset() {} focus() {} blur() {} dispose() {} clear() {} scrollToBottom() {} refresh() {} resize() {}
    loadAddon() {} attachCustomKeyEventHandler() {}
    onData() { return disp } onResize() { return disp } onSelectionChange() { return disp } onScroll() { return disp } onRender() { return disp }
    hasSelection() { return false } getSelection() { return '' }
  },
}
export const fitModule = { FitAddon: class { fit() {} proposeDimensions() { return { cols: 80, rows: 24 } } activate() {} dispose() {} } }
export const webglModule = { WebglAddon: class { onContextLoss() { return disp } activate() {} dispose() {} } }
export const searchModule = { SearchAddon: class { activate() {} dispose() {} findNext() { return false } findPrevious() { return false } clearDecorations() {} } }
export const clipboardModule = { ClipboardAddon: class { activate() {} dispose() {} } }
```

若 TerminalView 调用了上面没有的 Terminal 方法(测试报 `is not a function`),按报错名补一个空方法。

`frontend/src/test/appHarness.tsx`:

```tsx
import { vi } from 'vitest'
import * as api from '../lib/api'
import type { SessionInfo } from '../lib/api'
import { installFakeWebSocket } from './fakeWs'

export function mkSession(id: string, over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id, name: `s-${id}`, type: 'claude', cols: 80, rows: 24, work_dir: `/w/${id}`, description: '',
    status: 'idle', running: true, turn_state: 'idle', turn_started_ms: null, last_activity_ms: 1,
    turns_completed: 0, tmux_name: null, tmux_origin: null, other_clients: 0, peer_name: null,
    last_outcome: null, last_outcome_ms: null, last_snippet: null, current_step: null,
    pending_approvals: 0, lifetime_cost_usd: 0, ...over,
  }
}

export function setupApp(opts: { sessions?: SessionInfo[] } = {}) {
  let current = opts.sessions ?? [mkSession('a'), mkSession('b', { type: 'tmux', tmux_name: 'zmx-b', tmux_origin: 'own' })]
  const ws = installFakeWebSocket()
  vi.spyOn(api, 'checkAuth').mockResolvedValue({ id: 'u', login: 'u', avatar: null, role: 'admin', status: 'active' } as api.UserInfo)
  const list = vi.spyOn(api, 'listSessionsWithHost').mockImplementation(async () => ({ sessions: current, host_tmux: [] }))
  vi.spyOn(api, 'listSessions').mockImplementation(async () => current)
  vi.spyOn(api, 'listConfirmations').mockResolvedValue({ runs: [], count: 0 })
  vi.spyOn(api, 'getSchedulerHealth').mockResolvedValue({ heartbeat_ms: 1, healthy: true })
  vi.spyOn(api, 'getVaultMeta').mockResolvedValue({ enabled: false, name: '' })
  vi.spyOn(api, 'listQuickTargets').mockResolvedValue({ top: [] })
  vi.spyOn(api, 'listPrompts').mockResolvedValue([])
  vi.spyOn(api, 'getSessionRuns').mockResolvedValue({ runs: [], stats: null, lifetime: { turns: 0, duration_ms: 0, cost_usd: 0 } } as never)
  vi.spyOn(api, 'getSessionStatus').mockResolvedValue({ work_dir: '/w', git_branch: 'main', git_dirty: 0, is_git: true })
  const del = vi.spyOn(api, 'deleteSession').mockResolvedValue({ pending_until: Date.now() + 5000 })
  vi.spyOn(api, 'closeCheck').mockResolvedValue(null)
  globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
  return { ws, list, del, setSessions: (s: SessionInfo[]) => { current = s } }
}
```

说明:若 `getSessionRuns` 的返回类型字段名不同,以 `lib/api/sessions.ts:171` 的实际返回类型为准调整 mock(`as never` 仅为少写字段)。若某个被 App / Sidebar / TerminalView 挂载时调用的 api 函数未 mock 导致测试报网络错误,把它加进本 harness(按报错函数名 `vi.spyOn(api, '<name>')`)。

- [ ] **Step 3: 写 characterization 测试**

`frontend/src/__tests__/App.characterization.test.tsx`:

```tsx
import { render, screen, act, waitFor, fireEvent } from 'testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setupApp, mkSession } from '../test/appHarness'
import { xtermInstances } from '../test/xtermMock'
import * as api from '../lib/api'
import App from '../App'

vi.mock('@xterm/xterm', async () => (await import('../test/xtermMock')).xtermModule)
vi.mock('@xterm/addon-fit', async () => (await import('../test/xtermMock')).fitModule)
vi.mock('@xterm/addon-webgl', async () => (await import('../test/xtermMock')).webglModule)
vi.mock('@xterm/addon-search', async () => (await import('../test/xtermMock')).searchModule)
vi.mock('@xterm/addon-clipboard', async () => (await import('../test/xtermMock')).clipboardModule)

const pane = (id: string) => document.querySelector(`[data-session-pane="${id}"]`) as HTMLElement | null
const activePane = () => document.querySelector('[data-session-pane][data-active="1"]')?.getAttribute('data-session-pane')

async function boot(sessions = [mkSession('a'), mkSession('b', { type: 'tmux', tmux_name: 'zmx-b', tmux_origin: 'own' })]) {
  const h = setupApp({ sessions })
  render(<App />)
  await waitFor(() => expect(pane(sessions[0].id)).not.toBeNull())
  return h
}

async function selectSession(name: string) {
  // Works for both the old Sidebar row and the new TriageRow: both render the session name as clickable text.
  fireEvent.click((await screen.findAllByText(name))[0])
}

describe('App characterization', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    xtermInstances.length = 0
    history.replaceState(null, '', '/')
    localStorage.clear()
  })
  afterEach(() => { vi.useRealTimers() })

  describe('I-1 switching keeps views mounted', () => {
    it('switching sessions does not recreate xterm nor reconnect WS', async () => {
      const h = await boot()
      const wsBefore = h.ws.all.length
      const termBefore = xtermInstances.length
      await selectSession('s-b')
      await waitFor(() => expect(activePane()).toBe('b'))
      await selectSession('s-a')
      await waitFor(() => expect(activePane()).toBe('a'))
      expect(h.ws.all.length).toBe(wsBefore)
      expect(xtermInstances.length).toBe(termBefore)
      expect(pane('b')).not.toBeNull()   // hidden, still mounted
    })
  })

  describe('I-2 poll never moves focus', () => {
    it('a poll that reorders / prepends sessions keeps activeId', async () => {
      const h = await boot()
      await selectSession('s-b')
      await waitFor(() => expect(activePane()).toBe('b'))
      h.setSessions([mkSession('z', { last_activity_ms: 999 }), mkSession('b', { type: 'tmux', tmux_name: 'zmx-b', tmux_origin: 'own' }), mkSession('a')])
      await act(async () => { vi.advanceTimersByTime(3100) })
      await waitFor(() => expect(pane('z')).not.toBeNull())
      expect(activePane()).toBe('b')
    })
  })

  describe('I-3 auth errors', () => {
    it('poll 5xx keeps the user in; poll 401 logs out', async () => {
      const h = await boot()
      h.list.mockRejectedValueOnce(new api.ApiError(503))
      await act(async () => { vi.advanceTimersByTime(3100) })
      expect(pane('a')).not.toBeNull()
      h.list.mockRejectedValue(new api.ApiError(401))
      await act(async () => { vi.advanceTimersByTime(3100) })
      await waitFor(() => expect(pane('a')).toBeNull())
      expect(document.querySelector('input[type="password"]')).not.toBeNull()
    })
  })

  describe('I-17 deep links', () => {
    it('?session= selects that session on startup', async () => {
      history.replaceState(null, '', '/?session=b')
      await boot()
      await waitFor(() => expect(activePane()).toBe('b'))
    })
  })

  describe('I-18 undo close toast', () => {
    it('closing shows an undo toast that ends ~500ms before pending_until', async () => {
      const h = await boot([mkSession('a'), mkSession('c')])
      const now = Date.now()
      h.del.mockResolvedValue({ pending_until: now + 5000 })
      // Old UI: row ⋯ → 关闭. New UI (Task 11): same aria-label + same item label.
      fireEvent.click(screen.getAllByRole('button', { name: '会话菜单' })[0])
      fireEvent.click(await screen.findByRole('menuitem', { name: '关闭' }))
      expect(await screen.findByText(/已关闭/)).toBeInTheDocument()
      await act(async () => { vi.advanceTimersByTime(4400) })
      expect(screen.queryByText(/已关闭/)).not.toBeNull()
      await act(async () => { vi.advanceTimersByTime(300) })
      await waitFor(() => expect(screen.queryByText(/已关闭/)).toBeNull())
    })
  })
})
```

注意:`undoCloseToast` 的文案以 `lib/undoCloseToast.ts` 实际 `message` 为准——若不是「已关闭…」,把两处 `/已关闭/` 改为实际文案的正则。`Menu` 的项 role 以 `components/ui/Menu.tsx` 实际渲染为准(若是 `role="menuitem"` 则如上)。

- [ ] **Step 4: 运行,确认对旧 App 全绿**

Run: `cd frontend && npx vitest run src/__tests__/App.characterization.test.tsx`
Expected: 5 passed。若某条失败,**修测试而不是修 App**(这是对现状的描述),除非失败揭示真实 bug——那种情况停下报告。

- [ ] **Step 5: 验红(每条至少一次)**

逐条临时破坏被测逻辑,确认对应测试变红,再恢复:
- I-2:临时在 `App.tsx` 轮询 tick 里加 `setActiveId(r.sessions[0]?.id ?? null)` → I-2 红。
- I-3:临时把 poll catch 改成无条件登出 → I-3 红。
- I-1:临时把会话层 `sessions.map` 的 `key={s.id}` 改 `key={s.id + (isActive ? 'a' : 'i')}` → I-1 红。
- I-17:临时注释 `?session=` effect → I-17 红。
- I-18:临时把 `- 500` 改 `+ 2000` → I-18 红。

Run 每次:`npx vitest run src/__tests__/App.characterization.test.tsx`;全部恢复后再跑一次全绿。

- [ ] **Step 6: Commit**

```bash
git add frontend/src/test/xtermMock.ts frontend/src/test/appHarness.tsx frontend/src/__tests__/App.characterization.test.tsx frontend/src/App.tsx
git commit -m "test(app): characterization for I-1/I-2/I-3/I-17/I-18 against the current shell"
```

---

### Task 5: `useAcpSocket` 搬迁 + `sessionControls` 扩展

**Files:**
- Create: `frontend/src/components/__tests__/acpSocket.characterization.test.tsx`
- Create: `frontend/src/hooks/useAcpSocket.ts`
- Create: `frontend/src/lib/sessionControls.ts`
- Modify: `frontend/src/components/AcpChatView.tsx`(WS effect :333-419、`handleEvent` :421-669、`sendPrompt` :705-737、`interrupt` :754-760、`setQueueMode` :762-776、`resolveApproval` :305-310、`settleActiveTurn` :316-321、注册 effect :778-783)
- Modify: `frontend/src/App.tsx:59-65`(类型改用 `SessionControls`)

**Interfaces:**
- Produces:
  ```ts
  // lib/sessionControls.ts
  export interface PendingApproval { id: string; tool: string; purpose?: string }
  export interface SessionControls {
    setQueueMode(mode: string): void
    sendPrompt(text: string): boolean
    /** false = socket not OPEN; nothing sent, local state untouched. */
    interrupt(): boolean
    /** false = socket not OPEN; nothing sent, approval NOT marked resolved. */
    resolveApproval(id: string, action: 'approve' | 'reject'): boolean
    /** Unresolved approvals in this session's live transcript (for inline triage). */
    pendingApprovals(): PendingApproval[]
  }
  export type RegisterControls = (sid: string, api: SessionControls | null) => void
  export function useControlsRegistry(): { controls: React.RefObject<Record<string, SessionControls>>; register: RegisterControls }
  ```
  ```ts
  // hooks/useAcpSocket.ts
  export interface AcpSocketOptions {
    sessionId: string
    onQueueModeChange?: (sid: string, mode: string) => void
    /** Called right after events are appended; AcpChatView scrolls here. force = user's own send. */
    onAppend?: (force: boolean) => void
    /** onopen: AcpChatView arms its replay-scroll window here. NB a brand-new session
     *  never gets replay_done (ws_handler.rs:120), so the window stays armed — existing
     *  behaviour, preserved as-is. */
    onOpen?: () => void
    /** replay_done: AcpChatView runs its bottom-stick + follow here. */
    onReplayDone?: () => void
    /** Pending attachments are owned by the view; the hook reads them at send time. */
    getPending: () => string[]
    clearPending: () => void
  }
  // The three callbacks are held in refs synced every render (same idiom as the
  // existing onQueueModeChangeRef), so the WS effect keeps its [sessionId]-only deps
  // and handleEvent keeps its current useCallback capture semantics (analysis D2).
  export function useAcpSocket(o: AcpSocketOptions): {
    events: WireEvent[]; notices: Notice[]; pushNotice(n: Notice): void
    busy: boolean; turnStartedMs: number | null; lastEventMs: number | null; nowMs: number
    queuedCount: number; wsStatus: { status: WsStatus; since: number }
    ctxUsage: { used: number; total: number } | null
    resolvedApprovals: Record<string, 'approve' | 'reject'>
    metricsRefresh: number
    sendPrompt(text: string): boolean
    setQueueMode(mode: string): void
    interrupt(): boolean
    resolveApproval(id: string, action: 'approve' | 'reject'): boolean
  }
  export interface Notice { id: string; kind: 'system' | 'error'; text: string }
  export const newId: () => string
  ```

- [ ] **Step 0: `fakeWs` 支持真实的连接态(代码分析 §3.7-10)**

现 `test/fakeWs.ts` 构造即 `readyState=1`、`close()` 不触发 `onclose`,onopen 清空这类行为测不出来。给 `installFakeWebSocket` 加可选参数,**默认值保持现状**(既有测试零改动):

```ts
export function installFakeWebSocket(opts: { startConnecting?: boolean } = {}): { latest: () => FakeSocket; all: FakeSocket[] } {
```

类内:`readyState = opts.startConnecting ? 0 : 1`;`close()` 改为 `close() { const was = this.readyState; this.readyState = 3; if (opts.startConnecting && was !== 3) this.onclose?.() }`(仅新模式下同步回调,旧模式行为不变)。

Run: `cd frontend && npm test 2>&1 | tail -3` → 全绿(旧测试未受影响)。

- [ ] **Step 1: 写 characterization 测试(对现 AcpChatView)**

`frontend/src/components/__tests__/acpSocket.characterization.test.tsx`:

```tsx
import { render, screen, act, fireEvent } from 'testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import AcpChatView from '../AcpChatView'
import { installFakeWebSocket } from '../../test/fakeWs'
import type { SessionControls } from '../../lib/sessionControls'

describe('AcpChatView WS characterization (spec S3 §3.1)', () => {
  const origWs = (globalThis as unknown as { WebSocket?: unknown }).WebSocket
  let ws: ReturnType<typeof installFakeWebSocket>
  let controls: SessionControls | null = null
  const reg = (_: string, api: SessionControls | null) => { controls = api }
  const mount = (extra: Record<string, unknown> = {}) =>
    render(<AcpChatView sessionId="s1" active agentType="claude" onRegisterControls={reg} {...extra} />)

  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    ws = installFakeWebSocket({ startConnecting: true })
    controls = null
    globalThis.fetch = vi.fn(async () => new Response('{"runs":[],"lifetime":{"turns":0,"duration_ms":0,"cost_usd":0}}', { status: 200 })) as unknown as typeof fetch
  })
  afterEach(() => { vi.useRealTimers(); (globalThis as unknown as { WebSocket?: unknown }).WebSocket = origWs })

  it('1. onopen clears transcript, notices and busy (I-5)', () => {
    mount()
    const s = ws.latest()
    act(() => { s.fireOpen() })
    act(() => { s.emit({ type: 'content_block', block_type: 'text', text: 'old reply', turn_id: 1 }) })
    act(() => { s.emit({ type: 'error', message: 'boom' }) })
    expect(screen.getByText('old reply')).toBeInTheDocument()
    act(() => { s.fireOpen() })   // reconnect → server will replay
    expect(screen.queryByText('old reply')).toBeNull()
    expect(screen.queryByText('boom')).toBeNull()
    expect(screen.queryByText('中断')).toBeNull()
  })

  it('2. replay_done adopts backend running + queue_mode + silence baseline (I-5/I-6/I-7)', () => {
    const onQ = vi.fn()
    mount({ onQueueModeChange: onQ })
    const s = ws.latest()
    act(() => { s.fireOpen() })
    act(() => { s.emit({ type: 'replay_done', running: true, queue_mode: 'interrupt', last_activity_ms: Date.now() - 200_000 }) })
    expect(onQ).toHaveBeenCalledWith('s1', 'interrupt')
    expect(screen.getByText('中断')).toBeInTheDocument()
    expect(screen.getByText(/已静默 \d+s，可能卡住/)).toBeInTheDocument()
  })

  it('2b. brand-new session: no replay_done is ever sent (ws_handler.rs:120) — sending still works', () => {
    mount()
    const s = ws.latest()
    expect(s.readyState).toBe(0)
    let r = true
    act(() => { r = controls!.sendPrompt('early') })
    expect(r).toBe(false)                    // CONNECTING is not OPEN
    act(() => { s.fireOpen() })
    act(() => { r = controls!.sendPrompt('hi') })
    expect(r).toBe(true)
    expect(screen.getByText('中断')).toBeInTheDocument()
  })

  it('3. optimistic bubble is re-slotted by client_id on echo, not duplicated (I-10)', () => {
    mount()
    const s = ws.latest()
    act(() => { s.fireOpen() })
    act(() => { controls!.sendPrompt('hello there') })
    const sent = JSON.parse(s.sent.find(x => x.includes('"prompt"'))!)
    act(() => { s.emit({ type: 'user_prompt', text: 'hello there', turn_id: 7, client_id: sent.client_id }) })
    expect(screen.getAllByText('hello there')).toHaveLength(1)
  })

  it('4. reconnect backoff 1s,2s,4s,8s,10s,10s and resets after 3s stable (I-4)', async () => {
    mount()
    const delays = [1000, 2000, 4000, 8000, 10000, 10000]
    for (const d of delays) {
      const s = ws.latest()
      act(() => { s.fireClose() })
      const n = ws.all.length
      await act(async () => { vi.advanceTimersByTime(d - 10) })
      expect(ws.all.length).toBe(n)
      await act(async () => { vi.advanceTimersByTime(20) })
      expect(ws.all.length).toBe(n + 1)
    }
    act(() => { ws.latest().fireOpen() })
    await act(async () => { vi.advanceTimersByTime(3100) })
    act(() => { ws.latest().fireClose() })
    const n = ws.all.length
    await act(async () => { vi.advanceTimersByTime(1010) })
    expect(ws.all.length).toBe(n + 1)
  })

  it('5. sendPrompt returns false while disconnected and sends nothing', () => {
    mount()
    const s = ws.latest()
    act(() => { s.fireOpen() })
    act(() => { s.fireClose() })
    let r = true
    act(() => { r = controls!.sendPrompt('x') })
    expect(r).toBe(false)
    expect(s.sent.filter(x => x.includes('"prompt"'))).toHaveLength(0)
  })

  it('6. ConnectionBar since survives a failed retry', async () => {
    mount()
    const a = ws.latest()
    act(() => { a.fireOpen() })
    act(() => { a.fireClose() })
    await act(async () => { vi.advanceTimersByTime(1000) })
    act(() => { ws.latest().fireClose() })
    await act(async () => { vi.advanceTimersByTime(600) })
    expect(screen.getByText('连接断开,正在重连…')).toBeInTheDocument()
  })

  it('7. interrupt/resolveApproval return false when closed and leave state alone', () => {
    mount({ agentType: 'crew' })
    const s = ws.latest()
    act(() => { s.fireOpen() })
    act(() => { s.emit({ type: 'system', subtype: 'queued', count: 2 }) })
    act(() => { s.emit({ type: 'approval', approval_id: 'ap1', tool: 'rm -rf', tool_purpose: 'cleanup', turn_id: 1 }) })
    act(() => { s.fireClose() })
    let r1 = true, r2 = true
    act(() => { r1 = controls!.interrupt(); r2 = controls!.resolveApproval('ap1', 'approve') })
    expect(r1).toBe(false)
    expect(r2).toBe(false)
    expect(screen.getByText(/已排队 2 条/)).toBeInTheDocument()
    expect(screen.getByTestId('approval-approve')).toBeInTheDocument()
    expect(controls!.pendingApprovals()).toEqual([{ id: 'ap1', tool: 'rm -rf', purpose: 'cleanup' }])
  })

  it('8. open socket: interrupt/resolveApproval send and return true', () => {
    mount({ agentType: 'crew' })
    const s = ws.latest()
    act(() => { s.fireOpen() })
    act(() => { s.emit({ type: 'approval', approval_id: 'ap1', tool: 't', turn_id: 1 }) })
    let r = false
    act(() => { r = controls!.resolveApproval('ap1', 'reject') })
    expect(r).toBe(true)
    expect(s.sent.some(x => x.includes('"approval"') && x.includes('ap1'))).toBe(true)
    expect(controls!.pendingApprovals()).toEqual([])
    act(() => { r = controls!.interrupt() })
    expect(r).toBe(true)
    expect(s.sent.some(x => x.includes('"interrupt"'))).toBe(true)
  })
})
```

- [ ] **Step 2: 创建 `lib/sessionControls.ts`**

```ts
import { useCallback, useRef } from 'react'

export interface PendingApproval { id: string; tool: string; purpose?: string }

/** WS-only controls each mounted agent view registers, keyed by session id, so
 *  shell-level UI (triage row actions, FocusHeader, SendToMenu) can drive a
 *  session without opening another socket (a new WS triggers a full replay). */
export interface SessionControls {
  setQueueMode(mode: string): void
  sendPrompt(text: string): boolean
  /** false = socket not OPEN; nothing sent, local state untouched. */
  interrupt(): boolean
  /** false = socket not OPEN; nothing sent, approval NOT marked resolved. */
  resolveApproval(id: string, action: 'approve' | 'reject'): boolean
  pendingApprovals(): PendingApproval[]
}

export type RegisterControls = (sid: string, api: SessionControls | null) => void

export function useControlsRegistry() {
  const controls = useRef<Record<string, SessionControls>>({})
  const register = useCallback<RegisterControls>((sid, api) => {
    if (api) controls.current[sid] = api
    else delete controls.current[sid]
  }, [])
  return { controls, register }
}
```

- [ ] **Step 3: 运行测试,确认 7、8 失败,1–6 通过**

Run: `cd frontend && npx vitest run src/components/__tests__/acpSocket.characterization.test.tsx`
Expected: 1–6 PASS(描述现状);7、8 FAIL(`interrupt` 返回 undefined / `pendingApprovals` 不存在)。若 1–6 有失败,先修测试直到它们准确描述现状(**不改 AcpChatView**)。

- [ ] **Step 4: 先让 7、8 在 AcpChatView 内通过(行为改动,最小)**

在 `AcpChatView.tsx`:

```tsx
  const resolveApproval = useCallback((approvalId: string, action: 'approve' | 'reject'): boolean => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return false
    wsRef.current.send(JSON.stringify({ type: 'approval', approval_id: approvalId, action }))
    setResolvedApprovals(prev => (prev[approvalId] ? prev : { ...prev, [approvalId]: action }))
    return true
  }, [])
```

```tsx
  const interrupt = useCallback((): boolean => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return false
    wsRef.current.send(JSON.stringify({ type: 'interrupt' }))
    // Backend clears the pending collect queue on interrupt (E5); mirror locally.
    setQueuedCount(0)
    return true
  }, [])
```

`pendingApprovals`:用 ref 镜像最新 `events` 与 `resolvedApprovals`,避免注册 effect 每个事件重跑:

```tsx
  const eventsRef = useRef<WireEvent[]>([])
  useEffect(() => { eventsRef.current = events }, [events])
  const resolvedRef = useRef(resolvedApprovals)
  useEffect(() => { resolvedRef.current = resolvedApprovals }, [resolvedApprovals])
  const pendingApprovals = useCallback((): PendingApproval[] =>
    eventsRef.current
      .filter(e => e.type === 'content_block' && e.block_type === 'approval' && e.approval_id && !resolvedRef.current[e.approval_id])
      .map(e => ({ id: e.approval_id!, tool: e.name ?? '', ...(e.summary ? { purpose: e.summary } : {}) })),
  [])
```

注册 effect 改为 `onRegisterControls?.(sessionId, { setQueueMode, sendPrompt, interrupt, resolveApproval, pendingApprovals })`,deps 加 `interrupt, resolveApproval, pendingApprovals`。`Props.onRegisterControls` 类型改为 `RegisterControls`(从 `lib/sessionControls` import)。`App.tsx:61-65` 的 `sessionControls` / `registerControls` 类型改为 `Record<string, SessionControls>` / `RegisterControls`(暂不改用 `useControlsRegistry`,Task 11 再换)。内部「中断」按钮 `onClick={interrupt}` 不变(返回值忽略)。

Run: `npx vitest run src/components/__tests__/acpSocket.characterization.test.tsx && npm test 2>&1 | tail -3`
Expected: 8 passed;全量绿。

- [ ] **Step 5: Commit(行为改动单独提交)**

```bash
git add frontend/src/lib/sessionControls.ts frontend/src/components/AcpChatView.tsx frontend/src/App.tsx frontend/src/components/__tests__/acpSocket.characterization.test.tsx
git commit -m "feat(acp): interrupt/resolveApproval report delivery; expose pendingApprovals via sessionControls"
```

- [ ] **Step 6: 只搬不改 —— 抽出 `hooks/useAcpSocket.ts`**

把以下内容**原样**移入 `useAcpSocket`(保留全部注释):`events`/`seenClientIds`/`notices`/`busy`/`wsStatus`/`queuedCount`/`turnStartedMs`/`activeTurnIdRef`/`lastEventMs`/`nowMs`/`metricsRefresh`+`bumpMetrics`/`ctxUsage`/`resolvedApprovals`/`wsRef`/`busyRef`/`queueModeRef`/`onQueueModeChangeRef`/`adoptQueueMode`/`pushNotice`/`appendEvent`/`resolveApproval`/`settleActiveTurn`/WS effect/`handleEvent`/`sendPrompt`/busy-ticker effect/`interrupt`/`setQueueMode`/`metricsDebounce` 卸载清理;`newId` 与 `Notice` 类型一并移入并 export。

边界替换(仅此四处,其余一字不改):
- `appendEvent` 内 `scrollBottom(force)` → `onAppendRef.current?.(force)`;`pushNotice` 内 `scrollBottom()` → `onAppendRef.current?.(false)`。(`onAppendRef`/`onOpenRef`/`onReplayDoneRef` 都用 `useRef` + 每渲染同步的 effect,与既有 `onQueueModeChangeRef` 同构。)
- `ws.onopen` 末尾两行 `replayingRef.current = true; userScrolledUpRef.current = false` → `onOpenRef.current?.()`。
- `replay_done` 分支里从 `const el = scrollRef.current` 到 `replayingRef.current = false` 的滚动块 → `onReplayDoneRef.current?.()`。
- `sendPrompt` 里 `pending` → `o.getPending()`;`setPending([])` → `o.clearPending()`;deps 去掉 `pending`(用 `getPendingRef`)。

AcpChatView 保留:滚动 refs(`scrollRef`/`replayingRef`/`followingRef`/`userScrolledUpRef`/`roRef`/`roTimerRef`)、`scrollBottom`、记忆 popover 全部(含 `memReqRef`,它调用 hook 返回的 `pushNotice`)、preset popover、上传/`pending`、lifetime fetch(用 hook 的 `metricsRefresh`)、渲染。AcpChatView 中:

```tsx
  const onReplayDone = useCallback(() => {
    const el = scrollRef.current
    // (moved verbatim from the replay_done branch — keep every comment)
    ...
    replayingRef.current = false
  }, [])
  const sock = useAcpSocket({
    sessionId, onQueueModeChange,
    onAppend: scrollBottom,
    onOpen: () => { replayingRef.current = true; userScrolledUpRef.current = false },
    onReplayDone,
    getPending: () => pendingRef.current, clearPending: () => setPending([]),
  })
```

(`pendingRef` = `useRef(pending)` + 同步 effect。)`pendingApprovals` 留在 AcpChatView(读 `sock.events`/`sock.resolvedApprovals` 的 ref 镜像)。

- [ ] **Step 7: 验证只搬不改**

Run: `cd frontend && npm test 2>&1 | tail -3 && npx tsc -b && npm run lint 2>&1 | tail -3`
Expected: 全绿,测试文件零改动(`git diff --stat -- 'frontend/src/**/__tests__/**'` 为空)。

- [ ] **Step 8: Commit**

```bash
git add frontend/src/hooks/useAcpSocket.ts frontend/src/components/AcpChatView.tsx
git commit -m "refactor(acp): move WS lifecycle into useAcpSocket (no behaviour change)"
```

---

### Task 6: `StatusDot` primitive

**Files:**
- Create: `frontend/src/components/ui/StatusDot.tsx`
- Modify: `frontend/src/components/ui/index.ts`
- Modify: `frontend/src/index.css`(呼吸动画 keyframes,尊重 `prefers-reduced-motion`)
- Test: `frontend/src/components/ui/__tests__/StatusDot.test.tsx`

**Interfaces:**
- Produces: `export type DotTone = 'danger' | 'stuck' | 'attention' | 'running' | 'muted'`;`export function StatusDot({ tone, label, shape }: { tone: DotTone; label: string; shape?: 'dot' | 'diamond' }): JSX.Element` —— 渲染 `<span role="img" aria-label={label} data-tone={tone} data-shape=…>`;`attention` 默认 `diamond`,其余 `dot`;`muted` 为空心环;`danger` 实心 + 内白点;`stuck` 实心 + 静态外环;`running` 实心 + `.dot-breathe`。

- [ ] **Step 1: 写失败测试**

```tsx
import { render, screen } from 'testing-library/react'
import { describe, it, expect } from 'vitest'
import { StatusDot } from '../StatusDot'

describe('StatusDot', () => {
  it('exposes an accessible label and tone', () => {
    render(<StatusDot tone="danger" label="出错" />)
    const el = screen.getByRole('img', { name: '出错' })
    expect(el.dataset.tone).toBe('danger')
  })
  it('attention defaults to diamond; others are dots', () => {
    const { rerender } = render(<StatusDot tone="attention" label="待审批" />)
    expect(screen.getByRole('img').dataset.shape).toBe('diamond')
    rerender(<StatusDot tone="running" label="运行中" />)
    expect(screen.getByRole('img').dataset.shape).toBe('dot')
    expect(screen.getByRole('img').className).toMatch(/dot-breathe/)
  })
  it('muted is a hollow ring (no fill)', () => {
    render(<StatusDot tone="muted" label="空闲" />)
    expect(screen.getByRole('img').className).toMatch(/border/)
    expect(screen.getByRole('img').className).not.toMatch(/bg-\[var\(--fg-subtle\)\]/)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd frontend && npx vitest run src/components/ui/__tests__/StatusDot.test.tsx`
Expected: FAIL `Cannot find module '../StatusDot'`

- [ ] **Step 3: 实现**

`frontend/src/components/ui/StatusDot.tsx`:

```tsx
export type DotTone = 'danger' | 'stuck' | 'attention' | 'running' | 'muted'

const FILL: Record<Exclude<DotTone, 'muted'>, string> = {
  danger: 'bg-[var(--danger)]',
  stuck: 'bg-[var(--stuck)]',
  attention: 'bg-[var(--attention)]',
  running: 'bg-[var(--running)]',
}

/** Five-state status mark (spec §3.1): shape AND colour differ so it still
 *  reads for colour-blind users. 8px visual, centered in a 12px box. */
export function StatusDot({ tone, label, shape }: { tone: DotTone; label: string; shape?: 'dot' | 'diamond' }) {
  const s = shape ?? (tone === 'attention' ? 'diamond' : 'dot')
  const base = 'relative inline-block shrink-0 w-2 h-2'
  const form = s === 'diamond' ? 'rotate-45 rounded-[1px]' : 'rounded-full'
  const look = tone === 'muted'
    ? 'border border-[var(--fg-subtle)]'
    : `${FILL[tone]}${tone === 'running' ? ' dot-breathe' : ''}${tone === 'stuck' ? ' ring-2 ring-[var(--stuck)]/35' : ''}`
  return (
    <span role="img" aria-label={label} title={label} data-tone={tone} data-shape={s} className={`${base} ${form} ${look}`}>
      {tone === 'danger' && <span aria-hidden className="absolute inset-[2.5px] rounded-full bg-[var(--surface-1)]" />}
    </span>
  )
}
```

`index.ts` 加 `export { StatusDot, type DotTone } from './StatusDot'`。`index.css` 末尾加:

```css
keyframes dot-breathe { 0%, 100% { opacity: 1 } 50% { opacity: .5 } }
.dot-breathe { animation: dot-breathe 1.6s ease-in-out infinite; }
media (prefers-reduced-motion: reduce) { .dot-breathe { animation: none; } }
```

- [ ] **Step 4: 运行通过 + lint**

Run: `npx vitest run src/components/ui/__tests__/StatusDot.test.tsx && npm run lint 2>&1 | tail -3`
Expected: 3 passed;棘轮不增。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ui/StatusDot.tsx frontend/src/components/ui/index.ts frontend/src/index.css frontend/src/components/ui/__tests__/StatusDot.test.tsx
git commit -m "feat(ui): StatusDot — five tones, shape + colour"
```

---

### Task 7: 分诊纯函数 —— `triage` / `readState` / `nextNeedsYou`

**Files:**
- Create: `frontend/src/lib/triage.ts`、`frontend/src/lib/readState.ts`
- Test: `frontend/src/lib/__tests__/triage.test.ts`、`frontend/src/lib/__tests__/readState.test.ts`

**Interfaces:**
- Consumes: `SessionInfo`(Task 3 字段)、`STUCK_SILENCE_MS`(`lib/stuck.ts:3`)、`DotTone`(Task 6)。
- Produces:
  ```ts
  // lib/triage.ts
  export type Attention = 'error' | 'approval' | 'stuck' | 'confirm' | 'done_unread' | 'running' | 'idle' | 'ended'
  export interface TriageCtx { now: number; activeId: string | null; lastViewedMs: Record<string, number>; confirmsBySession: Record<string, number> }
  export function triage(s: SessionInfo, ctx: TriageCtx): Attention
  export const NEEDS_YOU: ReadonlySet<Attention>          // error, approval, stuck, confirm, done_unread
  export function toneOf(a: Attention): DotTone
  export function labelOf(a: Attention): string           // 出错 / 待审批 / 可能卡住 / 待确认 / 完成·未读 / 运行中 / 空闲 / 已结束
  export interface TriageItem { s: SessionInfo; attention: Attention; eventMs: number }
  export interface TriageGroups { needsYou: TriageItem[]; running: TriageItem[]; idle: TriageItem[] }
  export function groupTriage(sessions: SessionInfo[], ctx: TriageCtx): TriageGroups
  export function nextNeedsYou(groups: TriageGroups, currentId: string | null): string | null
  export function needsYouCount(groups: TriageGroups): number
  ```
  ```ts
  // lib/readState.ts
  export const READ_KEY = 'zmx_read'
  export function loadLastViewed(): Record<string, number>
  /** Baseline unseen sids at `now`, GC sids no longer listed. Returns the same object when nothing changed. */
  export function reconcileLastViewed(prev: Record<string, number>, sids: string[], now: number): Record<string, number>
  export function markViewed(prev: Record<string, number>, sid: string, now: number): Record<string, number>
  export function saveLastViewed(m: Record<string, number>): void
  ```

- [ ] **Step 1: 写 `readState` 失败测试**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { loadLastViewed, reconcileLastViewed, markViewed, saveLastViewed, READ_KEY } from '../readState'

describe('readState (spec v3 M10)', () => {
  beforeEach(() => localStorage.clear())
  it('baselines unseen sids at now and GCs vanished ones', () => {
    const r = reconcileLastViewed({ gone: 5, a: 10 }, ['a', 'b'], 100)
    expect(r).toEqual({ a: 10, b: 100 })
  })
  it('returns the same object when nothing changed (no re-render churn)', () => {
    const prev = { a: 10 }
    expect(reconcileLastViewed(prev, ['a'], 100)).toBe(prev)
  })
  it('markViewed only moves forward', () => {
    expect(markViewed({ a: 50 }, 'a', 40)).toEqual({ a: 50 })
    expect(markViewed({ a: 50 }, 'a', 60)).toEqual({ a: 60 })
  })
  it('round-trips through localStorage and survives garbage', () => {
    saveLastViewed({ a: 1 })
    expect(loadLastViewed()).toEqual({ a: 1 })
    localStorage.setItem(READ_KEY, '{not json')
    expect(loadLastViewed()).toEqual({})
    localStorage.setItem(READ_KEY, JSON.stringify({ a: 'x', b: 2 }))
    expect(loadLastViewed()).toEqual({ b: 2 })
  })
})
```

- [ ] **Step 2: 实现 `readState.ts`**

```ts
// Persisted "last time I looked at this session" (spec v3 M10). Timestamps,
// not turn counts: turns_completed resets to 0 on every backend restart, which
// would make a persisted count exceed it forever and hide new completions.
export const READ_KEY = 'zmx_read'

export function loadLastViewed(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(READ_KEY) ?? '{}')
    if (!raw || typeof raw !== 'object') return {}
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(raw)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    return out
  } catch { return {} }
}

export function reconcileLastViewed(prev: Record<string, number>, sids: string[], now: number): Record<string, number> {
  const keep = new Set(sids)
  let changed = Object.keys(prev).some(k => !keep.has(k))
  const next: Record<string, number> = {}
  for (const id of sids) {
    if (id in prev) next[id] = prev[id]
    else { next[id] = now; changed = true }
  }
  return changed ? next : prev
}

export function markViewed(prev: Record<string, number>, sid: string, now: number): Record<string, number> {
  return (prev[sid] ?? 0) >= now ? prev : { ...prev, [sid]: now }
}

export function saveLastViewed(m: Record<string, number>): void {
  try { localStorage.setItem(READ_KEY, JSON.stringify(m)) } catch { /* quota / private mode */ }
}
```

Run: `npx vitest run src/lib/__tests__/readState.test.ts` → 4 passed。

- [ ] **Step 3: 写 `triage` 失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { triage, groupTriage, nextNeedsYou, needsYouCount, toneOf, labelOf, type TriageCtx } from '../triage'
import type { SessionInfo } from '../api'

const NOW = 1_000_000_000
const s = (id: string, o: Partial<SessionInfo> = {}): SessionInfo => ({
  id, name: id, type: 'claude', cols: 80, rows: 24, work_dir: '/w', description: '', status: 'idle',
  running: true, turn_state: 'idle', turn_started_ms: null, last_activity_ms: NOW - 1000, turns_completed: 0,
  tmux_name: null, tmux_origin: null, other_clients: 0, last_outcome: null, last_outcome_ms: null,
  last_snippet: null, current_step: null, pending_approvals: 0, lifetime_cost_usd: 0, ...o,
})
const ctx = (o: Partial<TriageCtx> = {}): TriageCtx => ({ now: NOW, activeId: null, lastViewedMs: {}, confirmsBySession: {}, ...o })

describe('triage()', () => {
  it('error: last turn errored/timeout after last view', () => {
    expect(triage(s('a', { last_outcome: 'errored', last_outcome_ms: NOW - 10 }), ctx({ lastViewedMs: { a: NOW - 20 } }))).toBe('error')
    expect(triage(s('a', { last_outcome: 'timeout', last_outcome_ms: NOW - 10 }), ctx({ lastViewedMs: { a: NOW - 20 } }))).toBe('error')
  })
  it('error already seen → idle', () => {
    expect(triage(s('a', { last_outcome: 'errored', last_outcome_ms: NOW - 30 }), ctx({ lastViewedMs: { a: NOW - 20 } }))).toBe('idle')
  })
  it('approval beats stuck (waiting on the user looks silent)', () => {
    const x = s('a', { turn_state: 'running', last_activity_ms: NOW - 400_000, pending_approvals: 1 })
    expect(triage(x, ctx())).toBe('approval')
  })
  it('stuck: running and silent past STUCK_SILENCE_MS', () => {
    expect(triage(s('a', { turn_state: 'running', last_activity_ms: NOW - 181_000 }), ctx())).toBe('stuck')
    expect(triage(s('a', { turn_state: 'running', last_activity_ms: NOW - 179_000 }), ctx())).toBe('running')
  })
  it('confirm: pending scheduled confirmation for this session', () => {
    expect(triage(s('a'), ctx({ confirmsBySession: { a: 2 } }))).toBe('confirm')
  })
  it('done_unread: completed after last view; not while running', () => {
    const done = s('a', { last_outcome: 'completed', last_outcome_ms: NOW - 10 })
    expect(triage(done, ctx({ lastViewedMs: { a: NOW - 20 } }))).toBe('done_unread')
    expect(triage({ ...done, turn_state: 'running', last_activity_ms: NOW }, ctx({ lastViewedMs: { a: NOW - 20 } }))).toBe('running')
  })
  it('no outcome known (fresh backend restart) is never unread/error', () => {
    expect(triage(s('a', { last_outcome: null, last_outcome_ms: null }), ctx({ lastViewedMs: {} }))).toBe('idle')
  })
  it('missing lastViewed entry means not yet baselined → not unread', () => {
    expect(triage(s('a', { last_outcome: 'completed', last_outcome_ms: NOW - 10 }), ctx({ lastViewedMs: {} }))).toBe('idle')
  })
  it('the active session never shows error/done_unread', () => {
    const x = s('a', { last_outcome: 'errored', last_outcome_ms: NOW - 10 })
    expect(triage(x, ctx({ activeId: 'a', lastViewedMs: { a: 0 } }))).toBe('idle')
  })
  it('cancelled outcome is not an error', () => {
    expect(triage(s('a', { last_outcome: 'cancelled', last_outcome_ms: NOW - 10 }), ctx({ lastViewedMs: { a: 0 } }))).toBe('idle')
  })
  it('ended: process not running', () => {
    expect(triage(s('a', { running: false, turn_state: null }), ctx())).toBe('ended')
  })
  it('tmux sessions are only running/idle/ended', () => {
    expect(triage(s('t', { type: 'tmux', last_outcome: 'errored', last_outcome_ms: NOW }), ctx({ lastViewedMs: { t: 0 } }))).toBe('idle')
  })
  it('tone and label cover all 8 states', () => {
    const all = ['error', 'approval', 'stuck', 'confirm', 'done_unread', 'running', 'idle', 'ended'] as const
    for (const a of all) { expect(toneOf(a)).toBeTruthy(); expect(labelOf(a)).toBeTruthy() }
    expect(toneOf('stuck')).toBe('stuck')
    expect(toneOf('error')).toBe('danger')
    expect(toneOf('done_unread')).toBe('attention')
  })
})

describe('groupTriage / next', () => {
  const list = [
    s('idle1', { last_activity_ms: NOW - 50 }),
    s('run1', { turn_state: 'running', turn_started_ms: NOW - 9000, last_activity_ms: NOW }),
    s('err', { last_outcome: 'errored', last_outcome_ms: NOW - 100 }),
    s('done', { last_outcome: 'completed', last_outcome_ms: NOW - 5 }),
    s('run2', { turn_state: 'running', turn_started_ms: NOW - 1000, last_activity_ms: NOW }),
    s('idle2', { last_activity_ms: NOW - 10 }),
  ]
  const c = ctx({ lastViewedMs: { err: 0, done: 0, idle1: 0, idle2: 0, run1: 0, run2: 0 } })

  it('groups and orders: needsYou by priority then recency; running longest first; idle by recency', () => {
    const g = groupTriage(list, c)
    expect(g.needsYou.map(i => i.s.id)).toEqual(['err', 'done'])
    expect(g.running.map(i => i.s.id)).toEqual(['run1', 'run2'])
    expect(g.idle.map(i => i.s.id)).toEqual(['idle2', 'idle1'])
    expect(needsYouCount(g)).toBe(2)
  })
  it('next: first needs-you after current, wrapping; null when empty', () => {
    const g = groupTriage(list, c)
    expect(nextNeedsYou(g, null)).toBe('err')
    expect(nextNeedsYou(g, 'err')).toBe('done')
    expect(nextNeedsYou(g, 'done')).toBe('err')
    expect(nextNeedsYou(g, 'run1')).toBe('err')
    expect(nextNeedsYou(groupTriage([s('x')], ctx({ lastViewedMs: { x: 0 } })), null)).toBeNull()
  })
  it('next skips the current session when it is the only needs-you item', () => {
    const g = groupTriage([s('only', { pending_approvals: 1 })], ctx())
    expect(nextNeedsYou(g, 'only')).toBeNull()
  })
})
```

- [ ] **Step 4: 实现 `triage.ts`**

```ts
import type { SessionInfo } from './api'
import type { DotTone } from '../components/ui/StatusDot'
import { STUCK_SILENCE_MS } from './stuck'

export type Attention = 'error' | 'approval' | 'stuck' | 'confirm' | 'done_unread' | 'running' | 'idle' | 'ended'

export interface TriageCtx {
  now: number
  activeId: string | null
  lastViewedMs: Record<string, number>
  confirmsBySession: Record<string, number>
}

export const NEEDS_YOU: ReadonlySet<Attention> = new Set(['error', 'approval', 'stuck', 'confirm', 'done_unread'])

const PRIORITY: Record<Attention, number> = { error: 0, approval: 1, stuck: 2, confirm: 3, done_unread: 4, running: 5, idle: 6, ended: 7 }

// Unread/error are "happened after I last looked". A missing lastViewed entry
// means the sid hasn't been baselined yet (first poll) — treat as seen.
function newerThanView(s: SessionInfo, ctx: TriageCtx): boolean {
  const seen = ctx.lastViewedMs[s.id]
  return s.last_outcome_ms != null && seen != null && s.last_outcome_ms > seen && s.id !== ctx.activeId
}

/** Spec v3 M12 order. Pure; the shell derives it on every poll. */
export function triage(s: SessionInfo, ctx: TriageCtx): Attention {
  if (!s.running) return 'ended'
  const running = s.turn_state === 'running'
  if (s.type === 'tmux') return running ? 'running' : 'idle'
  if (!running && (s.last_outcome === 'errored' || s.last_outcome === 'timeout') && newerThanView(s, ctx)) return 'error'
  if ((s.pending_approvals ?? 0) > 0) return 'approval'
  if (running && ctx.now - s.last_activity_ms > STUCK_SILENCE_MS) return 'stuck'
  if ((ctx.confirmsBySession[s.id] ?? 0) > 0) return 'confirm'
  if (!running && s.last_outcome === 'completed' && newerThanView(s, ctx)) return 'done_unread'
  return running ? 'running' : 'idle'
}

export function toneOf(a: Attention): DotTone {
  switch (a) {
    case 'error': return 'danger'
    case 'stuck': return 'stuck'
    case 'approval': case 'confirm': case 'done_unread': return 'attention'
    case 'running': return 'running'
    default: return 'muted'
  }
}

const LABELS: Record<Attention, string> = {
  error: '出错', approval: '待审批', stuck: '可能卡住', confirm: '待确认',
  done_unread: '完成·未读', running: '运行中', idle: '空闲', ended: '已结束',
}
export const labelOf = (a: Attention): string => LABELS[a]

export interface TriageItem { s: SessionInfo; attention: Attention; eventMs: number }
export interface TriageGroups { needsYou: TriageItem[]; running: TriageItem[]; idle: TriageItem[] }

export function groupTriage(sessions: SessionInfo[], ctx: TriageCtx): TriageGroups {
  const g: TriageGroups = { needsYou: [], running: [], idle: [] }
  for (const s of sessions) {
    const attention = triage(s, ctx)
    const eventMs = s.last_outcome_ms ?? s.last_activity_ms
    const item = { s, attention, eventMs }
    if (NEEDS_YOU.has(attention)) g.needsYou.push(item)
    else if (attention === 'running') g.running.push(item)
    else g.idle.push(item)
  }
  g.needsYou.sort((a, b) => PRIORITY[a.attention] - PRIORITY[b.attention] || b.eventMs - a.eventMs)
  g.running.sort((a, b) => (a.s.turn_started_ms ?? a.s.last_activity_ms) - (b.s.turn_started_ms ?? b.s.last_activity_ms))
  g.idle.sort((a, b) => b.s.last_activity_ms - a.s.last_activity_ms)
  return g
}

export function needsYouCount(g: TriageGroups): number { return g.needsYou.length }

/** Next needs-you session after `currentId` in queue order, wrapping; never returns currentId. */
export function nextNeedsYou(g: TriageGroups, currentId: string | null): string | null {
  const ids = g.needsYou.map(i => i.s.id).filter(id => id !== currentId)
  if (ids.length === 0) return null
  const all = g.needsYou.map(i => i.s.id)
  const at = currentId ? all.indexOf(currentId) : -1
  if (at === -1) return ids[0]
  for (let k = 1; k <= all.length; k++) {
    const id = all[(at + k) % all.length]
    if (id !== currentId) return id
  }
  return null
}
```

- [ ] **Step 5: 运行通过**

Run: `npx vitest run src/lib/__tests__/triage.test.ts src/lib/__tests__/readState.test.ts`
Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/triage.ts frontend/src/lib/readState.ts frontend/src/lib/__tests__/triage.test.ts frontend/src/lib/__tests__/readState.test.ts
git commit -m "feat(triage): pure attention model, grouping, next, timestamp-based read state"
```

---

### Task 8: `lib/steps.ts` 步骤模型

**Files:**
- Create: `frontend/src/lib/steps.ts`
- Test: `frontend/src/lib/__tests__/steps.test.ts`

**Interfaces:**
- Consumes: `Block`, `TurnGroup`(`lib/transcript.ts:24-47`)。
- Produces:
  ```ts
  export type StepKind = 'tool' | 'thinking' | 'text' | 'error' | 'approval'
  export interface Step {
    kind: StepKind
    name?: string; summary?: string; input?: unknown; result?: string
    status: 'running' | 'done' | 'error'
    text?: string; approvalId?: string
    /** thinking only: number of merged thinking blocks */
    count?: number
  }
  export function toSteps(blocks: Block[], complete: boolean): Step[]
  export function touchedFiles(steps: Step[]): { path: string; label: string }[]
  export function conclusion(group: TurnGroup): string
  export function stepCount(steps: Step[]): number     // tool + approval steps
  ```
  (耗时打点 `arrivals` 按 v3 §0.5.5 **不做**。)

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { toSteps, touchedFiles, conclusion, stepCount } from '../steps'
import type { Block, TurnGroup } from '../transcript'

const tu = (name: string, summary?: string, input?: unknown): Block => ({ type: 'tool_use', name, summary, input })
const tr = (name: string, text: string): Block => ({ type: 'tool_result', name, text })
const tx = (text: string): Block => ({ type: 'text', text })
const th = (text: string): Block => ({ type: 'thinking', text })
const grp = (blocks: Block[], complete = true): TurnGroup => ({
  turnId: 1, userPrompts: [], blocks, complete,
  assistantText() { return this.blocks.filter(b => b.type === 'text').map(b => b.text ?? '').join('') },
})

describe('toSteps', () => {
  it('Claude: no results — a tool step closes when the next step starts', () => {
    const st = toSteps([tu('Read', 'a.ts'), tu('Edit', 'a.ts'), tx('done')], true)
    expect(st.map(s => [s.kind, s.name, s.status])).toEqual([
      ['tool', 'Read', 'done'], ['tool', 'Edit', 'done'], ['text', undefined, 'done'],
    ])
  })
  it('running turn: the last open tool step stays running', () => {
    const st = toSteps([tu('Read', 'a.ts'), tu('Bash', 'npm test')], false)
    expect(st.map(s => s.status)).toEqual(['done', 'running'])
  })
  it('Codex/Crew: a result pairs with the most recent unpaired same-name step', () => {
    const st = toSteps([tu('shell', 'ls'), tr('shell', 'a\nb'), tu('apply_patch', 'x.rs'), tr('apply_patch', 'ok')], true)
    expect(st).toHaveLength(2)
    expect(st[0].result).toBe('a\nb')
    expect(st[1].result).toBe('ok')
  })
  it('same-name consecutive calls pair in order', () => {
    const st = toSteps([tu('shell', 'one'), tu('shell', 'two'), tr('shell', 'R2')], true)
    expect(st[0].result).toBeUndefined()
    expect(st[1].result).toBe('R2')
  })
  it('merges consecutive thinking into one collapsed step with a count (replaces density)', () => {
    const st = toSteps([th('a'), th('b'), tu('Read'), th('c')], true)
    expect(st[0]).toMatchObject({ kind: 'thinking', count: 2, text: 'a\n\nb' })
    expect(st[2]).toMatchObject({ kind: 'thinking', count: 1 })
  })
  it('error block is an inline error step, approval keeps its id', () => {
    const st = toSteps([{ type: 'error', text: 'transient' }, { type: 'approval', name: 'rm', summary: 'why', approvalId: 'a1' }], false)
    expect(st[0]).toMatchObject({ kind: 'error', status: 'error', text: 'transient' })
    expect(st[1]).toMatchObject({ kind: 'approval', approvalId: 'a1', name: 'rm', summary: 'why' })
  })
  it('stepCount counts tools and approvals only', () => {
    expect(stepCount(toSteps([th('x'), tu('Read'), tx('y'), { type: 'approval', approvalId: 'a' }], true))).toBe(2)
  })
})

describe('touchedFiles', () => {
  it('Edit/Write/MultiEdit/NotebookEdit use input paths; dedupe keeps order', () => {
    const st = toSteps([
      tu('Edit', 'x', { file_path: '/r/src/a.ts' }), tu('Write', 'x', { file_path: '/r/src/b.ts' }),
      tu('MultiEdit', 'x', { file_path: '/r/src/a.ts' }), tu('NotebookEdit', 'x', { notebook_path: '/r/n.ipynb' }),
    ], true)
    expect(touchedFiles(st).map(f => f.path)).toEqual(['/r/src/a.ts', '/r/src/b.ts', '/r/n.ipynb'])
    expect(touchedFiles(st)[0].label).toBe('src/a.ts')
  })
  it('apply_patch splits its summary on ", " only (paths may contain spaces)', () => {
    const st = toSteps([tu('apply_patch', 'src/x.rs, docs/my notes.md')], true)
    expect(touchedFiles(st).map(f => f.path)).toEqual(['src/x.rs', 'docs/my notes.md'])
  })
  it('orphan tool_result (Codex try_send dropped the use) is ignored, not crashed on', () => {
    expect(toSteps([tr('shell', 'out'), tx('ok')], true).map(s => s.kind)).toEqual(['text'])
  })
  it('other write-ish tools only when summary looks like a path', () => {
    const st = toSteps([tu('create_file', 'docs/a.md'), tu('str_replace', 'not a path here'), tu('Read', 'src/r.ts')], true)
    expect(touchedFiles(st).map(f => f.path)).toEqual(['docs/a.md'])
  })
})

describe('conclusion', () => {
  it('first paragraph of the last text step, capped at 600 chars', () => {
    expect(conclusion(grp([tx('early'), tu('Read'), tx('Fixed it.\n\nDetails follow')]))).toBe('Fixed it.')
    expect(conclusion(grp([tx('y'.repeat(900))])).length).toBe(600)
  })
  it('empty when there is no text', () => {
    expect(conclusion(grp([tu('Read')]))).toBe('')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/lib/__tests__/steps.test.ts` → FAIL(模块不存在)。

- [ ] **Step 3: 实现**

```ts
import type { Block, TurnGroup } from './transcript'

// Turn blocks → display steps (spec S3 §3.2). Pure. Pairing is positional:
// no backend carries a tool_use_id; Claude never sends tool_result at all.

export type StepKind = 'tool' | 'thinking' | 'text' | 'error' | 'approval'
export interface Step {
  kind: StepKind
  name?: string
  summary?: string
  input?: unknown
  result?: string
  status: 'running' | 'done' | 'error'
  text?: string
  approvalId?: string
  count?: number
}

export function toSteps(blocks: Block[], complete: boolean): Step[] {
  const out: Step[] = []
  const closeOpenTools = () => { for (const s of out) if (s.kind === 'tool' && s.status === 'running') s.status = 'done' }
  for (const b of blocks) {
    const last = out[out.length - 1]
    switch (b.type) {
      case 'tool_use':
        closeOpenTools()
        out.push({ kind: 'tool', name: b.name, summary: b.summary, input: b.input, status: 'running' })
        break
      case 'tool_result': {
        for (let i = out.length - 1; i >= 0; i--) {
          const s = out[i]
          if (s.kind === 'tool' && s.name === b.name && s.result === undefined) { s.result = b.text ?? ''; s.status = 'done'; break }
        }
        break
      }
      case 'thinking':
        if (last?.kind === 'thinking') { last.text = `${last.text}\n\n${b.text ?? ''}`; last.count = (last.count ?? 1) + 1 }
        else { closeOpenTools(); out.push({ kind: 'thinking', text: b.text ?? '', status: 'done', count: 1 }) }
        break
      case 'text':
        if (last?.kind === 'text') last.text = `${last.text}${b.text ?? ''}`
        else { closeOpenTools(); out.push({ kind: 'text', text: b.text ?? '', status: 'done' }) }
        break
      case 'error':
        out.push({ kind: 'error', text: b.text ?? '', status: 'error' })
        break
      case 'approval':
        out.push({ kind: 'approval', name: b.name, summary: b.summary, text: b.text, approvalId: b.approvalId, status: 'running' })
        break
    }
  }
  if (complete) for (const s of out) if (s.status === 'running') s.status = 'done'
  return out
}

export function stepCount(steps: Step[]): number {
  return steps.filter(s => s.kind === 'tool' || s.kind === 'approval').length
}

// Mirrors backend format.rs `shorten_path`: parent/name.
function shortLabel(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts.length <= 1 ? (parts[0] ?? p) : parts.slice(-2).join('/')
}
const looksLikePath = (s: string) => !/\s/.test(s) && (s.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(s))
const WRITE_ISH = /write|edit|patch|create_file|str_replace/i

export function touchedFiles(steps: Step[]): { path: string; label: string }[] {
  const seen = new Set<string>()
  const out: { path: string; label: string }[] = []
  const add = (p: string | undefined) => {
    const v = p?.trim()
    if (!v || seen.has(v)) return
    seen.add(v); out.push({ path: v, label: shortLabel(v) })
  }
  for (const s of steps) {
    if (s.kind !== 'tool' || !s.name) continue
    const input = (s.input ?? {}) as Record<string, unknown>
    if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(s.name)) {
      add(typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined)
    } else if (s.name === 'apply_patch') {
      // Codex joins changed paths with ", " (codex_process.rs); paths may contain spaces.
      for (const p of (s.summary ?? '').split(', ')) if (p.trim()) add(p)
    } else if (WRITE_ISH.test(s.name) && s.summary && looksLikePath(s.summary)) {
      add(s.summary)
    }
  }
  return out
}

export function conclusion(group: TurnGroup): string {
  const texts = toSteps(group.blocks, group.complete).filter(s => s.kind === 'text' && (s.text ?? '').trim())
  const last = texts[texts.length - 1]?.text ?? ''
  const para = last.trim().split(/\n\s*\n/)[0] ?? ''
  return [...para].slice(0, 600).join('')
}
```

注:`conclusion` 的 `[...para].slice(0, 600)` 按码点截断(多字节安全)。第二个 conclusion 测试用 ASCII,长度 600 断言成立。

- [ ] **Step 4: 运行通过**

Run: `npx vitest run src/lib/__tests__/steps.test.ts` → 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/steps.ts frontend/src/lib/__tests__/steps.test.ts
git commit -m "feat(steps): blocks → steps with positional tool pairing, touched files, conclusion"
```

---
### Task 9: 壳层纯函数 —— `fuzzy` / `paletteParse` / `sessionActions` / `sendTargets`

**Files:**
- Create: `frontend/src/lib/fuzzy.ts`、`frontend/src/lib/paletteParse.ts`、`frontend/src/lib/sessionActions.ts`、`frontend/src/lib/sendTargets.ts`
- Test: `frontend/src/lib/__tests__/{fuzzy,paletteParse,sessionActions,sendTargets}.test.ts`

**Interfaces:**
- Consumes: `SessionInfo`、`SessionType`、`HostTmux`、`attachCommand/copyText`(`lib/attachCommand.ts`)。
- Produces:
  ```ts
  // lib/fuzzy.ts — subsequence match; lower score = better; null = no match
  export function fuzzyScore(query: string, text: string): number | null
  export function rankBy<T>(query: string, items: T[], keys: (t: T) => string[]): T[]   // stable on ties; empty query → items unchanged

  // lib/paletteParse.ts — ⌘K new-session mode: "<type>? <dir-fragment> <prompt>?"
  export type NewType = SessionType | 'vault'
  export interface ParsedNew { type: NewType | null; dir: string; prompt: string; literalPath: boolean }
  export const TYPE_WORDS: Record<string, NewType>   // claude codex crew tmux term→tmux vault
  export function parseNew(input: string): ParsedNew
  export const LAST_TYPE_KEY = 'zmx_last_type'
  export function loadLastType(): SessionType            // default 'claude'
  export function saveLastType(t: SessionType): void

  // lib/sessionActions.ts — the ONE registry rendered by TriageRow ⋯, FocusHeader ⋯ and ⌘K actions (R23)
  export interface ActionEnv {
    rename(id: string): void          // opens the rename/description dialog
    close(id: string): void           // App's handleDelete (undo toast, I-18)
    openHistory(id: string): void     // tmux only
  }
  export interface SessionAction { id: 'copy-attach' | 'rename' | 'copy-peer' | 'history' | 'close'; label: string; danger?: boolean; run(): void | Promise<void> }
  export function sessionActions(s: SessionInfo, env: ActionEnv): SessionAction[]

  // lib/sendTargets.ts — SendToMenu candidates (S3 §2.4)
  export function sendTargets(sessions: SessionInfo[], workDir: string | null, excludeId?: string): SessionInfo[]
  ```

- [ ] **Step 1: 写失败测试**

`lib/__tests__/fuzzy.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { fuzzyScore, rankBy } from '../fuzzy'

describe('fuzzy', () => {
  it('subsequence, case-insensitive; contiguous and early beats scattered', () => {
    expect(fuzzyScore('zmx', 'zeromux')).not.toBeNull()
    expect(fuzzyScore('xyz', 'zeromux')).toBeNull()
    expect(fuzzyScore('API', 'api-refactor')!).toBeLessThan(fuzzyScore('api', 'my-cool-app-index')!)
    expect(fuzzyScore('', 'anything')).toBe(0)
  })
  it('handles CJK', () => { expect(fuzzyScore('重构', '接口重构')).not.toBeNull() })
  it('rankBy uses the best key and is stable on ties', () => {
    const items = [{ n: 'docs-sync', d: '/w/docs' }, { n: 'api', d: '/w/zeromux' }, { n: 'api2', d: '/w/x' }]
    expect(rankBy('zero', items, t => [t.n, t.d]).map(t => t.n)).toEqual(['api'])
    expect(rankBy('api', items, t => [t.n]).map(t => t.n)).toEqual(['api', 'api2'])
    expect(rankBy('', items, t => [t.n])).toBe(items)
  })
})
```

`lib/__tests__/paletteParse.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { parseNew, loadLastType, saveLastType } from '../paletteParse'

describe('parseNew', () => {
  it('type keyword, dir fragment, prompt', () => {
    expect(parseNew('codex zeromux fix the sidebar')).toEqual({ type: 'codex', dir: 'zeromux', prompt: 'fix the sidebar', literalPath: false })
  })
  it('no type keyword → type null (caller uses last type)', () => {
    expect(parseNew('zeromux')).toEqual({ type: null, dir: 'zeromux', prompt: '', literalPath: false })
  })
  it('term is an alias for tmux; vault takes no dir', () => {
    expect(parseNew('term docs').type).toBe('tmux')
    expect(parseNew('vault').type).toBe('vault')
  })
  it('literal path when the dir fragment starts with / or ~', () => {
    expect(parseNew('claude ~/s3-workspace/x do it')).toEqual({ type: 'claude', dir: '~/s3-workspace/x', prompt: 'do it', literalPath: true })
    expect(parseNew('/tmp').literalPath).toBe(true)
  })
  it('keyword is case-insensitive and only recognised as the first token', () => {
    expect(parseNew('Claude zeromux').type).toBe('claude')
    expect(parseNew('zeromux claude').type).toBeNull()
  })
  it('blank input', () => { expect(parseNew('   ')).toEqual({ type: null, dir: '', prompt: '', literalPath: false }) })
})

describe('last type', () => {
  beforeEach(() => localStorage.clear())
  it('defaults to claude, round-trips, rejects garbage', () => {
    expect(loadLastType()).toBe('claude')
    saveLastType('codex'); expect(loadLastType()).toBe('codex')
    localStorage.setItem('zmx_last_type', 'kiro'); expect(loadLastType()).toBe('claude')
  })
})
```

`lib/__tests__/sessionActions.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { sessionActions } from '../sessionActions'
import type { SessionInfo } from '../api'

const base = { id: 's', name: 'n', cols: 80, rows: 24, work_dir: '/w', description: '', status: 'idle', running: true,
  turn_state: 'idle', turn_started_ms: null, last_activity_ms: 0, turns_completed: 0, tmux_name: null, tmux_origin: null,
  other_clients: 0 } as const
const env = () => ({ rename: vi.fn(), close: vi.fn(), openHistory: vi.fn() })

describe('sessionActions', () => {
  it('tmux: copy attach, rename, history, close — in that order', () => {
    const ids = sessionActions({ ...base, type: 'tmux', tmux_name: 'zmx-1', tmux_origin: 'own' } as SessionInfo, env()).map(a => a.id)
    expect(ids).toEqual(['copy-attach', 'rename', 'history', 'close'])
  })
  it('claude with a peer name: rename, copy peer, close', () => {
    const ids = sessionActions({ ...base, type: 'claude', peer_name: 'zmx-ai-abc' } as SessionInfo, env()).map(a => a.id)
    expect(ids).toEqual(['rename', 'copy-peer', 'close'])
  })
  it('codex/crew: rename, close; close is danger and calls env.close', () => {
    const e = env()
    const acts = sessionActions({ ...base, type: 'codex' } as SessionInfo, e)
    expect(acts.map(a => a.id)).toEqual(['rename', 'close'])
    const close = acts.find(a => a.id === 'close')!
    expect(close.danger).toBe(true)
    close.run(); expect(e.close).toHaveBeenCalledWith('s')
  })
  it('labels: rename covers description', () => {
    expect(sessionActions({ ...base, type: 'crew' } as SessionInfo, env())[0].label).toBe('重命名 / 描述…')
  })
})
```

`lib/__tests__/sendTargets.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { sendTargets } from '../sendTargets'
import type { SessionInfo } from '../api'

const s = (id: string, type: SessionInfo['type'], work_dir: string, last: number): SessionInfo => ({
  id, name: id, type, cols: 80, rows: 24, work_dir, description: '', status: 'idle', running: true, turn_state: 'idle',
  turn_started_ms: null, last_activity_ms: last, turns_completed: 0, tmux_name: null, tmux_origin: null, other_clients: 0,
})

describe('sendTargets', () => {
  it('agents only; same work_dir first, then most recent; excludes self', () => {
    const list = [s('t', 'tmux', '/a', 99), s('x', 'codex', '/b', 50), s('y', 'claude', '/a', 10), s('z', 'crew', '/a', 30), s('me', 'claude', '/a', 100)]
    expect(sendTargets(list, '/a', 'me').map(t => t.id)).toEqual(['z', 'y', 'x'])
  })
  it('no work_dir: pure recency', () => {
    expect(sendTargets([s('a', 'claude', '/a', 1), s('b', 'codex', '/b', 2)], null).map(t => t.id)).toEqual(['b', 'a'])
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd frontend && npx vitest run src/lib/__tests__/fuzzy.test.ts src/lib/__tests__/paletteParse.test.ts src/lib/__tests__/sessionActions.test.ts src/lib/__tests__/sendTargets.test.ts`
Expected: 4 个文件均 FAIL(模块不存在)。

- [ ] **Step 3: 实现**

`lib/fuzzy.ts`:

```ts
// Tiny subsequence matcher for ⌘K (sessions/actions are in-memory; dirs/notes
// use the backend fuzzy index). Score: gaps between matched chars + start offset.
export function fuzzyScore(query: string, text: string): number | null {
  const q = [...query.trim().toLowerCase()]
  if (q.length === 0) return 0
  const t = [...text.toLowerCase()]
  let qi = 0, score = 0, last = -1, first = -1
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      if (first < 0) first = i
      if (last >= 0) score += i - last - 1
      last = i; qi++
    }
  }
  return qi === q.length ? score + first : null
}

export function rankBy<T>(query: string, items: T[], keys: (t: T) => string[]): T[] {
  if (!query.trim()) return items
  const scored: { t: T; s: number; i: number }[] = []
  items.forEach((t, i) => {
    let best: number | null = null
    for (const k of keys(t)) { const sc = fuzzyScore(query, k); if (sc != null && (best == null || sc < best)) best = sc }
    if (best != null) scored.push({ t, s: best, i })
  })
  return scored.sort((a, b) => a.s - b.s || a.i - b.i).map(x => x.t)
}
```

`lib/paletteParse.ts`:

```ts
import type { SessionType } from './api'

export type NewType = SessionType | 'vault'
export interface ParsedNew { type: NewType | null; dir: string; prompt: string; literalPath: boolean }

export const TYPE_WORDS: Record<string, NewType> = { claude: 'claude', codex: 'codex', crew: 'crew', tmux: 'tmux', term: 'tmux', vault: 'vault' }

/** Rule-based, no LLM (spec §4.6). The preview row is what disambiguates. */
export function parseNew(input: string): ParsedNew {
  const toks = input.trim().split(/\s+/).filter(Boolean)
  let type: NewType | null = null
  if (toks.length && TYPE_WORDS[toks[0].toLowerCase()]) type = TYPE_WORDS[toks.shift()!.toLowerCase()]
  const dir = toks.shift() ?? ''
  return { type, dir, prompt: toks.join(' '), literalPath: dir.startsWith('/') || dir.startsWith('~') }
}

export const LAST_TYPE_KEY = 'zmx_last_type'
const VALID: SessionType[] = ['claude', 'codex', 'crew', 'tmux']
export function loadLastType(): SessionType {
  try { const v = localStorage.getItem(LAST_TYPE_KEY); return VALID.includes(v as SessionType) ? (v as SessionType) : 'claude' } catch { return 'claude' }
}
export function saveLastType(t: SessionType): void { try { localStorage.setItem(LAST_TYPE_KEY, t) } catch { /* ignore */ } }
```

`lib/sessionActions.ts`:

```ts
import type { SessionInfo } from './api'
import { attachCommand, copyText } from './attachCommand'
import { toast } from '../components/ui/toast'

export interface ActionEnv { rename(id: string): void; close(id: string): void; openHistory(id: string): void }
export interface SessionAction { id: 'copy-attach' | 'rename' | 'copy-peer' | 'history' | 'close'; label: string; danger?: boolean; run(): void | Promise<void> }

/** The single session-action registry (spec R23): TriageRow ⋯, FocusHeader ⋯ and ⌘K all render this. */
export function sessionActions(s: SessionInfo, env: ActionEnv): SessionAction[] {
  const out: SessionAction[] = []
  if (s.tmux_name) out.push({ id: 'copy-attach', label: '复制接续命令', run: async () => {
    toast.push({ message: (await copyText(attachCommand(s.tmux_name!))) ? '已复制接续命令' : '复制失败' })
  } })
  out.push({ id: 'rename', label: '重命名 / 描述…', run: () => env.rename(s.id) })
  if (s.peer_name) out.push({ id: 'copy-peer', label: '复制 peer 名', run: async () => {
    toast.push({ message: (await copyText(s.peer_name!)) ? `已复制 ${s.peer_name}` : '复制失败' })
  } })
  if (s.tmux_name) out.push({ id: 'history', label: '查看历史', run: () => env.openHistory(s.id) })
  out.push({ id: 'close', label: '关闭', danger: true, run: () => env.close(s.id) })
  return out
}
```

`lib/sendTargets.ts`:

```ts
import type { SessionInfo } from './api'

/** SendToMenu candidates: agent sessions, same work_dir first, then most recently active. */
export function sendTargets(sessions: SessionInfo[], workDir: string | null, excludeId?: string): SessionInfo[] {
  return sessions
    .filter(s => s.type !== 'tmux' && s.id !== excludeId)
    .map((s, i) => ({ s, i, same: workDir != null && s.work_dir === workDir ? 0 : 1 }))
    .sort((a, b) => a.same - b.same || b.s.last_activity_ms - a.s.last_activity_ms || a.i - b.i)
    .map(x => x.s)
}
```

- [ ] **Step 4: 移植 `SessionRowMenu.test` 的断言到 `sessionActions.test`**

打开 `frontend/src/components/__tests__/SessionRowMenu.test.tsx`,对其每个 `it`(`:14 :24 :36`)在 `sessionActions.test.ts` 中确认有等价断言(菜单项集合 / 复制 toast 文案);`:36` 的「窄屏改名后焦点」语义属于 UI,记入 Task 11 Step「移植测试」清单。

- [ ] **Step 5: 运行通过**

Run: `npx vitest run src/lib/__tests__/fuzzy.test.ts src/lib/__tests__/paletteParse.test.ts src/lib/__tests__/sessionActions.test.ts src/lib/__tests__/sendTargets.test.ts`
Expected: 全 PASS。

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/fuzzy.ts frontend/src/lib/paletteParse.ts frontend/src/lib/sessionActions.ts frontend/src/lib/sendTargets.ts frontend/src/lib/__tests__/fuzzy.test.ts frontend/src/lib/__tests__/paletteParse.test.ts frontend/src/lib/__tests__/sessionActions.test.ts frontend/src/lib/__tests__/sendTargets.test.ts
git commit -m "feat(shell): fuzzy, ⌘K new-mode parser, session action registry, send targets"
```

---

### Task 10: 新 turn 呈现 —— TurnTimeline / TurnSummaryCard / TurnStatusBar(仍在旧壳内)

**Files:**
- Modify: `frontend/src/lib/transcript.ts`(`TurnGroup.errored`;`WireEvent.is_error`;`foldTranscript` 与 `groupSignature` 纳入)
- Modify: `frontend/src/hooks/useAcpSocket.ts`(`settleActiveTurn` 注入 `is_error: true`,仅 `error`/`exit` 分支)
- Create: `frontend/src/components/turn/StepRow.tsx`、`TurnTimeline.tsx`、`TurnSummaryCard.tsx`、`TurnView.tsx`、`TurnStatusBar.tsx`
- Modify: `frontend/src/components/AcpChatView.tsx`(`groups.map` 渲染改用 `TurnView`;busy 状态栏改用 `TurnStatusBar`;删除 density state / 提示条 / `TurnGroupView` / `BlockView` / `partitionBlocks` import;`nowMs` 与 1s ticker 迁入 `TurnStatusBar`)
- Delete: `frontend/src/lib/density.ts`、`frontend/src/components/__tests__/density.test.ts`
- Test: `frontend/src/components/turn/__tests__/TurnView.test.tsx`、`TurnStatusBar.test.tsx`;`frontend/src/components/__tests__/transcript.test.ts`(**追加**用例,不改旧用例)

**Interfaces:**
- Consumes: `toSteps/touchedFiles/conclusion/stepCount`(Task 8)、`formatCost/formatDuration`(`lib/format.ts`)、`StatusDot`(Task 6)、`MarkdownContent`。
- Produces:
  ```ts
  // transcript.ts additions
  interface WireEvent { …; is_error?: boolean }
  interface TurnGroup { …; errored?: boolean }
  // turn/TurnView.tsx
  export const TurnView: React.MemoExoticComponent<(p: {
    group: TurnGroup; agentName: string
    resolvedApprovals?: Record<string, 'approve' | 'reject'>
    onResolveApproval?: (id: string, action: 'approve' | 'reject') => void
    peerNames?: Record<string, string>
    /** Clicking a touched-file chip. Task 11 wires this to ContextPanel → Git「改动」. */
    onOpenChanges?: () => void
  }) => JSX.Element>
  // turn/TurnStatusBar.tsx — owns the 1s clock (audit §6.4)
  export function TurnStatusBar(p: { busy: boolean; turnStartedMs: number | null; lastEventMs: number | null; queuedCount: number; onInterrupt: () => void }): JSX.Element | null
  ```
  memo 比较器:`group`、`agentName`、`resolvedApprovals`、`onResolveApproval`、`peerNames`、`onOpenChanges` 全 `===`(I-9);展开态是 TurnView 内部 state。

- [ ] **Step 1: transcript 出错位 —— 失败测试**

在 `components/__tests__/transcript.test.ts` 末尾追加:

```ts
describe('foldTranscript — errored turn (M9d)', () => {
  it('a synthetic is_error result marks the group errored without adding text', () => {
    const g = foldTranscript([
      { type: 'content_block', block_type: 'text', text: 'working', turn_id: 3 },
      { type: 'result', turn_id: 3, text: '', is_error: true },
    ])[0]
    expect(g.complete).toBe(true)
    expect(g.errored).toBe(true)
    expect(g.blocks).toHaveLength(1)
  })
  it('stabilizeGroups sees the errored flip as a change', () => {
    const a = foldTranscript([{ type: 'content_block', block_type: 'text', text: 'x', turn_id: 1 }])
    const b = foldTranscript([{ type: 'content_block', block_type: 'text', text: 'x', turn_id: 1 }, { type: 'result', turn_id: 1, text: '', is_error: true }])
    expect(stabilizeGroups(a, b)[0]).not.toBe(a[0])
  })
})
```

Run: `npx vitest run src/components/__tests__/transcript.test.ts` → 新用例 FAIL。

- [ ] **Step 2: 实现出错位**

`transcript.ts`:`WireEvent` 加 `is_error?: boolean`;`TurnGroup` 加 `errored?: boolean`;`result` 分支在 `g.complete = true` 后加 `if (e.is_error) g.errored = true`;`groupSignature` 返回值前缀改为 `` `${g.complete ? 1 : 0}${g.errored ? 'E' : ''}#…` ``。
`useAcpSocket.ts` 的 `settleActiveTurn` 增加参数 `(isError = false)`,注入 `{ type: 'result', turn_id: tid, text: '', ...(isError ? { is_error: true } : {}) }`;`error` 与 `exit` 分支调用改为 `settleActiveTurn(true)`。

Run: `npx vitest run src/components/__tests__/transcript.test.ts && npm test 2>&1 | tail -3` → 全绿。

- [ ] **Step 3: TurnStatusBar —— 失败测试**

`components/turn/__tests__/TurnStatusBar.test.tsx`:

```tsx
import { render, screen, act, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TurnStatusBar } from '../TurnStatusBar'

describe('TurnStatusBar', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  it('renders nothing when idle and no queue', () => {
    const { container } = render(<TurnStatusBar busy={false} turnStartedMs={null} lastEventMs={null} queuedCount={0} onInterrupt={() => {}} />)
    expect(container.firstChild).toBeNull()
  })
  it('ticks its own elapsed clock and offers 中断', () => {
    const now = Date.now()
    const onI = vi.fn()
    render(<TurnStatusBar busy turnStartedMs={now} lastEventMs={now} queuedCount={0} onInterrupt={onI} />)
    act(() => { vi.advanceTimersByTime(3000) })
    expect(screen.getByText(/运行中 3s/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '中断' }))
    expect(onI).toHaveBeenCalled()
  })
  it('stuck after 180s of silence uses the stuck tone (not danger)', () => {
    const now = Date.now()
    render(<TurnStatusBar busy turnStartedMs={now - 300_000} lastEventMs={now - 200_000} queuedCount={0} onInterrupt={() => {}} />)
    const msg = screen.getByText(/已静默 \d+s，可能卡住/)
    expect(msg.className).toMatch(/--stuck/)
  })
  it('shows the collect queue hint (I-19)', () => {
    render(<TurnStatusBar busy turnStartedMs={Date.now()} lastEventMs={Date.now()} queuedCount={2} onInterrupt={() => {}} />)
    expect(screen.getByText('已排队 2 条，本轮结束后合并发送')).toBeInTheDocument()
  })
})
```

- [ ] **Step 4: 实现 TurnStatusBar**

```tsx
import { useEffect, useState } from 'react'
import { STUCK_SILENCE_MS } from '../../lib/stuck'
import { formatDuration } from '../../lib/format'

/** Busy/queue line above the composer. Owns the 1s clock so the conversation
 *  view no longer re-renders every second (audit §6.4). */
export function TurnStatusBar({ busy, turnStartedMs, lastEventMs, queuedCount, onInterrupt }: {
  busy: boolean; turnStartedMs: number | null; lastEventMs: number | null; queuedCount: number; onInterrupt: () => void
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!busy) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [busy, turnStartedMs, lastEventMs])
  if (!busy && queuedCount === 0) return null
  const elapsed = turnStartedMs ? Math.max(0, now - turnStartedMs) : 0
  const silence = lastEventMs != null ? Math.max(0, now - lastEventMs) : 0
  const stuck = busy && lastEventMs != null && silence > STUCK_SILENCE_MS
  return (
    <div className="px-2 pb-1 flex flex-col gap-0.5 text-ui-xs">
      {queuedCount > 0 && <span className="text-[var(--fg-subtle)]">已排队 {queuedCount} 条，本轮结束后合并发送</span>}
      {busy && (
        <div className="flex items-center gap-2">
          {stuck
            ? <span className="text-[var(--stuck)]">已静默 {Math.floor(silence / 1000)}s，可能卡住</span>
            : <span className="num text-[var(--fg-subtle)]">运行中 {formatDuration(elapsed) || '0s'}</span>}
          <button type="button" onClick={onInterrupt}
            className={`ctl px-3 rounded-[var(--r-md)] border text-ui-xs font-semibold ${stuck ? 'border-[var(--stuck)] text-[var(--stuck)]' : 'border-[var(--border)] text-[var(--fg-muted)] hover:text-[var(--fg)]'}`}>
            中断
          </button>
        </div>
      )}
    </div>
  )
}
```

说明:「已排队 N 条，本轮结束后合并发送」「已静默 Ns，可能卡住」两句文案(含全角逗号)**逐字保持**,使 `acpSocket.characterization` 第 2、7 条无需修改;「已运行 Ns…」改为「运行中 Ns」——若既有测试断言了「已运行」,以该测试为准保留原文案。

Run: `npx vitest run src/components/turn/__tests__/TurnStatusBar.test.tsx` → PASS。

- [ ] **Step 5: TurnView —— 失败测试**

`components/turn/__tests__/TurnView.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { TurnView } from '../TurnView'
import { foldTranscript, type WireEvent } from '../../../lib/transcript'

const fold = (ev: WireEvent[]) => foldTranscript(ev)[0]
const running = fold([
  { type: 'user_prompt', text: '修复 sidebar', turn_id: 1 },
  { type: 'content_block', block_type: 'tool_use', name: 'Read', summary: 'Sidebar.tsx', turn_id: 1 },
  { type: 'content_block', block_type: 'thinking', text: 'hmm', turn_id: 1 },
  { type: 'content_block', block_type: 'tool_use', name: 'Bash', summary: 'npx vitest run', turn_id: 1 },
])
const done = fold([
  { type: 'user_prompt', text: '修复 sidebar', turn_id: 1 },
  { type: 'content_block', block_type: 'tool_use', name: 'Edit', summary: 'x', input: { file_path: '/r/src/Sidebar.tsx' }, turn_id: 1 },
  { type: 'content_block', block_type: 'text', text: 'Fixed the double tap.\n\nMore detail.', turn_id: 1 },
  { type: 'result', turn_id: 1, text: 'Fixed the double tap.\n\nMore detail.', cost_usd: 0.4213 },
])

describe('TurnView', () => {
  it('running: timeline with one row per step, last tool running, thinking collapsed to one line', () => {
    render(<TurnView group={running} agentName="Claude" />)
    expect(screen.getByText('修复 sidebar')).toBeInTheDocument()
    expect(screen.getByText('Sidebar.tsx')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: '运行中' })).toBeInTheDocument()
    expect(screen.getByText('思考 · 1 段')).toBeInTheDocument()
    expect(screen.queryByText('hmm')).toBeNull()
  })
  it('complete: summary card with conclusion, touched file, steps and cost', () => {
    render(<TurnView group={done} agentName="Claude" />)
    expect(screen.getByText('Fixed the double tap.')).toBeInTheDocument()
    expect(screen.queryByText('More detail.')).toBeNull()
    expect(screen.getByRole('button', { name: 'src/Sidebar.tsx' })).toBeInTheDocument()
    expect(screen.getByText(/1 步/)).toBeInTheDocument()
    expect(screen.getByText('$0.4213')).toBeInTheDocument()
  })
  it('过程 ▾ expands the timeline in place; a file chip calls onOpenChanges', () => {
    const onOpen = vi.fn()
    render(<TurnView group={done} agentName="Claude" onOpenChanges={onOpen} />)
    fireEvent.click(screen.getByRole('button', { name: /过程/ }))
    expect(screen.getByText('Edit')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'src/Sidebar.tsx' }))
    expect(onOpen).toHaveBeenCalled()
  })
  it('a step the user expanded keeps the turn in timeline form after completion', () => {
    const { rerender } = render(<TurnView group={running} agentName="Claude" />)
    fireEvent.click(screen.getByText('npx vitest run'))
    rerender(<TurnView group={{ ...running, complete: true, assistantText: running.assistantText }} agentName="Claude" />)
    expect(screen.queryByRole('button', { name: /过程/ })).toBeNull()
    expect(screen.getByText('npx vitest run')).toBeInTheDocument()
  })
  it('errored turn: danger tint + error line, not a left border (V9)', () => {
    const g = fold([{ type: 'user_prompt', text: 'go', turn_id: 2 }, { type: 'content_block', block_type: 'text', text: 'partial', turn_id: 2 }, { type: 'result', turn_id: 2, text: '', is_error: true }])
    render(<TurnView group={g} agentName="Codex" />)
    const card = screen.getByTestId('turn-summary')
    expect(card.dataset.errored).toBe('1')
    expect(card.className).not.toMatch(/border-l/)
    expect(screen.getByText('本轮出错结束')).toBeInTheDocument()
  })
  it('approval step keeps the 44px approve/reject buttons and resolves via callback', () => {
    const onR = vi.fn()
    const g = fold([{ type: 'content_block', block_type: 'approval', approval_id: 'a1', name: 'rm -rf', summary: 'cleanup', turn_id: 3 }])
    render(<TurnView group={g} agentName="Crew" onResolveApproval={onR} />)
    fireEvent.click(screen.getByTestId('approval-approve'))
    expect(onR).toHaveBeenCalledWith('a1', 'approve')
    expect(screen.getByTestId('approval-approve').className).toMatch(/min-h-\[44px\]/)
  })
  it('peer prompt keeps its sender label', () => {
    const g = fold([{ type: 'peer_message', text: 'hi', from_name: 'zmx-ai-abc', turn_id: 4 }])
    render(<TurnView group={g} agentName="Claude" peerNames={{ 'zmx-ai-abc': 'docs' }} />)
    expect(screen.getByText(/来自 @docs/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 6: 实现 turn 组件**

`components/turn/StepRow.tsx`:

```tsx
import { useState } from 'react'
import { ChevronRight, Ban, Check, AlertCircle } from 'lucide-react'
import type { Step } from '../../lib/steps'
import { StatusDot } from '../ui'
import MarkdownContent from '../markdown/MarkdownContent'

const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…(已截断)` : s)

/** One step. Tools/thinking expand in place; JSON.stringify runs only when open. */
export function StepRow({ step, complete, decision, onResolve, onToggle }: {
  step: Step; complete: boolean
  decision?: 'approve' | 'reject'
  onResolve?: (id: string, a: 'approve' | 'reject') => void
  onToggle?: (open: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const toggle = () => { setOpen(o => { onToggle?.(!o); return !o }) }
  if (step.kind === 'text') return <div className="text-ui-base text-[var(--fg)] leading-relaxed"><MarkdownContent text={step.text ?? ''} isComplete={complete} /></div>
  if (step.kind === 'error') return (
    <div className="flex items-start gap-1.5 text-ui-xs text-[var(--danger)]"><AlertCircle size={13} className="shrink-0 mt-0.5" /><span>{step.text}</span></div>
  )
  if (step.kind === 'approval') return (
    <div className="rounded-[var(--r-md)] border border-[var(--attention)]/40 bg-[var(--attention)]/5 p-2 text-ui-xs">
      <div className="flex items-center gap-1.5 font-medium text-[var(--attention)]"><StatusDot tone="attention" label="待审批" />需要你批准<span className="text-[var(--fg)] font-normal truncate">· {step.name}</span></div>
      {step.summary && <p className="mt-1 text-[var(--fg-muted)] break-words">{step.summary}</p>}
      {step.text && <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--surface-2)] p-2 text-[var(--fg-muted)]">{cap(step.text, 2000)}</pre>}
      {decision ? <p className="mt-1.5 italic text-[var(--fg-subtle)]">{decision === 'approve' ? '已批准' : '已拒绝'}</p>
        : step.approvalId ? (
          <div className="mt-2 flex gap-2">
            <button data-testid="approval-reject" onClick={() => onResolve?.(step.approvalId!, 'reject')}
              className="flex-1 min-h-[44px] rounded-[var(--r-md)] border border-[var(--border)] text-[var(--fg-muted)] hover:text-[var(--danger)] inline-flex items-center justify-center gap-1"><Ban size={13} />拒绝</button>
            <button data-testid="approval-approve" onClick={() => onResolve?.(step.approvalId!, 'approve')}
              className="flex-1 min-h-[44px] rounded-[var(--r-md)] bg-[var(--success-solid)] text-[var(--on-accent)] inline-flex items-center justify-center gap-1"><Check size={13} />批准</button>
          </div>
        ) : <p className="mt-1.5 text-[var(--attention)]">审批 id 缺失,无法在此回答</p>}
    </div>
  )
  const isThinking = step.kind === 'thinking'
  return (
    <div className="text-ui-xs">
      <button type="button" onClick={toggle} aria-expanded={open}
        className="row w-full flex items-center gap-2 text-left text-[var(--fg-muted)] hover:text-[var(--fg)]">
        <ChevronRight size={12} className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        {isThinking
          ? <span className="italic text-[var(--fg-subtle)]">思考 · {step.count ?? 1} 段</span>
          : <>
              <StatusDot tone={step.status === 'running' ? 'running' : step.status === 'error' ? 'danger' : 'muted'} label={step.status === 'running' ? '运行中' : '完成'} />
              <span className="font-medium text-[var(--fg)]">{step.name ?? 'tool'}</span>
              {step.summary && <span className="truncate min-w-0">{step.summary}</span>}
            </>}
      </button>
      {open && (isThinking
        ? <div className="pl-5 pt-1 italic text-[var(--fg-subtle)] whitespace-pre-wrap">{step.text}</div>
        : <div className="pl-5 pt-1 space-y-1">
            {step.input != null && <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--surface-2)] p-2 text-[var(--fg-muted)]">{cap(JSON.stringify(step.input, null, 2), 2000)}</pre>}
            {step.result != null && <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--surface-2)] p-2 text-[var(--fg-muted)]">{cap(step.result, 4000)}</pre>}
          </div>)}
    </div>
  )
}
```

`components/turn/TurnTimeline.tsx`:

```tsx
import type { Step } from '../../lib/steps'
import { StepRow } from './StepRow'

export function TurnTimeline({ steps, complete, resolved, onResolve, onToggleStep }: {
  steps: Step[]; complete: boolean
  resolved?: Record<string, 'approve' | 'reject'>
  onResolve?: (id: string, a: 'approve' | 'reject') => void
  onToggleStep?: (open: boolean) => void
}) {
  return (
    <div className="space-y-1">
      {steps.map((s, i) => (
        <StepRow key={i} step={s} complete={complete} decision={s.approvalId ? resolved?.[s.approvalId] : undefined} onResolve={onResolve} onToggle={onToggleStep} />
      ))}
    </div>
  )
}
```

`components/turn/TurnSummaryCard.tsx`:

```tsx
import { ChevronDown } from 'lucide-react'
import MarkdownContent from '../markdown/MarkdownContent'
import { formatCost } from '../../lib/format'

export function TurnSummaryCard({ conclusionText, files, steps, cost, errored, onExpand, onOpenChanges }: {
  conclusionText: string; files: { path: string; label: string }[]; steps: number; cost?: number; errored?: boolean
  onExpand: () => void; onOpenChanges?: () => void
}) {
  const shown = files.slice(0, 3)
  return (
    <div data-testid="turn-summary" data-errored={errored ? '1' : '0'}
      className={`rounded-[var(--r-lg)] p-3 space-y-2 ${errored ? 'bg-[var(--danger)]/[0.04]' : 'bg-[var(--surface-2)]'}`}>
      {errored && <p className="text-ui-xs font-medium text-[var(--danger)]">本轮出错结束</p>}
      {conclusionText && <div className="text-ui-base text-[var(--fg)] leading-relaxed line-clamp-6"><MarkdownContent text={conclusionText} isComplete /></div>}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ui-xs text-[var(--fg-subtle)]">
        {shown.map(f => (
          <button key={f.path} type="button" onClick={onOpenChanges} aria-label={f.label}
            className="ctl px-2 rounded-[var(--r-sm)] bg-[var(--surface-3)] text-[var(--fg-muted)] hover:text-[var(--fg)]">{f.label}</button>
        ))}
        {files.length > 3 && <span>+{files.length - 3}</span>}
        <span className="num">{steps} 步</span>
        {cost != null && cost > 0 && <span className="num">{formatCost(cost, 'long')}</span>}
        <button type="button" onClick={onExpand} className="ml-auto ctl px-2 inline-flex items-center gap-1 text-[var(--fg-muted)] hover:text-[var(--fg)]">
          过程 <ChevronDown size={12} />
        </button>
      </div>
    </div>
  )
}
```

`components/turn/TurnView.tsx`:

```tsx
import { memo, useMemo, useState } from 'react'
import type { TurnGroup } from '../../lib/transcript'
import { toSteps, touchedFiles, conclusion, stepCount } from '../../lib/steps'
import { peerLabel } from '../../lib/peer'
import { TurnTimeline } from './TurnTimeline'
import { TurnSummaryCard } from './TurnSummaryCard'

type Props = {
  group: TurnGroup; agentName: string
  resolvedApprovals?: Record<string, 'approve' | 'reject'>
  onResolveApproval?: (id: string, action: 'approve' | 'reject') => void
  peerNames?: Record<string, string>
  onOpenChanges?: () => void
}

// Running → timeline; complete → summary card (S3 §3.3–3.4). If the user opened a
// step while it ran, keep the timeline so we don't yank what they're reading.
function TurnViewImpl({ group, agentName, resolvedApprovals, onResolveApproval, peerNames, onOpenChanges }: Props) {
  const steps = useMemo(() => toSteps(group.blocks, group.complete), [group])
  const [expanded, setExpanded] = useState(false)
  const [pinnedOpen, setPinnedOpen] = useState(false)
  const showCard = group.complete && !expanded && !pinnedOpen && steps.length > 0
  return (
    <div className="space-y-2">
      {group.userPrompts.map((p, i) => (
        <div key={p.clientId ?? i}>
          <p className={`text-ui-2xs font-semibold mb-0.5 ${p.fromName ? 'text-[var(--peer)]' : 'text-[var(--accent)]'}`}>
            {p.fromName ? `来自 @${peerLabel(p.fromName, peerNames ?? {})}` : 'You'}
          </p>
          <p className="text-ui-base text-[var(--fg)] whitespace-pre-wrap">{p.text}</p>
        </div>
      ))}
      {steps.length > 0 && (
        <div className="space-y-1">
          <p className="text-ui-2xs font-semibold text-[var(--peer)]">{agentName}</p>
          {showCard
            ? <TurnSummaryCard conclusionText={conclusion(group)} files={touchedFiles(steps)} steps={stepCount(steps)}
                cost={group.cost} errored={group.errored} onExpand={() => setExpanded(true)} onOpenChanges={onOpenChanges} />
            : <TurnTimeline steps={steps} complete={group.complete} resolved={resolvedApprovals} onResolve={onResolveApproval}
                onToggleStep={open => { if (open && !group.complete) setPinnedOpen(true) }} />}
          {group.complete && group.errored && !showCard && <p className="text-ui-xs text-[var(--danger)]">本轮出错结束</p>}
        </div>
      )}
    </div>
  )
}

export const TurnView = memo(TurnViewImpl, (a, b) =>
  a.group === b.group && a.agentName === b.agentName && a.resolvedApprovals === b.resolvedApprovals &&
  a.onResolveApproval === b.onResolveApproval && a.peerNames === b.peerNames && a.onOpenChanges === b.onOpenChanges)
```

注:errored 的 turn 若无任何 block(秒错),`steps.length === 0`,不渲染卡片——错误信息仍由既有 NoticeBubble 显示。所用 token(`--peer`、`--success-solid`、`--on-accent`、`--r-sm/md/lg`、`--surface-2/3`、`--stuck`)均已在 `index.css` 定义。

- [ ] **Step 7: 接入 AcpChatView,删除 density**

`AcpChatView.tsx`:
- `groups.map(g => <TurnGroupView … />)` 替换为:
  ```tsx
  {groups.map(g => (
    <TurnView key={g.turnId} group={g} agentName={agentName} resolvedApprovals={sock.resolvedApprovals}
      onResolveApproval={resolveApprovalVoid} peerNames={peerNames} onOpenChanges={onOpenChanges} />
  ))}
  ```
  其中 `const agentName = agentType === 'crew' ? 'Crew' : agentType === 'codex' ? 'Codex' : 'Claude'`;`resolveApprovalVoid = useCallback((id, a) => { sock.resolveApproval(id, a) }, [sock.resolveApproval])`(保持 identity 稳定,I-9);`Props` 增加可选 `onOpenChanges?: () => void`。
- 删除:`density`/`showDensityHint`/`dismissDensityHint`/`expandDensity` 与提示条 JSX;`TurnGroupViewImpl`/`TurnGroupView`/`BlockView`/`TOOL_ICONS`/`iconFor`;`partitionBlocks`/`Density` import;不再使用的 lucide 图标 import(`tsc -b` 报 unused 为准)。
- busy/queued 两块 JSX(「已排队…」与 `{busy && (…中断…)}`)替换为 `<TurnStatusBar busy={sock.busy} turnStartedMs={sock.turnStartedMs} lastEventMs={sock.lastEventMs} queuedCount={sock.queuedCount} onInterrupt={() => { sock.interrupt() }} />`;删除 AcpChatView 内 `elapsed`/`stuck`/`silenceSecs` 计算。`useAcpSocket` 里 1s busy-ticker 与 `nowMs` state 保留(characterization 仍读 `nowMs`;删除属于逻辑变化,不在本期)。
- 删除 `lib/density.ts` 与 `components/__tests__/density.test.ts`(其规则「thinking 折叠、tool raw input 默认隐藏」已由 Task 8 `merges consecutive thinking…` 与 Step 5 `thinking collapsed to one line` 覆盖)。

- [ ] **Step 8: 全量验证**

Run: `cd frontend && npm test 2>&1 | tail -3 && npx tsc -b && npm run lint 2>&1 | tail -3 && npm run build 2>&1 | tail -3`
Expected: 全绿(`crewEventCases` 的审批测试走 `StepRow` 的同 testid,文案「需要你批准」「已批准」「已拒绝」「审批 id 缺失…」保持);棘轮不增;体积 ≤ 330KB。若 `crewEventCases`/`acpConnection` 中有断言依赖旧 BlockView 的具体 DOM(如 `"You"` 标签),保持 TurnView 输出同样文本即可,**不改这些测试**。

- [ ] **Step 9: 截图 + Commit**

用 `node frontend/scripts/screens.mjs`(S1 T2 的隔离截图脚本,参数见其 `--help`)对「运行中 turn」「完成 turn」出 390×844 与 1440×900 暗/亮四张,存 `docs/superpowers/screens/s2s3/turn/`。

```bash
git add -A frontend/src/components/turn frontend/src/components/AcpChatView.tsx frontend/src/lib/transcript.ts frontend/src/hooks/useAcpSocket.ts frontend/src/components/__tests__/transcript.test.ts docs/superpowers/screens/s2s3/turn
git rm frontend/src/lib/density.ts frontend/src/components/__tests__/density.test.ts
git commit -m "feat(chat): turn timeline + summary card replace TurnGroupView/density; status bar owns the clock"
```

---

### Task 11: 壳切换 —— AppShell + 分诊 + ⌘K + FocusHeader + ContextPanel(**单个可 revert 提交**)

> 本 Task 的全部改动**在最后一步一次性提交**(中间 Step 只在工作区验证)。开始前 `git status` 必须干净。若中途需要中断,`git stash` 保存,**不要**提交半个壳。

**Files:**
- Create: `frontend/src/components/shell/useShellState.ts`、`useSessionsPoll.ts`、`AppShell.tsx`、`TriageHeader.tsx`、`TriageList.tsx`、`TriageRow.tsx`、`CommandPalette.tsx`、`FocusHeader.tsx`、`ContextPanel.tsx`、`RenameDialog.tsx`、`useNextKeys.ts`、`TypeIcon.tsx`
- Create tests: `frontend/src/components/shell/__tests__/{TriageList,CommandPalette,ContextPanel,FocusHeader,useNextKeys}.test.tsx`
- Modify: `frontend/src/App.tsx`(只剩认证分级 + `<AppShell/>`)、`frontend/src/components/AcpChatView.tsx`(删 `showMetrics`/`onOpenMemory` 以外的 overlay 耦合,见 Step 7)、`frontend/src/components/GitViewer.tsx`(仅加 `initialTab?: 'worktree' | 'history'` prop)、`frontend/src/components/__tests__/crewSessionType.test.tsx`(② 改读新文件)
- Delete: `Sidebar.tsx`、`SessionInfoBar.tsx`、`SessionRowMenu.tsx`、`__tests__/Sidebar.newflow.test.tsx`、`__tests__/Sidebar.search.test.tsx`、`__tests__/SessionInfoBar.queuemode.test.tsx`、`__tests__/SessionRowMenu.test.tsx`(**先**完成 Step 8 的移植)

**Interfaces:**
- Consumes: Task 3 字段;Task 5 `SessionControls`/`useControlsRegistry`;Task 6 `StatusDot`;Task 7 `groupTriage/nextNeedsYou/needsYouCount/toneOf/labelOf/loadLastViewed/reconcileLastViewed/markViewed/saveLastViewed`;Task 9 `rankBy/parseNew/loadLastType/saveLastType/sessionActions`;Task 2 的 lazy 引用;`usePathSearch`、`QuickTargets`、`SearchResults`、`useIsNarrow`、`useTheme`、`components/ui` 全部 primitives。
- Produces:
  ```ts
  // shell/useShellState.ts — everything App.tsx used to own, minus auth
  export function useShellState(authActive: boolean, onAuthLost: () => void): ShellState
  export interface ShellState {
    sessions: SessionInfo[]; hostTmux: HostTmux[]; docTabs: DocTab[]
    activeId: string | null; select(id: string | null): void          // also marks viewed
    lastViewedMs: Record<string, number>
    queueModes: Record<string, string>; onQueueModeChange(sid: string, mode: string): void
    confirmRuns: TaskRun[]; confirmsBySession: Record<string, number>; orphanConfirms: number; schedulerHealthy: boolean
    controls: React.RefObject<Record<string, SessionControls>>; registerControls: RegisterControls
    create(type: SessionType | 'vault', workDir?: string, tmuxTarget?: string, prompt?: string): Promise<void>
    close(id: string): Promise<void>; rename(id: string, name: string, description: string): Promise<void>
    openVault(t: { path: string; kind: 'note' | 'folder' }): void; docTargets: Record<string, { path: string; kind: 'note' | 'folder'; nonce: number }>
    closeDocTab(id: string): void; updateDocTabTitle(id: string, title: string | null): void
    historyReq: { id: string; nonce: number } | null; openHistory(id: string): void
    context: Record<string, { open: boolean; tab: ContextTab }>; setContext(sid: string, patch: Partial<{ open: boolean; tab: ContextTab }>): void
  }
  export type ContextTab = 'git' | 'files' | 'runs'
  // shell/ContextPanel.tsx
  export function ContextPanel(p: { session: SessionInfo; open: boolean; tab: ContextTab; onTab(t: ContextTab): void; onClose(): void; asSheet: boolean; onForward?: (t: string) => boolean }): JSX.Element
  // shell/CommandPalette.tsx
  export function CommandPalette(p: { open: boolean; onClose(): void; initial?: { mode: 'search' | 'new'; text?: string }; shell: ShellState; actions: PaletteAction[] }): JSX.Element
  export interface PaletteAction { id: string; label: string; run(): void }
  // DOM contract kept from Task 4: every session pane root has data-session-pane={id} data-active="1"|"0"
  ```

- [ ] **Step 1: `useShellState` + `useSessionsPoll`(把 App 的 state/effect 原样搬出)**

新建 `shell/useSessionsPoll.ts`,**原样**搬入 `App.tsx` 的:`loadSessions`(:113-130)、3s 轮询 effect(:136-160)、确认队列 30s 轮询(:162-175,改为保存 `r.runs` 而非仅 `r.count`)、SW `active_session` 上报两个 effect(:177-187)、push resync(:188-203)、SW `open_session` 监听(:204-217)、`?session=` 深链(:218-222)。签名:

```ts
export function useSessionsPoll(o: {
  enabled: boolean
  onAuthLost: () => void
  setSessions: (s: SessionInfo[]) => void
  setHostTmux: (h: HostTmux[]) => void
  setActiveId: (f: (prev: string | null) => string | null) => void
  docTabIds: () => string[]
  setConfirmRuns: (r: TaskRun[]) => void
  onOpenFromPush: (sid: string, gitDirty: number) => void
  activeId: string | null
}): { reload(): Promise<void> }
```

轮询与 401/5xx 分支逐行保持(I-2/I-3 注释一并搬);SW 深链改为调 `onOpenFromPush(sid, st.git_dirty)`(由 `useShellState` 实现为 `select(sid)` + 若 `git_dirty > 0` 则 `setContext(sid, { open: true, tab: 'git' })`,M26)。调度器健康 60s `usePolling` 从 Sidebar(:145-148)搬进 `useSessionsPoll`。

新建 `shell/useShellState.ts`:搬入 App 的 `sessions/hostTmux/docTabs(+ref)/docTargets/activeId/queueModes/historyReq` state 与 `handleCreate`(:278-292)、`handleOpenVault`、`handleDeleteDocTab`、`updateDocTabTitle`、`handleDelete`(:356-383,含 I-18 公式,**逐字**)、`handleRename`(改为同时写 `description`:`updateSession(id, { name, description })`)。用 `useControlsRegistry()` 取代 `sessionControls` ref。已读:

```ts
  const [lastViewedMs, setLastViewedMs] = useState(loadLastViewed)
  useEffect(() => {
    // Baseline new sids at "now" (never mark history unread) and GC vanished ones (M10).
    setLastViewedMs(prev => reconcileLastViewed(prev, sessions.map(s => s.id), Date.now()))
  }, [sessions])
  useEffect(() => { saveLastViewed(lastViewedMs) }, [lastViewedMs])
  const select = useCallback((id: string | null) => {
    setActiveId(id)
    if (id) setLastViewedMs(prev => markViewed(prev, id, Date.now()))
  }, [])
```

`activeId` 变化时也 `markViewed`(离开时再记一次,确保「在看时完成」的 turn 不在离开后变未读):`useEffect(() => { if (activeId) return () => setLastViewedMs(p => markViewed(p, activeId, Date.now())) }, [activeId])`。
`confirmsBySession`/`orphanConfirms`:由 `confirmRuns` 与 `sessions` 派生(`useMemo`),`session_id` 为空或不在 `sessions` 中计入 `orphanConfirms`(M11)。
`context` state:`Record<sid, {open, tab}>`,默认 `{ open: session.type !== 'tmux' && !narrow, tab: 'git' }`(V3,不持久化)。

- [ ] **Step 2: `TriageRow` / `TriageList` / `TriageHeader` —— 失败测试**

`shell/__tests__/TriageList.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { TriageList } from '../TriageList'
import { mkSession } from '../../../test/appHarness'
import type { SessionControls } from '../../../lib/sessionControls'

const NOW = Date.now()
const ctrl = (o: Partial<SessionControls> = {}): SessionControls => ({
  setQueueMode: vi.fn(), sendPrompt: vi.fn(() => true), interrupt: vi.fn(() => true),
  resolveApproval: vi.fn(() => true), pendingApprovals: vi.fn(() => []), ...o,
})

function setup(sessions = [
  mkSession('err', { name: 'api-refactor', last_outcome: 'errored', last_outcome_ms: NOW - 10, last_snippet: 'cargo test 失败' }),
  mkSession('run', { name: 'zeromux-fe', turn_state: 'running', turn_started_ms: NOW - 5000, last_activity_ms: NOW, current_step: 'Edit · Sidebar.tsx' }),
  mkSession('crew', { name: 'crew-a', type: 'crew', turn_state: 'running', last_activity_ms: NOW - 400_000, pending_approvals: 1 }),
  mkSession('idle', { name: 'shell-main', type: 'tmux' }),
], controls: Record<string, SessionControls> = {}) {
  const onSelect = vi.fn()
  const utils = render(<TriageList sessions={sessions} activeId={null} onSelect={onSelect}
    lastViewedMs={{ err: 0, run: 0, crew: 0, idle: 0 }} confirmsBySession={{}} controls={{ current: controls }}
    actionsFor={() => []} now={NOW} />)
  return { onSelect, ...utils }
}

describe('TriageList', () => {
  it('groups into 需要你 / 运行中 / 空闲 with counts, approval ahead of stuck', () => {
    setup()
    expect(screen.getByText('需要你 (2)')).toBeInTheDocument()
    expect(screen.getByText('运行中 (1)')).toBeInTheDocument()
    const needs = screen.getByRole('list', { name: '需要你' })
    const names = [...needs.querySelectorAll('[data-row-name]')].map(e => e.textContent)
    expect(names).toEqual(['api-refactor', 'crew-a'])
    expect(screen.getByRole('img', { name: '待审批' })).toBeInTheDocument()
  })
  it('row second line: snippet, else current step, else description', () => {
    setup()
    expect(screen.getByText('cargo test 失败')).toBeInTheDocument()
    expect(screen.getByText('Edit · Sidebar.tsx')).toBeInTheDocument()
  })
  it('clicking a row selects it', () => {
    const { onSelect } = setup()
    fireEvent.click(screen.getByText('zeromux-fe'))
    expect(onSelect).toHaveBeenCalledWith('run')
  })
  it('inline 中断 on a running row does not select it; false → toast, nothing else', () => {
    const c = ctrl({ interrupt: vi.fn(() => false) })
    const { onSelect } = setup(undefined, { run: c })
    fireEvent.click(screen.getByRole('button', { name: '中断 zeromux-fe' }))
    expect(c.interrupt).toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.getByText('未连接,稍后重试')).toBeInTheDocument()
  })
  it('inline 批准 expands the approval summary from the mounted view and resolves it', () => {
    const c = ctrl({ pendingApprovals: vi.fn(() => [{ id: 'ap1', tool: 'rm -rf /tmp/x', purpose: '清理' }]) })
    const { onSelect } = setup(undefined, { crew: c })
    fireEvent.click(screen.getByRole('button', { name: '批准 crew-a' }))
    expect(screen.getByText('rm -rf /tmp/x')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '批准' }))
    expect(c.resolveApproval).toHaveBeenCalledWith('ap1', 'approve')
    expect(onSelect).not.toHaveBeenCalled()
  })
  it('poll keeps expanded approval open across a sessions prop replacement', () => {
    const c = ctrl({ pendingApprovals: vi.fn(() => [{ id: 'ap1', tool: 'rm' }]) })
    const { rerender } = setup(undefined, { crew: c })
    fireEvent.click(screen.getByRole('button', { name: '批准 crew-a' }))
    rerender(<TriageList sessions={[mkSession('crew', { name: 'crew-a', type: 'crew', turn_state: 'running', last_activity_ms: NOW, pending_approvals: 1 })]}
      activeId={null} onSelect={() => {}} lastViewedMs={{ crew: 0 }} confirmsBySession={{}} controls={{ current: { crew: c } }} actionsFor={() => []} now={NOW} />)
    expect(screen.getByText('rm')).toBeInTheDocument()
  })
  it('unchanged rows do not re-render when the list is replaced with equal data (I-9)', () => {
    const renders = vi.fn()
    const sessions = [mkSession('a', { name: 'alpha' })]
    const { rerender } = render(<TriageList sessions={sessions} activeId={null} onSelect={() => {}} lastViewedMs={{ a: 0 }}
      confirmsBySession={{}} controls={{ current: {} }} actionsFor={() => []} now={NOW} onRowRender={renders} />)
    const n = renders.mock.calls.length
    rerender(<TriageList sessions={[{ ...sessions[0] }]} activeId={null} onSelect={() => {}} lastViewedMs={{ a: 0 }}
      confirmsBySession={{}} controls={{ current: {} }} actionsFor={() => []} now={NOW} onRowRender={renders} />)
    expect(renders.mock.calls.length).toBe(n)
  })
})
```

- [ ] **Step 3: 实现 Triage 组件**

`shell/TypeIcon.tsx`(从 Sidebar `SessionTypeIcon` :96-104 原样搬出,export `TypeIcon`;保留 `case 'crew': return <CrewIcon` 这一行形态——`crewSessionType` ② 将改读此文件)。

`shell/TriageRow.tsx` 要点(完整实现):
- props:`{ item: TriageItem; active: boolean; onSelect(id): void; controls: RefObject<Record<string, SessionControls>>; actions: SessionAction[]; now: number; onRender?: () => void }`,`memo` 比较器按签名 `(id, attention, name, description, last_snippet, current_step, round(lifetime_cost_usd*100), other_clients, active, turn_started_ms)` + `actions.length`。
- 结构(R26 两行):第一行 `StatusDot(tone=toneOf, label=labelOf)` + `TypeIcon` + `<span data-row-name>{name}</span>` + 右侧耗时(running: `formatDuration(now - turn_started_ms)`;其余 `formatRelative(last_activity_ms, now)`)+ 桌面 `formatCost(…, 'short')` + `other_clients > 0` 时 `<Monitor size={12}/>` + 数字 + `IconButton label="会话菜单" icon={MoreHorizontal}` 打开 `<Menu items={actions.map(a => ({ label: a.label, danger: a.danger, onSelect: a.run }))} />`;第二行 `last_snippet ?? current_step ?? description`(`text-ui-xs text-[var(--fg-subtle)] truncate`)。
- 行内动作(仅 agent 会话):`running|stuck` → `IconButton label={`中断 ${name}`} icon={Square}`,点击 `e.stopPropagation(); if (!controls.current[id]?.interrupt()) toast.push({ message: '未连接,稍后重试' })`;`approval` → 按钮 `批准 ${name}`,点击 `stopPropagation` 并切换本行 `expanded` state,展开区列 `controls.current[id]?.pendingApprovals()` 每项(tool + purpose)与「批准」「拒绝」两个 44px 按钮,点击 `resolveApproval(ap.id, action)`,返回 false → 同一 toast;`confirm` → 按钮「打开确认」调 `onOpenConfirm()`(prop,由 AppShell 打开 ScheduledTasksPanel)。
- 整行 `role="listitem"`、`.row min-h-[56px]`(触屏 64px 由 `--row-h` 覆盖)、`onClick={() => onSelect(id)}`;名称 `onDoubleClick` → `actions.find(a => a.id === 'rename')?.run()`(桌面双击改名)。
- 调用 `onRender?.()` 于函数体首行(测试计数用)。

`shell/TriageList.tsx`:`useMemo(() => groupTriage(sessions, { now, activeId, lastViewedMs, confirmsBySession }), …)`,渲染三组 `<section><h3>需要你 (N)</h3><ul role="list" aria-label="需要你">…`,空组不渲染标题;「空闲」组底部若 `hostTmux.length > 0` 渲染可折叠「本机 tmux (N)」(`<details>`),每项点击 `create('tmux', undefined, h.name)`,`isOrphan(h)` 显示 `Badge` 文案「zeromux 遗留」;docTabs 组(标题「文档」)每行 ⋯ 菜单只有「关闭」。

`shell/TriageHeader.tsx`:`⌘K 搜索或命令…` 按钮(手机为常驻输入条外观,R20)、`orphanConfirms > 0` 时「定时待确认 (N)」行、调度器异常时 `StatusDot tone="danger" label="调度器异常"`、⚙ `IconButton label="设置"` → `<Menu>`:推送设置 / 常用 prompt / 定时任务 / 用户管理(admin)/ 主题(系统·暗·亮,三项)/ 退出登录。

Run: `npx vitest run src/components/shell/__tests__/TriageList.test.tsx` → PASS。

- [ ] **Step 4: `CommandPalette` —— 失败测试(含移植 `Sidebar.newflow` / `Sidebar.search` 语义)**

`shell/__tests__/CommandPalette.test.tsx` 覆盖(每条一个 `it`,用 `vi.spyOn(api, …)` 与 Task 4 harness 同款 mock):
1. 空状态列 quick targets(`listQuickTargets` 返回 `[{kind:'dir',path:'/w/a',agent:'crew',display:'a',hint:'~'}]`)与最近 5 个会话;点 quick target → `create('crew', '/w/a')`(R21;移植 `crewSessionType` ③b 语义)。
2. 输入 `api` → 会话区按 `rankBy` 显示 `api-refactor`,Enter → `select('err')` 并关闭。
3. ↑/↓ 移动高亮;**IME 组合中 Enter 不执行**(`fireEvent.keyDown(input, { key: 'Enter', isComposing: true })` → 未调用)。
4. `results stable across sessions prop change`:高亮第 2 项后 rerender 传入新 `sessions` 数组(同 id 同名)→ 高亮仍是同一 id。
5. 新建模式:输入 `codex zeromux 修 bug` → 预览行文本 `Codex · <目录搜索首项> · "修 bug"`(`searchPaths` mock 返回 `dirs.items[0].path='/w/zeromux'`),Enter → `create('codex', '/w/zeromux', undefined, '修 bug')`,`saveLastType('codex')`。
6. 无类型关键字 → 用 `loadLastType()`。
7. `~/x` 字面路径 → 不调 `searchPaths`,预览用字面路径。
8. **创建失败面板不关、预览行显示「创建失败:…」;in-flight 期间第二次 Enter 不再调用 create(移植 `creatingRef`,`Sidebar.newflow:85`)**。
9. 动作区:输入「主题」→ 显示「切换主题」;输入「笔记」→「打开笔记库」(vault 启用时);输入「tmux」且有 hostTmux → 「接入 tmux:<name>」。
10. 目录 / 笔记区复用 `SearchResults`;笔记项 ⚡ 调 `onAskAgent`(Task 13 前先接到「预填新建模式」:`initial={{mode:'new', text: askAgentPrompt(...)}}` 的 prompt 部分)。
11. 类型集合恰好 4 个 agent/终端类型 + vault,且 crew 使用 `CrewIcon`(移植 `crewSessionType` ②:改为 `src('components/shell/TypeIcon.tsx')` 匹配 `case 'crew':\s*return <CrewIcon`,`src('components/shell/CommandPalette.tsx')` 中 `TYPE_CHOICES` 恰好 4 项)。

- [ ] **Step 5: 实现 `CommandPalette`**

- 外壳 `<Dialog open onClose title="命令面板">`(桌面居中 640px;`useIsNarrow()` 时 `<Sheet side="full">`)。输入框 `text-ui-input` autofocus。
- 状态:`text`、`hi`(高亮 **id** 而非下标——测试 4)、`creating`(`useRef` 同步守卫 + state 镜像,逐字照搬 `Sidebar.tsx:135,245-259` 的 `runCreate` 语义与注释)、`createError`。
- 模式判定:`initial.mode === 'new'` 或 `parseNew(text).type !== null` 或以 `+`/`新建 ` 开头 → 新建模式;否则搜索模式。
- 搜索模式分区:会话(`rankBy(text, sessions, s => [s.name, s.work_dir, s.peer_name ?? ''])` 前 8)、动作(`rankBy(text, actions, a => [a.label])`)、目录/笔记(`usePathSearch(text, { scope: vaultEnabled ? 'dirs,notes' : 'dirs', debounceMs: 150, enabled: open, requeryWhile })`,`requeryWhile` 从 Sidebar `sidebarRequery`(:84-88)原样搬到本文件)、本机 tmux(`matchHostTmux(hostTmux, text)`)。
- 新建模式:`parseNew`;`literalPath` 时目录 = 字面值(`~` 保持原样交给后端);否则目录 = `usePathSearch(dir, { scope: 'dirs', … })` 首项;`Tab` 在候选间循环;预览行 `${TYPE_LABEL[type]} · ${dir} · "${prompt}"`;Enter → `runCreate(() => shell.create(type, dir, undefined, prompt || undefined))`,成功后 `saveLastType` + `onClose()`,失败显示错误且不关。
- 空状态:`<QuickTargets kind="dir" onPick={(p, agent) => runCreate(() => shell.create(agent ?? loadLastType(), p))} onChangeAgent={p => setText(`${loadLastType()} ${p} `)} onPickWithPrompt={(p, agent) => setText(`${agent ?? loadLastType()} ${p} `)} />` + 最近 5 会话。
- 键盘:↑↓ 改 `hi`;Enter(`!e.nativeEvent.isComposing`)执行;Esc 由 Dialog 关闭。
- `TYPE_CHOICES = ['claude', 'codex', 'crew', 'tmux'] as const`(导出常量,测试 11)。

Run: `npx vitest run src/components/shell/__tests__/CommandPalette.test.tsx` → PASS。

- [ ] **Step 6: `ContextPanel` / `FocusHeader` / `RenameDialog` / `useNextKeys` —— 测试与实现**

`shell/__tests__/ContextPanel.test.tsx`:
1. tab 懒挂载后常驻:打开「文件」→ 切「Git」→ 切回「文件」,`FileBrowser` mock 构造计数 = 1(I-1 同构)。
2. `asSheet` 时以 `Sheet side="bottom"` 呈现;`opening palette closes context sheet`:AppShell 级测试——手机宽度下打开 ContextPanel 后按 ⌘K,断言同时打开的 `dialog[open]` 只有 1 个(R13:禁 Sheet 套 Sheet)。
3. 「运行」tab 渲染 `RunMetricsPanel`,其 `running`/`turnStartedMs`/`refreshKey` 取自 `session.turn_state==='running'`、`turn_started_ms`、`last_outcome_ms ?? 0`(M9e);下半段 `<details><summary>事件</summary><AgentDashboard sessionId/></details>`。
4. Git tab 传 `initialTab`:由 `setContext(sid,{tab:'git'})` 从推送深链进入时 `initialTab='worktree'`。

实现:三个 tab 用 `SegmentedControl`(Git / 文件 / 运行);tmux 会话只显示 Git / 文件;各 tab 内容 `visited` 集合懒挂载 + `hidden` 切换;组件引用复用 Task 2 的 `lazy`(把 lazy 声明从 App.tsx 移到 `shell/lazyPanels.ts` 并 export),外包 `Suspense fallback={<Skeleton rows={4}/>}`;记忆(crew)不作为 tab,composer ⌘ 弹层「全部 →」打开 `MemoryPanel` Sheet(`AcpChatView.onOpenMemory` → `shell.openMemory()`)。`GitViewer.tsx` 仅加 `initialTab` prop:`useState<'worktree' | 'history'>(initialTab ?? 'history')`。

`FocusHeader`(测试:手机显示 `‹ 分诊 (N)` 按钮且点击 `select(null)`;显示 StatusDot + 耗时 + `formatCost(lifetime_cost_usd,'short')`;`⋯` 菜单项 = `sessionActions` 结果;面板开关 `IconButton label="面板"`;crew 显示 ctx%(由 AcpChatView 经新可选回调 `onCtxUsage` 上报,存 `useShellState`)):
```
桌面: ● 运行中 2m14s  $0.42  api-refactor           [▤ 面板]  ⋯
手机: ‹ 分诊 (3)  api-refactor  ●                     [▤]  ⋯
```

`RenameDialog`:`<Dialog title="重命名 / 描述">` 两个 `text-ui-input` 输入(名称、描述),保存调 `shell.rename(id, name, description)`;移植 `SessionRowMenu.test:36` 的「窄屏改名后焦点在名称输入框」断言。

`useNextKeys`(测试:`J` 在 body 焦点时调 `onNext`;在 `<input>`/`<textarea>`/`.xterm` 内不触发;`⌘K`/`Ctrl+K` 任意焦点调 `onPalette` 且 `preventDefault`;`⌘]` 调 `onNext` 且 `preventDefault`):

```ts
export function useNextKeys({ onNext, onPalette }: { onNext(): void; onPalette(): void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); onPalette(); return }
      if (mod && e.key === ']') { e.preventDefault(); onNext(); return }
      const t = e.target as HTMLElement | null
      const typing = !!t && (t.closest('input, textarea, [contenteditable="true"], .xterm') != null)
      if (!mod && !e.altKey && e.key === 'j' && !typing) { e.preventDefault(); onNext() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onNext, onPalette])
}
```

「下一个」:`const id = nextNeedsYou(groups, activeId); id ? select(id) : toast.push({ message: '都处理完了' })`(lucide `Check` 图标在 toast 外不需要;文案不含 emoji)。

- [ ] **Step 7: `AppShell` + 精简 `App.tsx`**

`AppShell.tsx` 布局:
- 桌面(`!narrow`):`[TriageHeader+TriageList 272px | FocusHeader + 会话层 | ContextPanel 360px(≥1280px 且 open)]`;`md ≤ 宽 < lg` 左栏可折叠为 56px 图标栏(每会话一个 StatusDot + TypeIcon,点击 select)。1024–1279px 时 ContextPanel 以 `Sheet side="right"` 呈现。
- 手机(`narrow`):`activeId == null` 时全屏分诊页(TriageHeader + TriageList + 底部常驻「搜索或新建…」条 → 打开 ⌘K);`activeId != null` 时全屏会话页(FocusHeader + 会话层);`needsYouCount > 0 && activeId` 时 FAB `IconButton label="下一个需要你的" icon={SkipForward}` 固定在 composer 上方右侧(`bottom: calc(var(--composer-h, 72px) + 12px)`),不遮挡键栏(tmux 会话 FAB 上移到 MobileKeyBar 之上)。
- **会话层**(I-1):`sessions.map` + `docTabs.map` 常驻挂载,根元素 `data-session-pane={id} data-active={…}` + `hidden`;TerminalView 与 AcpChatView 的 props 与旧 App 一致,**`active={isActive}`**(去掉 `&& view==='none'`,代码分析 §6.2-1:overlay 已不存在;ContextPanel 是并排而非覆盖);AcpChatView 新增 `onOpenChanges={() => shell.setContext(s.id, { open: true, tab: 'git' })}`,删掉 `showMetrics` 传参(RunMetrics 已进运行 tab;`AcpChatView` 内 `showMetrics` 分支与 Task 2 的 lazy RunMetricsPanel 一并删除);TerminalView 仍传 `onAskAgent`(M25,本期不动)与 `historyRequest`。
- 桌面 ContextPanel 开/收后,若 active 为 tmux,50ms 后 `window.dispatchEvent(new Event('resize'))` 触发 TerminalView 既有 refit 路径(I-12 去重不变)。
- 顶层挂载:`CommandPalette`(`paletteOpen` state;打开前若手机且 ContextPanel Sheet 开着,先 `setContext(activeId, { open: false })`——Review Focus 5)、`RenameDialog`、四个面板 Sheet(lazy)、`MemoryPanel` Sheet、`<Toaster/><DialogHost/>`。
- `document.title`:`needsYouCount > 0 ? `(${n}) ZeroMux` : 'ZeroMux'`(R25)。
- 空态:无会话无文档 → Focus 区 `创建一个会话开始` + 按钮「新建…」(打开 ⌘K 新建模式)。

`App.tsx` 精简为:`authState/user`、`initAuth`、`handleLegacyLogin`、`handleLogout`、`handleApproved`、`useTheme()`,以及 `authState === 'active'` 时 `<AppShell user={user} theme={themeCtx} onLogout={handleLogout} onAuthLost={() => { clearAuth(); setAuthState('unauthenticated'); setUser(null) }} />`。登录后首次若 0 会话自动建 tmux 的逻辑(`handleLegacyLogin` :261-274)保留在 App(它调用 `createSession` 后 AppShell 首轮 poll 即可见;`?session=` 以外的 activeId 由 `resolveActivePane` 处理)。

- [ ] **Step 8: 移植并删除旧测试与组件**

1. 确认 Step 4 覆盖了 `Sidebar.newflow.test.tsx` 与 `Sidebar.search.test.tsx` 的**每个** `it` 的行为(逐条对照,在 CommandPalette.test 中以注释 `// ported from Sidebar.newflow:<line>` 标注;纯属旧 UI 形态的断言——如「Terminal goes straight to the directory picker」——在注释中写明「新 IA 无此步骤,删除」)。
2. `SessionInfoBar.queuemode.test.tsx` 的 I-6 断言移植到 Task 12(composer chip);**本 Task 期间 FocusHeader 暂不放队列控件**,队列模式切换在 Task 12 之前经 ⌘K 动作「切换队列模式(当前:X)」提供(显示值读 `queueModes[activeId]`,I-6),并在 CommandPalette.test 加一条:`queueModes` 为 `interrupt` 时动作标签显示「当前:Interrupt」,执行调用 `controls.current[id].setQueueMode('collect')`。
3. `crewSessionType.test.tsx` ② 改为:
   ```tsx
   it('② TypeIcon has a crew branch; the palette offers exactly 4 session types', () => {
     const icon = src('components/shell/TypeIcon.tsx')
     expect(icon).toMatch(/case 'crew':\s*return <CrewIcon/)
     const pal = src('components/shell/CommandPalette.tsx')
     expect(pal).toMatch(/TYPE_CHOICES = \['claude', 'codex', 'crew', 'tmux'\] as const/)
     expect(pal).not.toContain("'kiro'")
   })
   ```
4. `git rm` 本 Task Files 列出的 4 个组件文件与 4 个测试文件。`grep -rn "Sidebar\|SessionInfoBar\|SessionRowMenu" frontend/src` 只允许剩注释。

- [ ] **Step 9: 全量验证(含 Task 4 契约)**

Run: `cd frontend && npx vitest run src/__tests__/App.characterization.test.tsx`
Expected: 5 passed,**测试文件与 Task 4 提交版本逐字相同**(`git diff HEAD -- frontend/src/__tests__/App.characterization.test.tsx` 为空)。若 `selectSession` 在手机布局下找不到行名:测试默认桌面宽度(happy-dom 无 matchMedia 匹配 → `useIsNarrow` 为 false),应能找到;若失败,修 AppShell 而非测试。

Run: `npm test 2>&1 | tail -3 && npx tsc -b && npm run lint 2>&1 | tail -3 && npm run build 2>&1 | tail -3`
Expected: 全绿;棘轮计数**低于**基线(删了 Sidebar/SessionInfoBar 的小字号与调色板用法);体积 ≤ 330KB(若超,把 CommandPalette 也 lazy:⌘K 首次打开才加载,输入条先渲染静态外观)。

- [ ] **Step 10: 隔离实例对位验收 + 截图**

```bash
cd /home/ubuntu/s3-workspace/keith-space/github-search/ai/zeromux
cargo build --release
D=$(mktemp -d); cp -r ~/.zeromux/sessions.db* "$D"/ 2>/dev/null || true
./target/release/zeromux --port 18093 --password smoke --data-dir "$D" --tmux-socket zmx-smoke-s2s3 &
```

逐行走 spec §0.5.4 对位表(每行在浏览器 1440×900 与 390×844 各做一次,结果记入 `docs/superpowers/screens/s2s3/parity.md`,格式 `| 功能 | 桌面 ✅/❌ | 手机 ✅/❌ | 备注 |`)。任何 ❌ 修完再继续。截图:分诊页、⌘K 空状态、⌘K 新建预览、Claude 会话 + ContextPanel(桌面右栏 / 手机 Sheet)、tmux 会话、FAB,暗/亮 × 两视口,存 `docs/superpowers/screens/s2s3/shell/`。结束 `kill %1; tmux -L zmx-smoke-s2s3 kill-server; rm -rf "$D"`。

- [ ] **Step 11: 单个提交**

```bash
git add -A frontend/src docs/superpowers/screens/s2s3
git commit -m "feat(shell): triage + ⌘K + FocusHeader + ContextPanel replace Sidebar/SessionInfoBar/overlays

Single revertable commit (spec v3 §0.5.6-3). App characterization (I-1/2/3/17/18)
passes unchanged. Old-UI tests ported to CommandPalette / sessionActions / TypeIcon."
```

---

### Task 12: FocusComposer —— 队列 chip + `/` 预设 + ⌘ 记忆统一(壳稳定 ≥ 2 天后)

**Files:**
- Create: `frontend/src/components/composer/QueueChip.tsx`、`PresetPicker.tsx`
- Modify: `frontend/src/components/Composer.tsx`(新增可选 `leftSlot` 与 `onSlash` 行为;原 props 不变)、`frontend/src/components/AcpChatView.tsx`(删 preset popover 与 `ListPlus` 按钮、手写遮罩;记忆弹层迁入 `<Popover>`)、`frontend/src/components/shell/CommandPalette.tsx`(删除 Task 11 的「切换队列模式」临时动作;新建模式 prompt 框接 `PresetPicker`)
- Test: `frontend/src/components/composer/__tests__/{QueueChip,PresetPicker}.test.tsx`;`frontend/src/components/__tests__/Composer.test.tsx`(追加)

**Interfaces:**
- Consumes: `queueModes`(`useShellState`,I-6)、`SessionControls.setQueueMode`、`usePromptPresets`、`applyPreset`、`confirm`(`components/ui`)。
- Produces:
  ```ts
  export function QueueChip(p: { mode: string; busy: boolean; onToggle(): void }): JSX.Element     // Collect ⇄ Interrupt one tap (V8/R27)
  export function PresetPicker(p: { open: boolean; query: string; presets: PromptPreset[]; anchor: HTMLElement | null;
    onPick(p: PromptPreset): void; onManage(): void; onClose(): void }): JSX.Element
  // Composer additions
  interface ComposerProps { …; leftSlot?: ReactNode; onSlash?: (query: string | null) => void }   // null = slash mode ended
  ```

- [ ] **Step 1: 失败测试**

`QueueChip.test.tsx`:
1. `mode='collect'` 显示「Collect」;点击调 `onToggle` 一次(1 击,验收 §0.5.7-2)。
2. **受控**:父组件未改 `mode` 时点击后仍显示「Collect」(送达才 adopt;移植 `SessionInfoBar.queuemode.test` 的「CONTROLLED reflection」断言)。
3. `mode='interrupt' && busy` 时 chip 高亮(`data-hot="1"`)且旁边显示「将打断」;发送键颜色**不变**(V9:断言 Composer 的发送按钮 className 与 collect 时相同)。

`PresetPicker.test.tsx`:
1. 行首输入 `/` 打开,`/fix` 按标题模糊过滤(`rankBy`);↑↓ + Enter 选择;列表底部「管理…」调 `onManage`。
2. 选中含 `{{input}}` 的 preset:`/fix 登录页` → 输入框变为 `applyPreset(body, '登录页')`。
3. 选中不含 `{{input}}` 的 preset 且输入框已有非 `/` 内容 → 弹 `confirm({ title: '用预设覆盖当前输入?' })`,取消则不变。
4. IME 组合中 Enter 不选择。

`Composer.test.tsx` 追加:`onSlash` 在值以 `/` 开头时收到去掉 `/` 的 query,变为非 `/` 开头时收到 `null`。

- [ ] **Step 2: 实现**

- `QueueChip`:`<button type="button" aria-label={`队列模式 ${label}`} data-hot=…>`,放在 Composer `leftSlot`(输入框内左下角,V8);文案 Collect / Interrupt;`busy && mode==='interrupt'` 时右侧 `<span className="text-ui-2xs text-[var(--attention)]">将打断</span>`。AcpChatView:`<QueueChip mode={queueMode} busy={sock.busy} onToggle={() => sock.setQueueMode(queueMode === 'collect' ? 'interrupt' : 'collect')} />`,`queueMode` 由新 prop `queueMode?: string`(AppShell 传 `shell.queueModes[s.id] ?? 'collect'`)提供——**显示值只来自后端权威**(I-6),`setQueueMode` 仅在 OPEN 时发送并 adopt(既有语义)。
- `PresetPicker`:`<Popover placement="top">` 锚在 composer;`usePromptPresets()` 在 AcpChatView 已有一份,传入;「管理…」→ AppShell `openPanel('prompts')`(经 AcpChatView 新 prop `onManagePresets`)。
- 「＋」按钮(V8):📎 上传与 ⌘ 记忆收进 `IconButton label="更多" icon={Plus}` 的 `<Menu>`;发送键 36px。删除 composer 的 `ListPlus` 预设按钮与两处手写 `fixed inset-0` 遮罩(改 `Popover`)。
- 记忆弹层:`memOpen` 内容原样放入 `<Popover>`;`memReqRef` 守卫原样保留(代码分析 §6.2-7:其无测试 → 本 Step 先补一条 stale 测试:打开弹层 → 冷 GET 挂起 → 写入一条 → 冷 GET 以旧快照返回 → 断言新条目仍在;注释守卫验红后恢复)。
- CommandPalette 删除临时「切换队列模式」动作及其测试;新建模式 prompt 部分输入 `/` 时同样弹 `PresetPicker`(V7:唯一实现)。

- [ ] **Step 3: 验证 + Commit**

Run: `cd frontend && npm test 2>&1 | tail -3 && npx tsc -b && npm run lint 2>&1 | tail -3 && npm run build 2>&1 | tail -3` → 全绿。

```bash
git add -A frontend/src/components/composer frontend/src/components/Composer.tsx frontend/src/components/AcpChatView.tsx frontend/src/components/shell frontend/src/components/__tests__/Composer.test.tsx
git commit -m "feat(composer): one-tap queue chip, / presets, memory popover on primitives"
```

---

### Task 13: SendToMenu —— 「发给 agent」唯一实现(Git 与笔记 ⚡ 接入)

**Files:**
- Create: `frontend/src/components/SendToMenu.tsx`
- Modify: `frontend/src/components/GitViewer.tsx`(「让 agent 处理」:原生 `confirm` 改 SendToMenu;保留 `onForward` prop 作为「当前会话」默认目标的兼容路径)、`frontend/src/components/shell/AppShell.tsx`(VaultReader `onAskAgent` 与 CommandPalette 笔记 ⚡ 接 SendToMenu)
- Test: `frontend/src/components/__tests__/SendToMenu.test.tsx`;`GitViewer.forward.test.tsx`(按新交互**追加**用例,旧用例若依赖原生 confirm 则改为点击 SendToMenu ★ 项——在 commit message 注明)

**Interfaces:**
- Consumes: `sendTargets`(Task 9)、`SessionControls.sendPrompt`、`queueModes`、`shell.create`、CommandPalette `initial`。
- Produces:
  ```ts
  export function SendToMenu(p: {
    open: boolean; anchor: HTMLElement | null; onClose(): void
    text: string                 // already wrapped by the caller (historyPrompt / askAgentPrompt)
    workDir: string | null; excludeId?: string
    sessions: SessionInfo[]; controls: RefObject<Record<string, SessionControls>>
    queueModes: Record<string, string>
    onSelectSession(id: string): void                                  // toast「查看」action
    onNew(prefill: { workDir: string | null; prompt: string }): void    // opens ⌘K new mode prefilled
  }): JSX.Element
  ```

- [ ] **Step 1: 失败测试**

1. 候选 = `sendTargets(...)`,首项带 ★ 且默认高亮;Enter 直接发送给首项(≤ 2 击:打开 + Enter)。
2. 发送成功:`sendPrompt(text)` 返回 true → toast「已发给 〈名〉」带 action「查看」,点「查看」调 `onSelectSession(id)`;**不切换焦点**(未调用 `onSelectSession`,直到点「查看」)。
3. 返回 false → toast「未连接,未发送」带 action「复制」(调用 `copyText(text)`)。
4. 目标 busy:`queueModes[id]==='collect'` 显示「将排队」,`'interrupt'` 显示「将打断」。
5. 「＋ 新开…」调 `onNew({ workDir, prompt: text })`。
6. 菜单底部固定小字「发送前请确认内容不含密钥」;无原生 `confirm`(`vi.spyOn(window, 'confirm')` 未被调用)。
7. 无候选时只显示「＋ 新开…」。

- [ ] **Step 2: 实现并接入**

`SendToMenu` 用 `<Menu>`(手机自动 bottom Sheet),项:候选(`TypeIcon` + 名称 + `work_dir` 缩写 + 「将排队/将打断」)、分隔、「＋ 新开…」、说明行。
接入:
- GitViewer「让 agent 处理」按钮 → 打开 SendToMenu(`workDir = session.work_dir`,`excludeId` 不传——当前 agent 会话也是合法目标并排首位,因为同目录且最近);`text` 沿用现有拼装逻辑(`GitViewer.tsx:276` 附近 confirm 之前构造的 prompt)。GitViewer 需要的 `sessions/controls/queueModes/onSelectSession/onNew` 由 ContextPanel 透传(ContextPanel 从 AppShell 拿 `shell`)。
- VaultReader / CommandPalette 笔记 ⚡:`text = askAgentPrompt(target)`,`workDir = target.absDir`,打开 SendToMenu;「新开」→ `setPalette({ mode: 'new', text: `${loadLastType()} ${target.absDir} ${askAgentPrompt(target)}` })`。
- **不改** TerminalView `onAskAgent`(M25,Plan B)。

- [ ] **Step 3: 验证 + Commit**

Run: `cd frontend && npm test 2>&1 | tail -3 && npx tsc -b && npm run lint 2>&1 | tail -3 && npm run build 2>&1 | tail -3` → 全绿。

```bash
git add frontend/src/components/SendToMenu.tsx frontend/src/components/GitViewer.tsx frontend/src/components/shell frontend/src/components/__tests__/SendToMenu.test.tsx frontend/src/components/__tests__/GitViewer.forward.test.tsx
git commit -m "feat(send-to): one 'send to agent' menu for git and note ⚡ (no native confirm)"
```

---

### Task 14: 合并期验收 + 回滚演练 + 部署

**Files:**
- Create: `docs/superpowers/screens/s2s3/acceptance.md`
- Modify: `CLAUDE.md`(项目根,「Frontend」一节:Sidebar/SessionInfoBar → AppShell/Triage/⌘K/FocusHeader/ContextPanel;views 列表)

- [ ] **Step 1: 自动化验收清单(spec §0.5.7)**

逐条给出证据(测试名或截图路径)写入 `acceptance.md`:
1. 对位表每行 → Task 11 Step 10 `parity.md`。
2. 击数:`TriageList.test`(行内中断/批准 ≤ 2 击不改 activeId)、`useNextKeys.test` + FAB(手机分诊 → 下一个 ≤ 1 击)、`CommandPalette.test` #1(quick target = ⌘K + 1 击)、`QueueChip.test` #1(1 击)、`SendToMenu.test` #1(⚡ → ★ ≤ 2 击)。
3. `triage.test` 8 态;`readState.test`;App characterization I-2;`TriageList.test` I-9 render 计数。
4. App characterization I-1 + `ContextPanel.test` #1。
5. `acpSocket.characterization` 全绿。
6. `npm run build` 输出的 br 值;`npm run lint` 棘轮输出。
7. 390×844 tmux 截图,可视高度 ≥ 75%(截图中测量终端区高度 / 844,写入数值)。

Run: `cd frontend && npm test 2>&1 | tail -3 && npm run lint 2>&1 | tail -3 && npm run build 2>&1 | tail -3 && cd .. && cargo test 2>&1 | tail -3`
Expected: 全绿,记录数字。

- [ ] **Step 2: 回滚演练(隔离,不碰线上)**

```bash
git switch -c rollback-drill
time git revert --no-edit <Task 11 commit sha>
time (cd frontend && npm run build) && time cargo build --release
./target/release/zeromux --port 18094 --password drill --data-dir "$(mktemp -d)" --tmux-socket zmx-drill &
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18094/      # expect 200
kill %1; tmux -L zmx-drill kill-server; git switch main; git branch -D rollback-drill
```

把 `git revert` / 前端构建 / cargo release 三段耗时写入 `acceptance.md`「回滚演练」节。

- [ ] **Step 3: 真机试用门槛**

在隔离实例(端口 18093,`--data-dir` 线上数据**副本**)上用手机与 Mac 使用 ≥ 1 天;问题记入 `acceptance.md`「试用记录」,P1(阻断日常使用)必须修复后才能进入 Step 4。

- [ ] **Step 4: 文档 + 提交 + 部署**

更新项目根 `CLAUDE.md` 的 Frontend 段(views:`AppShell`(Triage / Focus / ContextPanel)、`TerminalView`、`AcpChatView`(TurnView)、`GitViewer`;「Switching views uses CSS visibility toggling」保持)。

```bash
git add CLAUDE.md docs/superpowers/screens/s2s3/acceptance.md
git commit -m "docs: S2+S3 acceptance, rollback drill timings, CLAUDE.md frontend section"
git push
./deploy.sh --build
curl -s -o /dev/null -w '%{http_code}\n' https://zeromux.keithyu.cloud/     # expect 200
```

Expected: 200。部署从 zeromux 终端内执行时本终端会在 stop 时掉线,属预期(deploy.sh 已 systemd-run 逃逸),重连后再 curl 验证。
