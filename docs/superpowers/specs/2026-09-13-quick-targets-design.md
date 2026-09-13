# Quick Targets — 常用目录/笔记 frecency 快速入口 — 设计

日期：2026-09-13（2026-09-13 二次修订：纳入两条新约束 + CTO/PM 交叉 review）
状态：已确认，实现计划见 `docs/superpowers/plans/2026-09-13-quick-targets.md`

## 修订记录

**v2（本版）** —— 用户追加两条约束，并经 CTO（技术）+ PM（产品）交叉 review。
两位 reviewer 的关键结论均已由本人 grep/实测复核（本 repo 历史教训：reviewer 常
方向对而细节编造，故一律不采信未核实的断言）。

新约束：
1. 「更新频率不要静态，基于用户的操作」→ 引入事件驱动刷新（见「刷新时机」一节）。
   **原设计确有此缺陷**：`QuickTargets` 只在挂载时 GET 一次，而三个入口中有两个是
   长命组件（`VaultReader` 在 `App.tsx:396` 常驻 + `hidden` 不 unmount），会一直
   显示挂载时的快照。
2. 「kiro / codex / claude code / obsidian 都要有入口」→ 见「四个目的地」一节。
   **原设计确有此缺陷**：每行只存一个 `last_agent`，同一目录用三个 agent 时只有
   最后一个能一击直达。

v2 相对 v1 的实质改动（每条都附理由）：
- **砍掉 pin 全套**（端点 + 行内按钮 + 「不占名额」规则）。见「为何砍掉 pin」。
- **Top5 是显示上限，表里不删行**。见「Top5 的落点」。
- **行的身份从 `path` 改为 `(path, agent)`**，一目录多 agent 各占一行。
- **砍掉 `is_git` 徽标**。纯装饰，却是 per-row 文件系统 `exists()` 的一半成本，
  且就落在「零慢 FS 操作」这个卖点的关键路径上。
- **砍掉 Sidebar `pick-dir` 顶部的嵌入**（保留 `DirectoryPicker` 那一份）。
- **hover-only 控件全部改掉**，改为「整行主目标 + 一个 `⌄` 行级操作单」。
- **手机上弹层不再用 224px**。
- **首屏合并笔记行 + 显式 Obsidian 入口**。
- **读出时的守卫循环包进 `spawn_blocking`，候选上限 50 → 16**。
- **`DELETE` 改用 query param**（不带 JSON body）。

## 背景

New Session 选目录当前是「一层层点」：`Sidebar.tsx` 的 `pick-dir` step 每进一层触发一次
`GET /api/directories`，而该请求在 JuiceFS/S3 后端上带 8s abort（`Sidebar.tsx:126-131`
的注释即为此前踩坑记录）。

实测路径成本 —— 开一个 `~/s3-workspace/keith-space/github-search/ai/zeromux` 的 agent 会话：

- 点 5 次（`s3-workspace` → `keith-space` → `github-search` → `ai` → `zeromux`）
- 等 5 次慢列目录
- 再点「使用此目录」→ 选 agent 类型 → 过 prompt 页

手机是唯一的常用终端（见项目 CLAUDE.md 的 cgroup 自杀陷阱一节），这个成本每天付多次。

Obsidian 侧已有「最近打开」（`vault.ts` 的 `zmx-vault-recent` + `VaultReader.tsx:121`），
但有三个缺陷：仅存 localStorage（换设备/清缓存即失忆）、只有 recency 没有频次、
列表显示 `p.split('/').pop()` 导致同名笔记无法分辨（vault 里 `_index.md` 不止一个）。

**目标不是「加个排序」，而是「一击直达 + 零次列目录请求」。**

## 需求与语义拆分

用户原话含两个**不同**诉求，必须由两个机制分别承载，不能让一个硬扛：

| 用户说法 | 语义 | 承载机制 |
|---|---|---|
| 「我有一些常见的目录」 | 稳定的那几个 | frecency 稳态分数自然把它们顶在前（见下） |
| 「经常使用的目录」 | frequency | frecency 的 hits 累积 |
| 「根据最新使用的进行排序」 | recency | frecency 的时间衰减 |
| 「基于用户的操作」（v2 新增） | 列表随行为实时重排，非静态快照 | 事件驱动刷新（见「刷新时机」） |
| 「只保留 Top5」（v2 新增） | 可见条数恰好 5 | 显示上限（表里不删行，见「Top5 的落点」） |

纯 recency 的坏处：昨天误点一次的目录把天天用的挤出 Top5。
纯 frequency 的坏处：新项目永远上不了榜。
→ 取 frecency（zoxide / Firefox awesomebar 那一族）。

## 核心抽象：一张表，两种 kind

一个概念 **「我常去的地方」**（quick target），目录与 vault 笔记是它的两种实例，
共用存储、评分、API 形状、前端组件。

理由（反面教训）：本 repo 已经存在**两份**几乎相同的目录浏览器实现
（`Sidebar.tsx` 内联的 `pick-dir` + 独立组件 `DirectoryPicker.tsx`）。
不能再加第三份并行代码。

### 表结构

新文件 `src/quick_targets.rs`，模式照抄 `session_store.rs`
（`Mutex<Connection>` + `open(data_dir)` + `CREATE TABLE IF NOT EXISTS`）。

```sql
CREATE TABLE IF NOT EXISTS quick_targets (
  user_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,          -- 'dir' | 'note'
  path        TEXT NOT NULL,          -- dir: 绝对路径; note: vault 相对路径
  agent       TEXT NOT NULL DEFAULT '', -- dir: 'claude'|'kiro'|'codex'|'tmux'; note: ''
  hits        INTEGER NOT NULL DEFAULT 0,
  last_ms     INTEGER NOT NULL,       -- 最近一次使用（epoch ms）
  score_raw   REAL    NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, kind, path, agent)
);
CREATE INDEX IF NOT EXISTS idx_qt_lookup ON quick_targets(user_id, kind, last_ms DESC);
```

