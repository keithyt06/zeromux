# S4 终端验收(plan Task 7 / 4f92c3 v2 §3)

- 分支 `feat/s4-terminal` @ `8a8d6c1`;**本文件仅验收,未部署**(部署另行)。
- 隔离实例:`--port 18095 --host 127.0.0.1 --password smoke --data-dir $(mktemp -d) --tmux-socket zmx-smoke-s4`,work dir 为 `$HOME` 下 mktemp 目录(`work_dir` 须在 home 下)。tmux server 由测试脚本以 `zeromux --print-tmux-conf` 生成的配置(去掉 `source-file ~/.tmux.conf`)在 `-L zmx-smoke-s4` 上手动拉起 —— 所以 `mouse on / window-size latest / history-limit 50000` 与线上一致,但**不在** `zeromux-tmux.service` cgroup 里,冒烟页顶部会显示 45px 的「tmux server 不在 zeromux-tmux.service 中」横幅(线上没有)。
- Headless chromium(playwright-core,`--no-sandbox`);手机 = 390×844 `isMobile/hasTouch` + iPhone UA,dpr 2;桌面 = 1440×900。触摸手势用 CDP `Input.dispatchTouchEvent`(松手前停 150ms,不带惯性)。服务端状态用 `tmux -L zmx-smoke-s4 display -p` 读取。
- 测试:`npm test` **125 文件 / 853 测试全绿**;`cargo test` **554 passed**。
- 首屏 br(`npm run build`):`index-*.js` 307.0KB + `index-*.css` 9.0KB = **315.9KB / 330KB**(余量 14.1KB)。
- `find frontend/node_modules -maxdepth 3 -type l -lname '/tmp/*'` 结果为空。

## 五项验收(4f92c3 v2 §3)

| # | 项 | 期望 | 实测 | 结论 | 证据 |
|---|---|---|---|---|---|
| 1 | 重连复位 | 回滚进 copy-mode → 关 WS → 自动重连:胶囊消失,服务端 `pane_in_mode=0` | 上滑后 `pane_in_mode=1`,胶囊 `copy/回到底部`;页面内 `ws.close()` 关闭 term WS,5s 后新 WS `readyState=1`,胶囊 = null,`pane_in_mode=0` | **通过** | `acc1-before-reconnect-m.png`、`acc1-after-reconnect-m.png` |
| 2 | 超过 3 屏的长 inline 输出 | 上滑进历史;下滑回到底部 → 胶囊收起,恢复跟随 | `seq 400`(history 362 行,39 行/屏)。上滑 → `pane_in_mode=1 scroll_position=15`,胶囊出现;两次下滑 → `pane_in_mode=0`,胶囊 = null(按净滚动量收起);之后的新输出 `FOLLOW-OK-42` 出现在屏幕底部 | **通过** | `acc2-scrolled-up-m.png`、`acc2-back-to-bottom-m.png`、`acc2-follow-resumed-m.png` |
| 3 | 全屏程序(alternate screen) | 手势能滚动、⤓ 能回到底部、HistoryView 显示「仅当前屏」 | 冒烟机上没有 Claude,改用 `less`,两种情况都测了:**(a) `less --mouse`**(`alternate_on=1 mouse_any=1 mouse_sgr=1`)→ 走 AppWheel 路由:上滑后首行 02966→02953,`pane_in_mode` 保持 0,胶囊 `variant=app`(描边样式),空闲 3.5s 后退化为只剩 ⤓ 图标(`degraded=true`),点 ⤓ 后首行回到 02966,胶囊 = null。**(b) 普通 `less`**(不开鼠标上报)→ 不满足 AppWheel 条件,走 copy-mode(`pane_in_mode=1`,胶囊 `copy`)。tmux copy-mode 翻的是 tmux 自己的 history,不是 less 的内容;⤓ 后 `pane_in_mode=0`。两种情况 HistoryView 都显示「仅当前屏」,按钮 aria 为「发给 agent-star,仅当前屏」 | **通过(a)**;真 Claude Code 全屏**未验证** | `acc3-mouse-scrolled-m.png`、`acc3-mouse-idle-m.png`、`acc3-mouse-history-m.png`、`acc3-plain-*.png` |
| 4 | 撤回 | 一击发送后 3s 内点「撤回」→ 目标收不到 prompt | 手机 HistoryView 点「发给 ★ agent-star」→ toast「已发给 agent-star · 199 行」+「撤回」;577ms 时点撤回,4s 后目标 ACP socket 上拦截到的 `prompt` 数 = **0**。对照组(不撤回):1.5s 时为 0,**3055ms** 时发出 1 条(内容为 tail 200 行包装后的 prompt) | **通过** | `acc4-undo-toast-m.png`、`acc4-undone-m.png`(验证方式:包装 `WebSocket.prototype.send` 拦截 `/ws/acp/` 上的 prompt,没有真的交给 claude) |
| 5 | 可视高度(390×844,键栏收起) | 记录真实百分比(预期约 78%),与 82% 目标对照,不虚报 | 见下表 | **记录数据**(见下) | `acc5-*.png` |

