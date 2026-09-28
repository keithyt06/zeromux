# S2+S3 壳切换 —— §0.5.4 功能对位验收(Task 11)

隔离实例:`zeromux --port 18093 --data-dir <mktemp,全新,未拷线上数据> --tmux-socket zmx-smoke-s2s3`,
headless Chromium(playwright-core)截图 390×844(m)与 1440×900(d),暗/亮两主题,存 `shell/`。
测试 = vitest 组件/App 级测试;截图 = `shell/*.png`;— = headless 无法验证(需真机 / 真 agent / 推送)。

| 功能 | 桌面 | 手机 | 证明 | 备注 |
|---|---|---|---|---|
| 会话列表 / 未读 / 相对时间 | ✅ | ✅ | TriageList.test、AppShell.test(J/FAB/title)、`*-triage.png` | 未读 = `last_outcome_ms > lastViewedMs`(M10) |
| 行 ⋯:复制接续命令 / 重命名 / 查看历史 / 关闭 | ✅ | ✅ | sessionActions.test、FocusHeader.test(⋯ = 注册表)、App.characterization I-18 | 行 ⋯ 与 FocusHeader ⋯ 同源 |
| 双击重命名 | ✅ | n/a | TriageRow 名称 onDoubleClick → rename action | 手机走 ⋯ |
| 会话描述 | ✅ | ✅ | RenameDialog.test、AppShell.test(updateSession 含 description) | 行第二行无 snippet/step 时显示描述 |
| 桌面折叠图标栏 | ✅ | n/a | AppShell.test(900px rail)、`d-*-rail-900.png` | md–lg 56px;≥lg 为 272px 列 |
| 新建流程 / QuickTargets / 搜索 / 换类型 | ✅ | ✅ | CommandPalette.test(23 项,含 Sidebar.newflow/search 移植)、`*-palette-empty.png`、`*-palette-new.png` | |
| 设置:推送 / 预设 / 用户管理 / 主题 / 退出登录 | ✅ | ✅ | AppShell.test(⚙ 菜单全项 + 退出登录)、CommandPalette 动作 | 手机唯一入口 = 分诊页头 ⚙ |
| 定时任务入口 + 待确认徽标 + 调度器红点 | ✅ | ✅ | AppShell.test(定时待确认 (N))、TriageHeader | 调度器红点截图未覆盖(实例健康) |
| 本机 tmux 接入 / 「zeromux 遗留」 | ✅ | ✅ | TriageList.test、CommandPalette.test(接入 tmux:)、`*-triage.png`(本机 tmux (1)) | |
| 笔记库入口 / 关闭文档页签 | ✅ | ✅ | CommandPalette.test(打开笔记库)、TriageList.test(文档 ⋯ 关闭) | 实例未配 vault,截图无 |
| 队列模式下拉 | ✅ | ✅ | CommandPalette.test(临时 ⌘K 动作,显示后端权威值 I-6) | Task 12 改 composer chip |
| Files / Git / Events / Metrics / Memory | ✅ | ✅ | ContextPanel.test、AppShell.test、`d-*-agent.png`(右栏)、`m-*-agent-context.png`(Sheet) | 记忆 = composer「全部 →」→ MemoryPanel Sheet(Crew,未截图) |
| 复制 peer 名 / 休眠提示 | ✅ | ✅/— | sessionActions.test、FocusHeader.test | 手机顶栏不显休眠文字(空间) |
| 手动 Blocked/Done | 删除 | 删除 | — | R24 |
| 密度切换 | 删除 | 删除 | — | Task 10 |
| 会话成本、Crew ctx % | ✅ | ✅(ctx) | FocusHeader.test、crewEventCases(独立挂载仍内联) | 手机顶栏不显 $ |
| 其他终端也在看 | ✅ | ✅ | TriageList.test(Monitor 徽标) | |
| 中断 / 已排队 N 条 | ✅ | ✅ | TriageList.test(行内中断 + 未连接 toast)、TurnStatusBar.test | |
| 终端状态栏路径/分支/dirty、接续、历史、鼠标 | ✅ | ✅ | `*-tmux.png`(原样) | 本期不动 |
| Git「让 agent 处理」 | ✅ | ✅ | GitViewer.forward.test(onForward 经 ContextPanel 透传) | Task 13 SendToMenu |
| 推送深链 git_dirty → 改动 | ✅ | — | AppShell.test(M26) | SW 推送 headless 不可测 |
| `?session=` / SW open_session | ✅ | ✅ | App.characterization I-17、AppShell.test、截图用 `?session=` 打开 | |

## 截图中观察到的问题(非阻断,记录)
- ~~360px 右栏里 GitViewer 双栏拥挤~~ → fix round 1:容器查询 <640px 纵向堆叠(列表 ≤35% 高 + diff 全宽),已重拍 `d-dark-agent-context.png` / `m-dark-agent-context.png` 确认。
- tmux 会话顶部「tmux server 不在 zeromux-tmux.service 中」警告:冒烟实例专用 socket 手动起的 server,预期。
- FAB 未截:冒烟实例无出错/完成 turn(没有真 agent 输出);由 AppShell.test 覆盖。
