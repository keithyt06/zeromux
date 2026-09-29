# ZeroMux 能力盘点 × Kiro 五阶段（2026-09-29，调研底稿）

来源文章：
- https://kiro.dev/blog/software-factory-1000-prs/
- https://kiro.dev/topics/frontier-engineering/
- https://kiro.dev/topics/frontier-teams/

用户约束：个人项目，all-trust 授权 → **治理/权限/沙箱/审计不在范围内**。

## 五阶段（Kiro）
1 单会话 → 2 多标签(3-5) → 3 共享记忆+仪表板+定时任务+工作流(10-20) → 4 Agent 管道：分类→实现→审查→合并，各阶段独立、仅通过队列协调，GitHub label 充当队列(20+) → 5 Crew Mode：协调 agent 负责 decompose/dispatch/patrol/judge/sequence(50+)。
50+ 会话后协调成本成为瓶颈：轻模型监督、确定性脚本检查、最小上下文唤醒、会话知识复用、精确成本核算。
Frontier 原则：架构师而非打字员、最大化 agent 时间、为 agent 设计代码库、快反馈、方向>执行、代码可弃、人类标准审核、全面用 agent、持续调优设置；“喂养而不看护”：维持分好的 backlog、并行多 agent、异步 review；意图→设计→构建→验证（属性测试）。

## 现状结论
- 阶段 1–2：已经做扎实了（4 种后端、回放、Triage 队列 `lib/triage.ts`、⌘K、多设备 observer、tmux 持久化、SendToMenu 手动转发）。
- 阶段 3：做了一半。
  - 记忆：只有 Crew 有（`crew_memory.rs`、MemoryPanel）；Claude 和 Codex 没有共享记忆，也没有 `.zeromux/context.md` 注入（路线图未做）。Notes 后端已删除（54be804），CLAUDE.md 里的描述已经过时。
  - 仪表板：Triage 覆盖全部会话，但 AgentDashboard/events 只按会话展示，没有全局 activity feed；成本校准只覆盖 Claude。
  - 定时任务（`scheduled_tasks.rs`）：只支持 Claude（`session_manager.rs:2639`）；已有 VERDICT 标记（`:51`、`session_manager.rs:1466`）、overlap、watchdog、确认队列、replay。**没有任务之间的串联**（没有 on_success/next 字段，verdict 也不会被下游读取）。
  - 工作流：没有。
- 阶段 4：没有。现有的 `QueueMode` 只是单个会话内的输入合并。
- 阶段 5：没有。能拼起来的零件：peer 消息（只有 Claude：`--name zmx-ai-<id6>`，`process.rs:170-187`；inbound 只在 legacy 交互会话开启，`session_manager.rs:659`）、external turn（`classify_claude_event` :3403）、VERDICT、stuck/idle watchdog 与推送（`:948`、`:963`）、人工 verdict API、SendToMenu。
- Crew 集成（`acp/crew_process.rs`）：已有 slot、prompt、stop、审批卡；Crew Mode 的子任务结构还没有接入。
- 前端：AppShell / TriageList / FocusHeader / ContextPanel（Git/文件/运行，其中运行 tab 内嵌 AgentDashboard）；有 10 个懒加载面板；首屏 br ≤ 330KB（`scripts/check-size.mjs`）。
- 路线图 `docs/teamwork_enhanced_tasks.md` 有 13 项，一项都没勾选。实际已经做了的：启动 prompt、完成检测、推送、摘要、定时、按会话的 feed。没做的：context 注入、角色模板、产出持久化、Wiki/Lint 模板、多用户与会话移交。
