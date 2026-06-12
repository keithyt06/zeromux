# naozhi 功能借鉴调研 — zeromux 未来改进参考

> **类型**:竞品调研 / 功能灵感(非 spec)
> **日期**:2026-06-09;**2026-06-12 修订**(旧 4 条已消化 3 条,新增 AgentCore 派生的两条)
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

> **✅ 已消化(2026-06-12 移出本榜)**:原 #1 消息队列 `collect` 合并模式、原 #2 auto-titler 自动起名(均见 [[zeromux-collect-titler-shipped]] / commit 6c3aaeb),原 #4 后台自动更新(见 [[zeromux-auto-update-shipped]] / 已部署 live)三条已落地上线。本榜现保留 #3 事件持久化(B-1 续作),并新增 2026-06-12 从 naozhi **AgentCore RFC** 派生出的两条(本体缓议,寄生模式直接接 `scheduled_tasks.rs`,见 §5)。

### 👌 #3 事件持久化第二层 —— B-1 的自然续作(只抄 MVP)

**naozhi 做法**:除 CLI 自带 JSONL 外,另存 `~/.naozhi/events/<keyhash>.log`/`.idx`,记录 **JSONL 恢复不了的字段**:图片缩略图、附件路径、AskQuestion 卡片、agent-team 关联 ID。配附件引用计数 + 双 TTL 精确回收。

**zeromux 现状**:scrollback 是 2MB 内存 buffer,重启即丢。已做 B-1 持久化会话。

**接入判断**:这是把"富内容跨重启完整回放"补齐。**但**:naozhi 这套 RFC 极重(attachment-refcount 双 TTL + GC)。建议只抄 MVP——落盘 + 重连合并回放,**不抄**附件引用计数/GC 全套。

**参考**:naozhi `docs/rfc/event-log-persistence.md`、`attachment-refcount.md`。

---

## 3. 远期愿景区(写进路线图,先别动)

| 功能 | naozhi 做法 | 为什么先别做 |
|---|---|---|
| **自学习系统** | 会话结束触发后台 review agent → 沉淀 `SKILL.md`/`MEMORY.md`/`USER.md`,"用得越久越聪明"(灵感来自 Hermes Agent, 52K stars) | 差异化护城河,zeromux 多端数据比 IM 更适合做。但 naozhi 自己都标"设计提案,未实现",是大工程。 |
| **外部进程发现 + 接管** | 扫 `~/.claude/sessions/` 识别外部 Claude 进程,SIGTERM→`--resume` 一键接管 | 要先想清楚和 zeromux **worktree 隔离模型**怎么共存——naozhi 没有 worktree 直接接管,zeromux 接管外部 claude 会和 `.zeromux-worktrees/` 冲突。 |
| **多节点 NAT 穿越** | NAT 内工作站反向拨入公网 Primary,Dashboard 统一管理多机 | 单服务器场景用不上,等有多机需求再说。 |

---

## 4. 一句话路线图建议

> **已上线**:消息队列 collect + auto-titler([[zeromux-collect-titler-shipped]])、后台自动更新([[zeromux-auto-update-shipped]])。
> **近期**:§5 的 **#5 三态判定 + 副作用确认队列**(直击无人值守软肋,接 `scheduled_tasks.rs`,不碰广播扇出核心)。
> **中期**:§5 的 **#6 replay-not-resume + run record**(配 #5 一起做最顺)、#3 事件持久化 MVP。
> **愿景**:自学习系统 / 多节点 / AgentCore placement 轴(走多租户 SaaS 那天)。

---

## 5. AgentCore RFC 派生的两个寄生模式(2026-06-12 新增)

