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

## 3. 依赖变更(诚实记账 — 评审 P1-3)

`Cargo.toml` 新增:
- `web-push = "0.11"`,`default-features = false`(**仅用其 builder/RFC8188 加密/VapidSignatureBuilder,不用其 isahc/hyper client**)。
- `p256 = { version = "0.13", features = ["pem", "ecdsa"] }`(VAPID 密钥对生成 + PKCS8 PEM 导出 + uncompressed 公钥)。

**web-push 0.11 引入的传递依赖(实测记账,非"只是没引入 isahc")**:
- `http = "0.2"` —— 与全栈现用 `http 1`(axum 0.8 / reqwest 0.12 / tokio-tungstenite 0.29)**重复一份**(major 共存不报错,纯增体积)。
- `jwt-simple`(web-push 的 VapidSignatureBuilder 内部签名栈)—— 与现有 `jsonwebtoken 9`(OAuth 用)**两套 JWT 实现并存**。
- `ece`(RFC8188 AES128GCM 加密)、`pem`、`sec1_decode`、`ct-codecs`。

**对体积优化单二进制(opt-level=z + lto + strip)的代价决策**:
- 接受 `ece`(加密是难且易错的密码学,自写承担正确性风险——实证门已定用 web-push 做加密)。
- **接受 jwt-simple 进树**(本期不为砍它而自拼 VAPID `Authorization: vapid t=,k=` 头——那增加手写面,收益仅省一个 crate)。记为已知体积代价。
- **实现期硬性验证**:`cargo build --release` 后对比 strip 后 binary size diff,记录到实现报告;若增量 > 1.5MB,回头评估"只用 ece 加密 + jsonwebtoken+p256 自拼 VAPID 头"的瘦身路径。

p256 `to_pkcs8_pem()` 出 PKCS8(`BEGIN PRIVATE KEY`),`VapidSignatureBuilder::from_pem` 接受 PKCS8 与 SEC1 两种 —— 经核实兼容,这条链无坑。

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
- confirm:title `❓ {task_name} 需确认`,body **带中断原因**(评审 B2:文案太弱无法判断紧急度)——按 failure_kind 区分:`因空闲超时中断,等待确认` / `因运行超时中断,等待确认` / `因重启中断,等待确认`。
- 重启批量合并(§4.3 触发点 3):title `❓ {N} 个任务待确认`,body `重启后需逐一确认`。

> **通知内容原则(评审 B2)**:只发 session/任务名 + 事件类型 + **一个让用户做"现在 or 待会"决策的判别维度**(run_failed 的 failure_kind、confirm 的中断原因)。不含对话正文。

**`send_push(user_id, payload)`**(async;**调用方 `tokio::spawn`,绝不在热路径 await**):
1. `list_for_user(user_id)`;空 → 返回。
2. 每订阅:`SubscriptionInfo::new(endpoint,p256dh,auth)` → `WebPushMessageBuilder` set payload(`ContentEncoding::Aes128Gcm`,JSON bytes)+ VAPID 签名(from PEM)→ `.build()` → 取 `payload.content`+`crypto_headers` → reqwest POST 到 endpoint(附 `TTL`、`Urgency` 头)。
3. 响应 **404/410 → `delete(endpoint)`**(端点失效);其它错误 `tracing::warn`,继续下一个。
4. 错误隔离:任一订阅失败不影响其它、不向上传播。

### 4.2 `src/web.rs` 端点(authed `/api/*` 组,需 `CurrentUser`)

- `GET /api/push/vapid-key` → `{ "key": "<base64url 公钥>" }`。
- `POST /api/push/subscribe` body `{endpoint, keys:{p256dh, auth}}` → `PushStore.upsert(user.id, ...)` → `{ok:true}`。
  - **SSRF 防护(评审遗漏)**:`endpoint` 来自浏览器、send_push 会 reqwest POST 它 → 是 SSRF 面。subscribe 时校验 endpoint 必须 `https://` 且 host 非私网/环回(拒 `localhost`/`127.*`/`10.*`/`192.168.*`/`172.16-31.*`/`::1`/`169.254.*`)。不合规 400。单用户低危但零成本可堵。
