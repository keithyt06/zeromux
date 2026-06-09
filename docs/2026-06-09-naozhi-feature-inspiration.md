# naozhi 功能借鉴调研 — zeromux 未来改进参考

> **类型**:竞品调研 / 功能灵感(非 spec)
> **日期**:2026-06-09
> **来源**:[github.com/KevinZhao/naozhi](https://github.com/KevinZhao/naozhi)(调研时十几天 360 commit,极活跃)
> **用途**:写未来 spec 时的参考清单。每条已对照 zeromux 真实代码确认接入点。

---

## 1. naozhi 是什么 —— zeromux 的"镜像孪生"

两个项目**底层抽象几乎一致**:

| 维度 | naozhi | zeromux |
|---|---|---|
| 进程模型 | spawn AI CLI 长生命周期子进程 | 同 |
| Agent 后端 | Claude stream-json + Kiro ACP + Codex | 同 |
| 语音 | AWS Transcribe 中文转写 | 同 |
| 分发 | 单二进制 | 同 |
| 监控 | Dashboard | 同 |
| **载体** | **IM 机器人(飞书/Slack/Discord/微信)** | **Web 终端 + Agent 聊天** |

**唯一根本差异是载体。** 正因为 naozhi 长在 IM 上,被"IM 的天然交互模式"逼出了一批 zeromux 还没有的能力——这些是值得借鉴的核心。

> 附注:naozhi 有一条 **cron 每小时自动 review + 批量修 issue** 的研发流水线(commit 里大量 `fix(issues): batch N from cron hourly v9`),让项目"自己维护自己"。这本身是 zeromux 定时任务功能的一个演进方向。

naozhi 的 `docs/rfc/` 下有 50+ 篇设计文档,是现成的设计参考库。

---

## 2. 借鉴优先级榜(已对照 zeromux 代码确认接入点)

### 🔥 #1 消息队列 `collect` 合并模式 —— 最高 ROI,接口几乎现成

**naozhi 做法**:session 忙时新消息不丢弃,三种可配策略:
- `collect`(默认):排队 → 当前 turn 结束 + 500ms 收集窗口 → 合并为一个 prompt 发送
- `interrupt`:每条新消息打断当前 turn(更费 token)
- `passthrough`:每条直接转发(需 stream-json 后端,ACP 回退 collect)
- 配 `/stop`(软中断保留队列)+ `/urgent`(紧急抢占)

合并格式带系统提示头 `[以下是用户在你处理上一条消息期间追加发送的内容]` + 每条 `[HH:MM]` 时间戳,让 Claude 明确这是追加而非独立请求。

**zeromux 接入点(关键:地基已就位)**:B-2 已经做完了 naozhi 要从零造的部分——
- `SessionInput::{Prompt, Cancel, Interrupt}` 枚举(`src/session_manager.rs:110`)
- `TurnState { Idle, Running }` + `mark_turn` + `turn_seq` + `boundary_count`(:125, :1287, :1603)

当前 fanout loop 在 `Running` 时新 `Prompt` 直接透传(强打断)。改造点:fanout loop 内部加 `VecDeque<Prompt>` + 500ms collect 窗口,在 `mark_turn(Idle)` 那一刻合并发送。**改动只在 fanout loop 内,不破坏广播扇出不变量。**

**为什么值得做**:刚做完移动端 composer,手机用户天然连发"review 这个"→"重点看安全"→"特别是 SQL 注入"。现在这些要么乱序要么强打断。collect 是体验质变。

**参考**:naozhi `docs/rfc/message-queue.md`(含合并格式、收集窗口论证、时序图)。

---

### 🔥 #2 auto-titler 自动起名 —— 低成本高感知

**naozhi 做法**:派生短命 system session,读对话内容让 LLM 提炼 ≤16 字中文标题写回侧边栏。踩过的坑(直接抄):
- **英文 system 指令锁语义层**(LLM 对英文 system 指令服从更稳,抗 prompt injection),输出硬约束中文 ≤16 字
- rename 节流(默认 5 min 内不重复命名同一会话)
- `LabelOrigin` 标记:用户手动改过的名字**不被自动命名覆盖**
- 默认跳过群聊;为此造了 `internal/sysession/` 包(~700 LOC,Daemon+Manager+Runner)

**zeromux 接入点**:已有 `session.name` + `apply_meta` rename(`session_manager.rs:2151`)+ `/api/sessions/{id}` rename 端点 + **`src/scheduled_tasks.rs` 调度框架**。naozhi 为此造了整个包,而 zeromux 已有调度器——只差一个派生短命会话 + prompt。

**为什么值得做**:多会话列表一堆 `claude-1`/`codex-2` 是真痛点,自动起名感知强、成本低。

**参考**:naozhi `docs/rfc/system-session.md`(§6.6 prompt 设计、§7 AutoTitler MVP)。

---

### 👌 #3 事件持久化第二层 —— B-1 的自然续作(只抄 MVP)

**naozhi 做法**:除 CLI 自带 JSONL 外,另存 `~/.naozhi/events/<keyhash>.log`/`.idx`,记录 **JSONL 恢复不了的字段**:图片缩略图、附件路径、AskQuestion 卡片、agent-team 关联 ID。配附件引用计数 + 双 TTL 精确回收。

**zeromux 现状**:scrollback 是 2MB 内存 buffer,重启即丢。已做 B-1 持久化会话。

**接入判断**:这是把"富内容跨重启完整回放"补齐。**但**:naozhi 这套 RFC 极重(attachment-refcount 双 TTL + GC)。建议只抄 MVP——落盘 + 重连合并回放,**不抄**附件引用计数/GC 全套。

**参考**:naozhi `docs/rfc/event-log-persistence.md`、`attachment-refcount.md`。

---

### 👌 #4 后台自动更新 —— 直击部署 502 痛点

**naozhi 做法**:后台 goroutine 轮询 GitHub Releases,`download → SHA-256 → 原子替换`,三档:
- `notify`(仅通知)/ `download`(替换,下次重启生效,默认)/ `auto`(替换并立即重启)

**zeromux 现状**:手动 `deploy.sh`;部署记忆里多次因手动 stop→cp→start 之间窗口出现 502。

**接入判断**:这正是 `deploy.sh` 自愈逻辑(smoke→backup→stop→cp→start→health-check→auto-rollback)的产品化。先做原子替换 + 健康检查回滚,**签名验证可缓**——naozhi 自己在 `selfupdate-signing.md` 里承认了供应链缺口(泄露 GitHub token 能同时换二进制和 checksums.txt,SHA-256 同源校验防不住)。

**参考**:naozhi `docs/rfc/selfupdate-signing.md`。

---

## 3. 远期愿景区(写进路线图,先别动)

| 功能 | naozhi 做法 | 为什么先别做 |
|---|---|---|
| **自学习系统** | 会话结束触发后台 review agent → 沉淀 `SKILL.md`/`MEMORY.md`/`USER.md`,"用得越久越聪明"(灵感来自 Hermes Agent, 52K stars) | 差异化护城河,zeromux 多端数据比 IM 更适合做。但 naozhi 自己都标"设计提案,未实现",是大工程。 |
| **外部进程发现 + 接管** | 扫 `~/.claude/sessions/` 识别外部 Claude 进程,SIGTERM→`--resume` 一键接管 | 要先想清楚和 zeromux **worktree 隔离模型**怎么共存——naozhi 没有 worktree 直接接管,zeromux 接管外部 claude 会和 `.zeromux-worktrees/` 冲突。 |
| **多节点 NAT 穿越** | NAT 内工作站反向拨入公网 Primary,Dashboard 统一管理多机 | 单服务器场景用不上,等有多机需求再说。 |

---

## 4. 一句话路线图建议

> **近期**:#1 消息队列 collect(接口现成,衔接移动端 composer + B-2 打断)→ #2 auto-titler(复用 scheduled_tasks)。两者见效快、不碰广播扇出核心。
> **中期**:#3 事件持久化 MVP + #4 后台自动更新。
> **愿景**:自学习系统 / 多节点。
