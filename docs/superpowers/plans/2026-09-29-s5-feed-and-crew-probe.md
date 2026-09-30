# S5「收结果 + Crew 探针」Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 spec §11 分两期交付 S5。S5-a（后端）：Crew spike 补测与夹具 → F1 态势持久化（U1 七列迁移、`update_posture`、`persist_posture`、`load_all` 回填）→ F2 推送带结论与定时 `run_done`（后端 + SW）→ G1 Crew Mode 结果可见 → R4 `owns_slot` → G2 后端（`CreateSessionReq`、`SlotInit`、三列持久化、`zmx_usage` 埋点）→ 部署。S5-b（前端）：F3 离开期间卡 → G2 前端（⌘K 二级 chip、`crewVariant` 徽标、`crew:goal`）→ F4 记为约定 → 部署。

**Architecture:** 后端沿用现有模式。新列用吞错式 `ALTER TABLE … ADD COLUMN`；posture 在 sessions 锁内取快照、锁外写库，每次 settle 写一次；推送正文由 `payload_for` 的新参数 `body` 覆盖；Crew 的 `chat_message` 用纯函数 `crew_message_events` 按 kind 白名单放行，映射成非边界事件；slot 归属由持久化的 `crew_origin` 决定，经 `SlotInit` 传入 `CrewProcess::spawn`。前端新逻辑一律先写成纯函数（`lib/awaySummary.ts`、`lib/crewVariant.ts`、`lib/conventionPrompt.ts`），再接进组件。fan-out 仍然是进程/WS 的唯一 owner。

**Tech Stack:** Rust（axum 0.8 / tokio / rusqlite / reqwest / tokio-tungstenite）、React 19 + Vite + Tailwind v4 + vitest/happy-dom、Node 20（spike 脚本用 `--experimental-websocket`）。

**Spec:** `docs/superpowers/specs/2026-09-29-s5-feed-and-crew-probe-design.md`（v1；§0.2 U1–U5 是跨 spec 约定，§0.3 D1–D10 是本期 taste 决定）。下游消费方：`docs/superpowers/plans/2026-09-29-s6-gate-review-dispatch.md` 的「前置：S5 已上线」grep 清单。基线 `main @ ae5fef7`（S4 只动了前端终端相关文件，`src/` 与 spec 基线 `33c2236` 相同，本计划的 file:line 都在 `ae5fef7` 上核对过）。

## Global Constraints

- 个人项目、all-trust：**不做**治理、权限、沙箱、审计。
- 接口名以 S6 前置清单为准，逐字一致：`fn persist_posture`（`src/session_manager.rs`）、`Posture.awaiting_input`、`sessions` 表的 `crew_mode` / `crew_agent` / `crew_origin` 三列、`SessionInfo` 的 `pub crew_mode` / `pub crew_agent` / `pub crew_origin`、`pub fn payload_for(kind: &str, name: &str, session_id: &str, fk: Option<&str>, body: Option<&str>)`（写在**一行**里，S6 用 grep 逐字匹配）、`enum SlotInit`、`owns_slot`、`fn crew_message_events`、`target: "zmx_usage"`、fan-out 局部变量 `first_prompt_logged`、`frontend/src/lib/awaySummary.ts`、`frontend/src/components/shell/AwayCard.tsx`、`frontend/src/lib/crewVariant.ts`、`CommandPalette.tsx` 中出现「目标指挥」。
- U1 列定义逐字照抄：`crew_mode TEXT NOT NULL DEFAULT ''`、`crew_agent TEXT NOT NULL DEFAULT ''`、`crew_origin TEXT NOT NULL DEFAULT 'zeromux'`；posture 四列：`last_outcome TEXT`、`last_outcome_ms INTEGER`、`last_snippet TEXT`、`awaiting_input INTEGER NOT NULL DEFAULT 0`。
- U2：`owns_slot = crew_origin != "external"`。**禁止**用 `resume.is_none()` 推断归属。
- `upsert` 只写三个 `crew_*` 列，**不写** posture 四列；posture 只经 `update_posture` 写。
- `persist_posture` 只在 `settle_posture` 末尾（锁已释放后）调用；**不在** `apply_posture_delta` 调用；`current_step` / `approval_ids` 不持久化；写失败只 `tracing::warn!`。
- 推送正文截断：先把所有空白（含换行）折叠成单个空格，再按 `chars().take(120)` 截断，超出加 `…`；绝不按字节切。
- `run_done` 属于 **routine** 档，SW 在前台看着该会话时抑制；只在 `finalize_run(…, "succeeded", …)` 分支触发；标题 `⏰ {name} 完成`；正文优先 verdict，其次 snippet，都没有时写「定时任务已完成」。
- G1：`chat_message` 只在 `kind ∈ {crew_ack, crew_ask, crew_result, crew_meta}` 且 `role == "assistant"` 时放行；`crew_ack` → `System{subtype:"crew_ack"}`；其余三种 → 非边界 `ContentBlock{block_type:"text", summary:Some(kind)}`；**不进 `turn_text`**。
- G2 服务端校验：`crew_mode ∈ {"", "crew"}`，`crew_agent ∈ {"", "kirocrew-conductor"}`，其余返回 400。默认 `create_slot` 请求体逐字等于 `{"name":k}`。
- G2 前端 S5 只开放「聊天」「目标指挥」两个 chip（D1）；「并行话题」由 S6 T3 加。
- F3：本机 `localStorage['zmx_left_ms']`，离开 ≥ 30 分钟、窗口内至少一个事件才显示；关闭后本次不再出现；AwayCard 是首屏组件，不 lazy。
- F4：只经 `sessionControls.sendPrompt(conventionPrompt(text), { withAttachments: false })`，不加后端端点；toast 文案「已交给 agent 记录」/「未连接，稍后再试」。
- Crew secret/token：每次现读（`read_gateway_secret`）、现 mint，**不落盘、不进日志、不进夹具**；夹具只含脱敏后的帧（slot 名统一为 `zmxprobe`，不含 `/home/`、`?token=`、`X-Internal-Secret`）。
- 首屏 br ≤ 330KB（`npm run build` 内 `check-size.mjs dist 337920`）；S5 首屏增量合计 ≤ 2.5KB（F3 ≤ 1.5KB、徽标 ≤ 0.3KB、F4 ≤ 0.5KB）；超出时先把 F4 的 Dialog 改成懒加载。
- `frontend/src/__tests__/App.characterization.test.tsx` 每个 task 原样通过，不改断言。
- 文案中文、代码/注释英文；字号只用 `text-ui-*`，颜色只用语义 token，图标只用 lucide，禁 emoji（后端推送标题沿用 `payload_for` 既有 emoji 风格）；禁原生 `alert/confirm/prompt`；触控目标 ≥ 44px。
- `cargo test` 在仓库根目录跑，`frontend/dist/` 必须先存在（`rust-embed` 编译期读取）；缺失时先 `cd frontend && npm run build`。
- 每个 task 结束跑全量：`cargo test`、`cd frontend && npm test && npm run lint && npm run build`。
- 部署只用 `./deploy.sh`，**先 commit + push 再 deploy**（zeromux 终端在 cgroup 内，deploy 时本终端掉线属预期）。冒烟实例必须 `--data-dir $(mktemp -d)` + `--tmux-socket zmx-s5-smoke` + 端口 ≥ 18090。部署前 `find frontend/node_modules -maxdepth 3 -type l -lname '/tmp/*'` 必须为空。
- 不做：话题模式 busy 语义（S6 G3）、外部 slot 附着入口（S7 G6）、服务端已读（S6 T0）、`SessionInfo.awaiting_input`（S6 Task 9 产出）、`outcome_str`（S6 Task 1 产出）、用户消息气泡 ⋯ 菜单、「记为约定」埋点。

## Review Focus

1. **出错的一轮触发 turn_done 推送时，正文不能是上一轮的结论。** 在 Claude fan-out 里，`maybe_push_turn_done` 在 `settle_posture` 之前调用。这时 Errored 轮还没有把 `last_snippet` 清掉（A10），直接读 `last_snippet` 会把上一轮「全部测试通过」推到锁屏，标题还是「✅ 完成」。期望：正文只取**本轮** Result 的 snippet，本轮没有就用默认文案（Task 3 用例 `push_snippet_is_this_turns_result_only`）。
2. **PWA 从后台恢复时没有重新加载页面**（iOS 上最常见的「打开」方式），离开已 ≥ 30 分钟。只在挂载时读 `zmx_left_ms` 会让卡片永远不出现。期望：`visibilitychange → visible` 时重新读取离开时刻并重新判定，之前关掉的状态也随之重置（Task 9 用例 `resume from background re-arms the card`）。
3. **⌘K 里输入了 `crew:goal`，又点了「聊天」chip。** 关键词和 chip 各存一份状态时，谁赢取决于实现细节。期望：以最后一次显式选择为准，所以点「聊天」后建出来的是聊天会话，`crew_agent` 为空（Task 10 用例 `chip click overrides the crew:goal keyword`）。
4. **Crew 会话 resume 失败、走 fresh 兜底新建 slot。** 兜底路径过去传 `None`，新 slot 会丢掉 conductor agent，归属也可能被误判。期望：兜底新建的 slot 保留持久化的 mode/agent，并且 `owns_slot = true`（Task 6 用例 `fresh_fallback_keeps_mode_and_agent_and_owns`）。
5. **「记为约定」的预填来源。** composer 为空或全是空白时，预填应取本会话最近一条**自己发的**用户消息，不能取 Claude 跨会话发来的 peer 消息，也不能取空白串（Task 11 用例 `prefill skips peer messages and blank composer`）。

---

## File Structure

| 文件 | 动作 | 职责 | Task |
|---|---|---|---|
| `src/acp/testdata/crew_frames_{crew_result,crew_ask,crew_meta,crew_ack,normal_turn}.json` | Create | 脱敏后的 Gateway 帧夹具 | 1 |
| `docs/superpowers/audits/2026-09-29-kiro-crew-gap-research.md` | Modify | §7 追加 SP 补测结论 | 1 |
| `src/run_metrics.rs` | Modify | `RunOutcome::as_str` / `RunOutcome::parse_lenient` | 2 |
| `src/session_store.rs` | Modify | U1 七列迁移、`PersistedPosture`、`update_posture`、`upsert` 写 `crew_*`、`load_all` 读七列 | 2 |
| `src/session_manager.rs` | Modify | `Posture.awaiting_input`/`turn_snippet`、`persist_posture`、`load_persisted` 回填（2）；`push_snippet`、`maybe_push_turn_done` 带 body、`maybe_push_run_done`（3）；`CrewMeta`、`Session.crew`、`SpawnPlan.crew`、`crew_slot_init`、`spawn_crew(…, SlotInit)`（6）；`create_crew_session` 参数、`SessionInfo.crew_*`、`zmx_usage` 埋点（7） | 2、3、6、7 |
| `src/push.rs` | Modify | `payload_for(…, body)`、`push_body_of`、`run_done` 文案与档位 | 3 |
| `src/scheduled_tasks.rs`、`src/web.rs` | Modify | `payload_for` 调用点补 `None`（3）；`CreateSessionReq.crew_*`、`validate_crew_opts`（7） | 3、7 |
| `frontend/public/sw.js`、`frontend/src/components/PushSettings.tsx` | Modify | run_done 前台抑制与 tag；routine 档文案 | 4 |
| `frontend/src/lib/__tests__/sw.test.ts` | Create | 把 sw.js 装进假 `self` 驱动 push 事件 | 4 |
| `src/acp/crew_process.rs` | Modify | `crew_message_events`（5）；`SlotInit`、`owns_slot`、`should_delete_on_drop`、`resume_plan`（6）；`slot_create_body`（7） | 5、6、7 |
| `frontend/src/hooks/useAcpSocket.ts`、`frontend/src/lib/steps.ts`、`frontend/src/components/turn/StepRow.tsx` | Modify | `crew_ack` 提示；按 summary 渲染 crew_ask / crew_meta | 5 |
| `frontend/src/lib/awayClock.ts`、`frontend/src/lib/awaySummary.ts`、`frontend/src/components/shell/AwayCard.tsx` | Create | 离开时刻、离开摘要纯函数、卡片 | 9 |
| `frontend/src/components/shell/TriageList.tsx` | Modify | 在「需要你」之前挂 AwayCard | 9 |
| `frontend/src/lib/crewVariant.ts`、`frontend/src/components/shell/CrewVariantBadge.tsx` | Create | 三档派生、variant→字段映射、徽标 | 10 |
| `frontend/src/lib/paletteParse.ts`、`frontend/src/components/shell/CommandPalette.tsx`、`useShellState.ts`、`frontend/src/lib/api/sessions.ts`、`TriageRow.tsx`、`FocusHeader.tsx` | Modify | `crew:goal`、二级 chip、create 透传、徽标 | 10 |
| `frontend/src/lib/conventionPrompt.ts`、`frontend/src/components/composer/ConventionDialog.tsx` | Create | 约定模板、对话框 | 11 |
| `frontend/src/components/AcpChatView.tsx` | Modify | ＋ 菜单「记为约定…」 | 11 |

分支：S5-a 在 `feat/s5a-backend` 上做（Task 1–8），S5-b 在 `feat/s5b-frontend` 上做（Task 9–12），各自在部署 task 里合入 `main`。

---
# S5-a：后端

### Task 1: SP — Crew spike 补测，产出帧夹具

**依据:** spec §5、D10、K1、K2。R1/R2 已实测（调研 §7）；本 task 补两件事：`crew_result` 的完整形态，以及 conductor 普通模式（`agent=kirocrew-conductor`, `mode=""`）有没有 `chat_done`——D1 开放「目标指挥」以此为前提。顺带确认 Gateway 在**建 slot 时**是否接受 `mode` / `agent`：Task 7 的 `slot_create_body` 依赖这一点，§7 只验证过事后 `PATCH …/mode`。

**Files:**
- Create: `/tmp/zmx-s5-probe/probe.mjs`（一次性脚本，**不提交**；和上次 probe 一样放临时目录）
- Create: `src/acp/testdata/crew_frames_crew_result.json`、`crew_frames_crew_ask.json`、`crew_frames_crew_meta.json`、`crew_frames_crew_ack.json`、`crew_frames_normal_turn.json`
- Modify: `docs/superpowers/audits/2026-09-29-kiro-crew-gap-research.md`（§7 末尾追加「S5 SP 补测」小节）
- Modify: `frontend/src/lib/crewVariant.ts` 的 `GOAL_ENABLED` 值由本 task 决定（文件在 Task 10 创建；本 task 只把结论写进调研 §7，Task 10 照结论取值）

**Interfaces:**
- Consumes: 线上 Gateway `127.0.0.1:5476`；secret 文件 `~/.kiro/crew/run/gateway-5476.secret`，回落 `~/.kiro/crew/.local_secret`（与 `crew_process.rs:read_gateway_secret` 同序、同样 trim）。
- Produces:
  - 五个夹具文件，每个都是 **JSON 数组，元素是 Gateway 原始帧对象** `{"type": "...", "data": {...}}`。`data.slot` 统一改写为 `"zmxprobe"`。Task 5 用 `include_str!("testdata/crew_frames_<name>.json")` 读入。
  - 调研 §7 的三条结论：`CONDUCTOR_CHAT_DONE = yes|no|unverified`、`CREATE_WITH_MODE = yes|no|unverified`、`CREATE_WITH_AGENT = yes|no|unverified`。Task 7 和 Task 10 按这三条取分支。

- [ ] **Step 1: 确认 Gateway 在跑，且没有残留 probe slot**

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5476/ || true
```

Expected: 任意三位 HTTP 状态码（Gateway 在监听）。输出 `000` → Gateway 没在跑，直接跳到 Step 5「兜底夹具」，三条结论都记 `unverified`。

- [ ] **Step 2: 写 probe 脚本**

`/tmp/zmx-s5-probe/probe.mjs`：

```js
// One-shot Crew probe (S5 SP). Secret/token live only in this process's memory;
// nothing sensitive is written to disk or printed. Run: node --experimental-websocket probe.mjs
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const PORT = 5476
const BASE = `http://127.0.0.1:${PORT}`
const OUT = process.argv[2]            // repo src/acp/testdata
const HOME = homedir()

function secret() {
  for (const p of [join(HOME, '.kiro/crew/run', `gateway-${PORT}.secret`), join(HOME, '.kiro/crew/.local_secret')]) {
    try { const s = readFileSync(p, 'utf8').trim(); if (s) return s } catch { /* fall through */ }
  }
  throw new Error('crew secret unreadable')
}
const hdr = () => ({ 'X-Internal-Secret': secret(), 'Content-Type': 'application/json' })
async function rest(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: hdr(), body: body ? JSON.stringify(body) : undefined })
  let j = null; try { j = await r.json() } catch { /* body dropped */ }
  return { status: r.status, json: j }
}
async function token() {
  const r = await fetch(`${BASE}/api/token/local?ttl=30m`, { headers: { 'X-Local-Secret': secret() } })
  return (await r.json()).token
}

const frames = []                       // [{t, slot, frame}]
const t0 = Date.now()
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/ws?token=${await token()}`)
await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error('ws connect failed')) })
ws.onmessage = e => {
  try {
    const f = JSON.parse(e.data)
    const slot = f?.data?.slot
    if (typeof slot === 'string' && slot.startsWith('zmxprobe')) frames.push({ t: (Date.now() - t0) / 1000, slot, frame: f })
  } catch { /* non-JSON */ }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const rand = () => randomUUID().slice(0, 6)
const proj = mkdtempSync(join(tmpdir(), 'zmxprobe-'))
const report = {}

// ── A: crew mode, real small task ──
const a = `zmxprobe${rand()}`
report.a_create = await rest('POST', '/api/chat/slots', { name: a, mode: 'crew' })
report.a_info = (await rest('GET', `/api/chat/slots/${a}`)).json
report.a_project = (await rest('POST', `/api/chat/slots/${a}/project`, { project: proj })).status
report.a_chat = (await rest('POST', '/api/chat', { slot: a, message: '在当前目录创建 hello.txt 写入 hi，然后告诉我文件内容' })).status
await sleep(60_000)

// ── B: conductor agent, normal mode ──
const b = `zmxprobe${rand()}`
report.b_create = await rest('POST', '/api/chat/slots', { name: b, agent: 'kirocrew-conductor' })
report.b_info = (await rest('GET', `/api/chat/slots/${b}`)).json
report.b_project = (await rest('POST', `/api/chat/slots/${b}/project`, { project: proj })).status
report.b_chat = (await rest('POST', '/api/chat', { slot: b, message: '只回复 OK' })).status
for (let i = 0; i < 90 && !frames.some(x => x.slot === b && x.frame.type === 'chat_done'); i++) await sleep(1000)

// ── cleanup (always) ──
for (const s of [a, b]) {
  report[`del_${s === a ? 'a' : 'b'}`] = (await rest('DELETE', `/api/chat/slots/${s}`)).status
  report[`gone_${s === a ? 'a' : 'b'}`] = (await rest('GET', `/api/chat/slots/${s}`)).status
}
ws.close()

// ── redact + write fixtures ──
const scrub = v => JSON.parse(JSON.stringify(v)
  .replaceAll(a, 'zmxprobe').replaceAll(b, 'zmxprobe')
  .replaceAll(proj, '/tmp/zmxprobe-proj').replaceAll(HOME, '/home/user'))
const pick = (slot, pred) => frames.filter(x => x.slot === slot && pred(x.frame)).map(x => scrub(x.frame))
const kind = k => f => f.type === 'chat_message' && f.data?.kind === k
const TURN_TYPES = new Set(['chat_status', 'chat_chunk', 'tool_call', 'tool_result', 'chat_message', 'chat_done', 'chat_error', 'context_usage'])
mkdirSync(OUT, { recursive: true })
const files = {
  crew_result: pick(a, kind('crew_result')), crew_ask: pick(a, kind('crew_ask')),
  crew_meta: pick(a, kind('crew_meta')), crew_ack: pick(a, kind('crew_ack')),
  normal_turn: pick(b, f => TURN_TYPES.has(f.type)),
}
for (const [n, arr] of Object.entries(files)) writeFileSync(join(OUT, `crew_frames_${n}.json`), JSON.stringify(arr, null, 2) + '\n')

// ── summary (no secrets: only statuses, key names, frame types) ──
const seq = s => frames.filter(x => x.slot === s).map(x => `+${x.t.toFixed(1)}s ${x.frame.type}${x.frame.data?.kind ? ' kind=' + x.frame.data.kind : ''}`)
console.log(JSON.stringify({
  a_create: report.a_create.status, a_mode: report.a_info?.mode, a_info_keys: Object.keys(report.a_info ?? {}),
  b_create: report.b_create.status, b_agent: report.b_info?.agent, b_info_keys: Object.keys(report.b_info ?? {}),
  a_chat: report.a_chat, b_chat: report.b_chat,
  del: [report.del_a, report.del_b], gone: [report.gone_a, report.gone_b],
  counts: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.length])),
  crew_result_data_keys: files.crew_result[0] ? Object.keys(files.crew_result[0].data) : null,
  crew_result_meta_keys: files.crew_result[0]?.data?.meta ? Object.keys(files.crew_result[0].data.meta) : null,
  a_seq: seq(a), b_seq: seq(b),
}, null, 2))
```

- [ ] **Step 3: 运行 probe**

```bash
mkdir -p /tmp/zmx-s5-probe && cd /tmp/zmx-s5-probe
node --experimental-websocket probe.mjs /home/ubuntu/s3-workspace/keith-space/github-search/ai/zeromux/src/acp/testdata 2>&1 | tee summary.json
```

Expected: 约 2.5 分钟后打印 summary。`del` 为 `[200,200]`，`gone` 为 `[404,404]`。`gone` 不是 404 时，手动清理：`curl -s -X DELETE -H "X-Internal-Secret: $(cat ~/.kiro/crew/run/gateway-5476.secret)" http://127.0.0.1:5476/api/chat/slots/<name>`（在终端里现读，不写进任何文件）。

- [ ] **Step 4: 审核夹具并判定三条结论**

```bash
cd /home/ubuntu/s3-workspace/keith-space/github-search/ai/zeromux
grep -lE '/home/ubuntu|token=|X-Internal|secret' src/acp/testdata/crew_frames_*.json   # 必须无输出
python3 -c "import json,glob;[json.load(open(f)) for f in glob.glob('src/acp/testdata/crew_frames_*.json')];print('json ok')"
```

判定：
- `CONDUCTOR_CHAT_DONE`：summary 的 `b_seq` 含 `chat_done` → `yes`；60–90s 内没有 → `no`。
- `CREATE_WITH_MODE`：`a_mode == "crew"` → `yes`；是别的值 → `no`；`a_info_keys` 里没有 `mode` 字段 → `unverified`。
- `CREATE_WITH_AGENT`：`b_agent == "kirocrew-conductor"` → `yes`；是别的值 → `no`；没有该字段 → `unverified`。

某个夹具数组为空时（例如这次真实任务直接给了 `crew_result`，没有 `crew_ask`），用 Step 5 对应的兜底内容补齐这一个文件，并在 §7 注明「构造」。

- [ ] **Step 5: 兜底夹具（Step 1 失败，或 Step 4 某个文件为空时使用）**

帧形态取自调研 §7 已实测的帧（`/tmp/zmx-crew-probe/result.json`），slot 已改写。`crew_result` 没有实测样本，按同形态构造：`content` + `meta.mid` + `meta.crew_reply`；G1 的解析是宽松的，同时兼容 `data.text`。

`src/acp/testdata/crew_frames_crew_ack.json`：
```json
[
  {"type": "chat_message", "data": {"slot": "zmxprobe", "role": "assistant", "content": "On it.", "cls": "msg msg-a", "meta": {"mid": "m-8b0aa087b45b49b0"}, "kind": "crew_ack"}}
]
```

`src/acp/testdata/crew_frames_crew_ask.json`：
```json
[
  {"type": "chat_message", "data": {"slot": "zmxprobe", "role": "assistant", "content": "Couldn't start that one — say the word and I'll retry.", "cls": "msg msg-a crew-reply", "meta": {"crew_reply": true, "mid": "m-d356a6b392b34029"}, "kind": "crew_ask"}},
  {"type": "chat_message", "data": {"slot": "zmxprobe", "role": "assistant", "content": "Couldn't start that one — say the word and I'll retry.", "cls": "msg msg-a crew-reply", "meta": {"crew_reply": true, "mid": "m-3b738234918e45dc"}, "kind": "crew_ask"}},
  {"type": "chat_message", "data": {"slot": "zmxprobe", "role": "assistant", "content": "Couldn't start that one — say the word and I'll retry.", "cls": "msg msg-a crew-reply", "meta": {"crew_reply": true, "mid": "m-7e0d520e5ea94386"}, "kind": "crew_ask"}}
]
```