- `POST /api/push/unsubscribe` body `{endpoint}` → `PushStore.delete(endpoint)` → `{ok:true}`。

### 4.3 触发点接线

`SessionManager` 持 `Option<Arc<PushService>>`(仿现有 `scheduled` handle:`Mutex<Option<Arc<...>>>`,`:267`)。**锁内只 `clone()` 出 Arc、锁外用**(照抄 `scheduled` 取用模式 `:577`,绝不持锁 await send_push)。spawn 出去 fire-and-forget。

三个触发点:

1. **交互 turn 完成**(kind=`turn_done`)。
   - **触发条件(评审 P1-1,关键):不是"任一 `mark_turn(Idle)`"**。`mark_turn(Idle)` 对每个 boundary 都调(含 interrupt-resend 被取代的旧 turn),在那里推会狂推/会话还在跑也推。**正确落点**:fan-out boundary 块内 `if boundary_count >= turn_seq`(即 `local_running` 即将翻 false、会话真正 settle)的分支,且 `active_run_id` 为 None(普通交互 turn)。每轮真实交互最多一条。
   - **久候门槛(评审 B1)**:仅当本 turn 运行时长 > 60s 才推(复用 boundary 块已有的 turn 计时 / run_started_ms)。"小问题秒回"不推,"跑了几分钟的活完成了"才推。
   - **per-session 去抖(评审 P2-1)**:PushService 记 `last_turn_push_ms` per (user, session),同会话 turn_done 在 30s 内只推最后一条。
   - **默认关**(见 §5.4 分级)。前台抑制由 SW 端做(§5)。
   - **session name 获取(评审 P2-5)**:fan-out 闭包不持有 session name(只 sid/owner_id)。spawn push 前一次 `sessions.lock()` 读 name(短临界区)或 boundary 块 spawn 前 clone 出。

2. **无人值守 run 失败/超时**(kind=`run_failed`)。run finalize 为 `Errored`/`Timeout` 且 `active_run_id.is_some()`(后台/调度 run)。**先判 `active_run_id` 再 `.take()`**,两路 push 在对应 finalize 分支(评审 P2-4)。body=failure_kind 中文。**不推成功的后台 run**。

3. **确认队列新增**(kind=`confirm`)。
   - **评审 P1-2:`confirmation_queue` 是 SELECT 不是事件,现无干净入队单点**。新增 `ScheduledStore` 方法:在 reconcile(`reconcile_orphans` set-based UPDATE `:536/539`、`reconcile_timeouts_per_task` 逐行 `:575`)把行翻成 `aborted`+触发性 failure_kind **之后**,重跑完整队列谓词(JOIN config 拿 `side_effects=1`+`owner_id`)查出**本次新增**的 `(run_id, owner_id, task_name, failure_kind)`,逐个推。
   - **重启批量节流(评审 P2-1)**:`reconcile_orphans` 在进程重启时可能一次让 N 行入队 → 合并成一条"N 个任务待确认",而非 N 条(此刻前端 SW 可能还没注册)。

> 触发点 1 vs 2 用 `active_run_id.is_some()` 区分:交互 turn(None)→ turn_done;后台/调度(Some)→ run_failed(仅失败/超时,**不推成功的后台 run**)。`active_run_id` 在 boundary 块 `.take()` **之前**判断可靠(collect 合并 turn 显式 active_run_id=None)。

## 5. 前端设计

### 5.1 `frontend/public/sw.js`(service worker,原生无 workbox)

