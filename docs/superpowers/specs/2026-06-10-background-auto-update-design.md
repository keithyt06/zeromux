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
| swap 机制 | **方案 A**:detached `systemd-run` 跑 swap(字节级复刻 deploy.sh `do_swap`,保留全部自愈/回滚能力) |
| swap 脚本来源 | **binary 内嵌**(自包含,live binary 不依赖 repo/deploy.sh 存在;逻辑随版本走) |
| tmux 是否阻塞 | **tmux PTY 不阻塞升级**(无 turn 概念;只看 agent 会话 Running) |
| 升级失败重试 | **不做 failed-hash 黑名单**(每轮都重试;churn 是响亮信号,见「已知风险」)。失败守卫记为未来可选开关 |
| 用户可见性 | **静默升级**,前端零改动,只靠 INFO 日志字段可诊断 |

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
3. `watch_sha == self_baseline_sha` → 当前 installed 就是这个 build,**无需升级**,清「待升级」状态(覆盖「build 又被改回与当前相同」的情况)。
4. `watch_sha != self_baseline_sha` → 进入/保持「待升级」状态,记录 `pending_since = now`(仅首次进入时锚定)。
5. 「待升级」状态下,每轮检查 Idle gate:
   - **全 Idle**(无任何 agent 会话 Running)→ 触发 swap。
   - **非全 Idle 但 `now - pending_since >= max_wait`** → 硬上限到,**强制**触发 swap。
   - 否则继续等下一轮。

> **时间来源**:轮询用 `tokio::time::interval`;`pending_since` 用 `tokio::time::Instant`(单调钟,不受墙钟跳变影响)。不引入 `chrono` 依赖。

### Idle gate 判定

`SessionManager` 已有 `TurnState{Idle,Running}` + `mark_turn` + per-session turn 状态(B-2)。新增一个只读访问器:

```rust
// SessionManager
pub fn any_agent_running(&self) -> bool;
```

遍历会话,**仅** Claude/Kiro/Codex 类型且 `TurnState == Running` 才算「忙」。**Tmux 会话跳过**(无 turn 概念,不阻塞升级)。`!any_agent_running()` 即「全 Idle」。

---

## swap 执行(方案 A)

触发后:

1. 置「升级进行中」标志(并发保护,见下)。
2. 把**内嵌的 swap shell 脚本**写到临时文件(`std::env::temp_dir()/zeromux-selfupdate-<pid>.sh`)。
3. `sudo systemd-run --wait --pipe --collect --quiet --unit=zeromux-selfupdate-<pid> bash <tmpfile> <watch_path>`
   - transient service 由 PID 1 拥有,在 `system.slice` 自己的 cgroup 里 —— `systemctl stop zeromux` **够不到它**(这正是 deploy.sh 验证过的 cgroup 逃逸,binary 触发时面临完全相同的 self-kill 陷阱,解法相同)。
   - `--service` 而非 `--scope`(scope 会留在调用者 cgroup 里被一起杀,deploy.sh 已实证)。
4. swap 脚本会 `systemctl stop zeromux` —— **本进程在此刻被 systemd 终止**。这是预期的:旧进程的使命到此结束。systemd 随后 start 新 binary。
5. 若 swap 脚本 health-check 失败 → 它自己 rollback 到旧 binary 并 start —— 服务恢复旧版运行(本进程已死,但 rollback 由 detached service 完成,不受影响)。

### 内嵌 swap 脚本

字节级复刻 `deploy.sh` 的 `do_swap`,作为 Rust 字符串常量内嵌。接收 `$1 = built_path`,内部 `INSTALLED`/`SERVICE`/`HEALTH` 由脚本顶部变量定义(从 systemd-run 命令行参数或脚本内常量传入):