### 为何 `agent` 进主键，且必须 `NOT NULL DEFAULT ''` 而不是可空

**进主键**：v1 每行只有一个 `last_agent`，被最新一次 bump 覆盖。后果是同一目录用
三个 agent 时只有最后一个能一击直达，且**行上的标签会自己变**——今天在 zeromux 用
一次 codex，明天那行就从「Claude」变成「Codex」，一击直达的结果跟着变。在一个宣称
「一击直达」的界面里，行为不可预测的代价高于省下的点击。

改为 `(path, agent)` 后：每个「目录 + agent」组合是独立一行、独立累积 frecency、
自描述且稳定。用户约 6-8 个目录 × 约 2 个常用 agent ≈ 12 个组合，取 Top5 仍是 5 行。
这同时满足了新约束 2 的两种读法（「每个 agent 都能用这个列表」与「一份列表能通向
四个目的地」），不需要两套 UI。

**必须 `NOT NULL DEFAULT ''`**：已实测——SQLite 允许 PRIMARY KEY 列为 NULL，且
`NULL != NULL`，所以若 `agent` 可空，`kind='note'`（无 agent 概念，恒为空）**每打开
一次笔记就插一行**：

```
NULL agent 连插 3 次 → 3 行   ← PK 形同失效，note 的 frecency 直接报废
空串 agent 连插 3 次 → 1 行   ← 空串是真值，PK 正常去重
```

用空串作 note 的 agent 值，比为此新增一张侧表更简单，且不需要在 schema 里编码
「note 没有 agent」这个特例。

**落库位置：`~/.zeromux/zeromux.db`**（与 `sessions` 同库；`notes`/`prompts` 各自独立 db 文件，
本表跟随 `session_store` 的同库约定）。

**无条件开启，不依赖 OAuth 模式。** 已核实 `auth.rs:33` 的 `CurrentUser::legacy()` 其
`id` 为固定字符串 `"legacy"` —— 稳定，故 `user_id` scope 在 legacy 与 OAuth 两种模式下
都成立。本表属于「总是开」的存储（同 `SessionStore`），不是仅 OAuth 才开的 `Database`。

### 评分公式（指数半衰期）

```
首次插入：  score_raw = 1.0,  hits = 1,  last_ms = now
再次 bump： score_raw = score_raw * 0.5^((now - last_ms)/HALF_LIFE) + 1.0
            last_ms   = now
            hits     += 1
读取（排序）：score    = score_raw * 0.5^((now - last_ms)/HALF_LIFE)

HALF_LIFE = 14 天，以毫秒表示（14*24*3600*1000）。
now / last_ms 同为 epoch ms，指数的分子分母单位一致。
```

首次插入不套用衰减式（没有前一个 `last_ms` 可衰减），直接置 `score_raw = 1.0`。

选指数衰减而非 zoxide 的分桶（今天×4 / 本周×2 / 本月×0.5）：分桶会在跨桶边界产生
排序跳变（同一目录昨天第 1、今天不动却掉到第 4）。指数衰减连续、无跳变。

一次 bump 只更新一行；衰减在**读取时**计算 —— 不需要后台衰减任务，也不需要周期性重写全表。

**衰减计算在 Rust 中进行，不在 SQL 中。** 已核实 `Cargo.toml:26` 为
`rusqlite 0.31 features=["bundled"]`，bundled SQLite 默认不带 `pow()`（repo 内零处 `pow` 用法）。
为省几行 Rust 而开 math 扩展 feature 或注册自定义 SQL 函数，是不划算的构建依赖。
→ SQL 只取候选：`WHERE user_id=? AND kind=? ORDER BY last_ms DESC LIMIT 16`，
评分与排序在 Rust 内完成（纯函数，可单测）。

**候选上限 16（v2 从 50 下调）**：上限的真正约束不是内存，而是**读出时每行都要付一次
文件系统守卫**（JuiceFS 上实测约 20ms/行，见「读取成本」）。为返回 5 行而校验 50 行是
10× 浪费；16 给了足够的冗余（坏行被剔除后仍够凑满 5 条），最坏成本约 320ms 且已挪进
`spawn_blocking`。

### 为何砍掉 pin（v2 决定，推翻 v1）

v1 设计了 `pinned` 手动置顶，理由是「常见目录」是用户显式声明的、不该跟算法竞争。
v2 砍掉它，三个理由：

**1. 与新约束 1 冲突。** 「只保留 Top5」若 pin 不占名额，这个上限就不成立
（pin 4 个 = 9 行）。

**2. 在本用户的真实规模上收益趋近于零。** 按本 spec 的公式算稳态分数
（`1/(1-0.5^(1/间隔天数×14))`）：

| 使用频率 | 稳态 score |
|---|---|
| 每天用 | ≈ 20.7 |
| 每周 2 次 | ≈ 5.5 |
| 每周 1 次 | ≈ 3.1 |
| 两周 1 次 | ≈ 2.0 |

用户的目标集是「几个客户目录 + 一个 workshop + 一个研究仓库 + 一个 vault」约 6-8 个。
日常集（20.7 / 5.5）与偶发集（2.0）被清楚分层——**frecency 自己就能稳定把他想 pin 的
那几个顶在 Top5**，手动 pin 的边际价值≈0。

**3. 成本却很高。** pin 是 224px 行里两个 16px 图标的来源，是 hover-only 触屏失效的
重灾区（见「手机可用性」），也是「可见高度无上限」的来源。用一个近零收益的机制换掉
整行版式的可用性，不划算。

若日后 frecency 实际排序不符预期，再加 pin 是向后兼容的（加一列 + 一个端点）。
先不做（YAGNI）。

### Top5 的落点：显示上限，表里不删行

「只保留 Top5」有两种可能落点，这里明确取前者：

- ✅ **只显示 5 条**（`rank` 里 `truncate(TOP_N)`）
- ❌ 表里只存 5 行、挤出即删

