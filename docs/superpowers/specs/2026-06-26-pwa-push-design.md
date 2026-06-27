# 设计:PWA + Web Push 推送通知(Feature 2)

- **日期**:2026-06-26
- **状态**:待实现(spec 已过实证门;待用户审阅 + 后续双评审)
- **范围**:Feature 2(Feature 1 成本校准已 ship)
- **接入点**:`src/push.rs`(新)、`src/web.rs`、`src/session_manager.rs`、`src/scheduled_tasks.rs`、`Cargo.toml`;`frontend/public/sw.js`(新)、`frontend/src/lib/push.ts`(新)、`frontend/src/main.tsx`、设置区开关组件
- **不变量**:不破坏广播扇出模型;推送是 fire-and-forget,绝不阻塞 fan-out 热路径,绝不影响核心会话

---

## 1. 背景与动机

zeromux 手机优先,核心价值是"人离开桌面也能管 agent"。现网竞品(官方 Remote Control、Happy Coder)与多 agent 操作者(Boris Cherny 的"系统通知告诉我哪个 tab 需要输入")都把**通知**作为刚需。zeromux 已有前端红点/readCounts/busy 翻转(`App.tsx:24-26,114-116`;`AcpChatView.tsx:237-253`),但**息屏/切走时完全收不到**——这正是缺口。

PWA 基础已就位(`index.html:7` manifest 链接,`manifest.json` 含 `display:standalone`),但**无 service worker、无 web-push**。本 feature 补齐:真 Web Push(VAPID + SW 后台推),息屏可达。

## 2. 实证门(已执行)

承重假设:方案 C(用 `web-push` crate 做 VAPID+加密,但用现有 reqwest 发送,不引入 isahc/hyper)要求 `WebPushMessage` 暴露加密后的 body+headers。

**验证**:`web-push = "0.11"` 探针编译,访问 `msg.payload.{content: Vec<u8>, crypto_headers, content_encoding}` **零编译错误** → 字段公开可访问。运行时 `InvalidCryptoKeys` 仅因探针用了假密钥(证明加密路径在跑)。

**结论**:方案 C 成立。`web-push` 做难且易错的 RFC8188 加密 + VAPID 签名;取出 `payload.content` + `crypto_headers` 用现有 reqwest(rustls)POST。不引入 isahc(libcurl)/hyper(OpenSSL),保持单二进制纯 rustls、体积优化栈。VAPID 密钥对 `web-push` 不生成 → 用 `p256` crate 生成。

## 3. 依赖变更

`Cargo.toml` 新增:
- `web-push = "0.11"`(**仅用其 builder/加密/VAPID 签名,不用其 client**;若默认 features 强拉 isahc,用 `default-features = false` 并按需开启仅加密所需 feature——实现时核实最小 feature 集)。
- `p256 = { version = "0.13", features = ["pem", "ecdsa"] }`(VAPID 密钥对生成 + PKCS8 PEM 导出 + uncompressed 公钥)。

复用现有:`reqwest 0.12`(rustls,发送)、`base64 0.22`、`rand 0.9`、`rusqlite`(经 db 层)。

前端:**无新增运行时依赖**(Web Push / Notification / SW 均浏览器原生 API)。

## 4. 后端设计

### 4.1 `src/push.rs`(新模块)

**VAPID 密钥**:
- `load_or_generate() -> Vapid`:读 `~/.zeromux/vapid.json`(字段:私钥 PKCS8 PEM、公钥 base64url uncompressed point);不存在则 `p256` 生成 P-256 对、导出两种格式、写盘(权限 0600)。
- 公钥经 `GET /api/push/vapid-key` 暴露给前端 `applicationServerKey`。
- 生成/加载失败 → 整个推送子系统禁用(`PushService` 不构建,handle = None),`tracing::warn`,其余功能照常(对齐语音缺 AWS 凭证的降级)。

**`push_subscriptions` 表**(SQLite,经 db 层;legacy/OAuth 两模式统一,SQLite 永远打开):
```sql
CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint   TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    created_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
```
- endpoint 主键 → 同浏览器重订阅 `INSERT OR REPLACE`(upsert)。
- `user_id` 来自 `CurrentUser.id`(legacy="legacy" 单用户;OAuth=UUID 多用户)。

**`PushStore`**(表 CRUD):`upsert(user_id, endpoint, p256dh, auth)`、`list_for_user(user_id) -> Vec<Subscription>`、`delete(endpoint)`。