- **`push` 事件**:解析 payload JSON → 分级过滤(§5.4)→ 前台抑制 → 弹通知。
  - **分级过滤(评审 A1)**:turn_done 属"日常",仅当用户开启了日常推送才弹(偏好见 §5.4);run_failed/confirm 属"重要",总弹。偏好读取:SW 从 IndexedDB/Cache 读前端写入的 `push_levels`(纯前端存储,后端无需建表)。
  - **前台抑制改实时查询(评审 P2-2,不存陈旧单变量)**:在 push 事件内 `clients.matchAll({type:'window'})`,对每个 client 看 `client.focused && client.visibilityState==='visible'`,并经一次 postMessage 往返(或 client 在注册时上报)拿其当前 active session;**任一可见聚焦 client 的 active == payload.session_id → 抑制**。这天然处理多标签页(并集语义)+ 多设备(每设备各自 SW 判断)+ 消除"active 信息后到"的 race。查不到任何可见 client → 不抑制(照常弹,宁多勿漏)。
  - **`userVisibleOnly:true` 张力(评审遗漏)**:Chrome 对"收到 push 却连续不弹可见通知"会判定滥用静默推送并**吊销推送权限**。故抑制**只对 turn_done**(本就低频+默认关);run_failed/confirm 永远弹。不对重要类做静默抑制,规避掉权限。
  - 弹通知:`showNotification(title, { body, data:{session_id}, tag })`。**tag 分级(评审 B4)**:turn_done 用 `tag=session_id`(同会话折叠);run_failed/confirm 用 `tag=${session_id}:${kind}`(**不被后续 turn_done 覆盖**,重要通知不丢)。
- **`notificationclick` 事件**:`clients.matchAll({type:'window'})` → 有 zeromux 窗口则 `focus()` + `postMessage({type:'open_session', id})`;无则 `clients.openWindow('/?session=<id>')`。

### 5.2 `frontend/src/lib/push.ts`

- `registerServiceWorker()`:`main.tsx` 启动时注册 `/sw.js`(`navigator.serviceWorker.register`)。
- `vapidKeyToUint8Array(base64url)`:公钥转 `applicationServerKey` 所需的 Uint8Array(纯函数,可单测)。
- `enablePush()`:`Notification.requestPermission()` → granted 时 `reg.pushManager.subscribe({userVisibleOnly:true, applicationServerKey})`(key 取自 `GET /api/push/vapid-key`)→ POST `/api/push/subscribe`。
- `disablePush()`:`subscription.unsubscribe()` + POST `/api/push/unsubscribe`。
- `getPushState() -> 'unsupported'|'denied'|'enabled'|'disabled'`:供开关渲染。

### 5.3 active session 上报(配合 §5.1 实时查询)

每个页面 client 维护自己的"当前 active session + 是否可见"。SW 在 push 事件内 `clients.matchAll` 后,向各 client postMessage 询问(或 client 在 active/visibility 变化时主动 postMessage 上报,SW 按 clientId 暂存最近值)。**SW 不存全局单变量**(那会被多标签页互相覆盖、且 SW 休眠丢失)——抑制判断基于"当前所有可见 client 的 active 并集"。无可见 client → 不抑制。

### 5.4 设置区推送开关 — 两档分级(评审 A1,本 spec 最关键的产品修正)

**不用单一总开关**(评审一致判定:turn_done 最高频却价值最低,与失败/确认共用一个开关 → 用户嫌吵全关 → 连重要通知也漏,留存头号杀手)。

- **主开关「启用推送」**:授权 + 订阅(`pushManager.subscribe`)。三态:未授权(可点开启)/ 已开 / 被拒(提示去浏览器设置)。
- 主开关开启后,**两档子偏好**(存前端 IndexedDB/Cache 的 `push_levels`,SW 读取;后端不建表):
  - **「重要」(失败 + 确认)** — **默认开**。产品真正卖点(无人值守 run 挂了/卡住等确认)。
  - **「日常」(turn 完成)** — **默认关**。用户主动开;且即便开,也只在 turn > 60s 久候 + 不在前台时弹(§4.3/§5.1)。
- 实现成本:payload 已带 `kind`,SW 按 kind + push_levels 过滤即可。比"每类一个开关"简单,比"单一总开关"安全。
- 不支持(`!('PushManager' in window)`)→ 主开关禁用 + "当前浏览器不支持推送"。
- **iOS 门槛(评审 B3,真实劝退点,非一行旁注能解决)**:检测 iOS Safari 且 `!navigator.standalone`(未加主屏)时,把旁注升级为**带两步图示的静态说明**("① 点分享 → ② 添加到主屏幕")+「如何添加」可展开。纯静态文案 + UA/standalone 嗅探,零逻辑成本。**不做**浮层引导(那是非目标)。
- 放置:zeromux 现有设置/账户区域(实现时定位;无独立设置面板则放顶部菜单或会话列表头部)。