**为何不能表里只存 5 行**：挤出即清零累积分，会产生自毁式的正反馈环。设 A 稳定第 6 名
（`score_raw` 已累积到 8.0）。某天偶发用一次 B，B 挤掉 A，**A 的 8.0 归零**。第二天回去
用 A，A 从 1.0 重新开始——它现在是榜外新人，又会被下一个偶发目标挤掉。
**长期常用但暂时不在 Top5 的目标永远无法回榜**——而这恰恰是本设计选 frecency 而非纯
recency 的理由（见上文「纯 recency 的坏处」）。表里只存 5 行等于把纯 recency 的病重新
引入到一个专门为治它而设计的 frecency 之上。

**存储成本不构成理由**：一行约 100 字节，积累几百个目标也就几十 KB——相比既有的
`SCROLLBACK_MAX_BYTES = 2MB`（**每个** session）是噪声。

真正需要上限的是**读取路径**（per-row 守卫的文件系统 IO），已由 `CANDIDATE_LIMIT`
解决。用户想删单条有 `forget`（行级操作单里的「从列表移除」）——那是**显式**动作，
不是算法挤出。

（若日后确实担心表无界增长，正确机制是**基于分数的 GC**（`decayed_score < 0.01`
即约 90 天未访问的行可删），而非基于排名的挤出：前者删的是真的死掉的行，不破坏
frecency 语义。现在不做。）

## 记录时机：只在「用户真的去了那里」时 bump

这是最容易做错的地方。原则：**绝不在「用户路过」时记。**

| 事件 | 记录 | 落点 |
|---|---|---|
| 交互式创建 **agent** session 成功 | ✅ `kind=dir`, `agent=claude\|kiro\|codex` | `web.rs:create_session`（`web.rs:395`）成功分支 |
| 交互式创建 **tmux** session 成功 | ✅ `kind=dir`, `agent=tmux` | 同上 |
| **attach 既有 host tmux**（`tmux_target.is_some()`） | ❌ | 见下 |
| 打开 vault 笔记**成功** | ✅ `kind=note`, `agent=''` | `web.rs:vault_file`（`web.rs:3448`）成功分支 |
| 目录浏览器进入某层 | ❌ | 路过 ≠ 使用 |
| `pick-dir` 点「使用此目录」 | ❌ | 必然导向创建 session，在那里记即可，避免双计 |
| **定时任务**创建的 session | ❌ | 见下 |
| session 创建失败 | ❌ | 只在 `Ok` 分支记 |

### 为何 attach 既有 tmux 不记

`create_session`（`web.rs:409-411`）里 `tmux_target.is_some()` 是 admin-gated 的
「attach 到既有 host tmux 会话」分支。这条路径上用户**没有选目录**——`work_dir` 走的是
`req.work_dir.unwrap_or_else(|| state.work_dir.clone())`（`web.rs:413`）的兜底值，
线上即 systemd unit 的 `--work-dir /home/ubuntu`。记它等于往榜上插一条用户从未选择过的
`~`。

**注意 `agent='tmux'` 是刻意保留的**（不是当作「无类型」）：在某目录开一个终端确实是
「用户真的去了那里」，且 `(path, 'tmux')` 是独立一行，不会污染同目录的
`(path, 'claude')`。v1 的做法（单个 `last_agent` 被 `COALESCE` 覆盖）才是问题所在：
在某目录开一次终端，会把该行的 `last_agent` 从 `claude` 改写成 `tmux`，于是首屏那行
标着「Claude」却一击开出 bash。复合主键从结构上消除了这个类别。

### 为何排除定时任务

已核实定时任务经 `session_manager.rs:1090` 的 `create_acp_session_tagged` 创建，
带 `source_task_id`。若不排除，凌晨 cron 会连续数周把某目录刷成榜首，而用户本人从未
手动开过它 —— frecency 被机器人污染。

**排除方式（结构性，非条件判断）**：bump 只写在 `web.rs` 的 HTTP handler
`create_session` 内，**不**下沉到 `session_manager` 的 create_* 方法。已核实
`create_pty/acp/kiro/codex_session` 的唯一调用方就是 `web.rs:436-455`，而定时任务走
`create_acp_session_tagged` 这条独立路径。把 bump 放在 HTTP handler 层，
「非交互路径不会记录」就是**架构保证**而不是一行容易在重构中丢失的 `if`。

### 记录 `work_dir` 而非 `effective_dir`

必须记用户提交的 `work_dir`（`web.rs:413`），**不是** `resolve_work_dir` 之后的
`effective_dir`。开启 `--worktree-isolation` 时后者是 `.zeromux-worktrees/<short-id>/`
这类一次性路径，记它等于记垃圾（且下次点击必然失效）。

### best-effort，永不阻塞主流程

bump 失败只 `logger` 记录，**不**让 session 创建 / 笔记打开返回 5xx。
一个「记住我去过哪」的功能没有资格让核心功能失败。

## 刷新时机：事件驱动，非静态快照（新约束 1）

**v1 的缺陷（真实存在，不是假想）**：`QuickTargets` 只有一个 `useEffect(() => { load() }, [load])`，
而 `load` 的依赖只有 `kind`（常量）——**整个生命周期只 GET 一次**。三个入口里：

- New Session 首屏：popover 在 `step !== 'closed'` 时才渲染，每次开都 remount → 凑巧是新鲜的
- `DirectoryPicker`：长命
- `VaultReader`：**常驻挂载**（`App.tsx:396` 用 `docTabs.map` + `hidden` class 切换可见性，
  刻意不 unmount 以保留滚动状态）→ 会一直显示挂载时的快照

所以用户连开 3 篇笔记，Obsidian 里那个列表的顺序不会变。这正是「静态」。

### 方案：模块级订阅（`quickTargetsBus`）

新文件 `frontend/src/lib/quickTargetsBus.ts`（约 12 行）：一个 `Set<() => void>` +
`notifyQuickTargetsChanged()` + `subscribeQuickTargets(fn)`。`QuickTargets` 挂载时订阅，
收到通知即重新 `load()`（`load` 已有 `reqRef` 守卫，故并发的 notify + mount fetch 交织安全）。