`src/acp/testdata/crew_frames_crew_meta.json`：
```json
[
  {"type": "chat_message", "data": {"slot": "zmxprobe", "role": "assistant", "content": "I could not work out how to route this request after several attempts, so nothing was started. Please rephrase and send again.", "cls": "msg msg-a crew-reply", "meta": {"crew_reply": true, "mid": "m-c8d01848b0c94466"}, "kind": "crew_meta"}}
]
```

`src/acp/testdata/crew_frames_crew_result.json`（构造）：
```json
[
  {"type": "chat_message", "data": {"slot": "zmxprobe", "role": "assistant", "content": "已创建 hello.txt，内容为：hi", "cls": "msg msg-a crew-reply", "meta": {"crew_reply": true, "mid": "m-00000000000000r1"}, "kind": "crew_result"}}
]
```

`src/acp/testdata/crew_frames_normal_turn.json`（R1 普通模式实测帧；**不能**证明 conductor 有 `chat_done`）：
```json
[
  {"type": "chat_status", "data": {"slot": "zmxprobe", "status": "Thinking…"}},
  {"type": "chat_chunk", "data": {"slot": "zmxprobe", "content": "NORMAL-OK", "seq": 1}},
  {"type": "context_usage", "data": {"slot": "zmxprobe", "pct": 10.5, "used_tokens": 105019, "window_tokens": 1000000}},
  {"type": "chat_done", "data": {"slot": "zmxprobe"}}
]
```

用了兜底 → `CONDUCTOR_CHAT_DONE = unverified`；对应项没测到的，`CREATE_WITH_MODE` / `CREATE_WITH_AGENT` 也记 `unverified`。

- [ ] **Step 6: 结论写进调研 §7**

在 `docs/superpowers/audits/2026-09-29-kiro-crew-gap-research.md` 末尾追加（把尖括号换成实测值）：

```markdown
### S5 SP 补测（<日期>）

经用户授权，建临时 slot `zmxprobe<6位>`（crew mode，真实小任务）与 `zmxprobe<6位>`（agent=kirocrew-conductor，普通模式），测完 DELETE → 200、GET → 404。secret/token 只在进程内存中，未输出、未落盘。脱敏帧存为 `src/acp/testdata/crew_frames_*.json`（slot 统一改写为 `zmxprobe`）。

- `CONDUCTOR_CHAT_DONE = <yes|no|unverified>`：<b_seq 摘要>
- `CREATE_WITH_MODE = <yes|no|unverified>`：建 slot 时带 `mode:"crew"`，GET 回读 mode=<值>
- `CREATE_WITH_AGENT = <yes|no|unverified>`：建 slot 时带 `agent`，GET 回读 agent=<值>
- `crew_result` 字段：data 键 <crew_result_data_keys>；meta 键 <crew_result_meta_keys>（<实测|构造>）
- 附带发现：`context_usage` 实测字段为 `used_tokens` / `window_tokens` / `pct`，而 `normalize_frame` 读的是 `used` / `total|limit` → 当前 Crew 的 ctx% 恒不显示。不在 S5 范围，记入 deferred。

对 S5 的影响：`CONDUCTOR_CHAT_DONE != yes` → 按 spec §5 兜底，「目标指挥」chip 推迟到 S6 T3（Task 10 取 `GOAL_ENABLED = false`）；`CREATE_WITH_MODE != yes` → Task 7 在建 slot 后补一次 `PATCH …/mode`。
```

- [ ] **Step 7: Commit**

