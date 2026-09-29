# S5/S6/S7 spec review 裁决（主会话，2026-09-29）

输入：`spec-review-cto.md`（2 BLOCKER / 7 MAJOR / 9 MINOR）、`spec-review-pm.md`（3 / 6 / 8）。两份 review 全部采纳，以下只写需要裁决或跨 spec 协调的部分。

## 跨 spec 统一约定（S5 定义，S6/S7 引用）
1. **Crew 持久化字段**，定在 S5 G2/R4，存进 sessions 表，共三列：
   - `crew_mode`：Gateway 原值 `""|crew`
   - `crew_agent`：原值
   - `crew_origin`：`zeromux|external`

   `owns_slot = crew_origin != external`，不能拿 `resume.is_none()` 推断。展示用的三档（聊天、并行话题、目标指挥）由前端从这三列派生。来源：CTO M2、M3。
2. **Posture 持久化**：新增 `persist_posture(sid)`，`settle_posture` 和 crew_ask 两条路径都要调用。F1 的列加上 `awaiting_input`。S5 负责定义这个函数，S6 负责调用。来源：CTO M5、PM m5。
3. **门槛 T 只有一套口径**：以 S7 §0.1 的 journalctl `zmx_usage` 为准，S6 §9.1 改为引用它。计时从两个 chip 都上线那天算起，也就是 S6 T3 上线日。14 天内要有 ≥3 次，且分布在 ≥2 个不同日期。G9 不受 T 约束。来源：CTO M7、PM B3。
4. **北极星埋点**：`POST /api/sessions/{id}/read` 加服务端 `read_ms`（原 S7 §10 的跨设备已读），**挪到 S6**，写入时打 `zmx_usage wait_ms=…`。S6 补一节成功指标。来源：PM B1、M5。

## S6 修订
- **B1（CTO）**：话题模式不走 `mark_turn`，改用新增的 `set_crew_busy(sid,bool)`，不带 seq，也不 bump `last_activity`。补单测。
- **M4（CTO）**：topics 会话里，content_block 和 result 都不改 busy。
- **M6（CTO）**：重连时 GET slot 的 messages，用 `meta.mid` 补发断连期间的 crew_*；seen 集合从 scrollback 重建。
- **B2（PM）**：D1 退出码反过来：0 表示唤醒，1 表示跳过，其他都算故障。
- **M1（CTO）**：`upsert_config` 的 SET 加上 `gate_cmd` 和 `gate_since_ms`，`query_configs` 的 SELECT 同步。
- **PM M1**：外部 slot 推送的正文写明「在 Crew/微信回答」。Crew cron 失败推送带深链；**G9 从 S7 挪到 S6，和 T4 同期**。
- **PM M2**：「采纳」改为 ✓ 后直接打开「提交…」（仅当 files>0）。遇到 404 静默处理；去掉提交按钮上的 confirmDanger。
- **PM M3**：TriageRow 第一行加「目标」Badge，并纳入 `same()`。
- **PM M4，裁决选 B**：待派发改用服务端单表（仿 quick_targets），实现跨设备。理由是用户手机和 Mac 用得差不多，J2 的主路径就是「手机记、桌面派」，而这项工作量只有 S。
- **CTO m1–m5、m8**：全部采纳，包括 wait 回收僵尸进程、Wake 前复核 config、approval/ask 的去抖按 kind 分 key、父子快照只由 crew_watch 一个 owner 写入，并补齐测试。
- **CTO m3**：「7 天未唤醒」挪到 S7。
- **PM m1、m2、m4、m7**：采纳。待派发 N>0 时默认展开；离开卡最多 3 行；话题会话忙时显示「话题运行中」；S5–S7 的首屏累计预算写进各 spec。
- **PM m3**：G7b 标注为「范围新增」。

## S7 修订
- **B2（CTO）**：replay 快照记录的 `agent_type` 必须能回到 Crew。让 `scheduled_session_type` 接受 `"crew"`，测试改为断言 replay 仍走 Crew。
- **M1（CTO）**：`upsert_config` 的 SET 加上 `agent_type`，SELECT 同步。
- **PM M6 + CTO m7**：
  - S7-a 只做 ② Codex 定时，单独成一期，并单独安排 reviewer。
  - Crew fan-out 移植挪到 S7-f，和 G10 一起做。
  - 其余项放 S7-a2。
  - G9 移出，归 S6。§10 跨设备已读移出，也归 S6。
- **CTO m5**：代理层的 slots 数据复用 S6 crew_watch 的快照，不再单独做 SlotsCache。
- **CTO m6**：Mutex 改用 SessionManager 字段或 LazyLock。
- **CTO m9**：加一个启动自检测试。
- **PM m6**：抽查改用 `zmx_usage`。
- **PM m8**：G10 的 run 行注明「已派发，目标进度见子任务」。
- 新增「7 天未唤醒」一节，从 S6 挪过来。