**发射点必须精确镜像后端的两处 bump**，一一对应：

| 后端 bump | 前端发射点 |
|---|---|
| `web.rs:create_session` 成功分支 | `App.tsx:handleCreate` 的 `await createSession(...)` **之后** |
| `web.rs:vault_file` 成功分支 | `VaultReader.openNote` 的 `.then()` 内、`openReqRef` 守卫**之后** |

这个对称性是要点：发射点多于 bump 点 → 刷新了但数据没变（白付 IO）；少于 bump 点 →
数据变了但列表陈旧（就是 v1 的病）。

### 否决的其他方案

| 方案 | 否决理由 |
|---|---|
| props `refreshKey` 计数器 | 要从 `App` 穿到 `Sidebar → QuickTargets`、`FileBrowser → DirectoryPicker`、`ScheduledTasksPanel → DirectoryPicker`、`VaultReader → QuickTargets` —— 4 条穿透链，每加一个入口再穿一次。直接违背本 spec「一份实现多处复用」的核心主张。 |
| 后端 WS 推送 | `session_manager` 的 broadcast 是 **per-session** 的（`event_tx`/`input_tx`），没有用户级全局通道，要新建一个。而这是单用户单服务端场景（见非目标「跨设备同步冲突」），跨设备实时性不是需求。 |
| 轮询 | 每次轮询都付读出守卫的 per-row 文件系统 IO 成本。见下「读取成本」。 |
| React Context / 全局 store | 比模块级 bus 重（需 Provider 包裹全部消费者），而 `DirectoryPicker` 出现在 `FileBrowser` 的 `fixed inset-0 z-50` 浮层里。收益为零。 |

### 读取成本：这是事件驱动的前置条件

实测 JuiceFS 上每行守卫约 **20ms**（`canonicalize` 约 10ms + `.git` 存在性检查约 10ms）。
v1 的 `CANDIDATE_LIMIT = 50` 意味着最坏 **约 1 秒同步阻塞在一个 tokio worker 上**，
而首屏改成 `step='quick'` 后**每次点 ＋ 都先付这 1 秒**。事件驱动刷新会把这个成本
乘以刷新频率，所以下面三条是本方案的**前置条件，不是可选优化**：

1. 守卫循环整体包进 `tokio::task::spawn_blocking`（不占 tokio worker）
2. `CANDIDATE_LIMIT` 从 50 降到 **16**（只为返回 5 行而校验 50 行是 10× 浪费；
   50 这个数字原本是为「防表膨胀」，但表膨胀的代价是线性 IO 而非内存）
3. **砍掉 `is_git`**：它占成本的一半，却只用于选一个图标。行首图标改为显示 agent
   品牌图标（信息量更高：这行会开出什么），`is_git` 直接不要。

## 四个目的地：kiro / codex / claude code / obsidian（新约束 2）

先厘清一处语义：**kiro / codex / claude code 不是三个「入口面」，而是同一个入口
（New Session）里的三个 `SessionType` 值**（`Sidebar.tsx:473-528` 的 `pick-type` 是一个
统一类型选择器）。**obsidian 才是第四个独立面**。所以约束 2 实际是两件事：

### (A) 一份列表要能通向全部四个 —— 靠复合主键满足

行的身份是 `(path, agent)`，所以同一目录用三个 agent 就是三行，各自一击直达、各自
独立累积 frecency、标签稳定不漂移。`kind='note'` 的行通向 Obsidian 阅读器。

### (B) Obsidian 必须提上来，而 v1 把它压下去了 —— 必修

三个叠加的问题（全部已核实）：

1. **`'vault'` 永远不经过 `create_session`**：`App.tsx:240-244` 里 `type === 'vault'` 在
   前端直接 `newDocTab` 后 `return`，**不调 `createSession`**。所以 `agent` 永远不可能是
   `vault`，Obsidian 永远不会出现在 dir 榜上。
2. **入口从 2 tap 退化为 3 tap**：今天开 Obsidian 是 ＋ →「Obsidian 文档」
   （`Sidebar.tsx:516-527`）；按 v1 的 Task 6 改完，它被埋到「其他目录…」之后。
   约束 2 要求提上来，v1 却压下去了。
3. **笔记榜只在 `VaultReader` 内部、且仅 `cwd === ''` 时出现** —— 从 New Session 侧
   完全看不到笔记。

**修**：首屏合并渲染，且给 Obsidian 一个显式保底入口：

```
＋ 新建会话
──────────────────────────────
[C] zeromux                    ⌄     ← 行首图标即 agent（Claude）
    ~/…/github-search/ai              ← hint 独占第二行
[X] keith-space                ⌄     ← Codex
    ~/s3-workspace
[◆] 考研英语 · _index          ⌄     ← 笔记行（kind=note）
    projects/long-term
──────────────────────────────
📁 其他目录…                          ← 兜底：原 类型 → 目录 流程
📓 Obsidian 笔记库                    ← 显式保底，确保不退化
```

目录行与笔记行**混在同一个 Top5 里**（本 spec 的核心抽象「我常去的地方」本就统一），
而非两块分开的榜。

### 不做：全局 quick switcher（v2 的候选，非本次范围）

「我正在一个 kiro 会话里，不回侧栏就跳到常用目录/笔记」是一个合理且对手机用户价值更高
的形态，但用户这次没提。本次把 `QuickTargets` 设计成对「挂在哪」无知的组件，将来做
switcher 只是接线（挂到 `SessionInfoBar` 的图标条或全屏 sheet），不需要重设计，
**也不需要第三套目录浏览器**（本 spec 开头的反面教训依然适用）。

## 手机可用性：hover-only 控件在手机上是隐形按钮

这是本次 review 抓到的最严重的产品缺陷，且**已在构建产物中验证**。

Tailwind v4 把 `group-hover:opacity-100` 编译为：

