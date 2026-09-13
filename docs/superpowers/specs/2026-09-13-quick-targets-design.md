# Quick Targets — 常用目录/笔记 frecency 快速入口 — 设计

日期：2026-09-13
状态：待确认（brainstorming 产出，未写实现计划）

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
| 「我有一些常见的目录」 | 稳定、显式声明、不该参与竞争 | `pinned` 手动置顶 |
| 「经常使用的目录」 | frequency | frecency 的 hits 累积 |
| 「根据最新使用的进行排序」 | recency | frecency 的时间衰减 |

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
  hits        INTEGER NOT NULL DEFAULT 0,
  last_ms     INTEGER NOT NULL,       -- 最近一次使用（epoch ms）
  score_raw   REAL    NOT NULL DEFAULT 0,
  pinned      INTEGER NOT NULL DEFAULT 0,
  last_agent  TEXT,                   -- 仅 kind='dir'：上次在此目录用的 agent 类型
  PRIMARY KEY (user_id, kind, path)
);
CREATE INDEX IF NOT EXISTS idx_qt_lookup ON quick_targets(user_id, kind, last_ms DESC);
```

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
→ SQL 只取候选：`WHERE user_id=? AND kind=? ORDER BY pinned DESC, last_ms DESC LIMIT 50`，
评分与排序在 Rust 内完成（纯函数，可单测）。候选上限 50 远大于实际量级（几十条），
但仍需上限以防表意外膨胀时把全表读进内存。

### pinned 不占 Top5 名额

返回 = **全部 pinned** + **Top5 未 pin**。

pin 是用户显式声明的「常见目录」，不该跟算法竞争名额 —— 若占名额，pin 3 个就只剩 2 个
自动推荐位，功能互相抵消。

## 记录时机：只在「用户真的去了那里」时 bump

这是最容易做错的地方。原则：**绝不在「用户路过」时记。**

| 事件 | 记录 | 落点 |
|---|---|---|
| 交互式创建 session **成功** | ✅ `kind=dir` + 写 `last_agent` | `web.rs:create_session`（`web.rs:395`）成功分支 |
| 打开 vault 笔记**成功** | ✅ `kind=note` | `web.rs:vault_file`（`web.rs:3448`）成功分支 |
| 目录浏览器进入某层 | ❌ | 路过 ≠ 使用 |
| `pick-dir` 点「使用此目录」 | ❌ | 必然导向创建 session，在那里记即可，避免双计 |
| **定时任务**创建的 session | ❌ | 见下 |
| session 创建失败 | ❌ | 只在 `Ok` 分支记 |

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

### 2. 不存在的路径不返回（自愈）

目录被删/重命名后留在榜上，点一次就是 8s 超时再报错。读出时 `is_dir()` 检查，
失败即剔除 + 删行。同 `vault.ts:removeRecentNote` 现有的自愈思路，只是提前到列表阶段。

`kind=note` 同理：经 `vault_base` + `resolve_and_verify` 校验，失败即剔除删行。

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
GET    /api/quick-targets?kind=dir|note   → { pinned: [...], top: [...] }
POST   /api/quick-targets/pin             → { kind, path, pinned: bool }
DELETE /api/quick-targets                 → { kind, path }        （从榜上移除）
```

条目形状：
```jsonc
{
  "kind": "dir",
  "path": "/home/ubuntu/s3-workspace/keith-space/github-search/ai/zeromux",
  "display": "zeromux",           // 主标题。dir: basename；note: 笔记名（去 .md）
  "hint": "~/s3-workspace/…/ai",  // 次要行，区分同名。dir: 以 ~ 缩写的父路径；note: 父目录相对路径（顶层笔记为空串）
  "pinned": false,
  "last_agent": "claude",         // 仅 kind=dir，可能为 null
  "is_git": true                  // 仅 kind=dir
}
```

`pin` 与 `DELETE` 都要求 `path` 已存在于该 user 的表中（不能用 pin 端点凭空插入任意
路径 —— 那会退化成上文否决的伪造写入通道）。

## 前端：三个入口，一个组件

新组件 `frontend/src/components/QuickTargets.tsx`，一份实现三处复用。

### 入口 1：New Session 首屏（新增 step `quick`）

```
＋ 新建会话
├─ 📌 zeromux            Claude  ▸     ← 点行=直接建；点 ▸ =改 agent 类型
├─ ⏱ 考研英语            Claude  ▸
├─ ⏱ keith-space         Codex   ▸
├─ ⏱ workshop/eks        tmux    ▸
├─ ⏱ giikin              Claude  ▸
├─ ─────────────────────
└─ 📁 其他目录…                        ← 走现有 pick-type → pick-dir
```

