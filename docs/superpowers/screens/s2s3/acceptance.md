# S2+S3 合并期验收(spec §0.5.7)

- 线上部署 sha:`a96e57d`(origin/main)。本收尾分支 `chore/s2s3-closeout` 另加:非 git 目录友好空态 + ContextPanel 默认 文件 tab。
- 首屏 br(`npm run build`,本分支):`index-*.js` 304.5KB + `index-*.css` 8.9KB = **313.3KB / 330KB**(余量 16.7KB)。
- 测试:`npm test` **118 文件 / 750 测试全绿**;`cargo test` **551 passed**(注:`tmux::tests::capture_returns_history_and_truncates_head` 为既有 ~20% flake,本次通过)。
- lint:eslint 15 error / 3 warning,与 base 相同(无新增);token 棘轮 smallText 69 → 68,其余持平;对比度通过。
- 对位表逐行证明见同目录 [parity.md](parity.md)(Task 11,截图在 `shell/`)。

## 逐项证据

| # | 验收项 | 证据 |
|---|---|---|
| 1 | §0.5.4 对位表每行有测试或截图 | `parity.md` 全表(每行列出测试名 / `shell/*.png`);headless 不可达的两处(SW 推送深链、手机休眠文字)标 — |
| 2a | 手机分诊 → 下一个需要你 ≤ 1 击 | `AppShell.test`「phone: FAB 下一个需要你的 jumps to the needs-you session in one tap」 |
| 2b | 分诊行内中断 / 批准 ≤ 2 击且不改 activeId | `TriageList.test`「inline 中断 on a running row does not select it」「inline 批准 expands the approval summary … and resolves it」 |
| 2c | quick target 新建并发 prompt = ⌘K + 1 击 + 打字 | `CommandPalette.test`「empty state lists quick targets … a quick target creates with its agent」「a double tap on a quick target creates only one session」 |
| 2d | 队列模式切换 1 击 | `QueueChip.test`「shows Collect and one tap calls onToggle once (§0.5.7-2)」 |
| 2e | 笔记 ⚡ → 发给 ★ ≤ 2 击 | `CommandPalette.test`「⚡ → SendToMenu sends the note context to an existing agent without switching」;`SendToMenu.test`「the first is ★ and focused; Enter sends to it」 |
| 3a | `triage()` 8 态全覆盖 | `lib/__tests__/triage.test.ts`「tone and label cover all 8 states」及各态单测 |
| 3b | 刷新后离开期间完成的会话仍在「需要你」 | `readState.test`「round-trips through localStorage」+ `triage.test`「done_unread: completed after last view」(已读持久化 M10,组合证明;无单一端到端刷新测试) |
| 3c | 3s 轮询不改 activeId(I-2) | `App.characterization.test`「a poll that reorders / prepends sessions keeps activeId」 |
| 3d | 未变行不重渲染(I-9) | `TriageList.test`「unchanged rows do not re-render …(I-9)」;`AppShell.test`「a finished turn does not re-render on AppShell ticks / polls (I-9)」 |
| 4 | 切会话往返 xterm / WS / ContextPanel tab / turn 展开态不丢(I-1) | `App.characterization.test`「switching sessions does not recreate xterm nor reconnect WS」;`AppShell.test`「crossing the phone breakpoint … never remounts」「desktop ≥1280 … state is per session」(tab 往返);`TurnView.test`「a step the user expanded keeps the turn in timeline form」(展开态随 pane 常驻保留) |
| 5 | useAcpSocket characterization 六项 + 既有测试不改断言即绿 | `acpSocket.characterization.test`(1–9 项,覆盖原六项);既有 `crewEventCases` / `acpConnection` / `acpHeaderLifetime` / `transcript` 原样通过 |
| 6 | 首屏 br ≤ 330KB;棘轮/对比度不增;lint 不新增 error | 见页首:313.3KB;smallText 68(降);eslint 15 error = base |
| 7 | 终端可视高度(390×844,键盘收起)≥ 75% | `shell/m-dark-tmux.png`(2x,780×1688)目测测量终端区 y≈185–1480 → ≈ **77%**(含冒烟实例专有的 tmux 警告横幅;线上无该横幅会更高)。未用 `getBoundingClientRect` 精确测量 |
| 8 | 隔离实例真机试用无 P1;回滚演练耗时已记录 | 隔离实例:headless 截图走通(parity.md);**真机(iPhone / Mac)试用:未验证**(本收尾无真机)。回滚演练见下 |

## 回滚演练(2026-09-28,隔离;未碰 8090 / systemctl / 主 checkout)

在 `/tmp/zmx-s2s3` 从 `a96e57d` 开 `rollback-drill` 分支:

| 步骤 | 结果 | 耗时 |
|---|---|---|
| `git revert --no-edit 55a4648`(单提交壳切换) | **冲突,不干净**:9 个 modify/delete(`ContextPanel.tsx`、`TriageRow.tsx`、`useShellState.ts`、`useNextKeys.ts`、`paletteActions.ts` 及 4 个 shell 测试)——其后 5 个 composer/send-to 提交改了这些文件。已 `--abort` | 5.6s |
| `git revert --no-edit 55a4648^..a96e57d`(6 个提交整体回退) | **干净**,生成 6 个 revert 提交,树与 `55a4648^` 一致 | 25.5s |
| `npm run build`(回退后) | 成功,首屏 br 308.6KB | 12.1s |
| `cargo build --release` | 成功 | 1m06.7s |
| 隔离实例 `--port 18094 --data-dir $(mktemp -d) --tmux-socket zmx-drill --password drill`,`curl /` | 200(`<title>ZeroMux`) | 启动到 200 ≈ 0.5s |

结论:壳切换**已不能单提交 revert**(§0.5.6-3 的前提「composer/SendToMenu 等 ≥2 天再合」本期未满足)。真实回滚 = 回退 `55a4648^..a96e57d` 整段 6 个提交,git + 前端 + release 构建合计 ≈ **1m45s**,再加 `./deploy.sh`(未在演练中执行,不碰线上)。

## 未做 / 推迟

spec §0.5.5 原文:

> 推送 `&turn=` 深链;notices 按时间穿插;步骤 `arrivals` 耗时打点与每行 1s ticker(Timeline 只显示状态,turn 总耗时由 `turn_started_ms` 给出);tool result「看全文」Sheet(用 `<details>` + 截断);摘要卡文件 chip 精确定位 diff(本期点击只打开 Git「改动」tab);AgentDashboard 重做(原样放在「运行」tab 下半段的折叠区,不改代码——保住 `AgentDashboard.stale.test`);GitViewer 内部改造 B5/B6 与窄屏两级导航(本期 GitViewer 原样嵌入 Git tab,仅加 `initialView` prop);记忆完整编辑迁入 composer 弹层(本期 ⌘ 弹层底部「全部…」打开 MemoryPanel Sheet);`setAppBadge` 与分诊行「忽略」(保留 `document.title` 计数);`content-visibility` 优化;`⌘.` 等附加快捷键;Plan B 全部。

已知推迟的小项:

- `⌘]` 浏览器前进冲突未在真 Mac 上验证。
- 真机 iOS 键盘 / 推送未验证。
- AgentDashboard 在「运行」tab 折叠区隐藏时仍在轮询。
- 768–1279px 下 ContextPanel 是底部 Sheet(非内联列)。
- composer 记忆弹层与 MemoryPanel 不共享数据(各自拉取)。