```bash
set -euo pipefail
SERVICE="zeromux"
INSTALLED="/usr/local/bin/zeromux"
HEALTH="http://127.0.0.1:<PORT>/"
BUILT="$1"
backup="${INSTALLED}.bak-$(date +%Y%m%d-%H%M%S)"
cp "$INSTALLED" "$backup"
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

> `SERVICE`/`INSTALLED`/`PORT` 这些值在 binary 内嵌时用 `AutoUpdateConfig` 的字段做字符串插值后写入临时文件,避免脚本内硬编码与 config 漂移。`sudo` 由 systemd-run 整条命令带,前提是 passwordless sudo(deploy.sh 已依赖,live 主机已配)。

### 为什么不退而求其次用 rename + 干净退出

`rename()` 替换运行中 binary 在 Linux 是允许的(不像 `cp` 的 text-busy),诱人但**丢掉 health-check + auto-rollback**——而回滚是 deploy.sh 存在的全部意义、502 痛点的解药。全自动无人值守场景下没人盯着,自愈比省事重要得多。故坚持方案 A。

---

## 并发保护

「升级进行中」标志(`AtomicBool` 或 watcher 任务内局部 `bool`):一旦触发 swap 即置位,在 `systemd-run --wait` 返回前不触发第二次。实际上一旦 swap 成功本进程就被 stop 了,标志主要防御「systemd-run 还没 stop 我、但下一轮 tick 又到了」的窗口。

---

## 已知风险与边界

- **失败 build 的反复 churn(已接受,不做黑名单)**:坏 build 会每 30s 触发「试→health 失败→rollback」。但方案 A 的 auto-rollback 每轮都让服务回到旧 binary 运行 —— **不是宕机,是每 30s 抖动一次重启**(会断当前会话)。直到修好 build 或删改 built 文件。churn 本身是响亮信号(服务反复重启 + 日志刷屏),不会静默坏掉。**未来可选开关**:记录 failed-hash,对同一失败 hash 不再重试,直到出现不同 hash 才解禁 —— trivial,需要时加。
- **cgroup self-kill(已解)**:binary 触发 swap 时和 deploy.sh 一样身处 `zeromux.service` cgroup,故必须 detached `systemd-run --service`,绝不能直接 `systemctl stop`。
- **全自动重启断会话(已接受)**:升级会重启进程 → 断所有会话。B-1 恢复持久会话的 scrollback,但 **in-flight 的 Running turn 会丢**。「等全 Idle 再升级」正是为消除这一点 —— 正常情况不切断任何正在跑的 turn;只有硬上限到时才可能切断(此时已等满 max_wait,视为可接受的让步)。
- **max_wait 永远等不到全 Idle**:若总有 agent 在忙,硬上限保证最终必升(默认 10min)。这是「等 Idle」与「升级不能无限拖」之间的取舍点。
- **sudo 前提**:`systemd-run` 需 sudo;live 进程以 `ubuntu` 跑、deploy.sh 已依赖 passwordless sudo,前提成立。非此环境(无 sudo)则 swap 失败、记日志、服务继续跑旧版(不崩)。
- **watch_path 不存在 / build 删除**:`stat` 失败 → 当轮跳过,不报错不崩。

---

## 可观测性(字段可诊断,对齐 titler 经验)

watcher 在每个决策点打 INFO 日志(titler 的教训:默认 INFO 下不能是黑盒):
- 启动:`auto-update enabled, watching <path>, self-sha=<8 chars>`
- 检测到新 build:`new build detected sha=<8> (self=<8>), entering pending state`
- 等 Idle:`pending upgrade, N agent(s) running, waiting`(节流,避免每 30s 刷)
- 触发:`all idle (or max_wait reached), launching swap via systemd-run`
- swap 结果:由 detached service 的输出 + systemd-run `--pipe` 回传(本进程可能已被 stop,故结果主要看 `journalctl -u zeromux-selfupdate-*` 与新进程启动日志)
- 跳过/失败:`watch_path stat failed`、`build sha == self, no upgrade needed`

---

## 测试策略(goal-driven)

| 单元 | 测试 | 验证标准 |
|---|---|---|
| SHA256 计算 | 已知文件 → 已知 hash | 纯函数,文件 fixture |
| 升级判定 | self==watch 不触发;不同则进 pending | 纯函数 / 内存状态机 |
| Idle gate | 注入有 Running agent → false;全 Idle → true;tmux Running 不算忙;`pending_since` 超 max_wait → 强制 true | `any_agent_running` + gate 决策可单测(mock 会话集合) |
| pending 状态机 | build 改回与 self 相同 → 清 pending;新 hash → 重锚 pending_since | 状态转移单测 |
| 并发保护 | swap 进行中第二次 tick 不重复触发 | 标志位单测 |
| swap 脚本 | 复用 deploy.sh 已验证逻辑;health 失败 → rollback | 手动/集成(需 systemd 环境);脚本生成的字符串可断言含正确 SERVICE/INSTALLED/PORT |
| 端到端(手动) | 本机改 build → 观察 live:检测→等 Idle(开个 Running agent 验证阻塞)→空闲后自动 swap→新版起来;故意给坏 build → 观察 rollback + churn 日志 | journald + 版本确认 |

命令:`cargo test`、`cargo check`(release 慢,迭代用 debug)。

---

## 改动文件清单

| 文件 | 改动 |
|---|---|
| `src/auto_update.rs`(新) | `AutoUpdateConfig` + `spawn_auto_updater` watcher 任务(检测循环 + Idle gate + 内嵌 swap 脚本 + detached systemd-run);SHA256 计算、升级判定、状态机为可单测单元 |
| `src/main.rs` | 新增 `--watch-build <path>`、`--auto-update-max-wait <secs>` flag;router 起来后若 watch-build 提供则 `spawn_auto_updater` |
| `src/session_manager.rs` | 新增只读访问器 `any_agent_running(&self) -> bool`(仅 agent 会话 Running 才算忙,tmux 跳过) |
| `zeromux.service`(live 单元,文档说明) | `ExecStart` 加 `--watch-build /home/ubuntu/.../target/release/zeromux`;部署文档记录开启方式 |
| 前端 | **无改动** |

> systemd 单元的修改不在 repo 里(它在 `/etc/systemd/system/`);spec 仅说明上线时如何加 flag,实际改单元是部署动作。

---

## NOT in scope / 远期

- **GitHub Releases 轮询 + 异地分发**:naozhi 原型的完整形态。本期只做本机原地升级。需要多机/异地分发时再写 spec(那时才需要 download + 签名验证)。
- **三档 notify/download/auto**:本期单档全自动。若将来想要「检测到但等我手动点」,可加档位 + 前端提示(本期决策为静默全自动)。
- **failed-hash 黑名单**:见「已知风险」,trivial 的未来可选开关。
- **前端可见性**:本期静默。将来若要「检测到新版/即将升级」横幅,加一个轻量事件 + 一行 UI。
</content>
</invoke>