```css
@media (hover:hover){ .group-hover\:opacity-100:is(:where(.group):hover *){opacity:1} }
```

（实测自 `frontend/dist/assets/index-*.css`。）手机是 `hover: none` → **整条规则不生效**，
元素永久停在 `opacity: 0`。而 `opacity: 0` **不移除命中测试**——元素照样接收点击。

所以 v1 的行内控件在用户的**主设备**上是这样的：

| 控件 | v1 写法 | 手机实际表现 |
|---|---|---|
| `▸` 改 agent 类型 | `opacity-0 group-hover:opacity-100` | 永久隐形但可点。而它是 v1 指定的「要带 prompt 就走 ▸」的**唯一逃生口** |
| `×` 移除 | 同上 | 永久隐形、可点、**无确认**，且距主目标中心仅 20px |
| pin | 未 pin 时 `opacity-0 group-hover:…` | 未 pin 图标隐形 → **手机上永远无法 pin**；已 pin 的实心图标可见 → 可取消。方向错的单向门 |

（顺带记录：这个模式**已经在仓库里生产**——会话列表删除 `Sidebar.tsx:429`、doc tab 关闭
`Sidebar.tsx:450` 同样 hover-gated。本 spec 不修它们（不在范围内），但这意味着
「误建了会话想删掉」这条恢复路径在手机上本来就是断的，所以本设计**不能**依赖它兜底。）

### 版式设计

**根因先修**：新建会话弹层硬编码 `w-56` = 224px（`Sidebar.tsx:472`，且 `798`/`837` 两处
同样），**不随 `mobile` 变化**——虽然侧栏面板本身是 `mobile ? 'w-64' : 'w-56'`
（`Sidebar.tsx:320`）。手机上侧栏已是全屏遮罩，却把内容塞进 224px 浮层。
改为随 mobile 变宽（如 `mobile ? 'w-[calc(100vw-1rem)]' : 'w-56'`）——**一行改动，
整个宽度危机消失**，且顺带缓解既有的 `pick-dir`/`pick-prompt` 拥挤。

**为什么 224px 塞不下 v1 的行**（按 v1 的 class 实算）：

```
弹层                      224px
- pr-1 + gap-1×3 + 3 个 16px 图标按钮   64px
- 主按钮 px-3 + 13px 图标 + gap-2×3     61px
────────────────────────────────────
文字总预算                 99px  ← display + hint + agent 标签 三者共享
  "CLAUDE" (10px uppercase)  ≈ 44px
  "zeromux" (text-xs)        ≈ 48px
  hint 剩余                  ≈  7px  → 渲染成一个 "…"
```

**`hint` 唯一的存在理由是消歧**（vault 里多个 `_index.md` 必须靠父目录区分），
**却在它专为之设计的屏幕上被截成零**。这不是紧，是自我否定。

触控上：三个 16px 目标、中心距 20px。Apple HIG 44pt / Material 48dp 的最低标准下
16px 只有 **36%**；主按钮 `py-1.5` 行高约 28px，**主目标本身也不达标**。

**v2 行版式**：

```
┌────────────────────────────────────────┐  行高 ≥ 48px（v1 约 28px）
│  [C]  zeromux                      ⌄   │  第 1 行：agent 图标 + 名称 + 一个 ⌄
│       ~/…/github-search/ai              │  第 2 行：hint（10px，中段省略）
└────────────────────────────────────────┘
        ↑ 整行 = 主目标（一击创建）      ↑ 32×44px 副目标
```

1. **整行是唯一主目标**：`min-h-[48px]`，点击 = 用该行的 agent 直接创建。
2. **右侧只留一个 32×44px 的 `⌄`**，点开**行级操作单**（一次点击进入下一层，不靠 hover）：
   - 换 agent 类型 →
   - 带 prompt 打开
   - 从列表移除 ← 破坏性操作下沉一层，这一层本身即确认

   这一个改动同时解决：三个隐形控件、三个 16px 目标、v1 缺失的「带 prompt」触屏入口、
   以及 `×` 常驻席位。
3. **`hint` 独占第 2 行**：预算变为 224 − 24 − 21 − 44 ≈ **135px**，
   `~/…/github-search/ai` 在 10px 下约 90px，**放得下**。用**中段省略**（保留末 2 段，
   那才是消歧信息），非尾部截断。
4. **行首用 agent 品牌图标**（`SessionTypeIcon` 已存在于 `Sidebar.tsx:68-76`）：
   14px 图标替掉约 44px 的 `CLAUDE` 文本，省出的宽度给名称和 hint，且「这行会开出什么」
   变成第一眼可见。
5. **高度核算**：48×5 + 头部 28 + 两个兜底入口 88 ≈ **356px** 底部弹层，手机可接受。
   （若保留 pin 且不占名额，最多 9 行 ≈ 460px 会溢出——这是「Top5 是总上限」
   在版式上的独立证据。）

### 另外三处必修的交互缺陷

1. **空列表时首屏直接渲染 `pick-type`**。`QuickTargets` 空列表返回 `null`，所以全新库
   点 ＋ 只会看到一个标题加一行「其他目录…」——**比今天的 5 项类型菜单更差**。
2. **列表预留高度/骨架行**。`loaded` 前返回 `null` → 弹层从 1 行**跳变**成 6 行，
   恰好在拇指所在位置、且那些行都是「一击创建」。这是误触的直接放大器。
3. **手机上快速创建后关闭侧栏**。`onPick` 只 `setStep('closed')` 关弹层，而手机侧栏是
   全屏遮罩（`Sidebar.tsx:857-863`），用户建完会话正对着一块遮住新会话的侧栏。
   现有 `handleSelect` 的 `if (mobile) onToggle()`（`Sidebar.tsx:238-241`）只作用于
   **选择**已有会话。不修的话，「1 次点击」这句话是假的。

### 导航：`quick` 成为新首屏后的三个死角（必修）