```bash
git checkout -b feat/s5a-backend
git add src/acp/testdata/crew_frames_*.json docs/superpowers/audits/2026-09-29-kiro-crew-gap-research.md
git commit -m "test(crew): S5 SP probe — redacted Gateway frame fixtures + findings

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 2: F1 — U1 七列迁移、`update_posture`、`persist_posture`、`load_all` 回填

**依据:** spec §1、U1、U3、D9、K3、K6。

**Files:**
- Modify: `src/run_metrics.rs:7-12`（`RunOutcome` 后加 `impl`），`mod tests`（`:237`）
- Modify: `src/session_store.rs`：`PersistedSession`（`:13-30`）、`open`（`:60-66` 之后）、`upsert`（`:69-88`）、`update_description` 之后新增 `update_posture`、`load_all`（`:154-183`）、`mod tests`（`:187`）
- Modify: `src/session_manager.rs`：`Posture`（`:3603-3615`）、`settle_posture`（`:2127-2139`）、`load_persisted`（`:2337`）、`persisted_of`（`:2647-2665`）、测试字面量 `persisted()`（`:7048-7056`）；新增 `mod posture_persist_tests`（文件末尾）
- Test: `src/run_metrics.rs` `mod tests`、`src/session_store.rs` `mod tests`、`src/session_manager.rs` `mod posture_persist_tests`

**Interfaces:**
- Consumes: 无（第一个代码 task）。
- Produces:
  - `impl RunOutcome { pub fn as_str(self) -> &'static str; pub fn parse_lenient(s: &str) -> Option<RunOutcome> }`
  - `pub struct PersistedPosture { pub last_outcome: Option<String>, pub last_outcome_ms: Option<i64>, pub last_snippet: Option<String>, pub awaiting_input: bool }`（`#[derive(Debug, Clone, PartialEq, Default)]`，在 `session_store.rs`）
  - `PersistedSession` 新字段：`pub posture: PersistedPosture, pub crew_mode: String, pub crew_agent: String, pub crew_origin: String`
  - `SessionStore::update_posture(&self, id: &str, p: &PersistedPosture) -> Result<(), String>`
  - `Posture.awaiting_input: bool`（私有 struct 的字段；S6 直接读写 `s.posture.awaiting_input`）
  - `SessionManager::persist_posture(&self, sid: &str)`（私有方法，`fn persist_posture` 字样供 S6 grep）
  - `fn persisted_posture_of(p: &Posture) -> PersistedPosture`

- [ ] **Step 1: 写 `RunOutcome` 字符串往返的失败测试**

`src/run_metrics.rs` 的 `mod tests` 末尾追加：

```rust
    #[test]
    fn outcome_str_round_trips_and_unknown_is_none() {
        for o in [RunOutcome::Completed, RunOutcome::Errored, RunOutcome::Timeout, RunOutcome::Cancelled] {
            assert_eq!(RunOutcome::parse_lenient(o.as_str()), Some(o));
        }
        // Must match the serde snake_case wire form the frontend already reads.
        assert_eq!(RunOutcome::Completed.as_str(), "completed");
        assert_eq!(serde_json::to_string(&RunOutcome::Timeout).unwrap(), "\"timeout\"");
        assert_eq!(RunOutcome::parse_lenient("exploded"), None);
        assert_eq!(RunOutcome::parse_lenient(""), None);
    }
```

- [ ] **Step 2: 写 store 的失败测试**

`src/session_store.rs` 的 `mod tests`：先把 `sample()` 字面量末尾 `tmux_origin: None, cols: 80, rows: 24, pending_kill_until: None,` 之后追加一行：

```rust
            posture: PersistedPosture::default(),
            crew_mode: String::new(), crew_agent: String::new(), crew_origin: "zeromux".into(),
```

再在 `mod tests` 末尾追加：

```rust
    #[test]
    fn open_twice_is_idempotent() {
        let d = tempfile::tempdir().unwrap();
        SessionStore::open(d.path()).unwrap();
        // Second open re-runs every ALTER; duplicate-column errors must be swallowed.
        let st = SessionStore::open(d.path()).unwrap();
        st.upsert(&sample("a", None)).unwrap();
        assert_eq!(st.load_all().unwrap().len(), 1);
    }

    #[test]
    fn update_posture_round_trips() {
        let (st, _d) = tmp_store();
        st.upsert(&sample("a", None)).unwrap();
        let p = PersistedPosture {
            last_outcome: Some("completed".into()), last_outcome_ms: Some(1234),
            last_snippet: Some("全部通过".into()), awaiting_input: true,
        };
        st.update_posture("a", &p).unwrap();
        assert_eq!(st.load_all().unwrap()[0].posture, p);
    }

    #[test]
    fn upsert_does_not_clobber_posture() {
        // posture is per-turn runtime state; a metadata write (rename, resize,
        // resume-token) must never reset it (spec §1.2).
        let (st, _d) = tmp_store();
        st.upsert(&sample("a", None)).unwrap();
        let p = PersistedPosture { last_outcome: Some("errored".into()), last_outcome_ms: Some(9), ..Default::default() };
        st.update_posture("a", &p).unwrap();
        let mut renamed = sample("a", None);
        renamed.name = "renamed".into();
        renamed.posture = PersistedPosture::default();   // whatever the caller carries is ignored
        st.upsert(&renamed).unwrap();
        let r = &st.load_all().unwrap()[0];
        assert_eq!(r.name, "renamed");
        assert_eq!(r.posture, p);
    }

    #[test]
    fn crew_columns_round_trip_through_upsert() {
        let (st, _d) = tmp_store();
        let mut p = sample("c", Some(ResumeToken::Crew("zmx-k".into())));
        p.session_type = SessionType::Crew;
        p.crew_mode = "crew".into();
        p.crew_agent = "kirocrew-conductor".into();
        p.crew_origin = "external".into();
        st.upsert(&p).unwrap();
        let r = st.load_all().unwrap().into_iter().find(|x| x.id == "c").unwrap();
        assert_eq!((r.crew_mode.as_str(), r.crew_agent.as_str(), r.crew_origin.as_str()),
                   ("crew", "kirocrew-conductor", "external"));
    }

    #[test]
    fn pre_s5_rows_load_with_empty_posture_and_zeromux_origin() {
        // A DB written by the pre-S5 binary: none of the seven columns exist yet.
        let d = tempfile::tempdir().unwrap();
        {
            let conn = Connection::open(d.path().join("zeromux.db")).unwrap();
            conn.execute_batch(
                "CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
                   work_dir TEXT NOT NULL, owner_id TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
                   resume_kind TEXT, resume_value TEXT, worktree_path TEXT, created_ms INTEGER NOT NULL,
                   source_task_id TEXT, name_is_auto INTEGER NOT NULL DEFAULT 1, tmux_origin TEXT,
                   cols INTEGER NOT NULL DEFAULT 80, rows INTEGER NOT NULL DEFAULT 24, pending_kill_until INTEGER);
                 INSERT INTO sessions (id,name,type,work_dir,owner_id,created_ms) VALUES ('old','n','crew','/w','u',1);"
            ).unwrap();
        }
        let st = SessionStore::open(d.path()).unwrap();
        let r = st.load_all().unwrap().into_iter().find(|x| x.id == "old").unwrap();
        assert_eq!(r.posture, PersistedPosture::default());
        assert_eq!((r.crew_mode.as_str(), r.crew_agent.as_str(), r.crew_origin.as_str()), ("", "", "zeromux"));
    }
```

- [ ] **Step 3: 写 manager 的失败测试**

`src/session_manager.rs` 文件末尾追加新模块：

```rust
#[cfg(test)]
mod posture_persist_tests {
    use super::*;
    use crate::run_metrics::RunOutcome;

    fn session(id: &str) -> Session {
        Session {
            id: id.into(), name: "n".into(), session_type: SessionType::Claude, cols: 80, rows: 24,
            work_dir: "/tmp".into(), owner_id: "o".into(), description: String::new(),
            name_is_auto: true, status: SessionMeta::Idle, resume_token: None, tmux_origin: None,
            pending_kill_until: None, worktree_path: None, created_ms: 0, source_task_id: None,
            spawning: false, last_activity_ms: 0, turns_completed: 0, run_metrics: VecDeque::new(),
            lifetime_turns: 0, lifetime_duration_ms: 0, lifetime_cost_usd: 0.0, posture: Posture::default(),
            running: None, scrollback: VecDeque::new(), scrollback_bytes: 0,
        }
    }

    fn mgr_at(dir: &std::path::Path) -> Arc<SessionManager> {
        let events = Arc::new(crate::events::EventStore::open(dir).unwrap());
        let store = Arc::new(crate::session_store::SessionStore::open(dir).unwrap());
        SessionManager::new(events, store, "claude".into(), "codex".into(), "off".into(),
            5476, "/tmp/crew".into(), "bash".into(), false,
            crate::tmux::TmuxCtl::new(Some("zmx-test-unused".into())))
    }

    fn seed(m: &SessionManager, s: Session) {
        m.store.upsert(&persisted_of(&s)).unwrap();
        m.sessions.lock().unwrap().insert(s.id.clone(), s);
    }

    fn result(text: &str) -> AcpEvent {
        AcpEvent::Result { text: text.into(), turn_id: 0, session_id: String::new(),
            cost_usd: None, tokens_in: None, tokens_out: None }
    }

    fn reloaded_info(dir: &std::path::Path, id: &str) -> SessionInfo {
        let m = mgr_at(dir);
        m.load_persisted();
        let map = m.sessions.lock().unwrap();
        session_info_of(map.get(id).unwrap())
    }

    #[test]
    fn completed_settle_survives_restart() {
        let d = tempfile::tempdir().unwrap();
        let m = mgr_at(d.path());
        seed(&m, session("p"));
        m.record_and_broadcast("p", "{}".into(), true, posture_delta_of(&result("All green\nShipped")));
        m.settle_posture("p", RunOutcome::Completed);
        let before = session_info_of(m.sessions.lock().unwrap().get("p").unwrap());
        drop(m);
        let after = reloaded_info(d.path(), "p");
        assert_eq!(after.last_outcome, Some("completed"));
        assert_eq!(after.last_outcome_ms, before.last_outcome_ms, "timestamp survives verbatim");
        assert_eq!(after.last_snippet.as_deref(), Some("Shipped"));
    }

    #[test]
    fn errored_settle_persists_a_null_snippet() {
        // D9 / A10: a failed turn must not resurrect the previous turn's summary after restart.
        let d = tempfile::tempdir().unwrap();
        let m = mgr_at(d.path());
        seed(&m, session("p"));
        m.record_and_broadcast("p", "{}".into(), true, posture_delta_of(&result("old summary")));
        m.settle_posture("p", RunOutcome::Completed);
        m.settle_posture("p", RunOutcome::Errored);
        drop(m);
        let after = reloaded_info(d.path(), "p");
        assert_eq!(after.last_outcome, Some("errored"));
        assert_eq!(after.last_snippet, None);
    }

    #[test]
    fn current_step_and_approvals_are_not_restored() {
        let d = tempfile::tempdir().unwrap();
        let m = mgr_at(d.path());
        seed(&m, session("p"));
        m.settle_posture("p", RunOutcome::Completed);
        // A new turn is mid-flight when the process dies.
        let tool = AcpEvent::ContentBlock { block_type: std::borrow::Cow::Borrowed("tool_use"), turn_id: 0,
            text: None, name: Some("Bash".into()), input: None, streaming: None, summary: None };
        m.record_and_broadcast("p", "{}".into(), true, posture_delta_of(&tool));
        let ap = AcpEvent::Approval { id: "a".into(), tool: "t".into(), tool_input: None, tool_purpose: None, slot: "s".into() };
        m.record_and_broadcast("p", "{}".into(), true, posture_delta_of(&ap));
        m.persist_posture("p");
        drop(m);
        let after = reloaded_info(d.path(), "p");
        assert_eq!(after.current_step, None);
        assert_eq!(after.pending_approvals, 0);
        assert_eq!(after.last_outcome, Some("completed"));
    }

    #[test]
    fn awaiting_input_round_trips() {
        let d = tempfile::tempdir().unwrap();
        let m = mgr_at(d.path());
        seed(&m, session("p"));
        m.sessions.lock().unwrap().get_mut("p").unwrap().posture.awaiting_input = true;
        m.persist_posture("p");
        drop(m);
        let m2 = mgr_at(d.path());
        m2.load_persisted();
        assert!(m2.sessions.lock().unwrap().get("p").unwrap().posture.awaiting_input);
    }

    #[test]
    fn unknown_outcome_string_loads_as_none_without_panic() {
        let d = tempfile::tempdir().unwrap();
        let m = mgr_at(d.path());
        seed(&m, session("p"));
        m.store.update_posture("p", &crate::session_store::PersistedPosture {
            last_outcome: Some("exploded".into()), last_outcome_ms: Some(7), ..Default::default()
        }).unwrap();
        drop(m);
        let after = reloaded_info(d.path(), "p");
        assert_eq!(after.last_outcome, None);
        assert_eq!(after.last_outcome_ms, Some(7));
    }

    #[test]
    fn persist_for_a_session_missing_from_the_store_is_a_silent_noop() {
        // In-memory-only sessions (every other test module) must not error or panic.
        let d = tempfile::tempdir().unwrap();
        let m = mgr_at(d.path());
        m.sessions.lock().unwrap().insert("ghost".into(), session("ghost"));
        m.settle_posture("ghost", RunOutcome::Completed);
        m.persist_posture("nope");
    }
}
```

- [ ] **Step 4: 运行，确认失败**

Run: `cargo test outcome_str_round_trips 2>&1 | tail -5; cargo test session_store::tests 2>&1 | tail -5; cargo test posture_persist_tests 2>&1 | tail -5`
Expected: 编译失败，报 `no function or associated item named 'as_str'`、`cannot find type 'PersistedPosture'`、`no field 'awaiting_input'`、`no method named 'persist_posture'`。

- [ ] **Step 5: 实现 `RunOutcome` 字符串**

`src/run_metrics.rs`，紧跟 `pub enum RunOutcome { … }` 之后：

```rust
impl RunOutcome {
    /// Same spelling as the serde snake_case wire form (and SessionInfo.last_outcome).
    pub fn as_str(self) -> &'static str {
        match self {
            RunOutcome::Completed => "completed",
            RunOutcome::Errored => "errored",
            RunOutcome::Timeout => "timeout",
            RunOutcome::Cancelled => "cancelled",
        }
    }

    /// Inverse of `as_str` for rows read back from SQLite. Unknown → None, never panic
    /// (a newer binary may have written a value this one does not know).
    pub fn parse_lenient(s: &str) -> Option<RunOutcome> {
        match s {
            "completed" => Some(RunOutcome::Completed),
            "errored" => Some(RunOutcome::Errored),
            "timeout" => Some(RunOutcome::Timeout),
            "cancelled" => Some(RunOutcome::Cancelled),
            _ => None,
        }
    }
}
```

- [ ] **Step 6: 实现 store**

`src/session_store.rs`，`PersistedSession` 之前新增：

```rust
/// The persisted subset of triage posture (S5 U3). `current_step` / approvals are
/// turn-internal and deliberately absent: after a restart no turn is running.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct PersistedPosture {
    pub last_outcome: Option<String>,
    pub last_outcome_ms: Option<i64>,
    pub last_snippet: Option<String>,
    pub awaiting_input: bool,
}
```

`PersistedSession` 在 `pending_kill_until` 之后追加：

```rust
    /// Written ONLY by `update_posture`; `upsert` ignores it (spec §1.2).
    pub posture: PersistedPosture,
    /// S5 U1. Gateway raw values: mode `""|crew`, agent e.g. `kirocrew-conductor`;
    /// origin `zeromux|external` decides slot ownership (U2). Empty/zeromux for non-Crew.
    pub crew_mode: String,
    pub crew_agent: String,
    pub crew_origin: String,
```

`open()` 在 `pending_kill_until` 那行 ALTER 之后追加：

```rust
        // S5 U1: posture (F1) + Crew slot metadata (G2/R4). Column names are shared with S6/S7.
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN last_outcome TEXT", []);
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN last_outcome_ms INTEGER", []);
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN last_snippet TEXT", []);
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN awaiting_input INTEGER NOT NULL DEFAULT 0", []);
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN crew_mode TEXT NOT NULL DEFAULT ''", []);
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN crew_agent TEXT NOT NULL DEFAULT ''", []);
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN crew_origin TEXT NOT NULL DEFAULT 'zeromux'", []);
```

`upsert` 整体替换为：

```rust
    pub fn upsert(&self, s: &PersistedSession) -> Result<(), String> {
        let (rk, rv) = match &s.resume_token {
            Some(t) => { let (k, v) = t.to_kind_value(); (Some(k.to_string()), Some(v)) }
            None => (None, None),
        };
        let conn = self.conn.lock().unwrap();
        // Posture columns are intentionally absent: they are per-turn runtime state
        // written only by update_posture, never by a metadata write.
        conn.execute(
            "INSERT INTO sessions (id,name,type,work_dir,owner_id,description,resume_kind,resume_value,worktree_path,created_ms,source_task_id,name_is_auto,tmux_origin,cols,rows,pending_kill_until,crew_mode,crew_agent,crew_origin)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)
             ON CONFLICT(id) DO UPDATE SET
               name=?2, type=?3, work_dir=?4, owner_id=?5, description=?6,
               resume_kind=?7, resume_value=?8, worktree_path=?9, name_is_auto=?12,
               tmux_origin=?13, cols=?14, rows=?15, pending_kill_until=?16,
               crew_mode=?17, crew_agent=?18, crew_origin=?19",
            params![s.id, s.name, s.session_type.to_string(), s.work_dir, s.owner_id,
                    s.description, rk, rv, s.worktree_path, s.created_ms, s.source_task_id,
                    s.name_is_auto as i64, s.tmux_origin, s.cols as i64, s.rows as i64, s.pending_kill_until,
                    s.crew_mode, s.crew_agent, s.crew_origin],
        )
        .map_err(|e| format!("upsert failed: {}", e))?;
        Ok(())
    }
```

`update_description` 之后新增：

```rust
    /// U3: one UPDATE per settled turn. The row may not exist (in-memory test
    /// sessions) — zero rows affected is not an error.
    pub fn update_posture(&self, id: &str, p: &PersistedPosture) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE sessions SET last_outcome=?2, last_outcome_ms=?3, last_snippet=?4, awaiting_input=?5 WHERE id=?1",
            params![id, p.last_outcome, p.last_outcome_ms, p.last_snippet, p.awaiting_input as i64])
            .map_err(|e| format!("update_posture failed: {}", e))?;
        Ok(())
    }
```

`load_all`：SELECT 列表末尾 `pending_kill_until` 之后追加 `,last_outcome,last_outcome_ms,last_snippet,awaiting_input,crew_mode,crew_agent,crew_origin`；`PersistedSession { … }` 构造里 `pending_kill_until: row.get(15)?,` 之后追加：

```rust
                posture: PersistedPosture {
                    last_outcome: row.get(16)?,
                    last_outcome_ms: row.get(17)?,
                    last_snippet: row.get(18)?,
                    awaiting_input: row.get::<_, i64>(19)? != 0,
                },
                crew_mode: row.get(20)?,
                crew_agent: row.get(21)?,
                crew_origin: row.get(22)?,
```

- [ ] **Step 7: 实现 manager 侧**

`src/session_manager.rs`，`Posture` 的文档注释与定义替换为：

```rust
/// Precomputed "at a glance" state for the triage list (spec v3 §0.5.1 M2/M3/M5).
/// Maintained only under the sessions lock from `record_and_broadcast` /
/// `settle_posture` / `approval_resolved`; `session_info_of` just copies it.
/// `last_outcome*` / `last_snippet` / `awaiting_input` are persisted once per settled
/// turn by `persist_posture` (S5 U3); `current_step` / `approval_ids` stay in memory.
#[derive(Default, Clone, Debug, PartialEq)]
struct Posture {
    last_outcome: Option<crate::run_metrics::RunOutcome>,
    last_outcome_ms: Option<i64>,
    last_snippet: Option<String>,
    current_step: Option<String>,
    /// Unresolved Crew approval ids, deduped (M9b). Exported as `len()`.
    approval_ids: Vec<String>,
    /// 「待回答」 (S6 G3 writes it; S5 only persists and restores it).
    awaiting_input: bool,
}

fn persisted_posture_of(p: &Posture) -> crate::session_store::PersistedPosture {
    crate::session_store::PersistedPosture {
        last_outcome: p.last_outcome.map(|o| o.as_str().to_string()),
        last_outcome_ms: p.last_outcome_ms,
        last_snippet: p.last_snippet.clone(),
        awaiting_input: p.awaiting_input,
    }
}
```

`settle_posture` 整体替换为：

```rust
    /// A turn truly settled (not a Claude SkipBoundary): record its outcome and
    /// clear per-turn posture. Called beside `record_run_metric` in each fan-out.
    fn settle_posture(&self, sid: &str, outcome: crate::run_metrics::RunOutcome) {
        {
            let mut map = self.sessions.lock().unwrap();
            let Some(s) = map.get_mut(sid) else { return };
            s.posture.last_outcome = Some(outcome);
            s.posture.last_outcome_ms = Some(now_millis());
            s.posture.current_step = None;
            s.posture.approval_ids.clear();
            // A failed turn has no summary of its own; don't show the previous turn's (A10).
            if matches!(outcome, crate::run_metrics::RunOutcome::Errored | crate::run_metrics::RunOutcome::Timeout) {
                s.posture.last_snippet = None;
            }
        }
        // U3: lock released above — never hold `sessions` across SQLite I/O.
        self.persist_posture(sid);
    }

    /// U3: snapshot the persisted posture subset under the sessions lock, then write
    /// it OUTSIDE the lock (SQLite on JuiceFS can be slow). Best-effort: a failed
    /// write only warns — the fan-out must never stall on persistence.
    fn persist_posture(&self, sid: &str) {
        let snap = {
            let map = self.sessions.lock().unwrap();
            let Some(s) = map.get(sid) else { return };
            persisted_posture_of(&s.posture)
        };
        if let Err(e) = self.store.update_posture(sid, &snap) {
            tracing::warn!("persist posture {} failed: {}", sid, e);
        }
    }
```

`load_persisted` 中 `posture: Posture::default(),`（`:2337`）替换为：

```rust
                    posture: Posture {
                        last_outcome: p.posture.last_outcome.as_deref()
                            .and_then(crate::run_metrics::RunOutcome::parse_lenient),
                        last_outcome_ms: p.posture.last_outcome_ms,
                        last_snippet: p.posture.last_snippet,
                        awaiting_input: p.posture.awaiting_input,
                        ..Posture::default()
                    },
```

`persisted_of` 在 `pending_kill_until: s.pending_kill_until,` 之后追加（`crew_*` 在 Task 6 改为取自 `s.crew`）：

```rust
        posture: persisted_posture_of(&s.posture),
        crew_mode: String::new(),
        crew_agent: String::new(),
        crew_origin: "zeromux".into(),
```

测试字面量 `fn persisted(id, cols, rows)`（`:7048`）在 `tmux_origin: Some("own".into()), cols, rows, pending_kill_until: None,` 之后追加：

```rust
            posture: Default::default(),
            crew_mode: String::new(), crew_agent: String::new(), crew_origin: "zeromux".into(),
```

- [ ] **Step 8: 运行测试通过 + 全量**

Run: `cargo test outcome_str_round_trips && cargo test session_store::tests && cargo test posture_persist_tests && cargo test 2>&1 | tail -3`
Expected: 全部 PASS；全量 `test result: ok`。

- [ ] **Step 9: Commit**

```bash
git add src/run_metrics.rs src/session_store.rs src/session_manager.rs
git commit -m "feat(F1): persist triage posture across restarts (U1 seven columns, U3 persist_posture)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 3: F2 后端 — `payload_for` 加 `body`、正文截断、定时 `run_done`

**依据:** spec §2、U4、D7、D8。

**实现与 spec 的差异（Review Focus 1）:** spec §2.2 写的是「在 sessions 锁内读 `posture.last_snippet`」。但 Claude fan-out 里 `maybe_push_turn_done` 在 `settle_posture` **之前**调用（`session_manager.rs:2979-2982` 对比 `:3100`），这时 Errored 轮还没清掉上一轮的 snippet，推送会把上一轮结论配上「✅ 完成」标题。本 task 在 `Posture` 里加一个不持久化的 `turn_snippet`：只由本轮 Result 写入，在 turn 开始时（`apply_turn` Running 分支）清空，推送只读它。前端展示的 `last_snippet` 语义不变。

**Files:**
- Modify: `src/push.rs:343-384`（`payload_for`、`kind_allowed_by_levels`，新增 `push_body_of`），`mod tests`（`:623`）
- Modify: `src/session_manager.rs`：`Posture`（加 `turn_snippet`）、`apply_posture_delta`（`:3667`）、`apply_turn` Running 分支（`:599-606`）、`maybe_push_turn_done`（`:2794-2820`）、新增 `maybe_push_run_done`（紧跟其后）、Claude fan-out 成功分支（`:3009-3013`）、两处 `run_failed` 调用（`:3027`、`:3044`）、`term_ended`（`:1099`）；`mod posture_persist_tests` 追加用例
- Modify: `src/scheduled_tasks.rs:1040`、`:1147`，`src/web.rs:6809`（调用点补 `None`）
- Modify: `frontend/src/lib/push.ts:17-21`（`levelAllows` 与服务端映射同步）、`frontend/src/lib/__tests__/push.test.ts`
- Test: `src/push.rs` `mod tests`、`src/session_manager.rs` `mod posture_persist_tests`、`frontend/src/lib/__tests__/push.test.ts`

**Interfaces:**
- Consumes: Task 2 `Posture`（本 task 追加字段）。
- Produces:
  - `pub fn payload_for(kind: &str, name: &str, session_id: &str, fk: Option<&str>, body: Option<&str>) -> PushPayload`——签名写在**一行**里（S6 前置 grep 逐字匹配）。`body` 为 `Some(s)` 且 `s.trim()` 非空时覆盖默认正文（原样使用，不再截断），否则用默认文案。
  - `pub fn push_body_of(s: &str) -> Option<String>`：把所有空白折叠成单个空格并 trim，空串返回 None，按 char 截到 120 个，超出加 `…`（D7）。
  - `payload_for("run_done", name, …)`：标题 `⏰ {name} 完成`，默认正文「定时任务已完成」。
  - `kind_allowed_by_levels("run_done", …)` 归 routine（D8）。
  - `Posture.turn_snippet: Option<String>`（不持久化）；`fn push_snippet(&self, sid: &str) -> Option<String>`（私有）。
  - `fn maybe_push_run_done(mgr: &Weak<SessionManager>, sid: &str, owner_id: &str, verdict: Option<&str>)`

- [ ] **Step 1: 写 push 的失败测试**

`src/push.rs` 的 `mod tests`：把已有的 6 处 `payload_for(…, None)` / `payload_for(…, Some("…"))` 调用末尾各补一个参数 `, None`（`:629`、`:631`、`:634`、`:643`、`:794`、`:924`）。然后在 `mod tests` 末尾追加：

```rust
    #[test]
    fn body_overrides_default_text_when_non_blank() {
        let t = payload_for("turn_done", "重构会话", "s1", None, Some("修好了 3 个测试"));
        assert_eq!(t.title, "✅ 重构会话 完成");
        assert_eq!(t.body, "修好了 3 个测试");
        assert_eq!(payload_for("turn_done", "a", "s", None, None).body, "本轮已结束");
        assert_eq!(payload_for("turn_done", "a", "s", None, Some("  \n ")).body, "本轮已结束", "blank = None");
        // run_failed keeps its failure-kind default unless a body is given.
        let f = payload_for("run_failed", "夜跑", "s2", Some("idle_timeout"), None);
        assert!(f.body.contains("空闲") || f.body.contains("超时"));
    }

    #[test]
    fn run_done_payload_and_level() {
        let p = payload_for("run_done", "夜巡", "s", None, Some("无新告警"));
        assert_eq!(p.title, "⏰ 夜巡 完成");
        assert_eq!(p.body, "无新告警");
        assert_eq!(payload_for("run_done", "夜巡", "s", None, None).body, "定时任务已完成");
        // D8: routine, same band as turn_done.
        assert!(kind_allowed_by_levels("run_done", false, true));
        assert!(!kind_allowed_by_levels("run_done", true, false));
    }

    #[test]
    fn push_body_folds_whitespace_and_caps_by_chars() {
        assert_eq!(push_body_of("第一行\n第二行\t\t尾").as_deref(), Some("第一行 第二行 尾"));
        assert_eq!(push_body_of("  \n\t ").as_deref(), None);
        let long: String = "中".repeat(200);
        let b = push_body_of(&long).unwrap();
        assert_eq!(b.chars().count(), 121, "120 chars + ellipsis, never a byte slice (CJK safe)");
        assert!(b.ends_with('…'));
        let exact: String = "a".repeat(120);
        assert_eq!(push_body_of(&exact).unwrap(), exact, "exactly 120 → no ellipsis");
        // Emoji / 4-byte chars at the boundary must not panic.
        let emoji: String = "😀".repeat(130);
        assert_eq!(push_body_of(&emoji).unwrap().chars().count(), 121);
    }
```

- [ ] **Step 2: 写 manager 的失败测试**

`src/session_manager.rs` 的 `mod posture_persist_tests` 末尾追加：

```rust
    fn running(mut s: Session) -> Session {
        let (event_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        let (input_tx, _rx) = mpsc::channel::<SessionInput>(8);
        s.running = Some(RunningProcess { event_tx, input_tx, pty_pid: None, turn_state: TurnState::Idle,
            turn_started_ms: None, turn_seq: 0, queue_mode: QueueMode::Collect });
        s
    }

    #[test]
    fn push_snippet_is_this_turns_result_only() {
        // Review Focus 1: Claude calls maybe_push_turn_done BEFORE settle_posture, so an
        // errored turn still holds the previous turn's last_snippet at push time.
        let d = tempfile::tempdir().unwrap();
        let m = mgr_at(d.path());
        seed(&m, running(session("p")));
        m.mark_turn("p", TurnState::Running, 1);
        m.record_and_broadcast("p", "{}".into(), true, posture_delta_of(&result("全部测试通过")));
        assert_eq!(m.push_snippet("p").as_deref(), Some("全部测试通过"));
        m.settle_posture("p", RunOutcome::Completed);
        // Turn 2 errors without a Result of its own.
        m.mark_turn("p", TurnState::Running, 2);
        assert_eq!(m.push_snippet("p"), None, "a new turn starts with no push snippet");
        assert_eq!(
            session_info_of(m.sessions.lock().unwrap().get("p").unwrap()).last_snippet.as_deref(),
            Some("全部测试通过"),
            "the triage second line is unchanged until settle"
        );
    }

    #[test]
    fn push_snippet_is_not_persisted() {
        let d = tempfile::tempdir().unwrap();
        let m = mgr_at(d.path());
        seed(&m, running(session("p")));
        m.record_and_broadcast("p", "{}".into(), true, posture_delta_of(&result("done")));
        m.settle_posture("p", RunOutcome::Completed);
        drop(m);
        let m2 = mgr_at(d.path());
        m2.load_persisted();
        assert_eq!(m2.push_snippet("p"), None);
    }

    #[tokio::test]
    async fn maybe_push_run_done_is_safe_noop_without_push_service() {
        let d = tempfile::tempdir().unwrap();
        let m = mgr_at(d.path());
        seed(&m, running(session("p")));
        let weak = Arc::downgrade(&m);
        maybe_push_run_done(&weak, "p", "o", Some("无新告警"));
        maybe_push_run_done(&weak, "p", "o", None);
        maybe_push_run_done(&Weak::new(), "p", "o", None);
    }
```

- [ ] **Step 3: 写前端 `levelAllows` 的失败测试**

`frontend/src/lib/__tests__/push.test.ts` 的 `describe('push pure fns'` 内追加：

```ts
  it('levelAllows mirrors the server: run_done and term_ended are routine', () => {
    expect(levelAllows('run_done', { important: true, routine: false })).toBe(false)
    expect(levelAllows('run_done', { important: false, routine: true })).toBe(true)
    expect(levelAllows('term_ended', { important: false, routine: true })).toBe(true)
  })
```

- [ ] **Step 4: 运行，确认失败**

Run: `cargo test push::tests 2>&1 | tail -5; cargo test posture_persist_tests 2>&1 | tail -5; cd frontend && npx vitest run src/lib/__tests__/push.test.ts 2>&1 | tail -5`
Expected: Rust 编译失败（`payload_for` 参数个数不符 / `push_body_of`、`push_snippet`、`maybe_push_run_done` 未定义）；vitest 新用例 FAIL（`run_done` 被当 important）。

- [ ] **Step 5: 实现 push.rs**

`payload_for` 与 `kind_allowed_by_levels` 整体替换为：

```rust
/// Lock-screen body from free agent text (D7): whitespace (incl. newlines) folded to
/// single spaces, capped at 120 CHARS (never bytes — CJK/emoji safe) + `…`.
pub fn push_body_of(s: &str) -> Option<String> {
    let folded = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if folded.is_empty() { return None; }
    let mut it = folded.chars();
    let head: String = it.by_ref().take(120).collect();
    Some(if it.next().is_some() { format!("{head}…") } else { head })
}

/// U4: `body` = Some(non-blank) overrides the kind's default text verbatim (callers
/// pass it through `push_body_of` when it is free agent text).
pub fn payload_for(kind: &str, name: &str, session_id: &str, fk: Option<&str>, body: Option<&str>) -> PushPayload {
    let (title, default_body) = match kind {
        "turn_done" => (format!("✅ {name} 完成"), "本轮已结束".to_string()),
        "run_done" => (format!("⏰ {name} 完成"), "定时任务已完成".to_string()),
        "run_failed" => (
            format!("⚠️ {name} 失败"),
            // strip leading "因" for body, keep the rest
            failure_kind_zh(fk)
                .trim_start_matches('因')
                .to_string(),
        ),
        "confirm" => (
            format!("❓ {name} 需确认"),
            format!("{},等待确认", failure_kind_zh(fk)),
        ),
        "stuck" => (
            format!("⚠️ {name} 可能卡住"),
            "已静默约 10 分钟无输出".to_string(),
        ),
        "term_ended" => (format!("⏹ {name} 已结束"), "终端会话已退出".to_string()),
        "test" => (
            "🔔 测试推送".to_string(),
            "如果你看到这条,推送链路正常".to_string(),
        ),
        _ => (name.to_string(), String::new()),
    };
    let body = match body {
        Some(b) if !b.trim().is_empty() => b.to_string(),
        _ => default_body,
    };
    PushPayload {
        kind: kind.to_string(),
        session_id: session_id.to_string(),
        title,
        body,
    }
}

/// Single source of truth for level→kind gating (mirrors spec's mapping).
/// `test` always sends (self-test must reach the device to be meaningful).
pub fn kind_allowed_by_levels(kind: &str, lvl_important: bool, lvl_routine: bool) -> bool {
    match kind {
        "test" => true,
        "turn_done" | "run_done" | "term_ended" => lvl_routine,
        _ => lvl_important, // run_failed / confirm / stuck
    }
}
```

- [ ] **Step 6: 实现 manager 侧**

`Posture` 在 `awaiting_input` 之后追加字段（`persisted_posture_of` 不读它，所以不会落盘）：

```rust
    /// THIS turn's Result snippet, for the push body only (Review Focus 1): cleared
    /// when a turn starts, so an errored turn never pushes the previous summary.
    /// Never persisted.
    turn_snippet: Option<String>,
```

`apply_posture_delta` 的 Snippet 臂改为：

```rust
        PostureDelta::Snippet(s) => { p.turn_snippet = Some(s.clone()); p.last_snippet = Some(s) }
```

`apply_turn` Running 分支中 `session.posture.approval_ids.clear();` 之后追加：

```rust
                session.posture.turn_snippet = None;
```

`impl SessionManager`，`settle_posture` 之后新增：

```rust
    /// Push body source: this turn's own Result snippet, if any.
    fn push_snippet(&self, sid: &str) -> Option<String> {
        self.sessions.lock().unwrap().get(sid).and_then(|s| s.posture.turn_snippet.clone())
    }
```

`maybe_push_turn_done` 里 `let name = m.session_name(sid).unwrap_or_default();` 之后加 `let body = m.push_snippet(sid).and_then(|s| crate::push::push_body_of(&s));`，send 那行改为：

```rust
                    p.send_to_user(&uid, &crate::push::payload_for("turn_done", &name, &sid2, None, body.as_deref())).await;
```

紧跟 `maybe_push_turn_done` 函数之后新增：

```rust
/// F2: a scheduled run finished successfully. Routine band (D8); fired ONLY from the
/// `finalize_run(…, "succeeded", …)` arm, so a Cancelled/Timeout run (which never
/// reaches that arm) cannot push. Body: verdict > this turn's snippet > default.
/// Shares turn_done's debounce map: a scheduled turn never also fires turn_done
/// (that path is gated on `active_run_id.is_none()`), so marking it here only
/// throttles back-to-back runs of the same session.
fn maybe_push_run_done(mgr: &Weak<SessionManager>, sid: &str, owner_id: &str, verdict: Option<&str>) {
    let Some(m) = mgr.upgrade() else { return };
    let Some(p) = m.push_handle() else { return };
    let name = m.session_name(sid).unwrap_or_default();
    let body = verdict.and_then(crate::push::push_body_of)
        .or_else(|| m.push_snippet(sid).and_then(|s| crate::push::push_body_of(&s)));
    let (uid, sid2, now) = (owner_id.to_string(), sid.to_string(), now_millis());
    tokio::spawn(async move {
        p.mark_turn_pushed(&uid, &sid2, now);
        p.send_to_user(&uid, &crate::push::payload_for("run_done", &name, &sid2, None, body.as_deref())).await;
    });
}
```

Claude fan-out 成功分支（`:3009-3013`）改为：

```rust
                                            AcpEvent::Result { text, .. } => {
                                                let verdict = crate::scheduled_tasks::extract_verdict(text);
                                                m.finalize_run(&rid, "succeeded", verdict.as_deref(),
                                                    if verdict.is_some() { None } else { Some("no_verdict") });
                                                maybe_push_run_done(&mgr, &sid, &owner_id, verdict.as_deref());
                                            }
```

其余调用点机械补 `None`：`session_manager.rs:1099`（`term_ended`）、`:3027`、`:3044`（`run_failed`），`scheduled_tasks.rs:1040`（`confirm`）、`:1147`（`stuck`），`web.rs:6809`（`test`）——每处在原最后一个实参之后加 `, None`。补完后确认没有遗漏：

```bash
grep -rn "payload_for(" src | grep -v "fn payload_for" | grep -v ", None)\|, Some(" 
```

Expected: 无输出（每个调用都是 5 个实参）。

- [ ] **Step 7: 同步前端 `levelAllows`**

`frontend/src/lib/push.ts:17-21` 改为：

```ts
export function levelAllows(kind: string, levels: PushLevels): boolean {
  if (kind === 'test') return true
  // Mirrors src/push.rs kind_allowed_by_levels.
  if (kind === 'turn_done' || kind === 'run_done' || kind === 'term_ended') return levels.routine
  return levels.important  // run_failed / confirm / stuck
}
```

- [ ] **Step 8: 运行测试通过 + 全量**

Run: `cargo test push::tests && cargo test posture_persist_tests && cargo test 2>&1 | tail -3 && cd frontend && npx vitest run src/lib/__tests__/push.test.ts && npm test 2>&1 | tail -3`
Expected: 全部 PASS。

- [ ] **Step 9: Commit**

```bash
git add src/push.rs src/session_manager.rs src/scheduled_tasks.rs src/web.rs frontend/src/lib/push.ts frontend/src/lib/__tests__/push.test.ts
git commit -m "feat(F2): push bodies carry the turn's conclusion; scheduled run_done push (U4)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 4: F2 SW — `run_done` 前台抑制与 tag，PushSettings 文案

**依据:** spec §2.2 SW 段、D8。sw.js 目前没有任何测试；本 task 加一个装载器，把 `public/sw.js` 放进假的 `self` 里执行，再驱动 `push` 事件。

**Files:**
- Modify: `frontend/public/sw.js:22-35`
- Modify: `frontend/src/components/PushSettings.tsx:115`（routine 档 hint）
- Create: `frontend/src/lib/__tests__/sw.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `run_done` kind（服务端 payload `{kind, session_id, title, body}`）。
- Produces: SW 行为——`turn_done` 与 `run_done` 在「某个可见窗口的 active 会话 == payload.session_id」时不弹；两者的 tag 都是 `session_id`（同会话只留最新一条），其他 kind 为 `${session_id}:${kind}`。

- [ ] **Step 1: 写失败测试**

`frontend/src/lib/__tests__/sw.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Execute public/sw.js against a fake ServiceWorkerGlobalScope and drive its
// 'message' / 'push' listeners directly.
const SRC = readFileSync(resolve(__dirname, '../../../public/sw.js'), 'utf8')

type Handler = (e: unknown) => void
interface Shown { title: string; opts: { body?: string; tag?: string; data?: { session_id?: string } } }

function loadSw(windows: { id: string; visible: boolean; activeSession?: string }[]) {
  const handlers: Record<string, Handler> = {}
  const shown: Shown[] = []
  const fakeSelf = {
    addEventListener: (t: string, h: Handler) => { handlers[t] = h },
    clients: { matchAll: async () => windows.map(w => ({ id: w.id, visibilityState: w.visible ? 'visible' : 'hidden' })) },
    registration: { showNotification: async (title: string, opts: Shown['opts']) => { shown.push({ title, opts }) } },
  }
  const fakeCaches = { open: async () => ({ match: async () => undefined, put: async () => {} }) }
  new Function('self', 'caches', SRC)(fakeSelf, fakeCaches)
  for (const w of windows) {
    if (w.activeSession) handlers.message({ data: { type: 'active_session', id: w.activeSession, visible: w.visible }, source: { id: w.id } })
  }
  const push = async (payload: Record<string, string>) => {
    let done: Promise<unknown> = Promise.resolve()
    handlers.push({ data: { json: () => payload }, waitUntil: (p: Promise<unknown>) => { done = p } })
    await done
  }
  return { push, shown }
}

describe('sw.js push handler', () => {
  it('run_done is suppressed while its session is the visible active one', async () => {
    const sw = loadSw([{ id: 'w1', visible: true, activeSession: 's1' }])
    await sw.push({ kind: 'run_done', session_id: 's1', title: '⏰ 夜巡 完成', body: '无新告警' })
    expect(sw.shown).toHaveLength(0)
  })
  it('run_done shows in background with its body and a per-session tag', async () => {
    const sw = loadSw([{ id: 'w1', visible: false, activeSession: 's1' }])
    await sw.push({ kind: 'run_done', session_id: 's1', title: '⏰ 夜巡 完成', body: '无新告警' })
    expect(sw.shown).toEqual([{ title: '⏰ 夜巡 完成', opts: { body: '无新告警', tag: 's1', data: { session_id: 's1' } } }])
  })
  it('run_done and turn_done of one session share a tag (newest replaces)', async () => {
    const sw = loadSw([])
    await sw.push({ kind: 'turn_done', session_id: 's1', title: 'a', body: 'x' })
    await sw.push({ kind: 'run_done', session_id: 's1', title: 'b', body: 'y' })
    expect(sw.shown.map(s => s.opts.tag)).toEqual(['s1', 's1'])
  })
  it('important kinds are never foreground-suppressed and keep the kind in the tag', async () => {
    const sw = loadSw([{ id: 'w1', visible: true, activeSession: 's1' }])
    await sw.push({ kind: 'run_failed', session_id: 's1', title: 'f', body: 'b' })
    expect(sw.shown.map(s => s.opts.tag)).toEqual(['s1:run_failed'])
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `cd frontend && npx vitest run src/lib/__tests__/sw.test.ts`
Expected: 第 1 条 FAIL（`run_done` 弹出了 1 条），第 3 条 FAIL（tag 为 `s1:run_done`）；第 2 条因 tag FAIL；第 4 条 PASS。

- [ ] **Step 3: 实现**

`frontend/public/sw.js` 中从注释「前台抑制:仅 turn_done」到 `const tag = …` 这一段替换为：

```js
    // 前台抑制:routine 的两类(turn_done / run_done)。实时问所有可见 client 的 active
    const routine = kind === 'turn_done' || kind === 'run_done'
    if (routine) {
      const wins = await self.clients.matchAll({ type: 'window' })
      const visibleActives = wins
        .filter(c => c.visibilityState === 'visible')
        .map(c => (clientActives[c.id] || {}).sessionId)
        .filter(Boolean)
      if (visibleActives.includes(session_id)) return  // 用户正看着 → 抑制
    }
    // Routine kinds share one tag per session: the newest result replaces the older.
    const tag = routine ? session_id : `${session_id}:${kind}`
```

并把上方注释里的「only foreground-suppress turn_done」改为「only foreground-suppress turn_done / run_done」。

`frontend/src/components/PushSettings.tsx:115`：`hint="每轮完成"` 改为 `hint="每轮完成、定时任务完成"`。

- [ ] **Step 4: 运行测试通过 + 全量**

Run: `cd frontend && npx vitest run src/lib/__tests__/sw.test.ts src/components/__tests__/PushSettings.test.tsx && npm test && npm run lint && npm run build`
Expected: 全部 PASS；`check-size` 通过（sw.js 不在首屏 bundle）。

- [ ] **Step 5: Commit**

```bash
git add frontend/public/sw.js frontend/src/components/PushSettings.tsx frontend/src/lib/__tests__/sw.test.ts
git commit -m "feat(F2): SW foreground-suppresses run_done and folds it into the session tag

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 5: G1 — `chat_message` 按 `crew_*` 白名单放行，前端按 kind 渲染

**依据:** spec §6、D2、D3、K2；调研 §7 R1/R2。

**Files:**
- Modify: `src/acp/crew_process.rs`：`normalize_frame` 的 match（`:201-206` 兜底臂之前加一臂），新增 `pub fn crew_message_events`（紧跟 `normalize_frame` 之后），`mod tests`（`:688`）
- Modify: `frontend/src/hooks/useAcpSocket.ts:325-327`（`labelMap`）
- Modify: `frontend/src/lib/steps.ts:6-17`（`Step.crew`）、`:43-46`（`case 'text'`）
- Modify: `frontend/src/components/turn/StepRow.tsx:19`（text 分支）
- Test: `src/acp/crew_process.rs` `mod tests`、`frontend/src/lib/__tests__/steps.test.ts`、`frontend/src/components/__tests__/crewEventCases.test.tsx`

**Interfaces:**
- Consumes: Task 1 夹具 `src/acp/testdata/crew_frames_{crew_result,crew_ask,crew_meta,crew_ack,normal_turn}.json`（元素为 `{"type","data"}` 原始帧，`data.slot == "zmxprobe"`）。
- Produces:
  - `pub fn crew_message_events(data: &serde_json::Value) -> Vec<AcpEvent>`（纯函数；`data` 是帧的 `data` 对象，slot 过滤已由 `normalize_frame` 做完）
  - 线上事件：`{"type":"system","subtype":"crew_ack"}`；`{"type":"content_block","block_type":"text","text":…,"summary":"crew_ask"|"crew_result"|"crew_meta","turn_id":<fan-out 盖值>}`
  - 前端：`Step.crew?: 'crew_ask' | 'crew_meta'`；`labelMap.crew_ack = 'Crew 已接收'`

- [ ] **Step 1: 写后端失败测试**

`src/acp/crew_process.rs` 的 `mod tests` 末尾追加：

```rust
    // ── G1 · chat_message 白名单（夹具来自 S5 SP，slot 已改写为 zmxprobe）──
    const F_ACK: &str = include_str!("testdata/crew_frames_crew_ack.json");
    const F_ASK: &str = include_str!("testdata/crew_frames_crew_ask.json");
    const F_META: &str = include_str!("testdata/crew_frames_crew_meta.json");
    const F_RESULT: &str = include_str!("testdata/crew_frames_crew_result.json");
    const F_NORMAL: &str = include_str!("testdata/crew_frames_normal_turn.json");
    fn frames(src: &str) -> Vec<serde_json::Value> { serde_json::from_str(src).expect("fixture is a JSON array") }

    #[test]
    fn g1_normal_mode_assistant_chat_message_without_kind_is_dropped() {
        // Defensive regression (spec §6.3 must-have): KC may emit an assistant chat_message in
        // normal mode when no HTTP reader is attached; letting it through double-renders
        // alongside chat_chunk.
        let mut st = NormState::new();
        let f = json!({"type":"chat_message","data":{"slot":"s1","role":"assistant","content":"dup of the chunks"}});
        assert!(normalize_frame(&f, "s1", &mut st).is_empty());
    }

    #[test]
    fn g1_crew_ack_maps_to_a_system_notice() {
        let mut st = NormState::new();
        let evts: Vec<_> = frames(F_ACK).iter().flat_map(|f| normalize_frame(f, "zmxprobe", &mut st)).collect();
        assert!(!evts.is_empty());
        for e in &evts {
            assert!(matches!(e, AcpEvent::System { subtype, session_id: None, count: None } if subtype.as_ref() == "crew_ack"), "{e:?}");
        }
    }

    #[test]
    fn g1_ask_result_meta_become_non_boundary_text_blocks_tagged_by_kind() {
        for (src, kind) in [(F_ASK, "crew_ask"), (F_RESULT, "crew_result"), (F_META, "crew_meta")] {
            let mut st = NormState::new();
            let fs = frames(src);
            let evts: Vec<_> = fs.iter().flat_map(|f| normalize_frame(f, "zmxprobe", &mut st)).collect();
            assert_eq!(evts.len(), fs.len(), "one block per {kind} frame");
            for (e, f) in evts.iter().zip(&fs) {
                let want = f["data"]["content"].as_str().or(f["data"]["text"].as_str()).unwrap();
                match e {
                    AcpEvent::ContentBlock { block_type, text, summary, streaming, turn_id, .. } => {
                        assert_eq!(block_type.as_ref(), "text");
                        assert_eq!(text.as_deref(), Some(want));
                        assert_eq!(summary.as_deref(), Some(kind));
                        assert_eq!(*streaming, None);
                        assert_eq!(*turn_id, 0);
                    }
                    other => panic!("{kind}: expected ContentBlock (never a boundary), got {other:?}"),
                }
            }
        }
    }

    #[test]
    fn g1_crew_frames_never_enter_turn_text() {
        // Non-boundary: a crew_* body must not leak into the next chat_done's Result.
        let mut st = NormState::new();
        let _ = normalize_frame(&chunk("zmxprobe", "a", 1), "zmxprobe", &mut st);
        for f in frames(F_RESULT).iter().chain(frames(F_ASK).iter()) { let _ = normalize_frame(f, "zmxprobe", &mut st); }
        match normalize_frame(&done("zmxprobe"), "zmxprobe", &mut st).last().unwrap() {
            AcpEvent::Result { text, .. } => assert_eq!(text, "a"),
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn g1_another_slots_crew_result_is_filtered() {
        let mut st = NormState::new();
        for f in frames(F_RESULT) { assert!(normalize_frame(&f, "someone-else", &mut st).is_empty()); }
    }

    #[test]
    fn g1_lenient_fields_empty_bodies_and_foreign_kinds() {
        // text fallback + kind under meta (K2: upstream is experimental).
        let d = json!({"role":"assistant","text":"from text","meta":{"kind":"crew_result"}});
        assert!(matches!(&crew_message_events(&d)[..],
            [AcpEvent::ContentBlock { text: Some(t), summary: Some(k), .. }] if t == "from text" && k == "crew_result"));
        // Blank body → dropped (ack carries no body of interest and is kept).
        assert!(crew_message_events(&json!({"role":"assistant","kind":"crew_ask","content":"  "})).is_empty());
        assert_eq!(crew_message_events(&json!({"role":"assistant","kind":"crew_ack"})).len(), 1);
        // Unknown kind, user role, missing role → dropped.
        assert!(crew_message_events(&json!({"role":"assistant","kind":"crew_plan","content":"x"})).is_empty());
        assert!(crew_message_events(&json!({"role":"user","kind":"crew_result","content":"x"})).is_empty());
        assert!(crew_message_events(&json!({"kind":"crew_result","content":"x"})).is_empty());
        // Non-string junk never panics.
        assert!(crew_message_events(&json!({"role":"assistant","kind":7,"content":["x"]})).is_empty());
    }

    #[test]
    fn g1_normal_turn_fixture_still_ends_in_one_result_and_no_crew_blocks() {
        let mut st = NormState::new();
        let evts: Vec<_> = frames(F_NORMAL).iter().flat_map(|f| normalize_frame(f, "zmxprobe", &mut st)).collect();
        assert!(matches!(evts.last(), Some(AcpEvent::Result { .. })), "{evts:?}");
        assert!(!evts.iter().any(|e| matches!(e, AcpEvent::ContentBlock { summary: Some(k), .. } if k.starts_with("crew_"))));
    }
```

- [ ] **Step 2: 写前端失败测试**

`frontend/src/lib/__tests__/steps.test.ts` 的 `describe('toSteps'` 内追加：

```ts
  it('Crew crew_ask / crew_meta text blocks stay separate steps tagged by kind; crew_result is plain text', () => {
    const st = toSteps([
      { type: 'text', text: 'On it?', summary: 'crew_ask' },
      { type: 'text', text: 'again?', summary: 'crew_ask' },
      { type: 'text', text: 'nothing started', summary: 'crew_meta' },
      { type: 'text', text: '已创建 hello.txt', summary: 'crew_result' },
      tx(' 内容为 hi'),
    ], false)
    expect(st.map(s => [s.kind, s.crew, s.text])).toEqual([
      ['text', 'crew_ask', 'On it?'],
      ['text', 'crew_ask', 'again?'],
      ['text', 'crew_meta', 'nothing started'],
      ['text', undefined, '已创建 hello.txt 内容为 hi'],
    ])
  })
```

`frontend/src/components/__tests__/crewEventCases.test.tsx` 的 `describe` 内（最后一个 `it` 之后）追加：

```tsx
  it('G1: crew_ack 显示灰色一行，crew_ask 显示问题卡，crew_meta 显示灰色提示', async () => {
    mount()
    await act(async () => {
      ws().emit({ type: 'user_prompt', text: '建 hello.txt', turn_id: 1 })
      ws().emit({ type: 'system', subtype: 'crew_ack' })
      ws().emit({ type: 'content_block', block_type: 'text', text: '要写到哪个目录？', summary: 'crew_ask', turn_id: 1 })
      ws().emit({ type: 'content_block', block_type: 'text', text: 'nothing was started', summary: 'crew_meta', turn_id: 1 })
    })
    expect(await screen.findByText('Crew 已接收')).toBeInTheDocument()
    const ask = screen.getByTestId('crew-ask')
    expect(ask).toHaveTextContent('Crew 在问你')
    expect(ask).toHaveTextContent('要写到哪个目录？')
    expect(screen.getByTestId('crew-meta')).toHaveTextContent('nothing was started')
  })
```

- [ ] **Step 3: 运行，确认失败**

Run: `cargo test crew_process::tests::g1 2>&1 | tail -5; cd frontend && npx vitest run src/lib/__tests__/steps.test.ts src/components/__tests__/crewEventCases.test.tsx 2>&1 | tail -8`
Expected: Rust 编译失败（`crew_message_events` 未定义）；前端两条新用例 FAIL（`crew` 为 undefined、找不到 `Crew 已接收`）。

- [ ] **Step 4: 实现后端**

`normalize_frame` 的 match 里，在 `// ── 其余全部丢弃 ──` 兜底臂之前加：

```rust
        // ── chat_message：仅 Crew Mode 的 crew_* 回答（R1 实测：普通模式不发此帧）──
        // 白名单 kind，不按 role 放行（KC/state.py:2296-2348 普通模式在无 HTTP reader
        // 时也可能发 assistant chat_message → 会与 chat_chunk 双渲染）。
        // 非边界：不进 turn_text，不产 Result —— 否则会混进下一轮 chat_done 的正文。
        "chat_message" => crew_message_events(data),
```

并把兜底臂上方注释里列举的帧类型加上 `chat_message（非 crew_* kind 由 crew_message_events 丢弃）`。紧跟 `normalize_frame` 函数之后新增：

```rust
/// G1 (S5 spec §6.2). `data` is the frame's `data` object, already slot-filtered.
/// Lenient on purpose (K2, upstream is experimental): kind from `data.kind` or
/// `data.meta.kind`; body from `data.content` or `data.text`. Anything outside the
/// whitelist — other kinds, non-assistant roles, junk types — maps to nothing.
pub fn crew_message_events(data: &serde_json::Value) -> Vec<AcpEvent> {
    if data.get("role").and_then(|v| v.as_str()) != Some("assistant") { return vec![] }
    let kind = data.get("kind").and_then(|v| v.as_str())
        .or_else(|| data.get("meta").and_then(|m| m.get("kind")).and_then(|v| v.as_str()));
    let body = data.get("content").and_then(|v| v.as_str())
        .or_else(|| data.get("text").and_then(|v| v.as_str()))
        .filter(|s| !s.trim().is_empty());
    match (kind, body) {
        // D2: an ack is not an answer — a grey system line, never an assistant bubble.
        (Some("crew_ack"), _) => vec![AcpEvent::System {
            subtype: Cow::Borrowed("crew_ack"), session_id: None, count: None,
        }],
        // D3: non-boundary text blocks; the frontend styles them by `summary`.
        (Some(k @ ("crew_ask" | "crew_result" | "crew_meta")), Some(text)) => vec![AcpEvent::ContentBlock {
            block_type: Cow::Borrowed("text"),
            turn_id: 0,
            text: Some(text.to_string()),
            name: None,
            input: None,
            streaming: None,
            summary: Some(k.to_string()),
        }],
        _ => vec![],
    }
}
```

- [ ] **Step 5: 实现前端**

`frontend/src/hooks/useAcpSocket.ts` 的 `labelMap` 改为：

```ts
        const labelMap: Record<string, string> = {
          resume_failed: '⚠ 上下文恢复失败，已重置为新会话',
          crew_ack: 'Crew 已接收',
        }
```

`frontend/src/lib/steps.ts`：`Step` 接口末尾加一行：

```ts
  /** Crew Mode reply kind (G1): ask = a question for the user, meta = a routing note. */
  crew?: 'crew_ask' | 'crew_meta'
```

`case 'text':` 整体替换为：

```ts
      case 'text': {
        const crew = b.summary === 'crew_ask' || b.summary === 'crew_meta' ? b.summary : undefined
        // Crew ask/meta are standalone messages: never merge them into neighbouring prose.
        if (!crew && last?.kind === 'text' && !last.crew) last.text = `${last.text}${b.text ?? ''}`
        else { closeOpenTools(); out.push({ kind: 'text', text: b.text ?? '', status: 'done', ...(crew ? { crew } : {}) }) }
        break
      }
```

`frontend/src/components/turn/StepRow.tsx` 的 text 分支（`if (step.kind === 'text') return …`）之前插入：

```tsx
  if (step.kind === 'text' && step.crew === 'crew_ask') return (
    <div data-testid="crew-ask" className="rounded-[var(--r-md)] border border-[var(--attention)]/40 bg-[var(--attention)]/5 p-2 text-ui-sm">
      <div className="flex items-center gap-1.5 text-ui-xs font-medium text-[var(--attention)]"><StatusDot tone="attention" label="待回答" />Crew 在问你</div>
      <p className="mt-1 text-[var(--fg)] whitespace-pre-wrap break-words">{step.text}</p>
    </div>
  )
  if (step.kind === 'text' && step.crew === 'crew_meta') return (
    <p data-testid="crew-meta" className="text-ui-xs italic text-[var(--fg-subtle)] whitespace-pre-wrap break-words">{step.text}</p>
  )
```

- [ ] **Step 6: 运行测试通过 + 全量**

Run: `cargo test crew_process::tests && cargo test 2>&1 | tail -3 && cd frontend && npx vitest run src/lib/__tests__/steps.test.ts src/components/__tests__/crewEventCases.test.tsx && npm test && npm run lint && npm run build`
Expected: 全部 PASS；lint 的 token 棘轮不增（只用了 `--attention`、`--fg`、`--fg-subtle` 与 `text-ui-*`）。

- [ ] **Step 7: Commit**

```bash
git add src/acp/crew_process.rs frontend/src/hooks/useAcpSocket.ts frontend/src/lib/steps.ts frontend/src/components/turn/StepRow.tsx frontend/src/lib/__tests__/steps.test.ts frontend/src/components/__tests__/crewEventCases.test.tsx
git commit -m "feat(G1): show Crew Mode crew_* replies (whitelisted chat_message, non-boundary)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 6: R4 — `SlotInit` / `owns_slot`，`Session.crew` 贯通到 `spawn_crew`

**依据:** spec §8、U2；S6 计划 Task 9 消费 `Session.crew: Option<CrewMeta { mode, agent, origin }>` 与 `CrewProcess::spawn(cfg, work_dir, SlotInit)`。

**说明:** spec §7.2 写的是 `spawn_crew(.., SlotOpts{mode, agent})`。S6 只依赖 `SlotInit` 和 `CrewMeta`，所以本计划不引入第三个类型 `SlotOpts`：`spawn_crew` 直接收 `SlotInit`，由纯函数 `crew_slot_init` 从 `Option<ResumeToken>` + `Option<CrewMeta>` 算出来（见 Self-Review 第 5 条）。本 task 只做归属与参数贯通，S5 所有会话的 origin 都是 `zeromux`，**行为零变化**；Task 7 才让 mode/agent 进入 `create_slot` 的请求体。

**Files:**
- Modify: `src/acp/crew_process.rs`：`CrewProcess`（`:260-265`）、`spawn`（`:586-640`）、`impl Drop`（`:663-685`），新增 `SlotInit`、`should_delete_on_drop`、`ResumePlan`/`resume_plan`，`mod tests`
- Modify: `src/session_manager.rs`：新增 `pub struct CrewMeta` 与 `fn crew_slot_init`（放在 `SpawnPlan` 之前，`:531`）；`Session`（`:297-339`，加 `pub crew`）；`SpawnPlan`/`decide_spawn`（`:531-591`）；`ensure_running`（`:1784`、`:1832-1838`、`:1866`）；`spawn_crew`（`:1667-1708`）；`create_crew_session`（`:1724`、`:1735-1762`）；`load_persisted`（`:2310-2344`）；`persisted_of`（Task 2 加的三行 `crew_*`）；全部 11 个 `Session { … }` 字面量（`:1189,1308,1654,1758,2337,4690,4880,5597,6428,7027,7164`，以及 Task 2 新增的 `posture_persist_tests::session`）加 `crew: None,`
- Test: `src/acp/crew_process.rs` `mod tests`、`src/session_manager.rs` 新增 `mod crew_meta_tests`

**Interfaces:**
- Consumes: Task 2 `PersistedSession.crew_mode/crew_agent/crew_origin`。
- Produces:
  - `crew_process.rs`：
    ```rust
    pub enum SlotInit { New { mode: String, agent: String }, Resume { key: String, owns: bool } }
    pub fn should_delete_on_drop(owns_slot: bool) -> bool
    pub struct ResumePlan { pub set_project: bool }
    pub fn resume_plan(owns: bool) -> ResumePlan
    CrewProcess { …, owns_slot: bool }
    pub async fn spawn(cfg: CrewConfig, work_dir: &str, init: SlotInit) -> Result<Self, Box<dyn std::error::Error + Send + Sync>>
    ```
  - `session_manager.rs`：
    ```rust
    #[derive(Debug, Clone, PartialEq)] pub struct CrewMeta { pub mode: String, pub agent: String, pub origin: String }
    impl CrewMeta { pub fn owns_slot(&self) -> bool }          // origin != "external"
    Session { …, pub crew: Option<CrewMeta> }                 // Some only for SessionType::Crew
    SpawnPlan { …, crew: Option<CrewMeta> }
    fn crew_slot_init(token: Option<&ResumeToken>, crew: Option<&CrewMeta>) -> SlotInit
    async fn spawn_crew(&self, id: &str, work_dir: &str, owner_id: &str, init: SlotInit) -> Result<RunningProcess, String>
    ```

- [ ] **Step 1: 写 crew_process 的失败测试**

`src/acp/crew_process.rs` 的 `mod tests` 末尾追加：

```rust
    // ── R4 · owns_slot（U2：只看持久化的 origin，禁止从 resume.is_none() 推断）──
    #[test]
    fn r4_drop_deletes_only_owned_slots() {
        assert!(should_delete_on_drop(true));
        assert!(!should_delete_on_drop(false));
    }

    #[test]
    fn r4_resume_of_a_foreign_slot_never_touches_its_project() {
        // S7 D-G6: attaching an external slot must not overwrite its cwd.
        assert!(resume_plan(true).set_project, "our own slot: re-point project on resume (unchanged behaviour)");
        assert!(!resume_plan(false).set_project, "external slot: leave its project alone");
    }
```

- [ ] **Step 2: 写 session_manager 的失败测试**

`src/session_manager.rs` 文件末尾追加：

```rust
#[cfg(test)]
mod crew_meta_tests {
    use super::*;
    use crate::acp::crew_process::SlotInit;

    fn meta(origin: &str) -> CrewMeta {
        CrewMeta { mode: String::new(), agent: "kirocrew-conductor".into(), origin: origin.into() }
    }

    #[test]
    fn owns_slot_is_origin_not_resume_presence() {
        assert!(meta("zeromux").owns_slot());
        assert!(!meta("external").owns_slot());
        // Unknown origin strings are treated as ours: only an explicit "external" disowns.
        assert!(meta("").owns_slot());
    }

    #[test]
    fn own_slot_resumed_after_restart_is_still_owned() {
        // CTO M2: self-made slots restart via resume=Some(k) too; they must still be deleted on close.
        let tok = ResumeToken::Crew("zmx-k".into());
        match crew_slot_init(Some(&tok), Some(&meta("zeromux"))) {
            SlotInit::Resume { key, owns } => { assert_eq!(key, "zmx-k"); assert!(owns); }
            _ => panic!("expected Resume"),
        }
        match crew_slot_init(Some(&tok), Some(&meta("external"))) {
            SlotInit::Resume { owns, .. } => assert!(!owns),
            _ => panic!("expected Resume"),
        }
    }

    #[test]
    fn no_token_means_a_new_slot_with_the_persisted_mode_and_agent() {
        match crew_slot_init(None, Some(&CrewMeta { mode: "crew".into(), agent: String::new(), origin: "zeromux".into() })) {
            SlotInit::New { mode, agent } => { assert_eq!(mode, "crew"); assert_eq!(agent, ""); }
            _ => panic!("expected New"),
        }
        // Pre-S5 rows (crew: None) and a non-Crew token behave like a plain new slot.
        assert!(matches!(crew_slot_init(None, None), SlotInit::New { ref mode, ref agent } if mode.is_empty() && agent.is_empty()));
        let claude = ResumeToken::Claude("x".into());
        assert!(matches!(crew_slot_init(Some(&claude), None), SlotInit::New { .. }));
    }

    #[test]
    fn fresh_fallback_keeps_mode_and_agent_and_owns() {
        // Review Focus 4: when resume fails, ensure_running retries with token=None.
        // The fresh slot must keep the session's mode/agent — and is ours by construction.
        let m = meta("external");
        match crew_slot_init(None, Some(&m)) {
            SlotInit::New { agent, .. } => assert_eq!(agent, "kirocrew-conductor"),
            _ => panic!("expected New"),
        }
    }

    fn crew_session(id: &str, crew: Option<CrewMeta>) -> Session {
        Session {
            id: id.into(), name: "c".into(), session_type: SessionType::Crew, cols: 80, rows: 24,
            work_dir: "/tmp".into(), owner_id: "o".into(), description: String::new(),
            name_is_auto: true, status: SessionMeta::Idle, resume_token: Some(ResumeToken::Crew("zmx-k".into())),
            tmux_origin: None, pending_kill_until: None, worktree_path: None, created_ms: 0, source_task_id: None,
            spawning: false, last_activity_ms: 0, turns_completed: 0, run_metrics: VecDeque::new(),
            lifetime_turns: 0, lifetime_duration_ms: 0, lifetime_cost_usd: 0.0, posture: Posture::default(),
            crew, running: None, scrollback: VecDeque::new(), scrollback_bytes: 0,
        }
    }

    #[test]
    fn decide_spawn_carries_crew_meta() {
        let m = CrewMeta { mode: "crew".into(), agent: String::new(), origin: "zeromux".into() };
        let mut s = crew_session("c", Some(m.clone()));
        match decide_spawn(&mut s) {
            SpawnDecision::Spawn(plan) => assert_eq!(plan.crew, Some(m)),
            _ => panic!("expected Spawn"),
        }
    }

    #[test]
    fn crew_meta_round_trips_through_the_store_and_non_crew_rows_get_none() {
        let dir = tempfile::tempdir().unwrap();
        let events = Arc::new(crate::events::EventStore::open(dir.path()).unwrap());
        let store = Arc::new(crate::session_store::SessionStore::open(dir.path()).unwrap());
        let conductor = CrewMeta { mode: String::new(), agent: "kirocrew-conductor".into(), origin: "zeromux".into() };
        store.upsert(&persisted_of(&crew_session("c", Some(conductor.clone())))).unwrap();
        let mut claude = crew_session("k", None);
        claude.session_type = SessionType::Claude;
        claude.resume_token = None;
        store.upsert(&persisted_of(&claude)).unwrap();
        // A pre-S5 Crew row: crew columns at their DEFAULTs.
        store.upsert(&persisted_of(&crew_session("old", None))).unwrap();

        let m = SessionManager::new(events, store, "claude".into(), "codex".into(), "off".into(),
            5476, "/tmp/crew".into(), "bash".into(), false, crate::tmux::TmuxCtl::new(Some("zmx-test-unused".into())));
        m.load_persisted();
        let map = m.sessions.lock().unwrap();
        assert_eq!(map.get("c").unwrap().crew, Some(conductor));
        assert_eq!(map.get("k").unwrap().crew, None, "non-Crew sessions never carry CrewMeta");
        assert_eq!(map.get("old").unwrap().crew,
            Some(CrewMeta { mode: String::new(), agent: String::new(), origin: "zeromux".into() }),
            "pre-S5 Crew rows are ours (DEFAULT 'zeromux')");
    }
}
```

- [ ] **Step 3: 运行，确认失败**

Run: `cargo test crew_process::tests::r4 2>&1 | tail -5; cargo test crew_meta_tests 2>&1 | tail -5`
Expected: 编译失败（`should_delete_on_drop`、`resume_plan`、`CrewMeta`、`crew_slot_init`、`SlotInit`、`Session.crew` 未定义）。

- [ ] **Step 4: 实现 crew_process.rs**

`pub struct CrewProcess` 之前新增：

```rust
/// How `spawn` obtains its slot (R4). Ownership is decided by the caller from the
/// PERSISTED origin (U2) — never inferred from "is this a resume": our own slots are
/// resumed with a key after every restart too.
pub enum SlotInit {
    /// Create a fresh slot. `mode` / `agent` are Gateway raw values; empty = omit.
    New { mode: String, agent: String },
    /// Re-attach to an existing slot. `owns=false` for slots zeromux did not create.
    Resume { key: String, owns: bool },
}

/// Drop removes the Gateway slot only if we own it (U2).
pub fn should_delete_on_drop(owns_slot: bool) -> bool { owns_slot }

/// What a resume may touch. A foreign slot keeps its own project/cwd (S7 D-G6).
#[derive(Debug, PartialEq)]
pub struct ResumePlan { pub set_project: bool }

pub fn resume_plan(owns: bool) -> ResumePlan { ResumePlan { set_project: owns } }
```

`pub struct CrewProcess` 末尾加字段：

```rust
    /// R4: false for slots zeromux did not create — Drop then stops the loop but
    /// never DELETEs the slot. Only S7 G6 ever constructs `owns_slot=false`.
    owns_slot: bool,
```

`spawn` 从签名到 `set_slot_project` 错误处理这一段替换为：

```rust
    pub async fn spawn(cfg: CrewConfig, work_dir: &str, init: SlotInit)
        -> Result<Self, Box<dyn std::error::Error + Send + Sync>>
    {
        let secret = read_gateway_secret(&cfg.crew_home, cfg.port)?;   // fail fast
        let http = reqwest::Client::builder()
            // Gateway 在 loopback，任何重定向都是异常；照 push.rs 的 SSRF 硬化惯例
            // 直接禁掉，免得带 secret 的头被跟到别的 host 去。
            .redirect(reqwest::redirect::Policy::none())
            .build().map_err(|e| format!("build crew http client: {e}"))?;

        let (slot_key, owns_slot, created, set_project) = match init {
            SlotInit::Resume { key, owns } => {
                if !slot_alive(&http, &cfg.http_base, &secret, &key).await {
                    return Err(format!("Crew slot 已不存在（{key}），需重建会话").into());
                }
                (key, owns, false, resume_plan(owns).set_project)
            }
            SlotInit::New { mode: _, agent: _ } => {
                // mode/agent reach the request body in G2 (slot_create_body).
                let k = new_slot_key();
                create_slot(&http, &cfg.http_base, &secret, &k).await?;
                (k, true, true, true)
            }
        };

        // project 就是 agent 的真实 cwd（实测 agent `pwd` 与设定值逐字相同）。
        // work_dir=="." 解析成绝对路径 —— Gateway 逐字传给 ACP session/new 的 cwd，
        // 相对路径无意义（照 kiro_process.rs:134-138）。
        if set_project {
            let project = if work_dir == "." {
                std::env::current_dir()?.to_string_lossy().to_string()
            } else {
                work_dir.to_string()
            };
            if let Err(e) = set_slot_project(&http, &cfg.http_base, &secret, &slot_key, &project).await {
                if created {
                    // 建了 slot 但设 project 失败 → 清掉，别留孤儿
                    delete_slot(&http, &cfg.http_base, &secret, &slot_key).await;
                }
                return Err(e.into());
            }
        }
```

同一函数末尾 `Ok(Self { cmd_tx, event_rx, cfg, slot_key })` 改为 `Ok(Self { cmd_tx, event_rx, cfg, slot_key, owns_slot })`。

`impl Drop for CrewProcess` 中 `let _ = self.cmd_tx.try_send(Cmd::Stop);` 之后插入：

```rust
        // R4: never delete a slot we did not create (U2).
        if !should_delete_on_drop(self.owns_slot) { return; }
```

- [ ] **Step 5: 实现 session_manager.rs**

`struct SpawnPlan` 之前新增：

```rust
/// S5 U1: Crew slot metadata, persisted in the `crew_*` columns. Some only for Crew
/// sessions. The three display variants (chat / topics / goal) are derived by the
/// frontend from these raw values.
#[derive(Debug, Clone, PartialEq)]
pub struct CrewMeta {
    /// Gateway raw value: "" | "crew".
    pub mode: String,
    /// Gateway raw value, e.g. "kirocrew-conductor"; "" = default agent.
    pub agent: String,
    /// "zeromux" | "external".
    pub origin: String,
}

impl CrewMeta {
    /// U2: ownership comes ONLY from the persisted origin.
    pub fn owns_slot(&self) -> bool { self.origin != "external" }
}

/// Pure: how to (re)attach a Crew session's slot. A Crew token → resume it, owned per
/// origin; anything else (no token, the fresh-fallback retry, a stray non-Crew token)
/// → a new slot carrying the persisted mode/agent, which we own by construction.
fn crew_slot_init(token: Option<&ResumeToken>, crew: Option<&CrewMeta>) -> crate::acp::crew_process::SlotInit {
    use crate::acp::crew_process::SlotInit;
    match token {
        Some(ResumeToken::Crew(k)) => SlotInit::Resume {
            key: k.clone(),
            owns: crew.map(|c| c.owns_slot()).unwrap_or(true),
        },
        _ => SlotInit::New {
            mode: crew.map(|c| c.mode.clone()).unwrap_or_default(),
            agent: crew.map(|c| c.agent.clone()).unwrap_or_default(),
        },
    }
}
```

`pub struct Session`：在 `posture: Posture,` 之后加：

```rust
    /// S5 U1 / R4: Some only for SessionType::Crew. Persisted in the crew_* columns.
    pub crew: Option<CrewMeta>,
```

全部 `Session { … }` 字面量（本 task Files 列出的 11 处 + `posture_persist_tests::session`）在 `posture: …,` 之后加 `crew: None,`——`create_crew_session` 与 `load_persisted` 两处除外，写法见下。

`SpawnPlan` 末尾加字段 `crew: Option<CrewMeta>,`；`decide_spawn` 的 `SpawnPlan { … }` 末尾加 `crew: s.crew.clone(),`；`ensure_running` 的解构（`:1784`）改为：

```rust
        let Some(SpawnPlan { stype, resume_token: token, work_dir, owner_id, cols, rows, source_task_id, crew }) = plan else {
```

`ensure_running` 的 Crew 主路径（`:1832-1838`）改为：

```rust
            SessionType::Crew => {
                self.spawn_crew(id, &work_dir, &owner_id, crew_slot_init(token.as_ref(), crew.as_ref())).await
            }
```

fresh 兜底（`:1866`）改为：

```rust
                    SessionType::Crew => self.spawn_crew(id, &work_dir, &owner_id, crew_slot_init(None, crew.as_ref())).await,
```

`spawn_crew` 签名的 `resume: Option<String>,` 改为 `init: crate::acp::crew_process::SlotInit,`，函数体里 `CrewProcess::spawn(cfg, work_dir, resume.as_deref(),)` 改为 `CrewProcess::spawn(cfg, work_dir, init)`，文档注释改为 `/// Spawn a Crew session for \`id\` at \`work_dir\`, start its fan-out, return the live handle. \`init\` says whether to create or resume the slot (R4).`

`create_crew_session` 里 `.spawn_crew(&id, &effective_dir.to_string_lossy(), owner_id, None)` 改为：

```rust
            .spawn_crew(&id, &effective_dir.to_string_lossy(), owner_id,
                crate::acp::crew_process::SlotInit::New { mode: String::new(), agent: String::new() })
```

并在它的 `Session { … }` 字面量里 `posture: Posture::default(),` 之后加：

```rust
            crew: Some(CrewMeta { mode: String::new(), agent: String::new(), origin: "zeromux".into() }),
```

`load_persisted` 的 `map.insert(id, Session { … })` 之前（`let (cols, rows) = …;` 之后）加：

```rust
            let crew = (p.session_type == SessionType::Crew).then(|| CrewMeta {
                mode: p.crew_mode.clone(), agent: p.crew_agent.clone(), origin: p.crew_origin.clone(),
            });
```

字面量中 `posture: Posture { … },` 之后加 `crew,`。

`persisted_of` 里 Task 2 写的三行替换为：

```rust
        crew_mode: s.crew.as_ref().map(|c| c.mode.clone()).unwrap_or_default(),
        crew_agent: s.crew.as_ref().map(|c| c.agent.clone()).unwrap_or_default(),
        crew_origin: s.crew.as_ref().map(|c| c.origin.clone()).unwrap_or_else(|| "zeromux".into()),
```

- [ ] **Step 6: 运行测试通过 + 全量**

Run: `cargo test crew_process::tests && cargo test crew_meta_tests && cargo test 2>&1 | tail -3`
Expected: 全部 PASS；编译器不再报缺字段（若报 `missing field 'crew'`，按报错位置补 `crew: None,`）。

- [ ] **Step 7: Commit**

```bash
git add src/acp/crew_process.rs src/session_manager.rs
git commit -m "feat(R4): SlotInit + owns_slot from persisted crew_origin; CrewMeta on Session

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 7: G2 后端 — `CreateSessionReq` 透传 mode/agent、`slot_create_body`、`SessionInfo.crew_*`、`zmx_usage` 埋点

**依据:** spec §7.2、§7.4、§7.5、U1、U5；Task 1 结论 `CREATE_WITH_MODE` / `CREATE_WITH_AGENT`。

**Files:**
- Modify: `src/acp/crew_process.rs:319-321`（`create_slot`），新增 `slot_create_body`；`spawn` 的 `SlotInit::New` 臂（Task 6 写的）
- Modify: `src/session_manager.rs`：`SessionInfo`（`:388-414`）、`session_info_of`（`:667-705`）、`create_crew_session`（`:1710-1765`）、`spawn_crew_fanout` 的 Prompt 臂（`:4022`）与循环前局部变量（`:3909-3920`）；新增 `fn take_first_prompt`；`mod crew_meta_tests` 追加用例
- Modify: `src/web.rs`：`CreateSessionReq`（`:829-836`）、新增 `fn validate_crew_opts`（紧跟 `default_session_type`）、`create_session` 的 Crew 分支（`:940-945`）与校验（`validate_work_dir_under_home` 之后）；`mod create_session_req_tests`（`:6831`）
- Test: 上述三个文件的测试模块

**Interfaces:**
- Consumes: Task 6 `SlotInit::New { mode, agent }`、`CrewMeta`、`Session.crew`；Task 1 结论。
- Produces:
  - `pub fn slot_create_body(key: &str, mode: &str, agent: &str) -> serde_json::Value`（默认序列化后逐字等于 `{"name":"<key>"}`）
  - `SessionInfo`：`pub crew_mode: Option<String>`、`pub crew_agent: Option<String>`、`pub crew_origin: Option<String>`，均 `#[serde(skip_serializing_if = "Option::is_none")]`，非 Crew 会话为 None
  - `SessionManager::create_crew_session(&self, name: String, work_dir: &str, cols: u16, rows: u16, owner_id: &str, crew_mode: &str, crew_agent: &str) -> Result<String, String>`
  - `CreateSessionReq`：`#[serde(default)] crew_mode: String`、`#[serde(default)] crew_agent: String`
  - `fn validate_crew_opts(t: SessionType, mode: &str, agent: &str) -> Result<(), String>`（web.rs，私有）
  - `fn take_first_prompt(logged: &mut bool, scheduled: bool) -> bool`（session_manager.rs，私有）
  - 日志：`tracing::info!(target: "zmx_usage", "crew_create sid={} mode={} agent={}", …)`、`tracing::info!(target: "zmx_usage", "crew_first_prompt sid={}", …)`

- [ ] **Step 1: 写 crew_process 的失败测试**

`src/acp/crew_process.rs` 的 `mod tests` 末尾追加：

```rust
    // ── G2 · create_slot 请求体（默认逐字不变）──
    #[test]
    fn g2_default_slot_body_is_byte_identical_to_before() {
        assert_eq!(serde_json::to_string(&slot_create_body("zmx-ab12cd34", "", "")).unwrap(),
                   r#"{"name":"zmx-ab12cd34"}"#);
    }

    #[test]
    fn g2_mode_and_agent_are_added_only_when_set() {
        let b = slot_create_body("k", "crew", "");
        assert_eq!(b, json!({"name":"k","mode":"crew"}));
        let b = slot_create_body("k", "", "kirocrew-conductor");
        assert_eq!(b, json!({"name":"k","agent":"kirocrew-conductor"}));
        let b = slot_create_body("k", "crew", "kirocrew-conductor");
        assert_eq!(b, json!({"name":"k","mode":"crew","agent":"kirocrew-conductor"}));
    }
```

- [ ] **Step 2: 写 session_manager 的失败测试**

`src/session_manager.rs` 的 `mod crew_meta_tests` 末尾追加：

```rust
    #[test]
    fn info_exports_crew_fields_only_for_crew_sessions() {
        let s = crew_session("c", Some(CrewMeta { mode: String::new(), agent: "kirocrew-conductor".into(), origin: "zeromux".into() }));
        let i = session_info_of(&s);
        assert_eq!(i.crew_agent.as_deref(), Some("kirocrew-conductor"));
        assert_eq!(i.crew_mode.as_deref(), Some(""));
        assert_eq!(i.crew_origin.as_deref(), Some("zeromux"));
        let mut k = crew_session("k", None);
        k.session_type = SessionType::Claude;
        let json = serde_json::to_value(session_info_of(&k)).unwrap();
        assert!(json.get("crew_mode").is_none() && json.get("crew_agent").is_none() && json.get("crew_origin").is_none(),
            "non-Crew sessions omit the three keys: {json}");
    }

    #[test]
    fn conductor_agent_survives_restart_in_session_info() {
        let dir = tempfile::tempdir().unwrap();
        let mk = || {
            let events = Arc::new(crate::events::EventStore::open(dir.path()).unwrap());
            let store = Arc::new(crate::session_store::SessionStore::open(dir.path()).unwrap());
            SessionManager::new(events, store, "claude".into(), "codex".into(), "off".into(),
                5476, "/tmp/crew".into(), "bash".into(), false, crate::tmux::TmuxCtl::new(Some("zmx-test-unused".into())))
        };
        let m = mk();
        let s = crew_session("c", Some(CrewMeta { mode: String::new(), agent: "kirocrew-conductor".into(), origin: "zeromux".into() }));
        m.persist_meta(&s);
        drop(m);
        let m2 = mk();
        m2.load_persisted();
        let info = session_info_of(m2.sessions.lock().unwrap().get("c").unwrap());
        assert_eq!(info.crew_agent.as_deref(), Some("kirocrew-conductor"));
    }

    #[test]
    fn first_prompt_is_logged_once_and_never_for_scheduled_prompts() {
        let mut logged = false;
        assert!(!take_first_prompt(&mut logged, true), "a scheduled prompt is not a user adopting Crew");
        assert!(take_first_prompt(&mut logged, false));
        assert!(!take_first_prompt(&mut logged, false));
        assert!(logged);
    }

    #[test]
    fn usage_metric_lines_use_the_shared_target() {
        // U5: journalctl counting (gate T) greps these exact prefixes.
        let src = include_str!("session_manager.rs");
        assert!(src.contains(concat!("target: \"zmx_usage\", \"crew_", "create sid=")));
        assert!(src.contains(concat!("target: \"zmx_usage\", \"crew_", "first_prompt sid=")));
    }
```

- [ ] **Step 3: 写 web 的失败测试**

`src/web.rs` 的 `mod create_session_req_tests`：第一行 `use` 改为 `use super::{CreateSessionReq, validate_crew_opts};`，然后追加：

```rust
    #[test]
    fn crew_fields_default_to_empty_for_old_clients() {
        let req: CreateSessionReq = serde_json::from_str(r#"{"type":"crew"}"#).unwrap();
        assert_eq!((req.crew_mode.as_str(), req.crew_agent.as_str()), ("", ""));
        let req: CreateSessionReq = serde_json::from_str(r#"{"type":"crew","crew_agent":"kirocrew-conductor"}"#).unwrap();
        assert_eq!(req.crew_agent, "kirocrew-conductor");
    }

    #[test]
    fn crew_opts_whitelist() {
        assert!(validate_crew_opts(SessionType::Crew, "", "").is_ok());
        assert!(validate_crew_opts(SessionType::Crew, "crew", "").is_ok());
        assert!(validate_crew_opts(SessionType::Crew, "", "kirocrew-conductor").is_ok());
        assert!(validate_crew_opts(SessionType::Crew, "chat", "").is_err());
        assert!(validate_crew_opts(SessionType::Crew, "", "pipeline-conductor").is_err(), "Stage 4, not S5");
        assert!(validate_crew_opts(SessionType::Crew, "CREW", "").is_err(), "exact match, no case folding");
        // Crew options on any other type are a client bug.
        assert!(validate_crew_opts(SessionType::Claude, "crew", "").is_err());
        assert!(validate_crew_opts(SessionType::Claude, "", "").is_ok());
    }
```

- [ ] **Step 4: 运行，确认失败**

Run: `cargo test crew_process::tests::g2 2>&1 | tail -5; cargo test crew_meta_tests 2>&1 | tail -5; cargo test create_session_req_tests 2>&1 | tail -5`
Expected: 编译失败（`slot_create_body`、`SessionInfo.crew_agent`、`take_first_prompt`、`CreateSessionReq.crew_mode`、`validate_crew_opts` 未定义）。

- [ ] **Step 5: 实现 crew_process.rs**

`create_slot` 替换为：

```rust
/// G2: POST body for a new slot. With empty mode/agent this is byte-identical to the
/// pre-S5 `{"name":k}` so default sessions are untouched.
pub fn slot_create_body(key: &str, mode: &str, agent: &str) -> serde_json::Value {
    let mut b = serde_json::json!({ "name": key });
    if !mode.is_empty() { b["mode"] = serde_json::Value::String(mode.to_string()); }
    if !agent.is_empty() { b["agent"] = serde_json::Value::String(agent.to_string()); }
    b
}

async fn create_slot(http: &reqwest::Client, base: &str, secret: &str, body: serde_json::Value) -> Result<(), String> {
    post_json_ok(http, base, secret, "/api/chat/slots", body, REST_TIMEOUT).await
}
```

`spawn` 的 `SlotInit::New` 臂替换为：

```rust
            SlotInit::New { mode, agent } => {
                let k = new_slot_key();
                create_slot(&http, &cfg.http_base, &secret, slot_create_body(&k, &mode, &agent)).await?;
                (k, true, true, true)
            }
```

**仅当 Task 1 结论 `CREATE_WITH_MODE = no`**（Gateway 建 slot 时忽略 `mode`）：在 `stop_turn` 之前加

```rust
/// Gateway ignores `mode` on slot creation (S5 SP): set it explicitly (§7 R2: PATCH → 200).
async fn patch_slot_mode(http: &reqwest::Client, base: &str, secret: &str, key: &str, mode: &str) -> Result<(), String> {
    let resp = http.patch(format!("{base}/api/chat/slots/{key}/mode"))
        .header("X-Internal-Secret", secret)
        .json(&serde_json::json!({ "mode": mode })).timeout(REST_TIMEOUT).send().await
        .map_err(|_| format!("Gateway 请求失败：/api/chat/slots/{key}/mode"))?;
    let status = resp.status();
    drop(resp);
    if status.is_success() { Ok(()) } else { Err(format!("Gateway 拒绝设置 mode（HTTP {}）", status.as_u16())) }
}
```

并在 `create_slot(...).await?;` 之后加：

```rust
                if !mode.is_empty() {
                    if let Err(e) = patch_slot_mode(&http, &cfg.http_base, &secret, &k, &mode).await {
                        delete_slot(&http, &cfg.http_base, &secret, &k).await;
                        return Err(e.into());
                    }
                }
```

`CREATE_WITH_MODE` 为 `yes` 或 `unverified` 时不加（S5 前端不暴露「并行话题」，`mode=crew` 在本期只有 API 直调才会出现）。`CREATE_WITH_AGENT = no` 时，Task 10 取 `GOAL_ENABLED = false`，后端照样透传。

- [ ] **Step 6: 实现 session_manager.rs**

`SessionInfo` 在 `lifetime_cost_usd` 之后加：

```rust
    /// S5 U1 raw Crew values; the frontend derives chat / topics / goal. Omitted for
    /// non-Crew sessions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crew_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crew_agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crew_origin: Option<String>,
```

`session_info_of` 在 `lifetime_cost_usd: s.lifetime_cost_usd,` 之后加：

```rust
        crew_mode: s.crew.as_ref().map(|c| c.mode.clone()),
        crew_agent: s.crew.as_ref().map(|c| c.agent.clone()),
        crew_origin: s.crew.as_ref().map(|c| c.origin.clone()),
```

`create_crew_session` 签名在 `owner_id: &str,` 之后加 `crew_mode: &str, crew_agent: &str,`；`spawn_crew` 调用里的 `SlotInit::New { mode: String::new(), agent: String::new() }` 改为 `SlotInit::New { mode: crew_mode.to_string(), agent: crew_agent.to_string() }`；`Session` 字面量里的 `crew:` 改为：

```rust
            crew: Some(CrewMeta { mode: crew_mode.to_string(), agent: crew_agent.to_string(), origin: "zeromux".into() }),
```

`self.sessions.lock().unwrap().insert(id.clone(), session);` 之后、`Ok(id)` 之前加：

```rust
        // U5: gate-T input (journalctl -u zeromux | grep zmx_usage).
        tracing::info!(target: "zmx_usage", "crew_create sid={} mode={} agent={}", id, crew_mode, crew_agent);
```

`spawn_crew_fanout` 之前新增：

```rust
/// U5 first-prompt metric gate: true exactly once per fan-out, for the first
/// user (non-scheduled) prompt.
fn take_first_prompt(logged: &mut bool, scheduled: bool) -> bool {
    if scheduled || *logged { return false; }
    *logged = true;
    true
}
```

`spawn_crew_fanout` 循环前（`let mut turn_starts = TurnStarts::default();` 之后）加：

```rust
        // U5: one crew_first_prompt line per fan-out (S6 topics branch reuses this flag).
        let mut first_prompt_logged = false;
```

Prompt 臂 `Some(SessionInput::Prompt { text, run_id, client_id }) => {` 的第一行加：

```rust
                            if take_first_prompt(&mut first_prompt_logged, run_id.is_some()) {
                                tracing::info!(target: "zmx_usage", "crew_first_prompt sid={}", sid);
                            }
```

- [ ] **Step 7: 实现 web.rs**

`CreateSessionReq` 末尾加：

```rust
    /// S5 G2: Gateway slot mode ("" | "crew") and agent ("" | "kirocrew-conductor").
    /// Crew only; default "" keeps old clients and the default slot body unchanged.
    #[serde(default)]
    crew_mode: String,
    #[serde(default)]
    crew_agent: String,
```

紧跟 `fn default_session_type` 之后：

```rust
/// S5 §7.2 whitelist. `pipeline-conductor` is Stage 4 and deliberately absent.
fn validate_crew_opts(t: crate::session_manager::SessionType, mode: &str, agent: &str) -> Result<(), String> {
    if t != crate::session_manager::SessionType::Crew {
        return if mode.is_empty() && agent.is_empty() { Ok(()) }
               else { Err("crew_mode/crew_agent only apply to crew sessions".into()) };
    }
    if !matches!(mode, "" | "crew") { return Err(format!("invalid crew_mode: {mode}")); }
    if !matches!(agent, "" | "kirocrew-conductor") { return Err(format!("invalid crew_agent: {agent}")); }
    Ok(())
}
```

`create_session` 中 `validate_work_dir_under_home(&work_dir)?;` 之后加：

```rust
    validate_crew_opts(req.session_type, &req.crew_mode, &req.crew_agent)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
```

Crew 分支改为：

```rust
        crate::session_manager::SessionType::Crew => {
            state.sessions
                .create_crew_session(name.clone(), &work_dir, state.default_cols, state.default_rows, &owner_id,
                    &req.crew_mode, &req.crew_agent)
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        }
```

- [ ] **Step 8: 运行测试通过 + 全量**

Run: `cargo test crew_process::tests && cargo test crew_meta_tests && cargo test create_session_req_tests && cargo test 2>&1 | tail -3`
Expected: 全部 PASS。

- [ ] **Step 9: Commit**

```bash
git add src/acp/crew_process.rs src/session_manager.rs src/web.rs
git commit -m "feat(G2): create Crew slots with mode/agent, export crew_* on SessionInfo, zmx_usage metrics

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 8: S5-a 部署 — 冒烟实例验证持久化与透传，合入 main，`./deploy.sh`

**依据:** spec §10 过程指标「部署后完成·未读保留率 100%」、§11；CLAUDE.md cgroup 规则；记忆「冒烟必须 `--data-dir` 隔离」「cgroup 内必须先 push 再 deploy」。

**Files:**
- 无代码改动。

**Interfaces:**
- Consumes: Task 1–7 全部。
- Produces: 线上 `zeromux.service` 运行 S5-a；S6 前置清单中后端那 10 条 grep 全部有输出。

- [ ] **Step 1: 全量门禁**

```bash
cd /home/ubuntu/s3-workspace/keith-space/github-search/ai/zeromux
cargo test 2>&1 | tail -3
cd frontend && npm test 2>&1 | tail -3 && npm run lint && npm run build && cd ..
find frontend/node_modules -maxdepth 3 -type l -lname '/tmp/*'
```

Expected: 全绿；`find` 无输出。

- [ ] **Step 2: S6 前置清单（后端部分）自检**

```bash
grep -n "fn persist_posture" src/session_manager.rs
grep -n "awaiting_input" src/session_manager.rs src/session_store.rs
grep -n "crew_mode\|crew_agent\|crew_origin" src/session_store.rs
grep -n "pub crew_mode\|pub crew_origin" src/session_manager.rs
grep -n "pub fn payload_for(kind: &str, name: &str, session_id: &str, fk: Option<&str>, body: Option<&str>)" src/push.rs
grep -n "enum SlotInit\|owns_slot" src/acp/crew_process.rs
grep -n "fn crew_message_events" src/acp/crew_process.rs
grep -rn 'target: *"zmx_usage"' src | head -3
grep -n "first_prompt_logged" src/session_manager.rs
```

Expected: 每一条都有输出。任何一条为空都说明接口名偏离，回到对应 task 修正。

- [ ] **Step 3: 冒烟实例（隔离 data-dir，端口 18091）**

```bash
cargo build --release 2>&1 | tail -1
SMOKE=$(mktemp -d)
./target/release/zeromux --port 18091 --password smoke --data-dir "$SMOKE" --tmux-socket zmx-s5-smoke > "$SMOKE/log" 2>&1 &
echo $! > "$SMOKE/pid"; sleep 2
H='Authorization: Bearer smoke'
# G2 whitelist
curl -s -o /dev/null -w '%{http_code}\n' -H "$H" -H 'Content-Type: application/json' \
  -d '{"type":"crew","work_dir":"/home/ubuntu","crew_agent":"pipeline-conductor"}' http://127.0.0.1:18091/api/sessions
curl -s -o /dev/null -w '%{http_code}\n' -H "$H" -H 'Content-Type: application/json' \
  -d '{"type":"claude","work_dir":"/home/ubuntu","crew_mode":"crew"}' http://127.0.0.1:18091/api/sessions
```

Expected: 两行都是 `400`。

```bash
# G2 conductor create (needs the live Gateway; creates a real slot, cleaned up below)
curl -s -H "$H" -H 'Content-Type: application/json' \
  -d '{"type":"crew","work_dir":"/home/ubuntu","crew_agent":"kirocrew-conductor"}' http://127.0.0.1:18091/api/sessions | tee "$SMOKE/crew.json"
CID=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['id'])" "$SMOKE/crew.json")
curl -s -H "$H" http://127.0.0.1:18091/api/sessions | python3 -c "import json,sys;[print(s['id'][:8],s.get('crew_agent'),s.get('crew_origin')) for s in json.load(sys.stdin)['sessions'] if s['type']=='crew']"
grep 'zmx_usage' "$SMOKE/log"
```

Expected: 列表里该会话打印 `kirocrew-conductor zeromux`；日志有一行 `crew_create sid=<CID> mode= agent=kirocrew-conductor`。Gateway 没在跑时 create 返回 500，跳过这一段并在 Step 6 注明。

```bash
# F1: posture survives a restart of the smoke instance
sqlite3 "$SMOKE/zeromux.db" "UPDATE sessions SET last_outcome='completed', last_outcome_ms=1700000000000, last_snippet='smoke' WHERE id='$CID';" 2>/dev/null \
  || python3 -c "import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute(\"UPDATE sessions SET last_outcome='completed', last_outcome_ms=1700000000000, last_snippet='smoke' WHERE id=?\",(sys.argv[2],));c.commit()" "$SMOKE/zeromux.db" "$CID"
kill "$(cat "$SMOKE/pid")"; sleep 1
./target/release/zeromux --port 18091 --password smoke --data-dir "$SMOKE" --tmux-socket zmx-s5-smoke >> "$SMOKE/log" 2>&1 &
echo $! > "$SMOKE/pid"; sleep 2
curl -s -H "$H" http://127.0.0.1:18091/api/sessions | python3 -c "import json,sys;[print(s['last_outcome'],s['last_outcome_ms'],s['last_snippet'],s.get('crew_agent')) for s in json.load(sys.stdin)['sessions'] if s['id']=='$CID']"
```

Expected: `completed 1700000000000 smoke kirocrew-conductor`。

```bash
# cleanup: DELETE the session (5s undo window for tmux only; Crew deletes immediately → Drop deletes the slot)
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE -H "$H" "http://127.0.0.1:18091/api/sessions/$CID"
sleep 2; kill "$(cat "$SMOKE/pid")"; tmux -L zmx-s5-smoke kill-server 2>/dev/null; rm -rf "$SMOKE"
```

Expected: `200`（或 `204`）。

- [ ] **Step 4: 合入并推送（先 push 再 deploy）**

```bash
git checkout main && git merge --no-ff feat/s5a-backend -m "Merge branch 'feat/s5a-backend'"
git push origin main
```

- [ ] **Step 5: 部署**

```bash
./deploy.sh --build
```

Expected: 输出以健康检查通过结束。从 zeromux 终端执行时，本终端会在 stop 时断开（预期），重连后用 `systemctl is-active zeromux` 确认 `active`。

- [ ] **Step 6: 线上验证**

```bash
systemctl is-active zeromux
journalctl -u zeromux --since "10 min ago" --no-pager | grep -iE "persist posture|panic" | head
```

Expected: `active`；没有 `persist posture … failed` 和 `panic`。手测（spec §10）：在任意 Claude 会话跑完一轮但**不打开**它 → 再执行一次 `./deploy.sh` → 刷新页面，分诊里这一行仍是「完成·未读」。锁屏推送的正文应该是该轮最后一行结论，而不是「本轮已结束」。

---

# S5-b：前端

> 开工条件：Task 8 已上线；S4 上线稳定 ≥ 2 天（spec §11）。

```bash
git checkout main && git pull && git checkout -b feat/s5b-frontend
```

### Task 9: F3 — 离开期间卡（`awayClock` + `summarizeAway` + `AwayCard`）

**依据:** spec §3、D4、§9（首屏 ≤ 1.5KB）。F1 已上线，所以部署后 `last_outcome_ms` 不再是 null。

**Files:**
- Create: `frontend/src/lib/awayClock.ts`、`frontend/src/lib/awaySummary.ts`、`frontend/src/components/shell/AwayCard.tsx`
- Modify: `frontend/src/components/shell/TriageList.tsx:1-10`（import）、`:59-61`（计算）、`:79-80`（「需要你」之前挂卡片）
- Test: Create `frontend/src/lib/__tests__/awayClock.test.ts`、`frontend/src/lib/__tests__/awaySummary.test.ts`、`frontend/src/components/shell/__tests__/AwayCard.test.tsx`；Modify `frontend/src/components/shell/__tests__/TriageList.test.tsx`

**Interfaces:**
- Consumes: `SessionInfo.last_outcome` / `last_outcome_ms` / `lifetime_cost_usd` / `type`；`TriageListProps.confirmsBySession`、`onSelect`。
- Produces（S6 Task 15 在此基础上追加 Crew 行）：
  - `awayClock.ts`：`export const LEFT_KEY = 'zmx_left_ms'`；`markLeft(now?: number): void`；`readLeft(): number | null`；`useAwayWindow(): { leftMs: number | null; backMs: number; dismissed: boolean; dismiss(): void }`
  - `awaySummary.ts`：
    ```ts
    export const AWAY_MIN_MS = 30 * 60_000
    export type AwayKey = 'errored' | 'awaiting' | 'confirm' | 'completed' | 'other'
    export const AWAY_PRIORITY: readonly AwayKey[]   // 出错 > 待回答 > 待确认 > 完成 > 其他 (spec §3.2 排序键)
    export interface AwayItem { key: AwayKey; label: string; count: number; firstId: string | null }
    export interface AwaySummary { awayMs: number; items: AwayItem[]; costUsd: number; costPartial: boolean }
    export function summarizeAway(sessions: SessionInfo[], confirms: Record<string, number>, leftMs: number | null, nowMs: number): AwaySummary | null
    export function formatAway(ms: number): string
    ```
  - `AwayCard.tsx`：`export function AwayCard(p: { summary: AwaySummary | null; onSelect(id: string): void; onDismiss(): void })`——`summary` 为 null 时渲染 null。

- [ ] **Step 1: 写 `summarizeAway` 的失败测试**

`frontend/src/lib/__tests__/awaySummary.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { summarizeAway, formatAway, AWAY_PRIORITY } from '../awaySummary'
import { mkSession } from '../../test/appHarness'

const H = 3_600_000
const BACK = 100 * H
const LEFT = BACK - 7 * H

describe('summarizeAway', () => {
  it('counts only events inside (left, back], in priority order, omitting zero items', () => {
    const s = [
      mkSession('c1', { last_outcome: 'completed', last_outcome_ms: LEFT + H, lifetime_cost_usd: 1.5 }),
      mkSession('c2', { last_outcome: 'completed', last_outcome_ms: LEFT + 2 * H, lifetime_cost_usd: 1.6 }),
      mkSession('e1', { last_outcome: 'timeout', last_outcome_ms: LEFT + 3 * H }),
      mkSession('old', { last_outcome: 'completed', last_outcome_ms: LEFT - 1, lifetime_cost_usd: 9 }),
      mkSession('late', { last_outcome: 'errored', last_outcome_ms: BACK + 1 }),
      mkSession('cx', { last_outcome: 'cancelled', last_outcome_ms: LEFT + H }),
    ]
    const r = summarizeAway(s, { c1: 2 }, LEFT, BACK)!
    expect(r.awayMs).toBe(7 * H)
    expect(r.items.map(i => [i.key, i.label, i.count, i.firstId])).toEqual([
      ['errored', '出错', 1, 'e1'],
      ['confirm', '待确认', 2, 'c1'],
      ['completed', '完成', 2, 'c2'],          // newest first
    ])
    expect(r.costUsd).toBeCloseTo(3.1)          // windowed sessions only: c1 + c2 (+ e1, cx at $0)
    expect(r.costPartial).toBe(false)
  })
  it('null when away < 30 min, never left, or nothing happened', () => {
    const s = [mkSession('c', { last_outcome: 'completed', last_outcome_ms: BACK - 60_000 })]
    expect(summarizeAway(s, {}, BACK - 29 * 60_000, BACK)).toBeNull()
    expect(summarizeAway(s, {}, null, BACK)).toBeNull()
    expect(summarizeAway([mkSession('o', { last_outcome: 'completed', last_outcome_ms: LEFT - H })], {}, LEFT, BACK)).toBeNull()
  })
  it('pending confirms alone are enough to show the card', () => {
    const r = summarizeAway([mkSession('a')], { a: 1 }, LEFT, BACK)!
    expect(r.items).toEqual([{ key: 'confirm', label: '待确认', count: 1, firstId: 'a' }])
  })
  it('Codex / Crew in the window mark the cost as partial; tmux is ignored', () => {
    const r = summarizeAway([
      mkSession('x', { type: 'codex', last_outcome: 'completed', last_outcome_ms: LEFT + H }),
      mkSession('t', { type: 'tmux', last_outcome: 'errored', last_outcome_ms: LEFT + H }),
    ], {}, LEFT, BACK)!
    expect(r.costPartial).toBe(true)
    expect(r.items.map(i => i.key)).toEqual(['completed'])
  })
  it('the priority key is the spec §3.2 order (S6 appends rows by it)', () => {
    expect(AWAY_PRIORITY).toEqual(['errored', 'awaiting', 'confirm', 'completed', 'other'])
  })
})

describe('formatAway', () => {
  it('minutes, hours, then days', () => {
    expect(formatAway(45 * 60_000)).toBe('45m')
    expect(formatAway(7 * H + 20 * 60_000)).toBe('7h')
    expect(formatAway(50 * H)).toBe('2d')
  })
})
```

- [ ] **Step 2: 写 `useAwayWindow` 的失败测试（含 Review Focus 2）**

`frontend/src/lib/__tests__/awayClock.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useAwayWindow, readLeft, LEFT_KEY } from '../awayClock'

const T0 = 1_000_000_000
const setVis = (v: 'visible' | 'hidden') =>
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v })

describe('awayClock', () => {
  beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); vi.setSystemTime(T0) })
  afterEach(() => {
    vi.useRealTimers()
    delete (document as unknown as Record<string, unknown>).visibilityState
  })

  it('first open ever: no left time, so no window', () => {
    const { result } = renderHook(() => useAwayWindow())
    expect(result.current.leftMs).toBeNull()
  })

  it('pagehide and visibilitychange→hidden both stamp the left time', () => {
    renderHook(() => useAwayWindow())
    act(() => { window.dispatchEvent(new Event('pagehide')) })
    expect(localStorage.getItem(LEFT_KEY)).toBe(String(T0))
    vi.setSystemTime(T0 + 5)
    setVis('hidden')
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(readLeft()).toBe(T0 + 5)
  })

  it('resume from background re-arms the card', () => {
    // Review Focus 2: iOS PWAs resume without reloading, so mount-time reads are not enough.
    const { result } = renderHook(() => useAwayWindow())
    act(() => result.current.dismiss())
    expect(result.current.dismissed).toBe(true)
    setVis('hidden')
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    vi.setSystemTime(T0 + 2 * 3_600_000)
    setVis('visible')
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(result.current.leftMs).toBe(T0)
    expect(result.current.backMs).toBe(T0 + 2 * 3_600_000)
    expect(result.current.dismissed).toBe(false)
  })

  it('garbage in storage reads as no left time', () => {
    localStorage.setItem(LEFT_KEY, 'soon')
    expect(readLeft()).toBeNull()
  })
})
```

- [ ] **Step 3: 写 `AwayCard` 与 TriageList 的失败测试**

`frontend/src/components/shell/__tests__/AwayCard.test.tsx`：

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { AwayCard } from '../AwayCard'
import type { AwaySummary } from '../../../lib/awaySummary'

const summary: AwaySummary = {
  awayMs: 7 * 3_600_000, costUsd: 3.1, costPartial: false,
  items: [
    { key: 'errored', label: '出错', count: 1, firstId: 'e1' },
    { key: 'completed', label: '完成', count: 5, firstId: 'c9' },
  ],
}

describe('AwayCard', () => {
  it('one line: away time, items, cost; an item jumps to its first session', () => {
    const onSelect = vi.fn()
    render(<AwayCard summary={summary} onSelect={onSelect} onDismiss={() => {}} />)
    const card = screen.getByRole('region', { name: '离开期间' })
    expect(card).toHaveTextContent('离开 7h')
    expect(card).toHaveTextContent('$3.10')
    fireEvent.click(screen.getByRole('button', { name: '出错 1' }))
    expect(onSelect).toHaveBeenCalledWith('e1')
  })
  it('partial cost says so', () => {
    render(<AwayCard summary={{ ...summary, costUsd: 0, costPartial: true }} onSelect={() => {}} onDismiss={() => {}} />)
    expect(screen.getByText('部分未计')).toBeInTheDocument()
    expect(screen.queryByText('$0.00')).toBeNull()
  })
  it('× calls onDismiss; a null summary renders nothing', () => {
    const onDismiss = vi.fn()
    const { rerender, container } = render(<AwayCard summary={summary} onSelect={() => {}} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByRole('button', { name: '关闭离开摘要' }))
    expect(onDismiss).toHaveBeenCalled()
    rerender(<AwayCard summary={null} onSelect={() => {}} onDismiss={onDismiss} />)
    expect(container).toBeEmptyDOMElement()
  })
})
```

`frontend/src/components/shell/__tests__/TriageList.test.tsx`：第一行 `import { describe, it, expect, vi } from 'vitest'` 改为 `import { describe, it, expect, vi, afterEach } from 'vitest'`，文件末尾追加：

```tsx
describe('TriageList away card (F3)', () => {
  afterEach(() => localStorage.clear())
  it('shows above 需要你 after ≥30 min away with events; × hides it', () => {
    localStorage.setItem('zmx_left_ms', String(Date.now() - 2 * 3_600_000))
    // `err` is baselined at 0 by setup() → it sits in 需要你; `done` has no baseline → 空闲.
    setup([
      mkSession('err', { name: 'api-refactor', last_outcome: 'errored', last_outcome_ms: Date.now() - 60_000 }),
      mkSession('done', { name: 'nightly', last_outcome: 'completed', last_outcome_ms: Date.now() - 3_600_000 }),
    ])
    const card = screen.getByRole('region', { name: '离开期间' })
    expect(card).toHaveTextContent('出错 1')
    expect(card).toHaveTextContent('完成 1')
    const needs = screen.getByRole('list', { name: '需要你' })
    expect(card.compareDocumentPosition(needs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '关闭离开摘要' }))
    expect(screen.queryByRole('region', { name: '离开期间' })).toBeNull()
  })
  it('no stored left time → no card', () => {
    setup()
    expect(screen.queryByRole('region', { name: '离开期间' })).toBeNull()
  })
})
```

- [ ] **Step 4: 运行，确认失败**

Run: `cd frontend && npx vitest run src/lib/__tests__/awaySummary.test.ts src/lib/__tests__/awayClock.test.ts src/components/shell/__tests__/AwayCard.test.tsx src/components/shell/__tests__/TriageList.test.tsx`
Expected: FAIL（模块不存在 / 找不到「离开期间」region）。

- [ ] **Step 5: 实现 `awayClock.ts`**

```ts
import { useCallback, useEffect, useState } from 'react'

// When this device last left the app (F3, spec D4). Local-only by design until
// S6 T0 brings a server-side read state.
export const LEFT_KEY = 'zmx_left_ms'

export function markLeft(now = Date.now()): void {
  try { localStorage.setItem(LEFT_KEY, String(now)) } catch { /* private mode */ }
}

export function readLeft(): number | null {
  try {
    const v = Number(localStorage.getItem(LEFT_KEY))
    return Number.isFinite(v) && v > 0 ? v : null
  } catch { return null }
}

interface AwayWindow { leftMs: number | null; backMs: number; dismissed: boolean }

/** The (left, back] window for the away card. Re-read on every resume: an iOS PWA
 *  comes back from the background without reloading, so a mount-time read alone
 *  would never show the card (Review Focus 2). Resuming also clears a dismissal. */
export function useAwayWindow(): AwayWindow & { dismiss(): void } {
  const [w, setW] = useState<AwayWindow>(() => ({ leftMs: readLeft(), backMs: Date.now(), dismissed: false }))
  useEffect(() => {
    const onHide = () => markLeft()
    const onVis = () => {
      if (document.visibilityState === 'hidden') markLeft()
      else setW({ leftMs: readLeft(), backMs: Date.now(), dismissed: false })
    }
    window.addEventListener('pagehide', onHide)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.removeEventListener('pagehide', onHide)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])
  const dismiss = useCallback(() => setW(p => ({ ...p, dismissed: true })), [])
  return { ...w, dismiss }
}
```

- [ ] **Step 6: 实现 `awaySummary.ts`**

```ts
import type { SessionInfo } from './api'

export const AWAY_MIN_MS = 30 * 60_000

export type AwayKey = 'errored' | 'awaiting' | 'confirm' | 'completed' | 'other'
/** Card row / item order (spec §3.2). S6 appends rows (Crew external, gate silence)
 *  under this key and truncates to 3 lines + 「更多 (N)」. */
export const AWAY_PRIORITY: readonly AwayKey[] = ['errored', 'awaiting', 'confirm', 'completed', 'other']

export interface AwayItem { key: AwayKey; label: string; count: number; firstId: string | null }
export interface AwaySummary { awayMs: number; items: AwayItem[]; costUsd: number; costPartial: boolean }

const LABEL: Record<AwayKey, string> = { errored: '出错', awaiting: '待回答', confirm: '待确认', completed: '完成', other: '其他' }

/** What happened in (leftMs, nowMs]. Pure. null = don't show the card. */
export function summarizeAway(sessions: SessionInfo[], confirms: Record<string, number>, leftMs: number | null, nowMs: number): AwaySummary | null {
  if (leftMs == null || nowMs - leftMs < AWAY_MIN_MS) return null
  const inWindow = sessions
    .filter(s => s.type !== 'tmux' && s.last_outcome_ms != null && s.last_outcome_ms > leftMs && s.last_outcome_ms <= nowMs)
    .sort((a, b) => (b.last_outcome_ms ?? 0) - (a.last_outcome_ms ?? 0))
  const bucket = (pred: (s: SessionInfo) => boolean) => inWindow.filter(pred)
  const errored = bucket(s => s.last_outcome === 'errored' || s.last_outcome === 'timeout')
  const completed = bucket(s => s.last_outcome === 'completed')
  const confirmIds = sessions.filter(s => (confirms[s.id] ?? 0) > 0).map(s => s.id)
  const confirmCount = confirmIds.reduce((n, id) => n + confirms[id], 0)
  const counts: Partial<Record<AwayKey, { count: number; firstId: string | null }>> = {
    errored: { count: errored.length, firstId: errored[0]?.id ?? null },
    confirm: { count: confirmCount, firstId: confirmIds[0] ?? null },
    completed: { count: completed.length, firstId: completed[0]?.id ?? null },
  }
  const items: AwayItem[] = AWAY_PRIORITY.flatMap(key => {
    const c = counts[key]
    return c && c.count > 0 ? [{ key, label: LABEL[key], count: c.count, firstId: c.firstId }] : []
  })
  if (items.length === 0) return null
  return {
    awayMs: nowMs - leftMs,
    items,
    costUsd: inWindow.reduce((sum, s) => sum + (s.lifetime_cost_usd ?? 0), 0),
    // Codex / Crew report no cost (spec §3.2 「部分未计」).
    costPartial: inWindow.some(s => s.type === 'codex' || s.type === 'crew'),
  }
}

export function formatAway(ms: number): string {
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
}
```

- [ ] **Step 7: 实现 `AwayCard.tsx`**

```tsx
import { Fragment } from 'react'
import { X } from 'lucide-react'
import { formatAway, type AwaySummary } from '../../lib/awaySummary'
import { formatCost } from '../../lib/format'
import { IconButton } from '../ui'

/** 「离开期间」card at the top of the triage list (F3). First-paint component: keep it tiny. */
export function AwayCard({ summary, onSelect, onDismiss }: {
  summary: AwaySummary | null
  onSelect(id: string): void
  onDismiss(): void
}) {
  if (!summary) return null
  const dot = <span aria-hidden className="text-[var(--fg-subtle)]">·</span>
  return (
    <section aria-label="离开期间" className="mx-2 mt-2 pl-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--surface-1)] flex items-center gap-1">
      <div className="flex-1 min-w-0 flex flex-wrap items-center gap-x-1.5 text-ui-xs text-[var(--fg-muted)]">
        <span>{`离开 ${formatAway(summary.awayMs)}`}</span>
        {summary.items.map(i => (
          <Fragment key={i.key}>
            {dot}
            <button type="button" disabled={!i.firstId} onClick={() => i.firstId && onSelect(i.firstId)}
              className="min-h-[var(--hit)] px-0.5 rounded-[var(--r-sm)] text-[var(--fg)] hover:text-[var(--accent)] disabled:text-[var(--fg-muted)]">
              {`${i.label} ${i.count}`}
            </button>
          </Fragment>
        ))}
        {summary.costUsd > 0 && <>{dot}<span className="num">{formatCost(summary.costUsd, 'short')}</span></>}
        {summary.costPartial && <>{dot}<span className="text-[var(--fg-subtle)]">部分未计</span></>}
      </div>
      <IconButton label="关闭离开摘要" icon={X} size="sm" onClick={onDismiss} />
    </section>
  )
}
```

- [ ] **Step 8: 接进 TriageList**

`TriageList.tsx` import 区追加：

```tsx
import { useAwayWindow } from '../../lib/awayClock'
import { summarizeAway } from '../../lib/awaySummary'
import { AwayCard } from './AwayCard'
```

`const groups = useMemo(…)` 之后追加：

```tsx
  const away = useAwayWindow()
  const awaySummary = useMemo(
    () => (away.dismissed ? null : summarizeAway(sessions, confirmsBySession, away.leftMs, away.backMs)),
    [away.dismissed, away.leftMs, away.backMs, sessions, confirmsBySession])
```

返回的 JSX 里 `<Group title="需要你" …/>` 之前插入：

```tsx
      <AwayCard summary={awaySummary} onSelect={onSelect} onDismiss={away.dismiss} />
```

- [ ] **Step 9: 运行测试通过 + 全量**

Run: `cd frontend && npx vitest run src/lib/__tests__/awaySummary.test.ts src/lib/__tests__/awayClock.test.ts src/components/shell/__tests__/AwayCard.test.tsx src/components/shell/__tests__/TriageList.test.tsx src/__tests__/App.characterization.test.tsx && npm test && npm run lint && npm run build`
Expected: 全部 PASS；App.characterization 原样通过（它 `localStorage.clear()`，没有 `zmx_left_ms`）；`check-size` 通过，记下首屏 br 值，与 Task 8 时的值相比增量 ≤ 1.5KB。

- [ ] **Step 10: Commit**

```bash
git add frontend/src/lib/awayClock.ts frontend/src/lib/awaySummary.ts frontend/src/components/shell/AwayCard.tsx frontend/src/components/shell/TriageList.tsx frontend/src/lib/__tests__/awayClock.test.ts frontend/src/lib/__tests__/awaySummary.test.ts frontend/src/components/shell/__tests__/AwayCard.test.tsx frontend/src/components/shell/__tests__/TriageList.test.tsx
git commit -m "feat(F3): 离开期间 card at the top of triage

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 10: G2 前端 — ⌘K Crew 二级 chip、`crew:goal`、`crewVariant` 徽标

**依据:** spec §7.3、D1、R22（新建只走 ⌘K，移动端不加顶栏图标）；Task 1 结论 `CONDUCTOR_CHAT_DONE`。S6 Task 12 在本 task 的映射表和 options 上追加「并行话题」。

**Files:**
- Create: `frontend/src/lib/crewVariant.ts`、`frontend/src/components/shell/CrewVariantBadge.tsx`
- Modify: `frontend/src/lib/api/sessions.ts:7-33`（`SessionInfo`）、`:69-76`（`createSession`）
- Modify: `frontend/src/lib/paletteParse.ts`（`ParsedNew.crewVariant`、`crew:goal`）
- Modify: `frontend/src/components/shell/useShellState.ts:29`、`:157-170`（`create` 第 5 参）
- Modify: `frontend/src/components/shell/CommandPalette.tsx`：import、`PaletteBody` 状态、`submitNew`（`:224-231`）、`setType`（`:257-260`）、`preview`（`:262-271`）、chip 区（`:291-305`）
- Modify: `frontend/src/components/shell/TriageRow.tsx:63-66`（TypeIcon 旁徽标）、`:127-136`（`same()`）；`frontend/src/components/shell/FocusHeader.tsx:44`
- Test: Create `frontend/src/lib/__tests__/crewVariant.test.ts`；Modify `frontend/src/lib/__tests__/paletteParse.test.ts`、`frontend/src/lib/__tests__/createSession.test.ts`、`frontend/src/components/shell/__tests__/CommandPalette.test.tsx`、`frontend/src/components/shell/__tests__/TriageList.test.tsx`

**Interfaces:**
- Consumes: Task 7 的 `SessionInfo.crew_mode/crew_agent/crew_origin`（非 Crew 会话省略）与 `POST /api/sessions` 的 `crew_mode`/`crew_agent`。
- Produces（S6 Task 12 逐字消费）：
  - `crewVariant.ts`：
    ```ts
    export type CrewVariant = 'chat' | 'topics' | 'goal'
    export const GOAL_AGENT = 'kirocrew-conductor'
    export const GOAL_ENABLED: boolean
    export function variantOf(s: Pick<SessionInfo, 'type' | 'crew_mode' | 'crew_agent'>): CrewVariant | null
    export interface CrewOpts { crew_mode: string; crew_agent: string }
    export const CREW_VARIANT_FIELDS: Record<CrewVariant, CrewOpts>
    export const CREW_VARIANT_OPTIONS: { value: CrewVariant; label: string }[]   // S5: 聊天、目标指挥
    export const CREW_VARIANT_WORDS: Record<string, CrewVariant>                  // S5: { 'crew:goal': 'goal' }
    ```
  - `ParsedNew.crewVariant?: CrewVariant`（只有 `crew:<variant>` 关键词会设置，此时 `type === 'crew'`）
  - `createSession(type, name?, workDir?, tmuxTarget?, initialPrompt?, crew?: CrewOpts)`；`ShellState.create(type, workDir?, tmuxTarget?, prompt?, crew?: CrewOpts)`
  - `CrewVariantBadge({ session, size? })`：goal → `Target` 图标（`aria-label="目标指挥"`），topics → `Layers`（`aria-label="并行话题"`），chat / 非 Crew → null

- [ ] **Step 1: 写纯函数的失败测试**

`frontend/src/lib/__tests__/crewVariant.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { variantOf, CREW_VARIANT_FIELDS, CREW_VARIANT_OPTIONS, CREW_VARIANT_WORDS, GOAL_AGENT } from '../crewVariant'

describe('crewVariant', () => {
  it('derives the display variant from the raw Gateway values (agent wins over mode)', () => {
    expect(variantOf({ type: 'crew', crew_mode: '', crew_agent: GOAL_AGENT })).toBe('goal')
    expect(variantOf({ type: 'crew', crew_mode: 'crew', crew_agent: GOAL_AGENT })).toBe('goal')
    expect(variantOf({ type: 'crew', crew_mode: 'crew', crew_agent: '' })).toBe('topics')
    expect(variantOf({ type: 'crew', crew_mode: '', crew_agent: '' })).toBe('chat')
    expect(variantOf({ type: 'crew' })).toBe('chat')             // pre-S5 backend: fields absent
    expect(variantOf({ type: 'claude', crew_agent: GOAL_AGENT })).toBeNull()
  })
  it('variant → create fields; chat is the empty default', () => {
    expect(CREW_VARIANT_FIELDS.chat).toEqual({ crew_mode: '', crew_agent: '' })
    expect(CREW_VARIANT_FIELDS.goal).toEqual({ crew_mode: '', crew_agent: 'kirocrew-conductor' })
    expect(CREW_VARIANT_FIELDS.topics).toEqual({ crew_mode: 'crew', crew_agent: '' })
  })
  it('S5 offers no 并行话题 chip or keyword (D1)', () => {
    expect(CREW_VARIANT_OPTIONS.map(o => o.value)).not.toContain('topics')
    expect(Object.values(CREW_VARIANT_WORDS)).not.toContain('topics')
  })
})
```

`frontend/src/lib/__tests__/paletteParse.test.ts` 的 `describe('parseNew'` 内追加：

```ts
  it('crew:goal is a crew keyword carrying the 目标指挥 variant', () => {
    expect(parseNew('crew:goal ~/w 查一下 CI')).toEqual({ type: 'crew', dir: '~/w', prompt: '查一下 CI', literalPath: true, crewVariant: 'goal' })
    expect(parseNew('CREW:GOAL zeromux').crewVariant).toBe('goal')
    expect(parseNew('crew zeromux').crewVariant).toBeUndefined()
    expect(parseNew('crew:nope zeromux').type).toBeNull()      // unknown variant is not a keyword
  })
```

`frontend/src/lib/__tests__/createSession.test.ts` 的 `describe` 内追加：

```ts
  it('sends crew_mode / crew_agent only when crew opts are given', async () => {
    await createSession('crew', undefined, '/tmp/x', undefined, undefined, { crew_mode: '', crew_agent: 'kirocrew-conductor' })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.crew_agent).toBe('kirocrew-conductor')
    expect(body.crew_mode).toBe('')
    await createSession('claude', undefined, '/tmp/x')
    const plain = JSON.parse(fetchMock.mock.calls[1][1].body)
    expect('crew_mode' in plain || 'crew_agent' in plain).toBe(false)
  })
```

- [ ] **Step 2: 写 ⌘K 与徽标的失败测试**

`frontend/src/components/shell/__tests__/CommandPalette.test.tsx`：import 区追加 `import { GOAL_ENABLED } from '../../../lib/crewVariant'`，在 `describe('CommandPalette'` 内追加：

```tsx
  describe.runIf(GOAL_ENABLED)('Crew variant (G2)', () => {
    it('picking crew shows 聊天 | 目标指挥; 目标指挥 creates a conductor session', async () => {
      const { sh, type, key } = setup({ initial: { mode: 'new' } })
      type('crew ~/w 查 CI')
      await flush()
      const seg = screen.getByRole('radiogroup', { name: 'Crew 模式' })
      expect([...seg.querySelectorAll('[role=radio]')].map(r => r.textContent)).toEqual(['聊天', '目标指挥'])
      fireEvent.click(screen.getByRole('radio', { name: '目标指挥' }))
      expect(screen.getByTestId('palette-preview')).toHaveTextContent('Crew · 目标指挥 · ~/w · "查 CI"')
      key('Enter')
      await waitFor(() => expect(sh.create).toHaveBeenCalledWith('crew', '~/w', undefined, '查 CI', { crew_mode: '', crew_agent: 'kirocrew-conductor' }))
    })
    it('crew:goal preselects 目标指挥', async () => {
      const { sh, type, key } = setup()
      type('crew:goal ~/w')
      await flush()
      expect(screen.getByRole('radio', { name: '目标指挥' })).toHaveAttribute('aria-checked', 'true')
      key('Enter')
      await waitFor(() => expect(sh.create).toHaveBeenCalledWith('crew', '~/w', undefined, undefined, { crew_mode: '', crew_agent: 'kirocrew-conductor' }))
    })
    it('chip click overrides the crew:goal keyword', async () => {
      // Review Focus 3: the last explicit choice wins.
      const { sh, type, key } = setup()
      type('crew:goal ~/w')
      await flush()
      fireEvent.click(screen.getByRole('radio', { name: '聊天' }))
      key('Enter')
      await waitFor(() => expect(sh.create).toHaveBeenCalledWith('crew', '~/w', undefined, undefined, { crew_mode: '', crew_agent: '' }))
    })
  })

  it('non-crew types show no Crew 模式 control and pass no crew opts', async () => {
    const { sh, type, key } = setup()
    type('tmux ~/x')
    await flush()
    expect(screen.queryByRole('radiogroup', { name: 'Crew 模式' })).toBeNull()
    key('Enter')
    await waitFor(() => expect(sh.create).toHaveBeenCalledWith('tmux', '~/x', undefined, undefined))
  })
```

已有的用例 `no type keyword in new mode → uses the last used type`（LAST_TYPE_KEY=crew）不改：它只断言预览文本。已有断言 `expect(sh.create).toHaveBeenCalledWith('crew', '/w/a')`（`:63`，快捷目标路径）不改：那条路径不经过 `submitNew`。

`frontend/src/components/shell/__tests__/TriageList.test.tsx` 末尾追加：

```tsx
describe('Crew variant badge (G2)', () => {
  it('a conductor session shows the 目标指挥 badge; chat shows none', () => {
    setup([
      mkSession('g', { name: 'goal', type: 'crew', crew_mode: '', crew_agent: 'kirocrew-conductor', crew_origin: 'zeromux' }),
      mkSession('c', { name: 'chat', type: 'crew', crew_mode: '', crew_agent: '', crew_origin: 'zeromux' }),
    ])
    expect(screen.getAllByRole('img', { name: '目标指挥' })).toHaveLength(1)
    expect(screen.queryByRole('img', { name: '并行话题' })).toBeNull()
  })
})
```

- [ ] **Step 3: 运行，确认失败**

Run: `cd frontend && npx vitest run src/lib/__tests__/crewVariant.test.ts src/lib/__tests__/paletteParse.test.ts src/lib/__tests__/createSession.test.ts src/components/shell/__tests__/CommandPalette.test.tsx src/components/shell/__tests__/TriageList.test.tsx`
Expected: FAIL（`crewVariant` 模块不存在，`crewVariant` 字段为 undefined，第 6 个参数未发送，找不到 `Crew 模式` radiogroup 与徽标）。

- [ ] **Step 4: 实现 `crewVariant.ts`**

```ts
import type { SessionInfo } from './api'

export type CrewVariant = 'chat' | 'topics' | 'goal'
export const GOAL_AGENT = 'kirocrew-conductor'

/** D1: 目标指挥 ships in S5 only if the SP probe saw conductor normal mode end its turn
 *  with chat_done (spec §5 fallback). Set from docs/…/kiro-crew-gap-research.md §7
 *  「S5 SP 补测」: CONDUCTOR_CHAT_DONE = yes → true; no / unverified → false. */
export const GOAL_ENABLED: boolean = true

/** Display variant from the raw Gateway values (spec §7.3). null = not a Crew session. */
export function variantOf(s: Pick<SessionInfo, 'type' | 'crew_mode' | 'crew_agent'>): CrewVariant | null {
  if (s.type !== 'crew') return null
  if (s.crew_agent === GOAL_AGENT) return 'goal'
  if (s.crew_mode === 'crew') return 'topics'
  return 'chat'
}

export interface CrewOpts { crew_mode: string; crew_agent: string }

/** variant → POST /api/sessions fields. S6 T3 exposes `topics`. */
export const CREW_VARIANT_FIELDS: Record<CrewVariant, CrewOpts> = {
  chat: { crew_mode: '', crew_agent: '' },
  goal: { crew_mode: '', crew_agent: GOAL_AGENT },
  topics: { crew_mode: 'crew', crew_agent: '' },
}

/** ⌘K 二级 chip (D1: S5 offers 聊天 / 目标指挥; S6 T3 appends 并行话题). */
export const CREW_VARIANT_OPTIONS: { value: CrewVariant; label: string }[] = [
  { value: 'chat', label: '聊天' },
  ...(GOAL_ENABLED ? [{ value: 'goal' as const, label: '目标指挥' }] : []),
]

/** First-token keywords → variant (lower-case). */
export const CREW_VARIANT_WORDS: Record<string, CrewVariant> = GOAL_ENABLED ? { 'crew:goal': 'goal' } : {}
```

`GOAL_ENABLED` 的值：按 Task 1 写入调研 §7 的 `CONDUCTOR_CHAT_DONE` 取值——`yes` → `true`，`no` / `unverified` → `false`，并把本行注释改为实测结论与日期。取 `false` 时，`CommandPalette.test.tsx` 的 `describe.runIf(GOAL_ENABLED)` 整组跳过，`crewVariant.test.ts` 仍然全部运行。`CommandPalette.tsx` 里「目标指挥」这四个字仍会作为 `CREW_VARIANT_LABEL.goal` 出现（见 Step 7），S6 前置 grep 依然能命中；此时在 Self-Review 的实施记录里注明「目标指挥推迟到 S6 T3」。

- [ ] **Step 5: 实现 `paletteParse.ts` 与 api**

`frontend/src/lib/paletteParse.ts` 替换 `ParsedNew` 与 `parseNew`：

```ts
import type { SessionType } from './api'
import { CREW_VARIANT_WORDS, type CrewVariant } from './crewVariant'

export type NewType = SessionType | 'vault'
export interface ParsedNew { type: NewType | null; dir: string; prompt: string; literalPath: boolean; crewVariant?: CrewVariant }

export const TYPE_WORDS: Record<string, NewType> = { claude: 'claude', codex: 'codex', crew: 'crew', tmux: 'tmux', term: 'tmux', vault: 'vault' }

/** Rule-based, no LLM (spec §4.6). The preview row is what disambiguates.
 *  `crew:<variant>` (G2) is a crew keyword that also picks the Crew variant. */
export function parseNew(input: string): ParsedNew {
  const toks = input.trim().split(/\s+/).filter(Boolean)
  let type: NewType | null = null
  let crewVariant: CrewVariant | undefined
  const first = toks[0]?.toLowerCase()
  if (first && TYPE_WORDS[first]) { type = TYPE_WORDS[first]; toks.shift() }
  else if (first && CREW_VARIANT_WORDS[first]) { type = 'crew'; crewVariant = CREW_VARIANT_WORDS[first]; toks.shift() }
  const dir = toks.shift() ?? ''
  const out: ParsedNew = { type, dir, prompt: toks.join(' '), literalPath: dir.startsWith('/') || dir.startsWith('~') }
  return crewVariant ? { ...out, crewVariant } : out
}
```

（文件其余部分——`LAST_TYPE_KEY`、`loadLastType`、`saveLastType`——不变。已有的 `toEqual` 断言不含 `crewVariant` 键，它们仍然通过，因为只在关键词命中时才加这个键。）

`frontend/src/lib/api/sessions.ts`：`SessionInfo` 在 `lifetime_cost_usd?: number` 之后加：

```ts
  // Crew only (S5 U1): raw Gateway values; see lib/crewVariant.ts. Absent for other types.
  crew_mode?: string
  crew_agent?: string
  crew_origin?: 'zeromux' | 'external' | string
```

`createSession` 替换为：

```ts
export async function createSession(type: SessionType, name?: string, workDir?: string, tmuxTarget?: string, initialPrompt?: string,
  crew?: { crew_mode: string; crew_agent: string }): Promise<SessionInfo> {
  const res = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ type, name: name || null, work_dir: workDir || null, tmux_target: tmuxTarget || null, initial_prompt: initialPrompt || null, ...(crew ?? {}) }),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}
```

`frontend/src/components/shell/useShellState.ts`：接口里 `create(type: SessionType | 'vault', workDir?: string, tmuxTarget?: string, prompt?: string): Promise<void>` 改为

```ts
  create(type: SessionType | 'vault', workDir?: string, tmuxTarget?: string, prompt?: string, crew?: CrewOpts): Promise<void>
```

import 区加 `import type { CrewOpts } from '../../lib/crewVariant'`；实现里 `useCallback(async (type, workDir?, tmuxTarget?, initialPrompt?) => {` 的参数表末尾加 `crew?: CrewOpts`，`createSession(type, undefined, workDir, tmuxTarget, initialPrompt)` 改为 `createSession(type, undefined, workDir, tmuxTarget, initialPrompt, crew)`。

- [ ] **Step 6: 实现徽标**

`frontend/src/components/shell/CrewVariantBadge.tsx`：

```tsx
import { Layers, Target } from 'lucide-react'
import type { SessionInfo } from '../../lib/api'
import { variantOf } from '../../lib/crewVariant'

/** Tiny mark next to the TypeIcon: 目标指挥 / 并行话题. Plain chat shows nothing. */
export function CrewVariantBadge({ session, size = 12 }: { session: Pick<SessionInfo, 'type' | 'crew_mode' | 'crew_agent'>; size?: number }) {
  const v = variantOf(session)
  if (v === 'goal') return <Target size={size} role="img" aria-label="目标指挥" className="shrink-0 text-[var(--fg-subtle)]" />
  if (v === 'topics') return <Layers size={size} role="img" aria-label="并行话题" className="shrink-0 text-[var(--fg-subtle)]" />
  return null
}
```

`TriageRow.tsx`：import 加 `import { CrewVariantBadge } from './CrewVariantBadge'`；`<span className="relative shrink-0 flex items-center …">…</span>`（TypeIcon 那个 span）之后紧接着加 `<CrewVariantBadge session={s} />`；`same()` 的最后一个条件后追加 `&& x.crew_mode === y.crew_mode && x.crew_agent === y.crew_agent`。

`FocusHeader.tsx`：import 加 `import { CrewVariantBadge } from './CrewVariantBadge'`；`<TypeIcon type={session.type} … />` 之后加 `<CrewVariantBadge session={session} />`。

- [ ] **Step 7: 实现 ⌘K 二级 chip**

`CommandPalette.tsx` import 区加：

```tsx
import { CREW_VARIANT_FIELDS, CREW_VARIANT_OPTIONS, type CrewVariant } from '../../lib/crewVariant'
import { SegmentedControl } from '../ui/SegmentedControl'
```

`TYPE_LABEL` 之后加：

```tsx
const CREW_VARIANT_LABEL: Record<CrewVariant, string> = { chat: '聊天', topics: '并行话题', goal: '目标指挥' }
```

`PaletteBody` 里 `const newType: NewType = parsed.type ?? loadLastType()` 之后加：

```tsx
  // Crew variant (G2). A chip click is an explicit choice and beats the keyword
  // (Review Focus 3); the keyword only seeds it while no chip has been clicked.
  const [crewPick, setCrewPick] = useState<CrewVariant | null>(null)
  const offered = (v: CrewVariant | undefined) => (v && CREW_VARIANT_OPTIONS.some(o => o.value === v) ? v : undefined)
  const crewVariant: CrewVariant = crewPick ?? offered(parsed.crewVariant) ?? 'chat'
```

`submitNew` 替换为：

```tsx
  const submitNew = () => {
    if (resolvedDir === null) return
    const type = newType
    const prompt = parsed.prompt
    const crew = type === 'crew' ? CREW_VARIANT_FIELDS[crewVariant] : undefined
    runCreate(
      () => (type === 'vault' ? shell.create('vault')
        : crew ? shell.create(type, resolvedDir || undefined, undefined, prompt || undefined, crew)
        : shell.create(type, resolvedDir || undefined, undefined, prompt || undefined)),
      () => { if (type !== 'vault') saveLastType(type as SessionType); onClose() },
    )
  }
```

`setType` 的第一行改为按「有没有类型关键词」剥离首词（`crew:goal` 也要剥掉），并在切换类型时清掉 chip 选择：

```tsx
  const setType = (t: NewType) => {
    const body = parsed.type ? rest.trimStart().replace(/^\S+\s*/, '') : rest.trimStart()
    setCrewPick(null)
    goNew(`${t} ${body}`)
  }
```

`preview` 的最后一行改为：

```tsx
    const variant = newType === 'crew' && crewVariant !== 'chat' ? ` · ${CREW_VARIANT_LABEL[crewVariant]}` : ''
    return `${TYPE_LABEL[newType]}${variant} · ${dir}${parsed.prompt ? ` · "${parsed.prompt}"` : ''}`
```

类型 chip 的 `</div>`（`role="radiogroup" aria-label="会话类型"` 那个 div 的闭合）之后插入：

```tsx
          {newType === 'crew' && CREW_VARIANT_OPTIONS.length > 1 && (
            <SegmentedControl label="Crew 模式" value={crewVariant} options={CREW_VARIANT_OPTIONS}
              onChange={v => { setCrewPick(v); inputRef.current?.focus() }} />
          )}
```

- [ ] **Step 8: 运行测试通过 + 全量**

Run: `cd frontend && npx vitest run src/lib/__tests__/crewVariant.test.ts src/lib/__tests__/paletteParse.test.ts src/lib/__tests__/createSession.test.ts src/components/shell/__tests__/CommandPalette.test.tsx src/components/shell/__tests__/TriageList.test.tsx src/components/shell/__tests__/FocusHeader.test.tsx src/__tests__/App.characterization.test.tsx && npm test && npm run lint && npm run build && grep -n "目标指挥" src/components/shell/CommandPalette.tsx`
Expected: 全部 PASS；最后的 grep 有输出（S6 前置清单）；首屏增量（Task 9 + 10）≤ 1.8KB。

- [ ] **Step 9: Commit**

```bash
git add frontend/src/lib/crewVariant.ts frontend/src/components/shell/CrewVariantBadge.tsx frontend/src/lib/api/sessions.ts frontend/src/lib/paletteParse.ts frontend/src/components/shell/useShellState.ts frontend/src/components/shell/CommandPalette.tsx frontend/src/components/shell/TriageRow.tsx frontend/src/components/shell/FocusHeader.tsx frontend/src/lib/__tests__/crewVariant.test.ts frontend/src/lib/__tests__/paletteParse.test.ts frontend/src/lib/__tests__/createSession.test.ts frontend/src/components/shell/__tests__/CommandPalette.test.tsx frontend/src/components/shell/__tests__/TriageList.test.tsx
git commit -m "feat(G2): ⌘K Crew 聊天/目标指挥 chip, crew:goal keyword, variant badge

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 11: F4 — 记为约定（方案 A）

**依据:** spec §4、D5、D6、K4、§9（F4 首屏 ≤ 0.5KB）。

**说明:** AcpChatView 注册给 shell 的 `sessionControls.sendPrompt`，就是它自己从 `useAcpSocket` 拿到的那个 `sendPrompt`（`AcpChatView.tsx:310`）。所以在组件内直接调用 `sendPrompt(text, { withAttachments: false })`，与 spec「通过 `sessionControls.sendPrompt`」是同一个函数，不另开 WS，也不经 shell 中转。

**Files:**
- Create: `frontend/src/lib/conventionPrompt.ts`、`frontend/src/components/composer/ConventionDialog.tsx`
- Modify: `frontend/src/components/AcpChatView.tsx`：import（`:1-20`）、状态（`:177-178` 旁）、`plusItems`（`:315-322`）、JSX（`Menu` 之后，`:484`）
- Test: Create `frontend/src/lib/__tests__/conventionPrompt.test.ts`、`frontend/src/components/__tests__/conventionDialog.test.tsx`

**Interfaces:**
- Consumes: `useAcpSocket` 返回的 `events: WireEvent[]` 与 `sendPrompt(text, opts?)`；`toast.push`；`Dialog` / `Sheet`；`useIsNarrow`。
- Produces:
  - `conventionPrompt.ts`：`export function conventionPrompt(text: string): string`；`export function lastOwnPrompt(events: { type: string; text?: string; from_name?: string }[]): string`
  - `ConventionDialog.tsx`：`export function ConventionDialog(p: { open: boolean; initial: string; onClose(): void; onSend(text: string): boolean })`——`onSend` 返回 false 时对话框保持打开、文本不丢。

- [ ] **Step 1: 写纯函数的失败测试**

`frontend/src/lib/__tests__/conventionPrompt.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { conventionPrompt, lastOwnPrompt } from '../conventionPrompt'

describe('conventionPrompt', () => {
  it('embeds the convention verbatim, untruncated, after the fixed instructions', () => {
    const long = '包管理一律用 pnpm，不要用 npm。'.repeat(40) + '\n第二行 `code` $x$'
    const p = conventionPrompt(long)
    expect(p.endsWith(`约定：${long}`)).toBe(true)
    expect(p).toContain('CLAUDE.md 的「## 约定(zeromux)」一节末尾')
    expect(p).toContain('AGENTS.md')
    expect(p).toContain('只追加，不改动其他内容')
    expect(p).toContain('完成后回复「已记录」和追加的原文')
  })
})

describe('lastOwnPrompt', () => {
  it('prefill skips peer messages and blank composer', () => {
    // Review Focus 5: the newest OWN non-blank prompt, never a peer's message.
    expect(lastOwnPrompt([
      { type: 'user_prompt', text: '用 pnpm' },
      { type: 'content_block', text: 'ok' },
      { type: 'user_prompt', text: '   ' },
      { type: 'peer_message', text: '来自别的会话', from_name: 'zmx-ai-abc' },
    ])).toBe('用 pnpm')
    expect(lastOwnPrompt([])).toBe('')
  })
})
```

- [ ] **Step 2: 写组件的失败测试**

`frontend/src/components/__tests__/conventionDialog.test.tsx`：

```tsx
import { render, screen, act, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import AcpChatView from '../AcpChatView'
import { Toaster } from '../ui'
import { installFakeWebSocket } from '../../test/fakeWs'

describe('记为约定 (F4)', () => {
  const origWs = (globalThis as unknown as { WebSocket?: unknown }).WebSocket
  let ws: ReturnType<typeof installFakeWebSocket>
  beforeEach(() => {
    vi.restoreAllMocks()
    ws = installFakeWebSocket()
    globalThis.fetch = vi.fn(async () => new Response('{"runs":[],"lifetime":{"turns":0,"duration_ms":0,"cost_usd":0}}', { status: 200 })) as unknown as typeof fetch
  })
  afterEach(() => { (globalThis as unknown as { WebSocket?: unknown }).WebSocket = origWs })

  const openDialog = async () => {
    await act(async () => { screen.getByLabelText('更多').click() })
    await act(async () => { screen.getByRole('menuitem', { name: '记为约定…' }).click() })
    return screen.getByLabelText('约定内容') as HTMLTextAreaElement
  }

  for (const agentType of ['claude', 'codex', 'crew'] as const) {
    it(`${agentType}: ＋ menu offers 记为约定…`, async () => {
      render(<AcpChatView sessionId="s1" active agentType={agentType} />)
      await act(async () => { screen.getByLabelText('更多').click() })
      expect(screen.getByRole('menuitem', { name: '记为约定…' })).toBeInTheDocument()
    })
  }

  it('prefills from the last own prompt and sends the template without attachments', async () => {
    render(<><AcpChatView sessionId="s1" active agentType="claude" /><Toaster /></>)
    act(() => { ws.latest().fireOpen() })
    await act(async () => { ws.latest().emit({ type: 'user_prompt', text: '以后都用 pnpm', turn_id: 1 }) })
    const box = await openDialog()
    expect(box.value).toBe('以后都用 pnpm')
    fireEvent.change(box, { target: { value: '包管理一律用 pnpm' } })
    await act(async () => { screen.getByRole('button', { name: '发送给 agent' }).click() })
    const sent = ws.latest().sent.map(s => JSON.parse(s)).filter(m => m.type === 'prompt')
    expect(sent).toHaveLength(1)
    expect(sent[0].text).toContain('约定：包管理一律用 pnpm')
    expect(sent[0].text).not.toContain('[用户上传了以下文件')
    expect(screen.getByText('已交给 agent 记录')).toBeInTheDocument()
    expect(screen.queryByLabelText('约定内容')).toBeNull()
  })

  it('socket not open → toast, dialog stays open with the text', async () => {
    render(<><AcpChatView sessionId="s1" active agentType="claude" /><Toaster /></>)
    ws.latest().readyState = 3
    const box = await openDialog()
    fireEvent.change(box, { target: { value: '不要改 CI 配置' } })
    await act(async () => { screen.getByRole('button', { name: '发送给 agent' }).click() })
    expect(screen.getByText('未连接，稍后再试')).toBeInTheDocument()
    expect((screen.getByLabelText('约定内容') as HTMLTextAreaElement).value).toBe('不要改 CI 配置')
  })

  it('blank text cannot be sent', async () => {
    render(<AcpChatView sessionId="s1" active agentType="claude" />)
    await openDialog()
    expect(screen.getByRole('button', { name: '发送给 agent' })).toBeDisabled()
  })
})
```

- [ ] **Step 3: 运行，确认失败**

Run: `cd frontend && npx vitest run src/lib/__tests__/conventionPrompt.test.ts src/components/__tests__/conventionDialog.test.tsx`
Expected: FAIL（模块不存在；菜单里没有「记为约定…」）。

- [ ] **Step 4: 实现 `conventionPrompt.ts`**

```ts
// F4 方案 A (spec §4.2): the current agent appends the convention itself; no backend
// write endpoint (the file API overwrites whole files — lost-update race with the agent).
export function conventionPrompt(text: string): string {
  return [
    '请把下面这条约定追加到仓库根目录 CLAUDE.md 的「## 约定(zeromux)」一节末尾（没有该节就在文件末尾新建；若仓库根存在 AGENTS.md，同样追加一份）。',
    '只追加，不改动其他内容，保持简洁的一行式表述；完成后回复「已记录」和追加的原文。',
    `约定：${text}`,
  ].join('\n')
}

/** Newest non-blank prompt the user typed in THIS session (peer messages excluded). */
export function lastOwnPrompt(events: { type: string; text?: string; from_name?: string }[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type === 'user_prompt' && !e.from_name && e.text?.trim()) return e.text
  }
  return ''
}
```

- [ ] **Step 5: 实现 `ConventionDialog.tsx`**

```tsx
import { useState } from 'react'
import { Dialog, Sheet } from '../ui'
import { useIsNarrow } from '../../lib/useMediaQuery'

/** 「记为约定…」 editor (F4). `onSend` false = not sent (socket closed): stay open, keep text. */
export function ConventionDialog({ open, initial, onClose, onSend }: {
  open: boolean; initial: string; onClose(): void; onSend(text: string): boolean
}) {
  const narrow = useIsNarrow()
  if (!open) return null
  const body = <ConventionForm initial={initial} onClose={onClose} onSend={onSend} />
  return narrow
    ? <Sheet open side="bottom" onClose={onClose} title="记为约定">{body}</Sheet>
    : <Dialog open onClose={onClose} title="记为约定">{body}</Dialog>
}

function ConventionForm({ initial, onClose, onSend }: { initial: string; onClose(): void; onSend(text: string): boolean }) {
  const [text, setText] = useState(initial)
  const btn = 'ctl px-3 rounded-[var(--r-md)] text-ui-sm'
  return (
    <form className="p-4 pt-2 space-y-3" onSubmit={e => { e.preventDefault(); if (text.trim() && onSend(text.trim())) onClose() }}>
      <textarea aria-label="约定内容" value={text} rows={4} onChange={e => setText(e.target.value)}
        className="w-full px-3 py-2 text-ui-input bg-[var(--surface-1)] border border-[var(--border)] rounded-[var(--r-md)] outline-none focus:border-[var(--accent)] resize-y" />
      <p className="text-ui-2xs text-[var(--fg-subtle)]">会让当前 agent 把这条约定追加到仓库根的 CLAUDE.md（若有 AGENTS.md 同步写入）。隔离会话写入的是 worktree，合并后生效。</p>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className={`${btn} text-[var(--fg-muted)] hover:bg-[var(--surface-hover)]`}>取消</button>
        <button type="submit" disabled={!text.trim()} className={`${btn} bg-[var(--accent)] text-[var(--on-accent)] disabled:opacity-50`}>发送给 agent</button>
      </div>
    </form>
  )
}
```

- [ ] **Step 6: 接进 AcpChatView**

import 区：`import { Brain, AlertCircle, Paperclip, Plus, X } from 'lucide-react'` 改为 `import { Brain, AlertCircle, BookmarkPlus, Paperclip, Plus, X } from 'lucide-react'`；`import { IconButton, Menu, Popover, type MenuItem } from './ui'` 改为 `import { IconButton, Menu, Popover, toast, type MenuItem } from './ui'`；追加：

```tsx
import { ConventionDialog } from './composer/ConventionDialog'
import { conventionPrompt, lastOwnPrompt } from '../lib/conventionPrompt'
```

`const [plusOpen, setPlusOpen] = useState(false)` 之后加：

```tsx
  // 「记为约定…」 (F4): prefill = composer text, else this session's last own prompt.
  const [convention, setConvention] = useState<string | null>(null)
```

`plusItems` 替换为：

```tsx
  // 「＋」 menu (V8): 附件 upload, 记为约定 (F4, every agent), and ⌘ memory for Crew only.
  const plusItems: MenuItem[] = [
    { label: '附件', icon: Paperclip, onSelect: () => fileInputRef.current?.click() },
    { label: '记为约定…', icon: BookmarkPlus, onSelect: () => setConvention(input.trim() ? input : lastOwnPrompt(events)) },
    ...(agentType === 'crew' ? [{ label: '记忆', ariaLabel: 'memory', icon: Brain, onSelect: () => {
      setMemConfirming(null)
      setMemOpen(true)
      loadMemRecent()
    } }] : []),
  ]
```

`<Menu open={plusOpen} … title="更多" />` 之后加：

```tsx
              <ConventionDialog open={convention !== null} initial={convention ?? ''} onClose={() => setConvention(null)}
                onSend={t => {
                  // Same sendPrompt this view registers as sessionControls; never carry composer attachments.
                  const ok = sendPrompt(conventionPrompt(t), { withAttachments: false })
                  toast.push({ message: ok ? '已交给 agent 记录' : '未连接，稍后再试' })
                  return ok
                }} />
```

- [ ] **Step 7: 运行测试通过 + 全量**

Run: `cd frontend && npx vitest run src/lib/__tests__/conventionPrompt.test.ts src/components/__tests__/conventionDialog.test.tsx src/components/__tests__/crewMemoryWrite.test.tsx src/components/__tests__/sendPromptAttachments.test.tsx src/__tests__/App.characterization.test.tsx && npm test && npm run lint && npm run build`
Expected: 全部 PASS。记下首屏 br；S5-b 三个 task 合计增量 > 2.5KB 时，把 `ConventionDialog` 改为 `const ConventionDialog = lazy(() => import('./composer/ConventionDialog').then(m => ({ default: m.ConventionDialog })))`，外面包 `<Suspense fallback={null}>`，只在 `convention !== null` 时渲染，然后重跑本 step。

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/conventionPrompt.ts frontend/src/components/composer/ConventionDialog.tsx frontend/src/components/AcpChatView.tsx frontend/src/lib/__tests__/conventionPrompt.test.ts frontend/src/components/__tests__/conventionDialog.test.tsx
git commit -m "feat(F4): 记为约定 — the current agent appends the convention to CLAUDE.md

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 12: S5-b 部署 — 前端门禁、headless 冒烟、合入 main，`./deploy.sh --build`

**依据:** spec §9、§11；记忆「黑屏 = node_modules 软链打进两份 React，用 playwright `--no-sandbox` 抓 pageerror」。

**Files:**
- 无代码改动。

**Interfaces:**
- Consumes: Task 9–11。
- Produces: 线上运行 S5 全量；S6 前置清单 12 条 grep 全部有输出。

- [ ] **Step 1: 全量门禁与体积**

```bash
cd /home/ubuntu/s3-workspace/keith-space/github-search/ai/zeromux
find frontend/node_modules -maxdepth 3 -type l -lname '/tmp/*'
cd frontend && npm test 2>&1 | tail -3 && npm run lint && npm run build 2>&1 | tail -4 && cd ..
cargo test 2>&1 | tail -3
```

Expected: `find` 无输出；全绿；`check-size` 打印的首屏 br 比 Task 8 时的值多 ≤ 2.5KB。

- [ ] **Step 2: S6 前置清单全量自检**

```bash
grep -n "fn persist_posture" src/session_manager.rs \
 && grep -n "awaiting_input" src/session_manager.rs src/session_store.rs | head -2 \
 && grep -n "crew_mode\|crew_agent\|crew_origin" src/session_store.rs | head -2 \
 && grep -n "pub crew_mode\|pub crew_origin" src/session_manager.rs \
 && grep -n "pub fn payload_for(kind: &str, name: &str, session_id: &str, fk: Option<&str>, body: Option<&str>)" src/push.rs \
 && grep -n "enum SlotInit\|owns_slot" src/acp/crew_process.rs | head -2 \
 && grep -n "fn crew_message_events" src/acp/crew_process.rs \
 && grep -rn 'target: *"zmx_usage"' src | head -3 \
 && grep -n "first_prompt_logged" src/session_manager.rs | head -1 \
 && ls frontend/src/lib/awaySummary.ts frontend/src/components/shell/AwayCard.tsx frontend/src/lib/crewVariant.ts \
 && grep -n "目标指挥" frontend/src/components/shell/CommandPalette.tsx \
 && echo ALL-S6-PREREQS-OK
```

Expected: 最后一行 `ALL-S6-PREREQS-OK`。

- [ ] **Step 3: headless 冒烟（隔离实例，抓 pageerror）**

```bash
cargo build --release 2>&1 | tail -1
SMOKE=$(mktemp -d)
./target/release/zeromux --port 18092 --password smoke --data-dir "$SMOKE" --tmux-socket zmx-s5-smoke > "$SMOKE/log" 2>&1 &
echo $! > "$SMOKE/pid"; sleep 2
cat > "$SMOKE/smoke.mjs" <<'JS'
import { chromium } from 'playwright'
const b = await chromium.launch({ args: ['--no-sandbox'] })
const p = await b.newPage()
const errs = []
p.on('pageerror', e => errs.push(String(e)))
await p.goto('http://127.0.0.1:18092/')
await p.fill('input[type=password]', 'smoke'); await p.keyboard.press('Enter')
await p.waitForTimeout(1500)
// F3: plant a 2h-old left time, reload → card only if there are events; must not crash either way.
await p.evaluate(() => localStorage.setItem('zmx_left_ms', String(Date.now() - 7_200_000)))
await p.reload(); await p.waitForTimeout(1500)
// G2: ⌘K new-mode crew shows the Crew 模式 control.
await p.keyboard.press('Control+k'); await p.keyboard.type('+crew ~ ')
await p.waitForTimeout(500)
const seg = await p.locator('[role=radiogroup][aria-label="Crew 模式"]').count()
console.log(JSON.stringify({ errs, crewSegmented: seg }))
await b.close()
JS
# playwright lives OUTSIDE frontend/node_modules (never link/install it there — 2026-09-28 dual-React lesson).
(cd "$SMOKE" && npm init -y >/dev/null && npm i --no-save --silent playwright@1 && node smoke.mjs)
kill "$(cat "$SMOKE/pid")"; tmux -L zmx-s5-smoke kill-server 2>/dev/null; rm -rf "$SMOKE"
```

Expected: `errs` 为 `[]`；`GOAL_ENABLED = true` 时 `crewSegmented` 为 `1`，为 `false` 时为 `0`。登录页选择器与实际不符时，按 `frontend/src/components/LoginPage.tsx` 的输入框调整 `p.fill` 的选择器，其余不变。

- [ ] **Step 4: 合入并推送（先 push 再 deploy）**

```bash
git checkout main && git merge --no-ff feat/s5b-frontend -m "Merge branch 'feat/s5b-frontend'"
git push origin main
```

- [ ] **Step 5: 部署**

```bash
./deploy.sh --build
```

Expected: 健康检查通过；从 zeromux 终端执行时本终端会掉线（预期），重连后 `systemctl is-active zeromux` 为 `active`。

- [ ] **Step 6: 线上手测（手机）**

1. 关掉 PWA ≥ 30 分钟（期间让一个定时任务或会话跑完）→ 从后台切回：分诊顶部出现「离开 Xh · 完成 N …」，点「完成 N」跳到最近完成的会话，× 后本次不再出现。
2. ⌘K → `crew:goal ~/某目录 只回复 OK` → 建出的会话在分诊行和 FocusHeader 上有 Target 徽标；`journalctl -u zeromux --since "5 min ago" | grep zmx_usage` 能看到 `crew_create … agent=kirocrew-conductor` 与 `crew_first_prompt`（`GOAL_ENABLED = false` 时跳过本条）。
3. 任一 Claude 会话 → 「＋」→「记为约定…」→ 发送 → agent 回复「已记录」并附原文；到仓库根 CLAUDE.md 核对「## 约定(zeromux)」一节。

---
## Self-Review

**1. Spec 覆盖**

| spec | Task |
|---|---|
| §0.1 SP / §5（含 D10、K1 兜底） | 1 |
| §0.1 F1 / §1 / U1 七列 / U3 / D9 / K3 / K6 | 2 |
| §0.1 F2 / §2 / U4 / D7 / D8 | 3（后端）、4（SW + PushSettings 文案） |
| §0.1 G1 / §6 / D2 / D3 / K2 | 5 |
| §0.1 R4 / §8 / U2 | 6 |
| §0.1 G2 后端 / §7.2 / §7.4 / U5 | 7 |
| §0.1 F3 / §3 / D4 | 9 |
| §0.1 G2 前端 / §7.3 / D1 | 10 |
| §0.1 F4 / §4 / D5 / D6 / K4 | 11 |
| §9 体积预算 | 9、10、11 的 build 步骤；12 Step 1 汇总 |
| §10 过程指标（完成·未读保留率、推送可判定率） | 8 Step 6、12 Step 6 手测 |
| §11 分期、先 push 再 deploy | 8、12 |

不做（§13）的项在 Global Constraints 末行列出；spec §10 的「记为约定」不埋点，本计划也不加。

**2. 占位符扫描**：没有 TBD，也没有「类似 Task N」。有两处是**实测后二选一**，两个分支的代码都已写全，不属于占位：Task 7 Step 5 的 `patch_slot_mode`（仅 `CREATE_WITH_MODE = no` 时加入），Task 10 Step 4 的 `GOAL_ENABLED` 取值。两处的判定依据都是 Task 1 Step 4 写进调研 §7 的结论。

**3. 类型一致性**：`PersistedPosture`（Task 2 定义，Task 3/6 沿用）；`Posture.awaiting_input` 与 `Posture.turn_snippet`（Task 2/3）；`CrewMeta { mode, agent, origin }` 与 `SlotInit::{New{mode,agent}, Resume{key,owns}}`（Task 6 定义，Task 7 扩展 `New` 臂的用法）；`spawn_crew(…, init: SlotInit)`（Task 6），`create_crew_session(…, crew_mode, crew_agent)`（Task 7，web.rs 同步调用）；`SessionInfo.crew_*: Option<String>`（Task 7）对应前端 `crew_mode?/crew_agent?/crew_origin?`（Task 10）；`CrewOpts { crew_mode, crew_agent }`（Task 10），在 `createSession`、`ShellState.create` 和 `CREW_VARIANT_FIELDS` 三处同名同形。S6 计划消费的名字都与本计划逐字对照过：`crew_topics_tests::topics_session` 用的是 `crew: Some(CrewMeta {…})`；`p.posture.awaiting_input` 用的是 `PersistedSession.posture: PersistedPosture`；`spawn_crew` 签名在本计划形态上追加 `topics, cursor`；`payload_for(…, None, Some(&body))` 是 5 参；`AwayCard` 的 props 是 `summary / onSelect / onDismiss`；`CREW_VARIANT_OPTIONS` / `CREW_VARIANT_WORDS` 就是 S6 Task 12 说的「映射表」和「options」。

**4. Review Focus 与测试的对应**

| # | 用例 | 所在 task |
|---|---|---|
| 1 | `push_snippet_is_this_turns_result_only` | 3 |
| 2 | `resume from background re-arms the card` | 9 |
| 3 | `chip click overrides the crew:goal keyword` | 10 |
| 4 | `fresh_fallback_keeps_mode_and_agent_and_owns` | 6 |
| 5 | `prefill skips peer messages and blank composer` | 11 |

**5. spec 与代码、S6 计划之间的不一致（实施时以本计划为准）**

1. **turn_done 推送的 snippet 取值时机**：spec §2.2 说在锁内读 `posture.last_snippet`。但 Claude fan-out 里推送在 `settle_posture` 之前发出（`session_manager.rs:2979` 对 `:3100`），Errored 轮会推出上一轮的结论。本计划改为读不持久化的 `Posture.turn_snippet`（Task 3）。
2. **`SlotOpts`**：spec §7.2 写 `spawn_crew(.., SlotOpts{mode, agent})`。S6 前置清单只要求 `enum SlotInit`，S6 Task 9 消费的是 `CrewProcess::spawn(cfg, work_dir, SlotInit)` 和 `Session.crew: Option<CrewMeta>`。本计划不引入 `SlotOpts`，`spawn_crew` 直接收 `SlotInit`，由 `crew_slot_init(token, crew)` 算出（Task 6）。按 S6 为准。
3. **`PersistedSession.posture` 的结构**：spec §1.2 同时列了 `posture: PersistedPosture {…}` 和「三个 `crew_*: String`」。S6 用的是 `p.posture.awaiting_input`，本计划照此实现。
4. **`SessionInfo.crew_*` 类型**：spec §7.2 说「非 Crew 会话省略」，所以用 `Option<String>` + `skip_serializing_if`。S6 前置 grep 的 `pub crew_mode` / `pub crew_origin` 能匹配；S6 Task 12 的前端 `s.crew_mode !== 'crew'` 对 undefined 同样成立。
5. **`context_usage` 字段名**：线上实测帧（调研 §7 原始数据）是 `used_tokens` / `window_tokens` / `pct`，而 `normalize_frame` 读的是 `used` / `total|limit`，所以 Crew 的 ctx% 目前恒不显示。这不在 S5 范围，Task 1 Step 6 把它写进调研 §7 作为 deferred。
6. **`CREATE_WITH_MODE` 未经验证**：spec §7.1 引 `chat_handlers.py:2271,2389` 说建 slot 时可以传 mode/agent，但 §7 R2 实测走的是 `PATCH …/mode`。Task 1 补测这一点，Task 7 按结论决定是否补 `patch_slot_mode`。
7. **`/api/health`**：spec §5 与 CLAUDE.md 都没有定义这个端点。Task 1 的存活探测只看 Gateway 是否监听（任意状态码）。
8. **行号基线**：spec 引用的 file:line 基于 `33c2236`；`src/` 在 `ae5fef7` 上没有变化，所以行号仍然成立。前端行号按 `ae5fef7` 核对（S4 改过 AcpChatView 周边，但 `plusItems` 仍在 `:315`）。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-29-s5-feed-and-crew-probe.md`. Please review the plan. Which execution approach would you prefer?

- **Subagent-driven** — a fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** — I implement every task myself in this session, then one fresh reviewer on the most capable model checks the whole branch. Cheapest and fastest; no independent review until the end.

For this plan I recommend **Subagent-driven**, because Tasks 2→3→6→7 thread new fields through the same eleven `Session` literals and S6 greps the exact names, so a per-task reviewer catches a drifted signature before the next task builds on it.