### 第 5 项实测(`getBoundingClientRect`,viewport 高 844)

| 场景 | 终端容器 `.xterm-container` | `.xterm-screen`(实际字符区) | tmux 行数 | 底部区域 |
|---|---|---|---|---|
| 冒烟实例(有 45px tmux 警告横幅),键栏**收起** | 694px = **82.2%** | 680px = 80.6% | 39 | 57px |
| 冒烟实例,键栏**展开** | 639px = 75.7% | 629px = 74.5% | 36 | 112px |
| 健康(把 `/api/tmux/health` mock 成 in_unit=true,即线上形态、无横幅),键栏**收起** | 739px = **87.6%** | 731px = 86.6% | 42 | 57px |
| 健康,键栏**展开** | 684px = 81.0% | 680px = 80.6% | 39 | 112px |

- 冒烟实例上容器占比刚过 82%(82.2%),但实际字符区是 80.6%;线上没有横幅,收起时容器 87.6%、字符区 86.6%。表中 4 个数字都是实测值。和 4f92c3 预期的约 78% 有出入:可能是预期值的算法不同(含不含顶栏或横幅),这里不下结论,只给数据。
- 以上数字都是**软键盘未弹出**时测的。iOS 真实地址栏 / 安全区会把可用高度压得更低:**未验证**。

## 其它截图

- `desk-selection-sendto-d.png`:桌面 tmux 会话,Shift 拖选后出现「发给…」浮钮;`desk-sendto-menu-d.png`:点开后是 SendToMenu(★ agent-star 已获焦点);`desk-sent-toast-d.png`:按 Enter 后 toast「已发给 agent-star」,拦截到 prompt 1 条,内容是选中的 `error[E0425]…`。**桌面 = 选中 → 1 次点击 → Enter**,≤ 2 击达标。
- `desk-focusheader-menu-d.png`:FocusHeader ⋯ 菜单(复制接续命令 / 重命名·描述 / 查看历史 / 关闭)。
- `acc3-mouse-history-m.png`:手机 HistoryView 底栏,「发给 ★ agent-star」加上方的「仅当前屏」。
- 手机「终端报错交给 agent」击数(V5):键栏**展开**时 📜 → 「发给 ★」= **2 击**(达标);键栏**收起**时要先点「⌃ 键栏」,共 **3 击**(比 V5 的 ≤ 2 多 1 击,是收起键栏换高度的代价,需要 PM 确认是否接受)。
- 冒烟全过程 headless 没有出现 `pageerror`。

## 真机未验证项

- iOS 长按 / `-webkit-touch-callout`:长按「发给」打开菜单、历史文本仍能长按复制,headless 模拟不出 iOS 的长按菜单。
- 软键盘弹出 + `ResizeObserver` 在 keyboard padding 变化时 refit,需要在 iPhone 上确认没有反复重绘(final review 的 minor)。
- 锁屏 30s 后回来胶囊是否复位(ruling 中提到;headless 只验证了主动 `ws.close()` 后的重连路径)。
- 真 Claude Code 全屏(见第 3 项;线上 tmux.conf 设了 `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`,新开的终端默认不进全屏)。
- ⌘]:不适用(本期没有该快捷键)。

## 已知行为(不算失败)

- `window-size latest`:桌面打开右侧面板或缩窄窗口后,手机上同一会话也会跟着变窄(以最近活动的客户端尺寸为准)。

## 推迟清单

- **S5**:桌面 FocusHeader 状态行 / 鼠标开关 / 🖱⧉ 挪进 ⋯(termControls)。
- **P3**:PgUp/PgDn 在 tmux 下改走翻页滚动(需要服务端先检测 alternate)。
- A6、A8(审计遗留)。
- `useXterm` 抽取(顺带去掉 3 处重复的 `wsRef` 发送守卫)。
- WebGL 预算 V13。
- 其它 minor:键栏收起再展开后页码回到 1;undo toast 可能被连续 3 条以上的 toast 挤掉;copy-mode 下 idle timer 空转;characterization 测试的 act() 警告。