1. **`pick-type` 没有返回按钮**（已核实：`Sidebar.tsx:473-528` 只有一个 "Select type"
   标签）。它原本是第一屏不需要返回；现在 `quick` 是第一屏，从「其他目录…」进入
   `pick-type` 后**无法回到快速列表**，只能驱散整个弹层重开。需按
   `pick-terminal-mode`（`534`）/`pick-dir`（`609`）/`pick-prompt`（`693`）的既有形态
   加一个 `ChevronLeft` → `setStep('quick')`。
2. **`pick-prompt` 的返回硬编码指向 `pick-dir`**（`Sidebar.tsx:693`）。走「换 agent 类型」
   → `pick-type` → `pick-prompt` 这条新路径时 `pick-dir` **从未 `loadDirs()`**，返回后
   落在 `currentPath === ''`、`dirs === []` 的空浏览器上；而那块屏的「Use this directory」
   **没有 disabled 守卫**（`Sidebar.tsx:634-639`）→ 会把 `''` 当 work_dir 提交
   （后端 400，不是安全洞，但是一击可达的死胡同）。
   **对照 `DirectoryPicker.tsx:86` 的 `disabled={!currentPath}`——同一个坑，
   Sidebar 那一份没补。** 两处都要修：返回按来源分流 + 补 disabled 守卫。
3. **「换 agent 类型」选 Terminal 会静默丢掉已选目录**：`selectNewShell`
   （`Sidebar.tsx:187-190`）只做 `setStep('pick-dir'); loadDirs()`，完全不看已定的目录。
   用户说「用终端打开目录 A」，结果被扔回 5 层目录浏览。

## 安全设计：三道门

本 repo 路径守卫历史很厚（`SENSITIVE_DIR_NAMES`、`read_hits_home_dotdir`、
`validate_browse_root`）。新表引入一条新数据流，逐项封堵：

### 1. 写入时不校验，读出时重新校验（fail-closed + 自愈）

存的是**历史**。历史里的路径可能已被删除、已被替换为指向 `~/.ssh` 的 symlink、
或守卫规则本身已升级加严。

→ `GET` 返回前对每条 `kind=dir` 跑与 `list_directories` **完全相同**的守卫组合
（`web.rs:248-252`）：`validate_browse_root` + `read_hits_home_dotdir`。
失败条目**静默剔除并删行**。

这样即便某天守卫加严，旧行也不会成为绕过通道 —— 而不是「存的时候合法所以永远合法」。

### 2. 不存在的路径不返回（自愈），但区分「确定性拒绝」与「瞬时 IO 失败」

目录被删/重命名后留在榜上，点一次就是 8s 超时再报错。读出时检查，失败即剔除。
同 `vault.ts:removeRecentNote` 现有的自愈思路，只是提前到列表阶段。

**但 v2 修正一个 v1 的过激之处**：`still_valid` 不能是 bool，必须三态。
`validate_browse_root` 内部的 `canonicalize` 在 JuiceFS 抖动时会失败
（`web.rs:1077` 映射为 400），`resolve_and_verify` 同理（`web.rs:1514` 映射 403）。
v1 会把这种**瞬时 IO 错误**当作「路径失效」**永久删行**——用户的常用目录会因为一次
文件系统抖动而丢掉几周累积的 frecency。

```
Valid              → 返回
Invalid（删行）     → 确定性拒绝：不在 $HOME 下 / 命中敏感目录 / 不是目录 / NotFound
Unknown（仅剔除）   → 其他 IO 错误：本次不返回，但保留行，下次再试
```

最小实现：只在 `ErrorKind::NotFound` 时删行，其他错误只剔除不删。

### 2b. bump 前规范化路径，否则同一目标会存成多行

`vault_file` 的 `resolve_and_verify`（`web.rs:1491`）显式接受 `Component::CurDir`（忽略）
和 `ParentDir`（pop），所以 `a/b.md`、`./a/b.md`、`a/../a/b.md` 三个字符串解析到**同一
文件**，但若按 v1 直接 bump `q.path`，会在表里存成 **3 行**、各自独立累积、首屏出现 3 条
同名条目。这与本 spec「靠父目录区分同名 `_index.md`」的目标正好相反——变成同一篇笔记
显示多次。

- **note**：bump 前把 `real` 转回 vault-relative（`real.strip_prefix(base_path)`），
  这也让读出时的 `resolve_and_verify` 幂等。
- **dir**：`validate_work_dir_under_home`（`web.rs:381`）已经 `canonicalize` 过一次但
  **丢弃了结果**。改为复用它的 canonical 结果做 bump，消除 `/home/ubuntu/x` 与
  `/home/ubuntu/x/` 存成两行。
  （注意这与「记 `work_dir` 而非 `effective_dir`」不冲突：`canonicalize(work_dir)`
  只解 symlink，不是 `resolve_work_dir` 的 worktree 改写。）

### 3. 全部 owner-scope，read/write 对称

每条 SQL 都带 `WHERE user_id = ?` —— 包括 `pin` 与 `forget`，不只是 `SELECT`。
教训来源：2026-08-09 push 订阅跨用户劫持（write 的 owner-scope 未跟 read 对称）、
2026-07-13 `session_logs` 跨用户读。

**`kind=note` 的 scope 当前是恒真的**（`vault_base`（`web.rs:3368`）对非 admin 直接 403，
故 note 行只可能属于 admin）。仍然按 `user_id` 存与查：本 repo 反复出现的失效模式正是
「当时恒真的假设后来不再恒真」。owner-scope 是结构，不是优化。

### 不提供能「凭空建行」的写入端点（含 import）

写端点只有 `pin` 与 `DELETE` 两个，且**都只能改动已存在的行**（见 API 一节的约束）：
它们无法引入新 path，因此不构成伪造使用历史的通道。

在此之外**不做** localStorage → 后端的迁移端点。

理由：一个能批量写入任意 `path` + `last_ms` 的 import 端点，与「公开 bump 端点」是
同一个洞的两个名字 —— 都让前端能伪造使用历史，且能写 `kind=dir` 的任意路径，
绕过「只在真实创建 session 时记录」这一不变量。

