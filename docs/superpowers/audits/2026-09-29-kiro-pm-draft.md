# Kiro 五阶段 → ZeroMux 功能与前端补充(PM 草案)

日期:2026-09-29 · 基线 `33c2236` · 输入:`2026-09-29-kiro-stage-inventory.md`、总 spec v3 §0.5、S3 spec、UX 审计。只调研,未改代码。
约束:单人、all-trust,**不做治理/权限/审计**;不推翻 S2/S3(已上线)与 S4(终端,进行中)。

**北极星指标:等人时长** = agent 完成(`last_outcome_ms`)到我查看(`zmx_read.lastViewedMs`)的间隔,前端可直接算。**辅指标:空转率** = 有待办时 agent 处于空闲的时长占比。

## 1. 核心用户旅程与摩擦点

**J1 早上手机看昨晚无人值守的结果**(Stage 3 定时任务 / 异步 review)
1. 锁屏推送 → 只写「✅ X 完成 / 本轮已结束」(`src/push.rs:345`),看不出结论,只能点开。
2. 打开分诊 → 如果夜里自动更新重启过,`last_outcome` 仅存在内存、重启后归零(总 spec M8),「完成·未读」**全部消失**。
3. 定时 run 只有行内 ⏰ 角标(`TriageRow.tsx:65`)。verdict 要进 ⚙→定时任务 Sheet 才能看到(`ScheduledTasksPanel.tsx:271`)。
4. 没有「离开期间发生了什么」的汇总,只能逐行点进去翻。

**J2 把一个大目标拆给多个 agent 并行**(Stage 2→3,backlog)
1. ⌘K 新建一次只能建一个会话(`paletteParse.ts:9` `parseNew` 单 type/dir/prompt)。拆 4 份就要重复 4 次。
2. worktree 隔离是全局开关,默认关(CLAUDE.md)。同目录并行会共用 index,只能事先重启服务切换。
3. 分诊只按注意力分组(`triage.ts:57`),看不出哪几个会话属于同一个目标。
4. 想法没地方存:agent 忙的时候只能记在别处,忙完空转,想法也常常忘掉。

**J3 review 产出并决定合并**(Stage 4 异步 review)
1. 摘要卡的文件 chip 只打开整个 Git「改动」tab,不能定位到那个文件(`TurnSummaryCard.tsx:33`,总 spec §0.5.5 已推迟)。
2. 「提交 / 撤销」要经过 SendToMenu 再发 prompt 给 agent(`GitViewer.tsx:382-384`),摘要卡上没有「采纳」动作。
3. 好/坏评价只在「运行」tab(`RunMetricsPanel.tsx:84`),和分诊、已读没有联动。

**J4 把一次纠正沉淀为约定**(frontier「持续调优设置」)
1. 对话里纠正了 agent,没有入口把它「记下来」。
2. 预设是全局的,不区分目录(`src/prompts.rs:32` 表无 work_dir),也没有 `.zeromux/context.md` 注入(底稿)。
3. 记忆只有 Crew 有(`paletteActions.ts:336`)。Claude/Codex 只能开终端手动改 CLAUDE.md,手机上几乎做不到。

## 2. 功能清单