**`PushPayload`**(序列化为 JSON 作为推送 body,SW 解析):
```rust
struct PushPayload { kind: String, session_id: String, title: String, body: String }
// kind ∈ "turn_done" | "run_failed" | "confirm"
```
文案(不含对话正文,隐私+体积):
- turn_done:title `✅ {session_name} 完成`,body `本轮已结束`
- run_failed:title `⚠️ {session_name} 失败`,body `{failure_kind 中文}`(超时/传输错误/退出等)
- confirm:title `❓ {task_name} 需确认`,body `运行中断,等待确认`

**`send_push(user_id, payload)`**(async;**调用方 `tokio::spawn`,绝不在热路径 await**):
1. `list_for_user(user_id)`;空 → 返回。
2. 每订阅:`SubscriptionInfo::new(endpoint,p256dh,auth)` → `WebPushMessageBuilder` set payload(`ContentEncoding::Aes128Gcm`,JSON bytes)+ VAPID 签名(from PEM)→ `.build()` → 取 `payload.content`+`crypto_headers` → reqwest POST 到 endpoint(附 `TTL`、`Urgency` 头)。
3. 响应 **404/410 → `delete(endpoint)`**(端点失效);其它错误 `tracing::warn`,继续下一个。
4. 错误隔离:任一订阅失败不影响其它、不向上传播。

### 4.2 `src/web.rs` 端点(authed `/api/*` 组,需 `CurrentUser`)

- `GET /api/push/vapid-key` → `{ "key": "<base64url 公钥>" }`。
- `POST /api/push/subscribe` body `{endpoint, keys:{p256dh, auth}}` → `PushStore.upsert(user.id, ...)` → `{ok:true}`。
- `POST /api/push/unsubscribe` body `{endpoint}` → `PushStore.delete(endpoint)` → `{ok:true}`。

### 4.3 触发点接线

`SessionManager` 持 `Option<Arc<PushService>>`(仿现有 `scheduled` handle:`Mutex<Option<...>>`,启动后 set)。fan-out / 调度处:`if let Some(p) = push_handle { tokio::spawn(async move { p.send_push(uid, payload).await }); }`。

三个触发点:
1. **交互 turn 完成**:`session_manager.rs` 的 `mark_turn(_, TurnState::Idle, _)` 命中处(Claude `:2012`、Kiro `:2567` 等)。**仅普通交互 turn**(`run_id` 为 None 的)。session_name 取会话 name。
   - 前台抑制由 SW 端做(见 §5),后端无条件推。
2. **无人值守 run 失败/超时**:run 记录 outcome 为 `Errored`/`Timeout` 处(scheduled/idle-watchdog 路径)。payload kind=`run_failed`,body=failure_kind。
3. **确认队列新增**:`scheduled_tasks.rs` 新 run 进入 `confirmation_queue`(aborted+watchdog/restart/idle_timeout+confirm_status NULL)时。kind=`confirm`。

> 触发点 1 vs 2 的边界:交互 turn 完成(run_id None)用 turn_done;后台/调度 run 用 run_failed(仅失败/超时,**不推成功的后台 run**——避免噪音,成功的后台 run 走确认队列或无声)。实现时以 run 的 `run_id.is_some()` + outcome 区分。

## 5. 前端设计

### 5.1 `frontend/public/sw.js`(service worker,原生无 workbox)

- **`push` 事件**:解析 payload JSON → 前台抑制判断 → 弹通知。
  - 抑制判断抽为纯函数语义 `shouldSuppress(activeSessionId, payloadSessionId, anyVisibleFocused)`:存在可见且聚焦、且其 active session == payload.session_id 的窗口 → 抑制(用户正看着该会话)。
  - 否则 `self.registration.showNotification(title, { body, data:{session_id}, tag: session_id })`。`tag=session_id` → 同会话多通知折叠。
  - active session 来源:页面经 `postMessage({type:'active_session', id})` 告知,SW 存内存;**SW 被休眠重启致变量丢失时,默认不抑制(照常弹)**——安全侧(宁可多弹不可漏)。
- **`notificationclick` 事件**:`clients.matchAll({type:'window'})` → 有 zeromux 窗口则 `focus()` + `postMessage({type:'open_session', id})`;无则 `clients.openWindow('/?session=<id>')`。

### 5.2 `frontend/src/lib/push.ts`

