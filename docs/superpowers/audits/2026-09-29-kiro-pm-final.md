# Kiro × ZeroMux PM 终稿(2026-09-29,第三轮)

输入:`kiro-pm-draft`、`kiro-pm-reviews-cto`、`kiro-cto-draft`、`kiro-crew-gap-research`(下称「调研」)。

## 1. Stage 5 要不要调整

**调整**为:入口、可视化、叫醒三件事由 zeromux 做;编排全部交给 Crew conductor。zeromux 不写协调逻辑。

使用量为 0 这个信号**无法解读**:
- 结果看不见:Crew Mode 的回答在 zeromux 里被丢掉了(调研 G1,`crew_process.rs:202-206`),用了也看不到。
- 手机上没有入口。
- 但 Crew 自带桌面 dashboard,也是 0 次,所以需求本身同样没有得到证明。

结论:先做成本最低的探针,**G1(修丢帧)+ G2(入口)**,都是 S 级。设门槛:上线两周内实际用 conductor 或并行话题不少于 3 次,才投入 G4/G5。这样花的是验证成本,不是押注。

随之**降级** CTO 的 ⑥(`zeromux ctl` + `/prompt` 端点)到 P3:Crew conductor 已经覆盖同样的场景,不应在 zeromux 里再造一套。

## 2. 手机交互草图:统一成一套「子会话折叠」

**模型**:一个父会话挂 N 个子项。子项分两类:
- **slot 子项**:conductor 创建的 child slot。可以附着成 zeromux 会话,能进分诊。
- **话题子项**:Crew Mode 的 topic、subagent。不是会话,只在面板里显示。

我在 Q1 提的 `parent_id` 折叠方案就是这个模型的特例,不需要另做。

- **G2 入口**:在 ⌘K 新建模式里选 Crew 后,出现二级 chip「聊天 / 并行话题 / 目标指挥」,一击选择;也支持关键词 `crew:goal` / `crew:topics`。不新增顶栏图标,仍遵守 R22「新建只走 ⌘K」。
- **分诊中的父行**:第二行显示「↳ 5 项:3 运行 · 1 需要你」。需要你的 slot 子项**单独进入「需要你」组**,行内注明「来自 〈父会话〉」;其余子项折叠不展开。M12 排序不变。
- **G4 子任务 tab**:加在 ContextPanel 的 Crew 会话里(Git / 文件 / 运行 / 子任务),手机上是底部 Sheet。每行是状态点 + 最后一句结论 + 「打开」;只有 slot 子项能打开。
- **G5 目标卡**:放在子任务 tab 的**头部**,不做对话区 sticky 卡片,以免挤占手机可视高度(S4 目标)。内容是「目标 · 第 2 轮 · 3/5 通过」,附带待回答的 `ask_question` 数量。回答时跳到父会话 composer。
- **G6 外部 slot**:不整组并入分诊(否则微信、cron 的 slot 会淹没队列)。只有 needs_input 的外部 slot 进「需要你」;其余放进 ⌘K「接入 Crew 会话」,和「本机 tmux」同构。
- **G7 叫醒**:外部 slot 的 needs_input 走现有 `confirm` 推送;推送正文带问题原文(与 F2 同一原则)。

## 3. G9 Crew cron 只读分段

**值得做,但要拆开**:
- **失败推送:P1**。用户真实在用 Crew cron(2 个考研英语推送任务,18 条 run)。推送类任务失败了没人知道,这正是「叫醒」的本义,而且可以复用 G7 的轮询。
- **只读列表:P2**。平时不需要看,出了问题才看;放在 ScheduledTasksPanel 的第二个分段里。
- 编辑、启停一律不做,避免出现两套调度语义。

## 4. 最终优先级

- **P0**:F1 已读状态持久化、F2 推送带结论、F3 离开期间卡、④ shell 预检、F4 记为约定(只做写入口)、**G1 Crew Mode 结果可见**(这本质上是缺陷)。
- **P1**:G2 入口;G7 与 Crew cron 失败推送;F7 摘要卡采纳 / 打回;③ 串联(含链视图);② 定时任务支持 Codex;F5 本地待派发;G4 + G5(等 G2 过门槛后再做)。
- **P2**:G6 全量外部 slot、G9 列表、⑤ 全局动态、⑧ Codex 成本、G8 巡检徽章、G10 定时任务启动 conductor。
- **P3 / 不做**:⑥ ctl 与 `/prompt`、G11 workflow 视图、G12 pipeline 看板、zeromux 自建协调者 / DAG / 看板。

## 5. 与 CTO 仍有的分歧

1. **约定写入口**:CTO 认为「原生已读,不做」;我坚持手机上要能写入,P0。
2. **② 和 ③ 的级别**:CTO 定 P0,我定 P1。理由是先解决「人收结果」的问题,再让 agent 跑得更多。
3. **⑥ ctl**:CTO 定 P1,我在调研之后建议降到 P3,由 Crew conductor 替代。
4. **backlog**:机器侧用 GitHub label(Crew pipeline-conductor 本来就这样做),这点已一致;分歧只剩手机上随手记的本地「待派发」要不要做。我主张做,P1。
5. **G3(Crew Mode 的 turn 边界)**:交给 CTO 实测后定。PM 只要求 busy 状态不要一直亮着。