| # | 功能 / 用户价值 | Stage | 交互草图(桌面 / 手机) | 验收 | 优先级 |
|---|---|---|---|---|---|
| F1 | **态势字段持久化**:重启、部署后「完成·未读 / 出错」不丢 | 3 | 无新 UI。`last_outcome*`、`last_snippet` 写入 session_store | 重启后未读保留率 100% | **P0** |
| F2 | **推送带结论**:锁屏就能判断要不要处理 | 3 | turn_done/run_failed 的 body = `last_snippet`(120 字);定时 run 附带 verdict | ≥50% 推送无需点开即可判断(自评抽样) | **P0** |
| F3 | **离开期间卡**:一眼看清昨晚发生了什么 | 3 | 分诊「需要你」上方一张可折叠卡:「离开 7h:完成 5 · 出错 1 · 待确认 2 · 花费 $3.1」,点某一项跳到对应行;手机同位置,J/FAB 顺序不变 | J1 从打开到清空「需要你」≤3 分钟;等人时长中位数下降 | **P0** |
| F4 | **记为约定**:一次纠正,以后不再犯 | 调优 | 用户消息气泡 ⋯ 与 composer「＋」加「记为约定…」→ Dialog 预览要追加到 `<repo>/CLAUDE.md`(若存在 AGENTS.md 同时写)「## 约定(zeromux)」段的内容 → 确认后写入(复用文件写 API 及其守卫)。手机为底部 Sheet | 手机上 ≤3 击 + 编辑;写入后下一次新会话能生效 | **P0** |
| F5 | **Backlog 待派发**:agent 忙时先存想法,空了一键派发 | 3/4 | 分诊底部「运行中」后加「待派发 (N)」折叠组(按目录);⌘K 输入后多一个选项「存入 backlog」;行内「派发」= 预填 ⌘K 新建模式(R22 唯一新建实现) | 想到→入库 ≤2 击;派发 ≤2 击;空转率下降 | P1 |
| F6 | **批量派发 + 目标标签**:一个目标拆多份并行 | 2→3 | backlog 多选 →「并行派发」:同目录、每个会话**单独选择**是否隔离 worktree(预计 24s,提示),会话描述自动写成「目标:X」;TriageRow 第二行已会显示描述 | 4 路并行从 4×(⌘K+输入)降到 1 次多选 | P1 |
| F7 | **摘要卡 review 动作**:在一处完成看、判、处理 | 4 | 摘要卡底部行加「采纳 ✓ / 打回 ↩ / 提交…」。采纳 = human verdict good + 标为已读;打回 = 聚焦 composer 并预填;提交走 SendToMenu(同目录)。文件 chip 定位到单个文件 diff(取消 §0.5.5 推迟) | review 一轮 ≤3 击;不离开 Focus 区 | P1 |
| F8 | **定时「立即运行」后打开会话**(R25 未落地,`ScheduledTasksPanel.tsx:106-110` 只写 note) | 3 | toast 带「打开会话」action | 1 击进入 | P1 |
| F9 | **定时任务串联**:A 的 verdict 为 good 时触发 B(夜间「实现→自测→总结」) | 3/4 | 任务表单加「成功后运行 ▾」;分诊中以 ⏰→⏰ 标记 | 串联链夜间无人值守跑通率 | P2 |
| F10 | **定时任务支持 Codex/Crew** | 3 | 表单 agent 下拉。后端前置条件见 `session_manager.rs:2630` 注释 | 三种后端均可定时运行 | P2 |
| F11 | **今日成本**:精确成本核算的最小版 | 3 | ⌘K 动作「今日花费」+ F3 卡片内显示;Codex/Crew 显示「未校准」 | 与账单偏差可解释 | P2 |

排期:F1/F2 纯后端,可与 S4 并行。F3/F4/F7 在 S4 上线稳定 ≥2 天后作为 **S5「喂养」** 一期,其余为 S6。F5 的 backlog 与 F3 懒加载,每个 task 都跑 `check-size`(首屏 br ≤330KB)。

## 3. 与进行中重设计的衔接

- 不新增顶层导航:入口只放在已有的 Triage 组/头部、⌘K、`sessionActions`、SendToMenu、TurnSummaryCard、composer「＋」。
- 保持现有决议:卡片不内嵌回复(§0.2);新建唯一走 ⌘K(R22);注意力判定顺序 M12 不改,backlog 不进「需要你」;不引入手动 Blocked/Done(R24)。
- S4(终端)期间 F 系列不改动 TerminalView / 键栏。

## 4. 不做什么

| 不做 | 原因 |
|---|---|
| 治理、权限、沙箱、审计日志 | 用户约束:单人、all-trust |
| Stage 5 协调 agent(自动 decompose/dispatch/patrol/judge) | 3–8 个会话时协调成本不是瓶颈;先用人工 backlog + 批量派发验证需求,空转率明显时再议 |
| Stage 4 自动流水线(GitHub label 当队列、自动合并) | 个人项目没有 PR 流程;「人类标准审核」由 F7 满足,不自动合并 |
| 看板 / 全局 activity feed / 全局事件 WS | 与分诊队列重复(§0.2 已决);F3 卡片足以覆盖「离开期间」 |
| LLM 生成的二次摘要 | 增加成本和延迟;`last_snippet` 已够用(S3 非目标) |
| 属性测试生成、代码库「为 agent 设计」改造工具 | 属于项目本身的工程实践,不是 zeromux 的产品功能;可以通过 F4 约定沉淀来引导 |
| 多用户、会话移交 | 单人使用 |