- `registerServiceWorker()`:`main.tsx` 启动时注册 `/sw.js`(`navigator.serviceWorker.register`)。
- `vapidKeyToUint8Array(base64url)`:公钥转 `applicationServerKey` 所需的 Uint8Array(纯函数,可单测)。
- `enablePush()`:`Notification.requestPermission()` → granted 时 `reg.pushManager.subscribe({userVisibleOnly:true, applicationServerKey})`(key 取自 `GET /api/push/vapid-key`)→ POST `/api/push/subscribe`。
- `disablePush()`:`subscription.unsubscribe()` + POST `/api/push/unsubscribe`。
- `getPushState() -> 'unsupported'|'denied'|'enabled'|'disabled'`:供开关渲染。

### 5.3 active session → SW 同步

前端 active session 变化时 `navigator.serviceWorker.controller?.postMessage({type:'active_session', id})`。SW 收 message 存内存变量。页面 `visibilitychange` 也同步(隐藏时告知 SW "无可见会话")。

### 5.4 设置区"启用推送通知"开关

- 三态显示:未授权(可点开启)/ 已开(可点关闭)/ 被拒(提示去浏览器设置)。
- 不支持(`!('PushManager' in window)`)→ 开关禁用 + "当前浏览器不支持推送"。
- **iOS 旁注**:"iOS 需先将本站『添加到主屏幕』后才能启用推送"(平台限制)。
- 放置:zeromux 现有设置/账户区域(实现时定位;若无独立设置面板,放顶部菜单或会话列表头部)。

### 5.5 `notificationclick` 深链落地

`main.tsx` / `App.tsx` 监听 `navigator.serviceWorker` 的 message(`open_session`/`active_session` 回流)→ 切到对应 session(复用 App 的 `setActiveId`)。`openWindow('/?session=<id>')` 的 query 在启动时解析切到该 session。

## 6. 错误处理(全局:推送是增强,绝不影响核心会话)

- `send_push` fire-and-forget(spawn),失败只 `tracing::warn`,绝不阻塞 fan-out/turn。
- VAPID 失败 → 推送子系统禁用,其余照常。
- 失效订阅 404/410 自动删,不堆积。
- 前端不支持/被拒优雅降级,无报错弹窗。
- SW 休眠致 active session 丢失 → 默认不抑制(宁多勿漏)。

## 7. 测试策略(TDD)

### Rust 单元
1. `vapid_load_or_generate_idempotent`:生成→落盘→重载得同一密钥对;公钥 base64url 格式校验。
2. `push_store_upsert_and_list`:upsert 同 endpoint 不重复;按 user_id 查多设备;delete 生效。
3. `push_payload_text_by_kind`:turn_done/run_failed/confirm 的 title/body 文案正确(含 failure_kind 中文映射)。
4. `send_push_empty_subscriptions_noop`:无订阅时 no-op,不报错。
5. `send_push_removes_subscription_on_410`:发送结果可注入(trait/mock),404/410 触发 delete,其它错误不删。

### 前端(vitest)
6. `vapidKeyToUint8Array`:base64url→Uint8Array 转换正确(已知向量)。
7. `getPushState` 状态机:unsupported/denied/enabled/disabled 各分支。
8. `shouldSuppress(activeId, payloadSessionId, visible)` 纯函数:前台聚焦同会话→true,其余→false,SW 无 active 信息→false。

### 手动(部署后真机,Web Push 唯一端到端验证方式)
- iOS Safari "加到主屏幕" → 设置里开启推送 → 授权 → 锁屏。
- 触发:交互 turn 完成(切走后)/ 后台 run 失败 / 确认队列新增 → 收到推送。
- 点击推送 → 聚焦/打开并深链到对应 session。
- Android Chrome / 桌面 Chrome 同样验一遍。

## 8. 非目标(明确划出)

- ❌ 成本超阈值推送 / `max_cost_usd` 护栏(后续 feature)。
- ❌ 每类事件独立开关(本期单一总开关)。
- ❌ 通知含对话正文(只发 session 名 + 事件类型 + failure_kind)。
- ❌ 软提示 / PWA 安装引导(本期只显式设置开关)。
- ❌ 推送重试队列 / 离线暂存(fire-and-forget,失败即丢)。
- ❌ Elicit / 需输入推送(Codex elicitation 当前自动接受,无真实事件源)。
- ❌ 成功的后台 run 推送(仅失败/超时;避免噪音)。

## 9. 验证标准(goal-driven)

- 实证门已过(§2:WebPushMessage 暴露 content+headers)。
- §7 的 8 个单元测试全绿。
- `cargo test` + 前端 `npm test` 全过。
- 真机:iOS 加主屏 + Android + 桌面各至少一次端到端(授权→锁屏/切走→触发→收到→点击深链)。
- 不破坏现有:语音/会话/文件浏览器等回归测试通过;推送禁用时(无 VAPID)全功能正常。