### 5.5 `notificationclick` 深链落地

`main.tsx` / `App.tsx` 监听 `navigator.serviceWorker` 的 message(`open_session`/`active_session` 回流)→ 切到对应 session(复用 App 的 `setActiveId`)。`openWindow('/?session=<id>')` 的 query 在启动时解析切到该 session。

## 6. 错误处理(全局:推送是增强,绝不影响核心会话)

- `send_push` fire-and-forget(spawn),失败只 `tracing::warn`,绝不阻塞 fan-out/turn。
- VAPID 失败 → 推送子系统禁用,其余照常。
- 失效订阅 404/410 自动删,不堆积。
- 前端不支持/被拒优雅降级,无报错弹窗。
- 前台抑制只作用于 turn_done(日常类);run_failed/confirm 永远弹 → 规避 Chrome"静默推送滥用→吊销权限"(评审遗漏)。查不到可见 client → 不抑制(宁多勿漏)。
- VAPID 私钥泄漏边界(评审 P2-6):VAPID 私钥是应用服务器身份(RFC8292,全用户共享一对,正确);泄漏只能向已知端点发骚扰推送,**不能解密**任何内容(载荷加密用每订阅的 p256dh/auth)。0600 落盘对自托管够,不上 KMS(over-build)。

## 7. 测试策略(TDD)

### Rust 单元
1. `vapid_load_or_generate_idempotent`:生成→落盘→重载得同一密钥对;公钥 base64url 格式校验。
2. `push_store_upsert_and_list`:upsert 同 endpoint 不重复;按 user_id 查多设备;delete 生效。
3. `push_payload_text_by_kind`:turn_done/run_failed/confirm 文案正确;confirm 按 failure_kind 给中断原因(评审 B2);重启批量给"N 个任务待确认"。
4. `send_push_empty_subscriptions_noop`:无订阅时 no-op,不报错。
5. `send_push_removes_subscription_on_410`:发送结果可注入(trait/mock),404/410 触发 delete,其它错误不删。
6. `endpoint_ssrf_validation`:`https://` 非私网通过;`http://`、`localhost`、`127.*`、`10.*`、`192.168.*`、`::1` 等拒绝(评审 SSRF)。
7. `confirm_queue_newly_entered_after_reconcile`:reconcile 把行翻 aborted+failure_kind 后,新增方法查出本次新入队且满足完整队列谓词(side_effects=1)的 (run_id, owner_id, task_name);非 side_effects 的不入队不查出(评审 P1-2)。
8. `turn_done_debounce_and_long_threshold`:同会话 30s 内只推一次;turn < 60s 不推(评审 B1/P2-1)。

### 前端(vitest)
9. `vapidKeyToUint8Array`:base64url→Uint8Array 转换正确(已知向量)。
10. `getPushState` 状态机:unsupported/denied/enabled/disabled 各分支。
11. `shouldSuppress(visibleClients, payloadSessionId)` 纯函数:存在可见 client 其 active==payload→true(抑制);无可见 client→false;可见但 active 不同会话→false(评审 P2-2 实时查询语义)。
12. `levelAllows(kind, push_levels)` 纯函数:turn_done 在日常关时→false,开时→true;run_failed/confirm 恒 true(评审 A1 分级)。

### 手动(部署后真机,Web Push 唯一端到端验证方式)
- iOS Safari "加到主屏幕" → 设置里开启推送 → 授权 → 锁屏。
- 触发:交互 turn 完成(切走后)/ 后台 run 失败 / 确认队列新增 → 收到推送。
- 点击推送 → 聚焦/打开并深链到对应 session。
- Android Chrome / 桌面 Chrome 同样验一遍。

## 8. 非目标(明确划出)