点一行 = `onCreate(last_agent, path)` 直接创建 —— **1 次点击、0 次列目录请求**。

**跳过 prompt 页直接创建。** 快速卡片的价值是「一击直达」，中间插一页就退化成
「少点两下的老流程」。需要带 prompt 的场景走 `▸` 或「其他目录…」。

**`last_agent` 必须白名单校验。** `last_agent` 是库里的字符串，若某个 agent 类型日后
被移除（如 `kiro`），旧行会让前端把脏字符串发给后端。
→ 前端对 `last_agent` 校验是否属于当前 `SessionType` 集合；不属于则退化到 pick-type，
而不是原样发送。`last_agent` 为 `null`（旧行/首次）同样退化到 pick-type。

### 入口 2：`pick-dir` 顶部

已选定 agent 类型后，Top5 目录横在目录列表上方，点了直接 `selectDir(path)`。
`Sidebar.tsx` 的内联 `pick-dir` 与 `DirectoryPicker.tsx` **两处都加**（后者服务于
定时任务表单，同样受益）。

### 入口 3：VaultReader 的「最近打开」

`VaultReader.tsx:121` 的 localStorage recent 换成后端 frecency（`kind=note`）。

顺手修一个现存缺陷：当前显示 `p.split('/').pop()`，vault 内多个 `_index.md`
全部显示为 `_index` 无法分辨 → 改为 **`笔记名 · 父目录`**。

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
   - 同路径连续 bump → `hits` 累加，`score_raw` 单调增
   - 衰减纯函数：`last_ms` 距今 14 天 → `score` ≈ `score_raw * 0.5`
   - 排序：pinned 全部在前且不占 Top5 名额；未 pin 部分按 score 降序
   - owner-scope：user A 的 bump 不出现在 user B 的查询结果
   - `forget` / `pin` 跨 user 无效（owner-scope 对称）
2. **守卫单测**
   - 表中一条指向 `~/.ssh` 的行 → GET 不返回该条且行被删除
   - 表中一条已不存在的目录 → GET 不返回且行被删除
3. **前端单测（vitest）**
   - `last_agent` 为未知字符串 / `null` → 退化到 pick-type，不发脏值
   - 列表 fetch 的 stale response 不覆盖新 response（reqRef 生效）
   - pin 乐观写 + 慢 refresh 交织 → 不出现 ghost / 消失条目
4. **端到端手测**
   - 全新库：创建 3 个不同目录的 session → 首屏出现 3 条，最近的在前
   - pin 其中 1 条 → 始终在首位，且 Top5 仍显示 5 条未 pin
   - 打开 2 篇同名 `_index.md` → 列表能通过父目录区分
   - 定时任务触发一次 run → 该目录**不**出现在榜上（污染排除生效）

## 影响范围

**后端**
- `src/quick_targets.rs`（新）—— 表、bump、list、pin、forget、衰减纯函数 + 单测
- `src/main.rs` —— 无条件 open store，注入 `AppState`
- `src/web.rs` —— 3 个路由（authed `/api/*` 组）；`create_session` 与 `vault_file`
  成功分支各加一处 best-effort bump

**前端**
- `frontend/src/components/QuickTargets.tsx`（新）
- `frontend/src/components/Sidebar.tsx` —— 新增 step `quick` 作首屏；`pick-dir` 顶部嵌入
- `frontend/src/components/DirectoryPicker.tsx` —— 顶部嵌入
- `frontend/src/components/VaultReader.tsx` —— 「最近打开」换后端来源 + 显示父目录
- `frontend/src/lib/api.ts` —— 3 个 API 封装
- `frontend/src/lib/vault.ts` —— 删除 localStorage recent 三函数与 KEY

## 非目标（YAGNI，明确不做）

- ❌ 全盘扫描发现「可能的项目目录」（find-based）—— JuiceFS 上是灾难，且常用目录本就寥寥
- ❌ 模糊搜索 / 直接输入路径跳转 —— 现有浏览 + Top5 已足；真需要再加
- ❌ Top N 可配置 —— 需求是 Top5，写成常量
- ❌ 跨设备同步冲突处理 —— 单用户单服务端，SQLite 即唯一真相
- ❌ 目录使用统计图表 / 面板 —— 无人需要
- ❌ localStorage → 后端迁移端点 —— 见「安全设计」，攻击面与收益不成比例
- ❌ 公开 bump 端点 —— 同上