**背景**:naozhi 6/10–6/12 主线是 [`docs/rfc/agentcore-cloud-sandbox.md`](https://github.com/KevinZhao/naozhi/blob/master/docs/rfc/agentcore-cloud-sandbox.md)(AWS Bedrock AgentCore Runtime 接成"执行基底",最新 PR #2047 = §7.4 确认队列 + §7.3 replay)。

**PM 判断:AgentCore 本体 zeromux 缓议。** 它解决的是 naozhi 的痛(cron 会话泄漏 6 个占 9.68GB / 无多租户隔离 / 无弹性并发),绑死一个 2026-06 才 GA 的 AWS 产品。zeromux 是单二进制单服务器,**worktree 隔离 + Drop-based 清理就是这个量级的等价物**;"flavor × placement 正交"的心智模型很干净,但真要做也是走多租户 SaaS 那天的事,先归档进 §3 愿景区。

**但** naozhi 在云沙箱之上叠的两个**概念模式与"云"解耦**,直接能用在 zeromux **已有的 `scheduled_tasks.rs` 无人值守功能**上——这才是真借鉴。

---

### 🔥 #5 三态终态判定 + 副作用确认队列 —— 最高 ROI,直击无人值守软肋

**naozhi 最硬的洞见**(§6.1 / §6.2 / §7.4):
- **干净 EOF ≠ 任务完成"有见证"**。他们 V8 实测:AgentCore 平台把 SSE 流静默也判 idle 并焚毁 microVM,**产生一个干净的 FIN——和正常跑完的干净 EOF 不可区分**。结论:只能靠 bootstrap `exit` 帧这种"handler 见证的死亡"才敢判 `failed-clean`,否则一律保守判 `failed-transport`。
- 三态对"是否产生副作用、能否安全重放"语义不同:`success`(收到 `result` 且非 error,流干净到尾)/ `failed-clean`(`result` 报错 或 有 `exit` 帧见证早退,副作用大概率没发生)/ `failed-transport`(断流,**或干净 EOF 但既无 `result` 也无 `exit`**——云端状态未知)。
- **有副作用任务(提 PR / 改文件)断流后不自动重放**,进 dashboard 人工确认队列:先查 PR 是否已提,再决定 `确认已完成` / `确认未完成→重放`。防 `run_id` 去重防不住的"云端实际跑完了但 naozhi 没见证"双跑。

**zeromux 接入点(已对照真实代码,2026-06-12 核实)**——地基已就位,但判定恰好是二元糊判,**正是这个洞见要补的盲区**:
- run 状态机 `claimed|running|succeeded|failed|skipped|aborted`(`src/scheduled_tasks.rs:211`)。
- 完成判定在 fanout 终态事件处(`src/session_manager.rs:1762-1772`):`AcpEvent::Result`→`succeeded`;`AcpEvent::Error`→`failed`(cli_error);`AcpEvent::Exit`→`failed`(cli_exited)。
- **关键:zeromux 已经有 naozhi 千辛万苦才搞到的 `Exit` 帧见证原语**(`AcpEvent::Exit`),却没用足——一个**静默/卡住但没退出**的 agent(没 Result、没 Error、没 Exit)会一直挂在 `running`,直到 `scheduled_tasks.rs:363` 那个**粗粒度 30min watchdog** `reconcile_orphans` 把它一刀切成 `aborted`。`aborted` 没区分"卡死" vs "其实在干活被误杀",也**没有 `side_effects` 概念**——一个提 PR 的任务被误判后若叠加未来的自动重试,就会重复提。

**改造点(最小):**
1. 把 `failed` 拆出 `failed_transport`(`failure_kind` 已有,纯加值,不改 schema):区分"CLI 自己报错/退出有见证"(failed-clean,可较安全重放)vs"30min watchdog 误杀 / 连接断 / 静默无见证"(failed-transport,云端未知)。
2. 任务定义加 `side_effects: bool`(提 PR / push / 改文件类)。`side_effects && failed_transport` → **不自动处理,进 dashboard 待办分区**(复用现有 cron run-history UI 加一个 attention 计数,对齐 naozhi §7.4)。
3. (可选,治本)给无人值守 agent 发**心跳/keepalive 事件**,让"静默"和"卡死"可区分——直接对应 naozhi F6 教训(idle timeout ≠ 安全兜底,要靠 keepalive 保流非静默)。

**为什么值得做**:这是无人值守功能**最危险的盲区**——任务"声称跑完其实断了""被 30min watchdog 误杀""副作用任务被重复触发"现在全是糊的。不需要任何云沙箱。

**参考**:naozhi §6.1(三态表)、§6.2(双跑封堵三件套)、§7.4(确认队列 UI)、validation 报告 §7 F6(keepalive 硬前提)。

---

### 🔥 #6 replay-not-resume + run record(输入快照)—— 配 #5 一起做最顺

**naozhi 做法**(§5):debug 一次跑过的任务,**存的不是会话状态,是任务的输入**。run record 文件化:
```
run record
├─ run_id
├─ input/  payload.json(config + prompt + skills 的 content-hash;secrets 只存引用名,绝不落明文)
├─ output/ events.ndjson(完整事件流,边收边写)
└─ meta:   { image_version, started, ended, exit_status, cost }
```
replay = 同一份 payload 重新跑一遍全新进程,新 run 以 `replay_of: <原run_id>` 链回。比"无损重建 transcript 再 `--resume`"省太多;`success`/`failed-clean` 可重放,`failed-transport` 禁用(对齐 #5)。

**zeromux 接入点**:
- 路子和现有文件化持久化([[zeromux-session-persistence-b1]])完全一致——B-1 已经把会话落盘,这里只是为**定时 run** 多存一份"输入快照 + 输出 ndjson"。
- **content-hash 存 skills/config 直接复用渲染层已在用的内容寻址**([[zeromux-rendering-ordering-naozhi-shipped]] 里的 markdown hash 缓存):多次 run 引用同一份 prompt/skill 只存一份,且重放时按 hash 还原"当时那个版本",哪怕 prompt 后来改了。
- **secrets 红线照抄**:run record 里 secrets 只存引用名,replay 时由控制面按引用重新解析当前值注入(顺带解决凭证轮换后旧快照失效)。

**为什么值得做**:无人值守任务最缺的就是"这次到底喂了什么、为什么跑成这样"的可复现性。run record 把它补齐,且为 #5 的"确认未完成→重放"提供了重放所需的输入快照——**两条天然一起做**。

**参考**:naozhi §5(replay≠resume 对比表)、§5.1(run record 结构 + secrets 红线)、§5.2(content-hash 优化)、§7.3(run 详情 + 重放按钮 UI)。