代价对比：现存 localStorage 里 ≤10 条 vault recent，打开一次笔记就自然重建。
为省几次点击而开一个可伪造写入端点，完全不成比例。
→ `zmx-vault-recent` 的 localStorage 代码直接删除，不迁移。

### bump 无公开端点

bump 是 `create_session` / `vault_file` 的**副作用**，不暴露为 API。
没有任何场景需要前端主动声明「我用过某路径」。

## API

```
GET    /api/quick-targets?kind=dir|note                      → { top: [...] }
DELETE /api/quick-targets?kind=dir&path=<enc>&agent=<enc>     → 204（从榜上移除）
```

**`DELETE` 用 query param，不带 JSON body。** 已核实 `api.ts` 里全部 7 处 DELETE
调用**没有一个带 body**（如 `deleteSessionFile` 用 `?path=${encodeURIComponent(path)}`，
`api.ts:476`），后端也无任何 `delete(handler)` 接 `Json<T>`。DELETE-with-body 在
RFC 9110 里语义未定义，实践中会被中间层丢弃——而这台机器上 **nginx 正在前面反代**
（live site `zeromux.keithyu.cloud` → 8090）。body 被丢弃 → axum 的 `Json` 提取器
返回 400/415 → 前端 `catch` 静默吞掉 → 用户点「从列表移除」条目消失（乐观），
下次 `load()` 后原样复活。表现就是「移除按钮不管用」且无任何提示。

`pin` 端点随 pin 机制一起砍掉（见「为何砍掉 pin」）。

条目形状：
```jsonc
{
  "kind": "dir",
  "path": "/home/ubuntu/s3-workspace/keith-space/github-search/ai/zeromux",
  "agent": "claude",              // dir: claude|kiro|codex|tmux；note: ""
  "display": "zeromux",           // 主标题。dir: basename；note: 笔记名（去 .md）
  "hint": "~/s3-workspace/…/ai"   // 第 2 行，区分同名。dir: 以 ~ 缩写的父路径；note: 父目录相对路径（顶层笔记为空串）
}
```

`is_git` 已砍掉（见「读取成本」：占 per-row 成本一半却只用于选图标，行首图标改为
显示 agent 品牌图标）。`pinned` 随 pin 机制一起砍掉。

`DELETE` 要求 `(kind, path, agent)` 已存在于该 user 的表中——写端点不能凭空建行，
否则退化成上文否决的伪造写入通道。

## 前端：三个入口，一个组件

新组件 `frontend/src/components/QuickTargets.tsx`，一份实现三处复用。

### 入口 1：New Session 首屏（新增 step `quick`）

版式见「手机可用性 → 版式设计」。内容见「四个目的地 → (B)」。

点一行 = `onCreate(agent, path)` 直接创建 —— **1 次点击、0 次列目录请求**。
（手机上还需同时关闭全屏侧栏，否则用户对着遮罩看不到结果——见「另外三处必修」。）

**跳过 prompt 页直接创建。** 快速卡片的价值是「一击直达」，中间插一页就退化成
「少点两下的老流程」。而且**信息零丢失、只是重排**：会话建好后 `AcpChatView` 的
composer 里有一模一样的 preset 选择器 + 输入框（`AcpChatView.tsx:757-766`），
所以这不是砍功能，是把一个可延后 3 秒且零损耗的步骤从关键路径移走。
需要带 prompt 的场景走行级操作单的「带 prompt 打开」。

**`agent` 必须白名单校验。** 它是库里的字符串，若某个 agent 类型日后被移除（如 `kiro`），
旧行会让前端把脏字符串发给后端。→ 前端校验是否属于当前 `SessionType` 集合；
不属于则退化到选类型，而不是原样发送。`kind='note'` 的行（`agent=''`）走 Obsidian
阅读器路径，不参与此校验。

### 入口 2：`DirectoryPicker`（定时任务表单）顶部

Top5 目录横在目录列表上方，点了直接 `onSelect(path)`。

**v2 砍掉 Sidebar 内联 `pick-dir` 顶部的那一份**：能走到 `pick-dir` 的用户，路径必然是
`quick` →「其他目录…」→ 选类型 → `pick-dir`——**他刚刚才明确选择了「不用快速目标」**。
在下一屏把同样 5 行再摆一遍是噪音，还把 224px 弹层撑得更高。
`DirectoryPicker` 那一份保留：定时任务表单是低频、易填错的表单，真受益。

### 入口 3：VaultReader 的「最近打开」

`VaultReader.tsx:121` 的 localStorage recent 换成后端 frecency（`kind=note`）。

顺手修一个现存缺陷：当前显示 `p.split('/').pop()`，vault 内多个 `_index.md`
全部显示为 `_index` 无法分辨 → 改为 **`笔记名` + 第 2 行父目录**。

**用 CSS `hidden` 而非条件渲染。** v1 写的是 `{cwd === '' && <QuickTargets …/>}`，
切到子目录会 unmount、切回来 remount → 每次都重付一遍全量 note 校验的 IO。而
`VaultReader` 本身在 `App.tsx:396` 是常驻挂载（刻意不 unmount 以保留滚动状态），
用条件渲染反而丢掉了这个优势。改用 `hidden` class，与 App 的既有做法一致。

删除 `vault.ts` 的 `getRecentNotes` / `pushRecentNote` / `removeRecentNote`
与 `RECENT_KEY`（本次改动使其成为死代码，属「清理自己造成的 mess」）。

### stale-response 防护（从第一行就带）

`QuickTargets` 的列表 fetch 与 pin/forget 乐观写**都**上单调 `reqRef` 令牌：
fetch 顶部 bump，每个乐观 `setState` 前 bump，`await` 后守卫。

本 repo 已因这一类 bug 修过 12 次（`AgentDashboard` / `GitViewer` / `FileBrowser` /
`MarkdownViewer` / `SessionInfoBar` / `usePromptPresets` …；最近一次 2026-08-16）。
新组件同时具备「慢 GET」与「乐观 mutation」两个条件，是该 bug 的教科书场景 ——
第一版就写对，不留给下次 review。

