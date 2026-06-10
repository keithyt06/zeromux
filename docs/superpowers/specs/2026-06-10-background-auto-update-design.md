# 设计:后台自动更新(本机原地升级)

> **类型**:实现 spec
> **日期**:2026-06-10
> **来源调研**:[docs/2026-06-09-naozhi-feature-inspiration.md](../../2026-06-09-naozhi-feature-inspiration.md)(借鉴清单 #4)
> **前置实现**:[deploy.sh](../../../deploy.sh)(本设计是其自愈逻辑的 in-binary 产品化)、B-1 持久会话恢复
> **状态**:设计已批准,待写实现计划

## 背景与目标

借鉴 naozhi 的「后台自动更新」,但**裁剪为本机原地升级**——不引入 GitHub Releases / CI / 远程分发依赖(zeromux 当前是单台 live 服务器、本机 build 本机部署)。

`deploy.sh` 已经做到原子替换 + 健康检查 + 自动回滚 + cgroup 逃逸。502 复发的真正根因是**人的环节**:忘了跑 `start`、stale staged revert、在 zeromux 终端里手跑 `systemctl stop`(cgroup self-kill 陷阱)。换句话说脚本逻辑是对的,坏在「要记得在正确环境正确地调用它」。

**本功能的价值**:把 `deploy.sh` 的自愈逻辑搬进 binary,让升级变成**产品内的自动行为**——你在本机 `cargo build --release` 完,live binary 自己检测到、在所有会话空闲时原子替换自身并重启,失败自动回滚。**人不再需要记得调用任何东西。**

### 与 naozhi 的差异

| 维度 | naozhi | 本设计 |
|---|---|---|
| 更新源 | 轮询 GitHub Releases | **本机 build 路径**(`--watch-build <path>`) |
| 分发 | download→SHA256→替换 | 无 download,直接用本机已 build 的文件 |
| 自动档位 | notify / download / auto 三档 | **单档:全自动**(检测到即在空闲时升级) |
| 签名验证 | 有(但自承认供应链缺口) | 不需要(本机文件,无网络分发面) |

## 已确认决策

| 决策点 | 选择 |
|---|---|
| 更新源 | **本机原地升级**(deploy.sh 产品化),不引入 GitHub/CI 依赖 |
| 自动程度 | **全自动**(检测到新 build 即在空闲时自动 swap+restart,无人值守) |
| 升级时机 | **等所有 agent 会话 Idle 再升级** + 硬上限兜底(默认 10min 强制) |
| 检测机制 | `--watch-build <path>` 显式指定监视路径 + mtime→SHA256 轮询(默认不给 flag = 功能关闭) |
| swap 机制 | **方案 A**:detached `systemd-run` 跑 swap(复刻 deploy.sh `do_swap`,保留全部自愈/回滚能力) |
| swap 脚本来源 | **binary 内嵌,经 `systemd-run bash -c '<内联脚本>'` 传入,不落临时文件**(评审 E8:消除 root 路径的 tmpfile 篡改窗口) |
| tmux 是否阻塞 | **tmux PTY 不阻塞升级**(无 turn 概念;只看 agent 会话 Running) |
| **run_id turn 是否可被强制穿透** | **否(硬阻塞,评审 E1)**:`max_wait` 强制升级只对**交互** turn 生效;携带 `run_id` 的调度运行 Running turn 永不被穿透。调度运行有 30min 看门狗自我了断,等待有界。保护 collect C3 的 run_id verdict 完整性 |
| 检测稳定性 | **sha 连续两轮相同才动手**(评审 E5:杀掉「release slot 半写被 sha 到」竞态)+ **stop 前先冒烟 `<watch> --help`**(评审 E6:坏 build 不进停服路径) |
| backup 轮转 | **保留最近 3 个 `.bak-*`**(评审 E3:deploy.sh 从不清理 backup,全自动 + 无黑名单下坏 build 每窗口造一个 → 撑爆 `/usr/local/bin`) |
| 升级失败重试 | **不做 failed-hash 黑名单**(每轮都重试;churn 是响亮信号,见「已知风险」)。失败守卫记为未来可选开关 |
| 用户可见性 | **静默升级**,前端零改动,只靠 INFO 日志字段可诊断 |

> **CTO/PM 评审修订(2026-06-10)**:本 spec 经 PM(scope/真问题)+ CTO(failure-mode)双帽走查后修订。
> - **E1(critical,run_id 完整性)**:`max_wait` 强制升级**不穿透** run_id Running turn(调度运行单次最长 30min,有看门狗;若 10min `max_wait` 能砍它 = 例行性误杀调度运行 + verdict 丢失,重新引入 collect C3 拼命保护的东西)。
> - **E3(critical,磁盘泄漏)**:内嵌 swap 脚本加 backup 轮转(deploy.sh 现状从不清理 `.bak-*`)。
> - **E5+E6(correctness/race)**:sha 连续两轮稳定再动手(防半写)+ stop 前冒烟新 binary(防坏 build 进停服路径造成本可避免的服务抖动),对齐 deploy.sh:92。
> - **E8(security,P1)**:swap 脚本走 `bash -c` 内联,**不写临时文件**——自主 root 路径下 world-writable tmpfile 在「写入→exec」间被替换 = root RCE。比 deploy.sh 的 tmpfile 路子更安全。
> - **build=deploy footgun(PM,已接受裸路径)**:见下「关键风险」。监视裸 `target/release/zeromux` 时,**任何** `cargo build --release`(含本地测试)都会让 live 在空闲时静默换上去——「build 来测一下」静默变成「部署到生产」。已接受(本机通常只在打算部署时才 release build;sha 稳定 + idle gate 收窄爆炸半径),但醒目记录。

---

## 系统组成

### 新模块 `src/auto_update.rs`

一个后台 `tokio::spawn` 的 watcher 任务,职责单一:**监视 build 路径 → 判定该升级 → 在空闲时触发 swap**。它不拥有任何会话进程,只读 `SessionManager` 的 turn 状态、读文件系统、派生 detached systemd 服务。不破坏广播扇出不变量。

```rust
pub struct AutoUpdateConfig {
    pub watch_path: PathBuf,        // --watch-build
    pub max_wait: Duration,         // --auto-update-max-wait(默认 600s)
    pub poll_interval: Duration,    // 固定 30s
    pub service_name: String,       // "zeromux"
    pub installed_path: PathBuf,    // /usr/local/bin/zeromux
    pub health_url: String,         // http://127.0.0.1:<port>/
}

pub fn spawn_auto_updater(cfg: AutoUpdateConfig, mgr: Weak<SessionManager>);
```

`spawn_auto_updater` 仅当 `--watch-build` 提供时由 `main.rs` 调用;否则功能完全不启用。

### 启动接线(`src/main.rs`)

新增 CLI flag:
- `--watch-build <path>`(`Option<PathBuf>`,默认 None):要监视的 build 产物路径。给了才启用自动更新。
- `--auto-update-max-wait <secs>`(默认 600):进入「待升级」后等待全 Idle 的硬上限,超时强制升级。

`main` 在 router 起来后,若 `watch_build.is_some()`,构造 `AutoUpdateConfig` 并 `spawn_auto_updater(cfg, Arc::downgrade(&session_manager))`。`installed_path` 取 `/usr/local/bin/zeromux`(可由 `/proc/self/exe` 解析自身实际路径,优先用它,使非标准安装也工作);`health_url` 的 port 复用 `--port`。

---

## 检测循环

### 自身 baseline

启动时算一次**当前运行二进制**的 SHA256(读 `/proc/self/exe` 指向的文件),存内存做 baseline。这是「我现在跑的是哪个版本」的真相。

> 为什么用 `/proc/self/exe` 而非 installed_path:升级当下 installed_path 已被替换成新版,但旧进程仍在跑旧映像;`/proc/self/exe` 在 Linux 上即使原文件被 rename/替换也仍指向**正在执行的那个 inode**,是「我自己是什么」的可靠来源。baseline 在**启动时**算一次即可(进程生命周期内自身不变)。

### 每轮(30s)

1. `stat` watch_path 取 mtime + size。与上轮记录比:**未变则跳过本轮**(省去哈希计算)。
2. mtime/size 变了 → 算 watch_path 的 SHA256。
3. **sha 稳定门(评审 E5)**:与**上一轮算出的 watch_sha** 比。若不同 → 记下本轮 sha,**本轮不动手**(可能正被 `cp`/`mv` 半写)。仅当**连续两轮 sha 相同**才认为文件写入完成,进入下面的判定。这杀掉「watcher 在 release slot 写到一半时 sha 到一个残缺文件」的竞态。
4. `watch_sha == self_baseline_sha` → 当前 installed 就是这个 build,**无需升级**,清「待升级」状态(覆盖「build 又被改回与当前相同」的情况)。
5. `watch_sha != self_baseline_sha`(且已稳定)→ 进入/保持「待升级」状态,记录 `pending_since = now`(仅首次进入时锚定)。
6. 「待升级」状态下,每轮检查 Idle gate(见下):
   - **可升级**(无阻塞 turn)→ 触发 swap。
   - **仅被交互 turn 阻塞 且 `now - pending_since >= max_wait`** → 硬上限到,**强制**触发 swap。
   - **被 run_id(调度运行)turn 阻塞** → **永不强制穿透**,继续等(评审 E1)。
   - 否则继续等下一轮。

> **时间来源**:轮询用 `tokio::time::interval`;`pending_since` 用 `tokio::time::Instant`(单调钟,不受墙钟跳变影响)。不引入 `chrono` 依赖。

### Idle gate 判定(区分交互 turn 与 run_id turn,评审 E1)

`SessionManager` 已有 `TurnState{Idle,Running}` + per-session turn 状态(B-2),且 `SessionInput::Prompt` 已带 `run_id: Option<String>`,fanout 已知道当前 Running turn 是否携带 run_id(`active_run_id`)。新增一个只读访问器,返回**两个维度**:

```rust
// SessionManager
pub struct RunningSummary { pub interactive: usize, pub scheduled: usize }
pub fn running_summary(&self) -> RunningSummary;
```

遍历会话,**仅** Claude/Kiro/Codex 类型且 `TurnState == Running` 才计数;按该 Running turn 是否携带 `run_id` 分入 `scheduled` / `interactive`。**Tmux 会话跳过**(无 turn 概念,不阻塞升级)。

gate 决策(纯函数,可单测):
- `scheduled == 0 && interactive == 0` → **可升级**(全 Idle)。
- `scheduled > 0` → **阻塞,且 max_wait 不适用**(调度运行有 30min 看门狗自我了断 `scheduled_tasks.rs:363`,等待有界;强制砍它 = 误杀 + verdict 丢失,违背 collect C3)。
- `scheduled == 0 && interactive > 0` → 阻塞,但 `max_wait` 到时**可强制**(交互 turn 无 verdict 完整性约束,B-1 恢复 scrollback;这是「等 Idle」与「升级不能无限拖」的取舍点)。

---

## swap 执行(方案 A)

触发后:

1. 置「升级进行中」标志(并发保护,见下)。
2. **冒烟新 binary(评审 E6)**:`<watch_path> --help` 退出码非 0 → 这是个坏/截断的 build,**不进入停服路径**,记日志放弃本轮(下一轮若 sha 仍稳定且仍 != self 会再来,但服务从未抖动)。对齐 deploy.sh:92。
3. 用 `AutoUpdateConfig` 字段把内嵌脚本模板做字符串插值,得到完整 swap 脚本字符串(`SERVICE`/`INSTALLED`/`HEALTH`/`BUILT` 全部填好)。**不写临时文件**(评审 E8)。
4. `sudo systemd-run --wait --pipe --collect --quiet --unit=zeromux-selfupdate-<pid> /bin/bash -c '<内联脚本>'`
   - **脚本经 `bash -c` 内联传入,不落盘**:消除「world-writable 临时文件在写入→exec 之间被替换 → root RCE」的窗口(自主 root 路径比手动 deploy.sh 风险更高,故比 deploy.sh 的 tmpfile 路子更严)。
   - transient service 由 PID 1 拥有,在 `system.slice` 自己的 cgroup 里 —— `systemctl stop zeromux` **够不到它**(这正是 deploy.sh 验证过的 cgroup 逃逸,binary 触发时面临完全相同的 self-kill 陷阱,解法相同)。
   - `--service` 而非 `--scope`(scope 会留在调用者 cgroup 里被一起杀,deploy.sh 已实证)。
5. swap 脚本会 `systemctl stop zeromux` —— **本进程在此刻被 systemd 终止**。这是预期的:旧进程的使命到此结束。systemd 随后 start 新 binary。
6. 若 swap 脚本 health-check 失败 → 它自己 rollback 到旧 binary 并 start —— 服务恢复旧版运行(本进程已死,但 rollback 由 detached service 完成,不受影响)。

### 内嵌 swap 脚本

复刻 `deploy.sh` 的 `do_swap` 并加两处评审加固(冒烟已在 binary 侧做过、backup 轮转),作为 Rust 字符串模板内嵌,插值后经 `bash -c` 传入:

```bash
set -euo pipefail
SERVICE="zeromux"
INSTALLED="/usr/local/bin/zeromux"
HEALTH="http://127.0.0.1:<PORT>/"
BUILT="<WATCH_PATH>"
backup="${INSTALLED}.bak-$(date +%Y%m%d-%H%M%S)"
cp "$INSTALLED" "$backup"
# backup 轮转(评审 E3):保留最近 3 个,防全自动+无黑名单下坏 build 每窗口造一个撑爆磁盘
ls -1t "${INSTALLED}".bak-* 2>/dev/null | tail -n +4 | xargs -r rm -f
systemctl stop "$SERVICE"
cp "$BUILT" "$INSTALLED"
systemctl start "$SERVICE"
for _ in $(seq 1 10); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$HEALTH" || true)"
  [ "$code" = "200" ] && exit 0
  sleep 1
done
# health failed → rollback
systemctl stop "$SERVICE"
cp "$backup" "$INSTALLED"
systemctl start "$SERVICE"
exit 1
```

> `<PORT>`/`<WATCH_PATH>`/`SERVICE`/`INSTALLED` 在 binary 内嵌时用 `AutoUpdateConfig` 字段插值,避免脚本内硬编码与 config 漂移。`sudo` 由 systemd-run 整条命令带,前提是 passwordless sudo(deploy.sh 已依赖,live 主机已配)。
> **插值安全**:`AutoUpdateConfig` 的路径/端口来自 CLI flag(运维自己给的,非用户输入),非注入面;但实现期仍应避免把任意外部字符串拼进 `bash -c`(当前字段都是受信启动配置,满足)。

### 为什么不退而求其次用 rename + 干净退出

`rename()` 替换运行中 binary 在 Linux 是允许的(不像 `cp` 的 text-busy),诱人但**丢掉 health-check + auto-rollback**——而回滚是 deploy.sh 存在的全部意义、502 痛点的解药。全自动无人值守场景下没人盯着,自愈比省事重要得多。故坚持方案 A。

---

## 并发保护

「升级进行中」标志(`AtomicBool` 或 watcher 任务内局部 `bool`):一旦触发 swap 即置位,在 `systemd-run --wait` 返回前不触发第二次。实际上一旦 swap 成功本进程就被 stop 了,标志主要防御「systemd-run 还没 stop 我、但下一轮 tick 又到了」的窗口。

---

## 已知风险与边界

- **⚠️ build = deploy footgun(PM 评审,已接受裸路径)**:监视裸 `target/release/zeromux` 时,**任何一次** `cargo build --release` —— 哪怕只是本地迭代、测试别的东西 —— 都会让 live server 在下次空闲时静默换上去。「我只是 build 来测一下」会**静默变成「我部署到生产了」**。已接受(本机通常只在打算部署时才跑 release build;sha 稳定门 + idle gate 收窄爆炸半径),但这是真陷阱:**若将来发现误触发,改用专用 release slot(`--watch-build /home/ubuntu/zeromux-release/zeromux`,部署 = 显式 `mv` 进去)即可恢复 build≠deploy 的意图边界。**
- **失败 build 的反复 churn(已接受,不做黑名单)**:坏 build 会每个空闲窗口触发「冒烟…」——但 E6 冒烟(`<watch> --help`)会先挡掉**进程能起但 --help 都跑不过**的坏 build(不进停服路径,零抖动);只有「冒烟过、但运行起来 health 不过」的 build 才会走到 swap→rollback(每轮一次抖动重启)。E3 backup 轮转保证不撑爆磁盘。churn 本身是响亮信号(反复重启 + 日志刷屏),不静默坏掉。**未来可选开关**:failed-hash 黑名单,trivial,需要时加。
- **cgroup self-kill(已解)**:binary 触发 swap 时和 deploy.sh 一样身处 `zeromux.service` cgroup,故必须 detached `systemd-run --service`,绝不能直接 `systemctl stop`。
- **自主 root 路径(E8,已解)**:auto-update 让 binary 能自主 `sudo systemd-run`。swap 脚本走 `bash -c` 内联、不落临时文件,消除 tmpfile 篡改→RCE 窗口。`AutoUpdateConfig` 的插值字段均来自受信启动 flag,非用户输入。
- **release slot 半写竞态(E5,已解)**:sha 连续两轮稳定才动手,避免 sha 到半写文件。
- **坏 build 进停服路径(E6,已解)**:stop 前先 `<watch> --help` 冒烟,坏 build 不造成本可避免的服务抖动。
- **scheduled-run 饿死(E1,已解)**:run_id Running turn 硬阻塞,`max_wait` 不穿透;调度运行有 30min 看门狗自我了断,等待有界,verdict 完整性不被破坏(collect C3 一致)。
- **全自动重启断会话(已接受)**:升级会重启进程 → 断所有会话。B-1 恢复持久会话的 scrollback,但 **in-flight 的 Running turn 会丢**。「等全 Idle 再升级」正是为消除这一点 —— 正常情况不切断任何正在跑的 turn;只有硬上限到时才可能切断(此时已等满 max_wait,视为可接受的让步)。
- **max_wait 永远等不到全 Idle**:若总有 agent 在忙,硬上限保证最终必升(默认 10min)。这是「等 Idle」与「升级不能无限拖」之间的取舍点。
- **sudo 前提**:`systemd-run` 需 sudo;live 进程以 `ubuntu` 跑、deploy.sh 已依赖 passwordless sudo,前提成立。非此环境(无 sudo)则 swap 失败、记日志、服务继续跑旧版(不崩)。
- **watch_path 不存在 / build 删除**:`stat` 失败 → 当轮跳过,不报错不崩。

---

## 可观测性(字段可诊断,对齐 titler 经验)

watcher 在每个决策点打 INFO 日志(titler 的教训:默认 INFO 下不能是黑盒):
- 启动:`auto-update enabled, watching <path>, self-sha=<8 chars>`
- 检测到新 build:`new build detected sha=<8> (self=<8>), entering pending state`
- sha 未稳定:`build sha changed, waiting for stable (anti half-write)`
- 等 Idle:`pending upgrade, interactive=N scheduled=M running, waiting`(节流,避免每 30s 刷)
- 被调度运行阻塞:`pending upgrade blocked by scheduled run(s), max_wait NOT applied`(E1 可见)
- 冒烟失败:`new build failed --help smoke, skipping swap (no service disruption)`(E6 可见)
- 触发:`upgradeable (idle or interactive max_wait reached), launching swap via systemd-run`
- swap 结果:由 detached service 的输出 + systemd-run `--pipe` 回传(本进程可能已被 stop,故结果主要看 `journalctl -u zeromux-selfupdate-*` 与新进程启动日志)
- 跳过/失败:`watch_path stat failed`、`build sha == self, no upgrade needed`

---

## 测试策略(goal-driven)

| 单元 | 测试 | 验证标准 |
|---|---|---|
| SHA256 计算 | 已知文件 → 已知 hash | 纯函数,文件 fixture |
| 升级判定 | self==watch 不触发;不同则进 pending | 纯函数 / 内存状态机 |
| **sha 稳定门(E5)** | 一轮 sha 变、下一轮再变 → 不动手;连续两轮同 → 才进 pending | 状态转移单测 |
| Idle gate 决策(E1) | `scheduled>0` → 阻塞且 max_wait **不**穿透;`scheduled==0 && interactive>0` 且超 max_wait → 强制;全 0 → 可升级;tmux Running 不计数 | 纯函数 `gate_decision(RunningSummary, elapsed, max_wait)` 可单测;`running_summary` mock 会话集合 |
| pending 状态机 | build 改回与 self 相同 → 清 pending;新 hash → 重锚 pending_since | 状态转移单测 |
| 并发保护 | swap 进行中第二次 tick 不重复触发 | 标志位单测 |
| swap 脚本生成 | 插值后字符串含正确 SERVICE/INSTALLED/PORT/WATCH_PATH;含 backup 轮转行(E3) | 字符串断言(纯函数 `render_swap_script(cfg) -> String`) |
| swap 执行 | 冒烟挡坏 build(E6,不进停服);health 失败 → rollback | 手动/集成(需 systemd 环境) |
| 端到端(手动) | 改 build → 观察 live:检测→sha 稳定→等 Idle(开 Running agent 验证阻塞;开调度运行验证 max_wait 不穿透 E1)→空闲后自动 swap→新版起来;给「--help 都跑不过」的坏 build → 观察冒烟挡下零抖动;给「health 不过」的坏 build → 观察 rollback + backup 只留 3 个(E3) | journald + 版本确认 + `ls /usr/local/bin/zeromux.bak-*` |

命令:`cargo test`、`cargo check`(release 慢,迭代用 debug)。

---

## 改动文件清单

| 文件 | 改动 |
|---|---|
| `src/auto_update.rs`(新) | `AutoUpdateConfig` + `RunningSummary` + `spawn_auto_updater` watcher 任务(检测循环 + sha 稳定门 E5 + Idle gate);可单测纯函数:SHA256 计算、`gate_decision`、`render_swap_script`(E3 backup 轮转)、pending 状态机;swap 经 `bash -c` 内联 detached systemd-run(E8),stop 前冒烟(E6) |
| `src/main.rs` | 新增 `--watch-build <path>`、`--auto-update-max-wait <secs>` flag;router 起来后若 watch-build 提供则 `spawn_auto_updater` |
| `src/session_manager.rs` | 新增只读访问器 `running_summary(&self) -> RunningSummary`(仅 agent 会话 Running 才计数,按是否携带 run_id 分 interactive/scheduled,tmux 跳过) |
| `zeromux.service`(live 单元,文档说明) | `ExecStart` 加 `--watch-build /home/ubuntu/.../target/release/zeromux`;部署文档记录开启方式 + **build=deploy 警告** |
| 前端 | **无改动** |

> systemd 单元的修改不在 repo 里(它在 `/etc/systemd/system/`);spec 仅说明上线时如何加 flag,实际改单元是部署动作。

---

## NOT in scope / 远期

- **GitHub Releases 轮询 + 异地分发**:naozhi 原型的完整形态。本期只做本机原地升级。需要多机/异地分发时再写 spec(那时才需要 download + 签名验证)。
- **三档 notify/download/auto**:本期单档全自动。若将来想要「检测到但等我手动点」,可加档位 + 前端提示(本期决策为静默全自动)。
- **failed-hash 黑名单**:见「已知风险」,trivial 的未来可选开关。
- **专用 release slot**:本期接受裸 `target/release` + build=deploy 警告。若误触发成为实际问题,改用 `--watch-build` 指向专用 slot(部署 = 显式 `mv` 进去)即可恢复意图边界——纯运维改动,无需改码。
- **前端可见性**:本期静默。将来若要「检测到新版/即将升级」横幅,加一个轻量事件 + 一行 UI。
