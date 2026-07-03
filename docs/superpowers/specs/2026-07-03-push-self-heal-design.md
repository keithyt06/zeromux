# 推送自愈加固 — 设计文档

日期：2026-07-03
分支：`feat/push-self-heal`

## 问题陈述

线上 Web Push 推送**经常失灵，且每次都要重新进设置手动开启**。

## 根因诊断（已实证）

通读 `src/push.rs`、`frontend/src/lib/push.ts`、`frontend/public/sw.js`、
`PushSettings.tsx`，并查了线上 `~/.zeromux/push.db`（legacy 模式，库里当前有
**3 条 Apple 订阅全挂在 `legacy` 用户**下）。

- **根因 A（核心，解释"每次要重开"）：`sw.js` 缺 `pushsubscriptionchange` handler。**
  浏览器 / Apple 会周期性轮换（作废）推送订阅——iOS PWA 尤其频繁。标准 Web Push
  应用必须在 Service Worker 监听 `pushsubscriptionchange`，用新订阅重新调
  `/api/push/subscribe`。当前项目全局 0 处该 handler。旧订阅失效后服务端仍往死
  endpoint 发 → 收到 410 → 服务端 `delete` 掉这条 → `push.db` 变空 → 表现即
  "推送停了，得进设置重开一次"。**这是必然周期性发生，非偶发。**

- **根因 B：前端状态检测不校验服务端存在性。** `getPushState()` 只看浏览器本地
  `pushManager.getSubscription()`，不校验服务端 `push.db` 里是否仍有该 endpoint。
  当本地订阅还在、但服务端那条已被 410 清掉时，UI 显示"已开启"实际收不到 →
  用户感知为"随机失灵"。

- **根因 C：线上库堆积 3 条陈旧订阅（均 legacy）。** 印证订阅换过多轮却从未主动
  续订/清理。

- 次要：debounce map 为纯内存 `Mutex<HashMap>`，进程重启清零——不影响"收不到"，
  仅让重启后首条 turn_done 不受去抖限制。不在本次修复范围。

## 方案

拆分独立分支 `feat/push-self-heal`，与 vault HTML 渲染互不相关。

### 改动 1：`sw.js` 增加 `pushsubscriptionchange` handler（根治）

```
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    // 优先复用 oldSubscription 的 applicationServerKey；取不到再 fetch vapid-key
    // 用新 key 重新 subscribe，再 POST /api/push/subscribe 续上
  })())
})
```

- `applicationServerKey` 来源顺序：`event.oldSubscription?.options?.applicationServerKey`
  → 兜底 `fetch('/api/push/vapid-key')`。
- 重新 `self.registration.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey })`。
- `POST /api/push/subscribe`，body 为新订阅的 `{endpoint, keys}`。
- 全程 try/catch，失败不抛（推送非关键路径）。

### 改动 2：前端页面加载时静默自愈（`main.tsx`）

在 SW 注册后，若 `Notification.permission === 'granted'`：
- 本地存在 subscription → 静默重新 `POST /api/push/subscribe`（幂等 upsert，
  修复"服务端被 410 清空而本地还在"的错位）。
- 本地无 subscription 但 localStorage 有"曾开启"标记（`zmx_push_enabled`）→ 静默
  重新 `subscribe` 全流程。
- 抽成 `lib/push.ts` 的 `resyncPush()`，纯函数化便于单测；`main.tsx` 仅调用。
- `enablePush()` 成功后写 `localStorage.setItem('zmx_push_enabled','1')`；
  `disablePush()` 清除该标记（避免用户主动关闭后又被自愈重新打开）。

### 改动 3：`getPushState` 反映真实性

设置面板"已开启"以"浏览器本地有订阅"为主判据不变，但自愈（改动 2）保证本地有
订阅时服务端必然也有，从而消除错位。**不新增服务端存在性查询端点**（避免扩大
REST 面 + legacy/OAuth 双模式复杂度）——自愈的幂等 re-subscribe 已覆盖该场景。

### 改动 4：服务端陈旧订阅清理（`src/push.rs`）

`upsert` 成功后，按 `user_id` 仅保留最近 `PUSH_MAX_SUBS_PER_USER`（=5）条，按
`created_ms` 降序，多余的删除。防止像线上那样无限堆积死订阅。纯 SQL，单测覆盖。

## 不改动

后端发送逻辑、SSRF 守卫（`endpoint_is_safe` 双查 + `redirect::none`）、去抖算法
（`should_push_turn_done` / `should_push_stuck`）、两档级别开关、深链。这些已验证正确。

## 验证

- **单测（前端）：** `resyncPush()` 三分支（本地有订阅/曾开启无订阅/未开启）；
  `enablePush`/`disablePush` 正确读写 `zmx_push_enabled` 标记。
- **单测（SW 逻辑）：** 把 `pushsubscriptionchange` 的 key 选择 + 重订阅逻辑抽为可测
  纯函数（applicationServerKey 来源优先级）。
- **单测（后端）：** `upsert` 后每用户订阅数 ≤ 5，且保留的是最近的；跨用户不误删。
- **真机 checklist：** iOS PWA 开启推送 → 放置 ≥ 24h → 仍能收到 turn_done/confirm；
  中途不需手动重开。（人工，记录于 PR。）

## 风险

- iOS Safari 对 `pushsubscriptionchange` 支持历史上有缺陷（部分版本不触发该事件）。
  改动 2 的"页面加载自愈"是对此的**第二道防线**：即使 SW 事件不触发，用户下次打开
  PWA 也会静默续订。两道防线叠加即可覆盖绝大多数失效场景。