## 验证标准（成功即可测）

1. **Rust 单测（`src/quick_targets.rs` 内联 `#[cfg(test)]`）**
   - `bump` 首次插入 → `hits=1`，`score_raw≈1.0`
   - 同 `(path, agent)` 连续 bump → `hits` 累加、`score_raw` 单调增、**仍是 1 行**
   - **同 `path` 不同 `agent` → 2 行，各自独立累积**（复合主键生效）
   - **`kind='note'` 同一 path 连续 bump 3 次 → 仍是 1 行**（空串 agent 不触发
     NULL≠NULL 陷阱，这是本 spec 实测过的失效模式，必须有回归测试）
   - 衰减纯函数：`last_ms` 距今 14 天 → `score` ≈ `score_raw * 0.5`
   - 衰减纯函数：负 elapsed（时钟回拨）钳到不放大
   - 排序：按 score 降序，`truncate(TOP_N)` 恰好 5 条
   - owner-scope：user A 的 bump 不出现在 user B 的查询结果；`forget` 跨 user 无效
2. **守卫单测**
   - 表中一条指向 `~/.ssh` 的行 → GET 不返回该条**且行被删除**（确定性拒绝）
   - 表中一条已不存在的目录 → GET 不返回**且行被删除**（NotFound）
   - **瞬时 IO 错误 → GET 不返回但行保留**（三态自愈，不因抖动丢累积分）
3. **前端单测（vitest）**
   - `agent` 为未知字符串 → 退化到选类型，不发脏值
   - 列表 fetch 的 stale response 不覆盖新 response（reqRef 生效）
   - **乐观 forget + 在途慢 GET 交织 → 被移除的条目不复活成 ghost**
   - **`notifyQuickTargetsChanged()` 触发挂载中组件重新 load**（事件驱动生效）
4. **端到端手测**
   - 全新库：点 ＋ → 因列表为空，**直接看到 `pick-type`**（不是空壳首屏）
   - 创建 3 个不同目录的 session → 首屏出现 3 条，最近的在前
   - **同一目录先用 claude 再用 codex → 首屏出现 2 行，标签各自稳定不漂移**
   - **在 Obsidian 里连开 3 篇笔记 → 不离开该页面，列表顺序实时重排**（事件驱动）
   - 打开 2 篇同名 `_index.md` → 列表能通过第 2 行父目录区分
   - 定时任务触发一次 run → 该目录**不**出现在榜上（污染排除生效）
   - **attach 既有 host tmux → `~` 不出现在榜上**
   - **手机（或 DevTools 触屏模拟）：行级 `⌄` 可见可点；创建后侧栏自动关闭**

## 影响范围

**后端**
- `src/quick_targets.rs`（新）—— 表、bump、candidates、forget、衰减与排序纯函数 + 单测
- `src/main.rs` —— 无条件 open store，注入 `AppState`
- `src/web.rs` —— 2 个路由（authed `/api/*` 组）；`create_session` 与 `vault_file`
  成功分支各加一处 best-effort bump；读出守卫循环包 `spawn_blocking`

**前端**
- `frontend/src/components/QuickTargets.tsx`（新）—— 两行行版式 + 行级操作单
- `frontend/src/lib/quickTargetsBus.ts`（新，约 12 行）—— 事件驱动刷新
- `frontend/src/components/Sidebar.tsx` —— 新增 step `quick` 作首屏（含 Obsidian 保底
  入口）；弹层宽度随 mobile；`pick-type` 加返回键；`pick-prompt` 返回按来源分流；
  `pick-dir` 的「Use this directory」补 `disabled` 守卫；`selectNewShell` 尊重已定目录
- `frontend/src/components/DirectoryPicker.tsx` —— 顶部嵌入
- `frontend/src/components/VaultReader.tsx` —— 「最近打开」换后端来源（用 `hidden` 而非
  条件渲染）+ 显示父目录 + 发射刷新事件
- `frontend/src/App.tsx` —— `handleCreate` 成功后发射刷新事件
- `frontend/src/lib/api.ts` —— 2 个 API 封装
- `frontend/src/lib/vault.ts` —— 删除 localStorage recent 三函数与 KEY

## 非目标（YAGNI，明确不做）

- ❌ 全盘扫描发现「可能的项目目录」（find-based）—— JuiceFS 上是灾难，且常用目录本就寥寥
- ❌ 模糊搜索 / 直接输入路径跳转 —— 现有浏览 + Top5 已足；真需要再加
- ❌ Top N 可配置 —— 需求是 Top5，写成常量
- ❌ 跨设备同步冲突处理 —— 单用户单服务端，SQLite 即唯一真相
- ❌ 目录使用统计图表 / 面板 —— 无人需要
- ❌ localStorage → 后端迁移端点 —— 见「安全设计」，攻击面与收益不成比例
- ❌ 公开 bump 端点 —— 同上
- ❌ **手动 pin** —— v2 砍掉，见「为何砍掉 pin」（frecency 在本用户 6-8 个目标的规模上
  已能稳定命中，pin 的边际价值≈0 而版式与触屏成本很高）
- ❌ **`is_git` 徽标** —— 占 per-row IO 成本一半却只用于选图标
- ❌ **基于排名的表内挤出（只存 5 行）** —— 会把纯 recency 的病重新引入 frecency
- ❌ **基于分数的 GC** —— 正确但当前无必要（几十 KB），YAGNI
- ❌ **全局 quick switcher（在 agent 会话内跳转）** —— 价值可能更高但本次用户未提；
  组件设计为对挂载位置无知，将来只需接线
- ❌ **修既有的 hover-only 会话删除/doc tab 关闭**（`Sidebar.tsx:429`/`450`）—— 同类缺陷
  但不在本次范围；本设计只保证**自己不新增**，且不依赖它们兜底
