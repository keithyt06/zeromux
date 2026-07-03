# 推送自愈加固 — 设计文档（v2，经 CTO + PM 双评审修订）

日期：2026-07-03
分支：`feat/push-self-heal`

## 问题陈述

线上 Web Push 推送**经常失灵，且每次都要重新进设置手动开启**。

## 根因诊断（v2：主犯已由评审纠正，均实证）

> v1 曾把"浏览器周期性轮换订阅 + 缺 `pushsubscriptionchange`"定为主犯。CTO 评审
> 用 Apple/Chromium 官方文档 + 本仓代码推翻了这一定性，PM 评审补充了体验缺口。以下
> 为已复核（读代码坐实）的 v2 结论。

### 主犯（P1）：iOS「静默推送三振吊销」

- **Apple 明确：Safari 不支持静默推送**——SW 收到 `push` 事件后若不 `showNotification`，
  Safari 会在**约 3 次**后吊销推送权限/订阅
  （[Apple 文档](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)、
  [progressier 机制分析](https://dev.to/progressier/how-to-fix-ios-push-subscriptions-being-terminated-after-3-notifications-39a7)、
  [firebase-js-sdk#8010](https://github.com/firebase/firebase-js-sdk/issues/8010) 同款症状）。
- **本仓恰好制造静默推送**（已读码坐实）：
  - `send_to_user`（`src/push.rs:387`）**不带级别参数**，后端把 `turn_done`
    **无条件发给该用户所有订阅**（`session_manager.rs:2061-2063` 只过时长/去抖门）。
  - 前端 `routine` **默认 false**（`sw.js:22,61`、`push.ts:69`）。
  - SW 收到后 `if (!levelAllows(kind, levels)) return`（`sw.js:23`）→ **不展示通知**。
  - ⇒ **默认配置下，每次 turn 完成到达 iOS 都是一条静默推送** → 累计 ~3 次即被吊销 →
    "推送停了，得进设置重开一次"（重开 = 权限被吊销后重新授权）。
- 前台抑制 `return`（`sw.js:31`）是第二条静默路径，同理累积吊销风险。

### 次犯（P2）：订阅失效后客户端无自愈

- 线上 `push.db` 有 **3 条 Apple 订阅全挂 `legacy`**，印证订阅换过多轮却从未主动续订。
- `sw.js` 无 `pushsubscriptionchange` handler，服务端 410 清库后本地订阅还在 →
  `getPushState()`（`push.ts:25`）只看浏览器本地 → UI 谎报"已开启"实际收不到（根因 B）。

### `pushsubscriptionchange` 的现实（决定其定位为"防线"而非"根治"）

- **Chrome**：订阅不过期、多年从不触发；2025 M137 起仅在"权限撤销后重授"触发，且
  `old/newSubscription` 均空
  （[Chromium blink-dev Intent to Ship](https://groups.google.com/a/chromium.org/g/blink-dev/c/_ckNx_SZIjc)、
  [w3c/push-api#325](https://github.com/w3c/push-api/issues/325)）。
- **Firefox**：触发但 `old/newSubscription` 恒 undefined。
- **Safari**：名义 shipped，触发时机无官方文档、实测不可靠
  （[MDN 标注非 Baseline](https://developer.mozilla.org/docs/Web/Events/pushsubscriptionchange)）。
- ⇒ handler 里"从 `oldSubscription.options` 取 key，取不到 fetch vapid-key 兜底"中，
  **fetch 兜底其实是主路径**。保留该 handler 作防线，但根治靠 P1。

## 方案（v2）

拆分独立分支 `feat/push-self-heal`，与 vault HTML 渲染互不相关。

### 改动 1（P1 根治）：级别过滤搬到服务端，iOS 上「凡到达必展示」

- **订阅表加两列** `lvl_important INTEGER NOT NULL DEFAULT 1`、
  `lvl_routine INTEGER NOT NULL DEFAULT 0`（`ALTER TABLE ... ADD COLUMN`，旧行取默认）。
- **`/api/push/subscribe` 接收 levels**（可选字段，缺省 important=on/routine=off），
  `upsert` 写入。前端 `setLevels` 时也 `POST` 一次同步到服务端（新增轻量端点
  `POST /api/push/levels` 或复用 subscribe 的 upsert；见"接口"）。
- **`send_to_user` 增加 `kind→level` 过滤**：遍历订阅时，按该订阅的 `lvl_*` 决定是否投递。
  `turn_done`→需 `lvl_routine`；`run_failed`/`confirm`/`stuck`→需 `lvl_important`。
  **不满足级别的订阅直接跳过，不产生任何到 Apple 的请求** → 不再有静默推送 →
  不触发三振吊销。
- **SW 侧**：收到即 `showNotification`（保留 `levelAllows` 仅作 Chrome 的双保险——
  Chrome 静默丢弃只弹 "site updated in background"，不吊销）。**移除**"级别不匹配就
  `return`"作为 iOS 的主依赖——因为该判定已前移到服务端，SW 收到的必是该展示的。
- **前台抑制**（`sw.js:31`）：保留，但仅对 `turn_done`（本就仅此类抑制）。由于 routine
  默认关、且服务端已按级别过滤，iOS 上 turn_done 只有在用户显式开 routine 时才会发；
  此时前台抑制偶发一次静默不足以三振（去抖 + 用户在前台的时间窗有限）。**验收需实测**；
  若实测仍触发吊销，退化为"前台也展示 turn_done"。

### 改动 2（P2 防线 A）：`sw.js` 增加 `pushsubscriptionchange` handler

- key 来源：`event.oldSubscription?.options?.applicationServerKey` → 兜底
  `fetch('/api/push/vapid-key')`（实为主路径）。
- 重新 `subscribe` → `POST /api/push/subscribe`（带当前 levels）。全程 try/catch，不抛。

### 改动 3（P2 防线 B）：回到前台时静默自愈（时机扩大）

- 抽 `resyncPush()` 到 `lib/push.ts`（纯逻辑，便于单测）：若
  `Notification.permission === 'granted'`——
  - 本地有 subscription → 静默重新 `POST /subscribe`（幂等，修复服务端被 410 清空的错位）。
  - 本地无 subscription 但 localStorage 有 `zmx_push_enabled` 标记 → 静默重跑 `subscribe`。
- **挂载点（PM 采纳）**：不仅 `main.tsx` 页面加载，**额外挂 `visibilitychange→visible`**
  （节流：每小时至多一次）。iOS PWA 常驻内存、数天不冷启动，仅靠加载时自愈窗口太窄。
- `enablePush()` 成功写 `zmx_push_enabled=1`；`disablePush()` 清除（避免用户主动关后被自愈重开）。

### 改动 4（PM 强烈建议，纳入本期）：设置面板「发送测试推送」按钮

- 新端点 `POST /api/push/test`（authed），复用 `send_to_user` 给当前用户发一条
  `kind:"test"`（`payload_for` 加 test 分支，级别按 important 走，确保 iOS 必展示）。
- `PushSettings.tsx` 在"已开启"时显示按钮。端到端自证整条链（本地订阅→服务端→VAPID
  签名→Apple→SW 展示），既建立用户信任，也是日后排障利器。

### 改动 5（P3）：服务端陈旧订阅清理

- `upsert` 成功后按 `user_id` 仅保留最近 `PUSH_MAX_SUBS_PER_USER=5` 条（`created_ms` 降序），
  多余删除。注释写明依赖改动 3 的 resync 刷新 `created_ms` 以免误删低频活跃设备（如 iPad）。

### 接口/鉴权注意（CTO P2，写入实现约束）

- SW 内 `fetch` 拿不到 localStorage 的 Authorization header，只能靠 cookie
  （legacy `zeromux_token` 7d、OAuth `zeromux_jwt` 有 Max-Age）。cookie 过期后续订会
  **静默 401**。改动 2 失败时**写一个 Cache 标记**，让下次改动 3 的前台自愈接手。
- 主线程路径（`enablePush`/`resyncPush`）**改用 `api()` helper 带 Authorization**，
  消除"app 正常但 push 端点因 cookie 过期 401"的静默分叉。

## 不改动

后端发送的 SSRF 守卫（`endpoint_is_safe` 双查 + `redirect::none`）、去抖算法
（`should_push_turn_done`/`should_push_stuck`）、深链、两档级别的**语义**（只是把执行点
从纯客户端前移到服务端）。

## 验证

- **单测（后端）**：`send_to_user` 按订阅级别过滤（routine 关的订阅收不到 turn_done、
  能收到 run_failed）；subscribe 写入/更新 levels；`ALTER TABLE` 旧行取默认；每用户订阅
  数 ≤ 5 且保留最近；跨用户不误删；`/api/push/test` 给当前用户发一条。
- **单测（前端）**：`resyncPush()` 三分支；`enablePush/disablePush` 读写 `zmx_push_enabled`；
  SW key 选择逻辑（抽为可测模块——见下）。
- **SW 可测性（CTO P3-2）**：`sw.js` 在 `frontend/public/` 不进 Vite 打包，vitest 无法
  直接 import。沿用现有 `levelAllows` 双份模式：把 key 选择纯逻辑复制到
  `lib/push.ts` 可测函数，`sw.js` 手动同步（代码注释标注"与 sw.js 同步"）。
- **真机 checklist（CTO P2-3，专测真凶）**：
  ① routine **关闭** + 连续 ≥3 次长 turn 完成后，`run_failed`/`confirm` 仍能送达
     （若改动 1 未生效，此项会当场红）；
  ② iOS PWA 开推送 → 放置 ≥24h → 仍能收到 important 类，中途不需手动重开；
  ③ 点"发送测试推送"能立即收到。
- 记录于 PR。

## 残余风险（对用户诚实，写入 PR/文档）

- 订阅在用户**完全不打开 app 期间**轮换、且 iOS 未触发 SW 事件 → 直到下次打开前推送全丢。
  这是平台天花板，双防线 + 服务端级别过滤已把可控部分做到最好，此死窗无解，明确告知避免
  下次偶发丢失被当"没修好"重查。
- 改动 1 的前台抑制若实测仍导致吊销，退化为"前台也展示 turn_done"。