- ❌ 成本超阈值推送 / `max_cost_usd` 护栏(后续 feature)。
- ❌ 每类事件独立细分开关(本期只两档:重要 / 日常)。
- ❌ 通知含对话正文(只发 session 名 + 事件类型 + 一个判别维度)。
- ❌ PWA 安装浮层引导(本期只在 iOS 未安装时显静态两步图示说明)。
- ❌ 推送重试队列 / 离线暂存(fire-and-forget,失败即丢)。
- ❌ 成功的后台 run 推送(仅失败/超时;避免噪音)。

### 🔺 已知最高价值缺口 → Feature 3:危险操作手机审批(评审 A2,必须正名,勿埋)

PM 评审指出:多 agent 操作者的真正刚需是"哪个 agent **需要我决策/批准**"(Boris Cherny)。但 zeromux 三个 backend **当前主动自动批准了所有决策点**:Claude `--dangerously-skip-permissions`(`process.rs:120`)、Kiro 自动 `allow-once`(`kiro_process.rs:362-368`)、Codex 自动 `Accept`(`codex_process.rs:141-156`)。

**所以"Elicit/需输入推送"不是"没需求",而是"我们的架构主动消灭了这个信号"** —— 这是一个安全姿态缺口(离开桌面期间 agent 可 `rm -rf`/push/改 prod 无人能拦),也是相对裸 CLENT 的真正护城河。本期**不做**(涉及改三 backend 的批准逻辑 + 手机审批 UI,工作量大),但在此**正名为 Feature 3 / 已知最高价值下一步**,防止以"非目标"姿态被永久搁置。本 Web Push 子系统正是它将来复用的推送通道。

## 8.1 评审记录(CTO + PM 双重对抗性评审,2026-06-26)

本 spec 是评审后的修订版。两份独立评审都判"调整后可进实现",根本方案(真 Web Push + 方案 C)无需重想。关键修订:

- **P1-1(CTO)**:turn_done 触发点从"任一 mark_turn(Idle)"改为"`boundary_count >= turn_seq` settle 分支 + active_run_id None"——否则 interrupt-resend 狂推/会话还在跑也推(§4.3)。**已采纳。**
- **P1-2(CTO)**:`confirmation_queue` 是 SELECT 非事件,无干净入队单点 → 新增"reconcile 后查本次新入队行(含 owner/task_name)"方法;reconcile_orphans 重启批量合并一条(§4.3)。**已采纳。**
- **P1-3(CTO)**:依赖体积诚实记账(http 0.2 重复 + jwt-simple + ece),接受 jwt-simple、实现期测 size diff(§3)。**已采纳。**
- **A1(PM,最关键产品修正)**:单一总开关 → 两档(重要默认开 / 日常默认关),避免"一类太吵→全关→漏重要的"(§5.4)。**已采纳。**
- **A2(PM)**:"等用户决策/审批"才是最高价值缺口(被三 backend 自动批准消灭),正名为 Feature 3,勿以"非目标"埋掉(§8)。**已采纳。**
- **P2/B 类**:per-session 去抖 + 久候门槛(B1)、前台抑制改实时 clients.matchAll 消除 race/多标签(P2-2)、tag 分级防重要通知被覆盖(B4)、confirm 文案补中断原因(B2)、iOS 未安装显两步图示(B3)、SSRF endpoint 校验、userVisibleOnly 静默抑制只对 turn_done(防吊销权限)、session name spawn 前 clone(P2-5)。**已采纳进相应章节。**
- VAPID 私钥威胁模型(P2-6:全用户共享一对是 RFC8292 正确设计,泄漏只能骚扰不能解密)→ 记入 §6,不上 KMS。

## 9. 验证标准(goal-driven)

- 实证门已过(§2:WebPushMessage 暴露 content+headers)。
- §7 的 12 个单元测试全绿(后端 8 + 前端 4)。
- `cargo test` + 前端 `npm test` 全过;`cargo build --release` 后记录 binary size 增量(评审 P1-3,> 1.5MB 则评估瘦身)。
- 真机:iOS 加主屏 + Android + 桌面各至少一次端到端(授权→锁屏/切走→触发→收到→点击深链);验「重要」默认开、「日常」默认关。
- 不破坏现有:语音/会话/文件浏览器等回归测试通过;推送禁用时(无 VAPID)全功能正常。
