# 模糊搜索 —— New Session 目录 + Obsidian 文件夹/笔记 — 设计

日期：2026-09-25
状态：v3.1（vault inotify 实时增量；已经 CTO + PM 增量 review 并修订，待用户审阅）

## 修订记录

**v3.1（本版）** —— CTO + PM 对 v3 增量 review。关键断言本人复核：`docker ps` 证实 Obsidian
跑在 `lscr.io/linuxserver/obsidian` 容器内（宿主无 `/opt/obsidian`，v3 写错）；`inotify-0.11.5/src/inotify.rs:128`
证实 `read_events_blocking` 无超时、`:103/:112` 证实 `add_watch/rm_watch` 已 deprecated。改动：

| # | 改动 | 来源 | 理由 |
|---|---|---|---|
| 1 | 1d 重写为**「事件只标脏 → 单目录 `read_dir` 对账」**，删 cookie 配对与计数器 | CTO M2–M5 | 精细维护在 4 个实测场景出错（见 1d）；对账模型终态恒由真实 `read_dir` 决定，且代码更少 |
| 2 | `poll(fd, timeout)` + 非阻塞读 | CTO M1 | 阻塞读无超时，防抖与 6h 计时无法实现 |
| 3 | 全量 BFS 期间每 64 目录 drain 一次队列；重建间隔 ≥60s；根 `read_dir` 失败=构建失败 | CTO M6 / m4 | 队列上限 16384，重建由突发触发，不读队列会「溢出→重建」循环；卸载间隙不能建出空索引 |
| 4 | 掩码加 `DONT_FOLLOW`；`admissible()` 统一谓词；`UNMOUNT` 入事件表；`catch_unwind` 代替监督任务 | CTO m3/M4/m4/m9 | symlink TOCTOU；改名到噪音名；卸载；监督任务永占 blocking 线程 |
| 5 | 同分排序：非空 > 空文件夹，再按 mtime 降序 | PM P1-1/P1-2 | 查「单词」10 篇同分、今天那篇不保证进前 6；查「阅读理解」17 个空真题骨架（116/117 个空文件夹是 `考研英语/20xx/英语二/*` 骨架）挤掉真笔记 |
| 6 | 打开 New Session 时若目录快照 > 30s 即后台预刷新 | PM P2-5 | 21 个 repo 模拟中 17 个名字被旧路径命中，零结果逃生口不触发；预刷新在用户打字期间完成 |
| 7 | 非目标补「非 `.md` 文件不索引」；笔记段删「索引重建中」态；统一时延数字 | PM P2-1/P2-4/P2-3 | VaultReader 打不开非 md（`vault.ts:13`）；近两周新增非 md 只有已被笔记引用的图片 |

**v3** —— 用户追加约束：「obsidian 是动态的，新产生的文件/文件夹也要能模糊搜」。
调研（2026-09-25 本机实测）结论与决策：

- **写入方全在本机**：近两周新增 `.md` 属主均为 `ubuntu`，来源是本机 zeromux agent、本机常驻
  Obsidian 桌面端（docker 容器 `lscr.io/linuxserver/obsidian`，vault 是同一 FUSE superblock 的 bind mount）、以及 Mac 端经 `remotely-save` 插件由本机
  Obsidian 拉取落盘。均经本机 JuiceFS FUSE 挂载点写入。
- **inotify 在 JuiceFS FUSE 挂载点上可用**：探针实测新建（含中文名）文件夹 / 新建 `.md` /
  文件改名 / 文件夹改名（`MOVED_FROM`+`MOVED_TO` 成对，同 cookie）/ 删除，均 ≤50ms 送达。
  局限：**其他主机**直写同一 JuiceFS 的变更本机收不到（当前无此写入方，靠周期全量兜底）。
- **轮询不可行**：vault 全量遍历 42s；只 `stat` 1894 个目录的 mtime 也要 20s。
- **v2「零结果才刷新」对 vault 失效**：新写 `2026-09-25-下午.md` 后搜「单词」，旧笔记照样命中 →
  不零结果 → 不刷新，最坏 10 分钟后才可搜。这恰是用户最高频的场景（每天两篇单词笔记）。
- **v2 文件夹规则漏新建空文件夹**：「子树含 .md 才收」→ 在 Obsidian 里刚建的文件夹搜不到。
  实测 1894 个文件夹中 409 个子树含笔记、117 个为空。
- **watch 成本可接受**：`projects/` 1548 个目录 `inotify_add_watch` 共 16s（后台一次性）；
  `max_user_watches = 248967`。

决策（用户选 A）：vault 用 **inotify 增量 + 周期/溢出全量兜底**；`$HOME` 目录索引保持轮询
（遍历仅 3.7s，新目录多为新 clone 的 repo、名字不与旧目录重合，零结果触发有效），TTL 10→2 分钟。

**v2** —— CTO（技术）+ PM（产品）并行交叉 review。两位 reviewer 的关键断言
均由本人复核（本 repo 教训：reviewer 方向对但细节常编造，一律不采信未核实的断言）：
线上 journal `06:23:33 serving vault → 06:24:19 listening` 证实 vault 同步遍历 46s；
`deploy.sh:82` 注释证实健康检查 90s 窗口即为此；`~/.zeromux/zeromux.db` 中 12 个 dir
frecency 路径有 3 个在 vault 内；`Sidebar.tsx:183-188` + `:811` 证实选类型后进 prompt 页
且 textarea `autoFocus`；`docTabs.ts:1` 证实 DocTab 只有 `{id,title,kind}`。

v2 相对 v1 的实质改动：

| # | 改动 | 来源 | 理由 |
|---|---|---|---|
| 1 | vault 索引也改为**启动异步构建** | CTO MAJOR-1 | 现状同步遍历 46s 阻塞 listener bind；顺手把 deploy/重启宕机窗口从 ~46s 降到秒级 |
| 2 | 目录索引**不再排除 vault 子树** | CTO MAJOR-2 / PM P1-3 | 用户真实在 vault 文件夹里开 agent（3/12）；同一路径在「目录」「笔记」两段语义不同（开会话 / 读），不算重复 |
| 3 | IndexSlot 状态机补全（未建/首建/刷新/panic 复位） | CTO MAJOR-3 | v1 首建期间会双重遍历；panic 后 `rebuilding` 永不复位 = 永不刷新 |
| 4 | VaultDir 只收「子树含 .md」的文件夹 | CTO MAJOR-4 | 2124 个文件夹只有 409 个含笔记，231 个是 `__pycache__` 等 |
| 5 | frecency 加分写死公式 + 按 path 聚合 | CTO MAJOR-5 | v1「成比例有上限」不可实现；表按 `(path, agent)` 分行 |
| 6 | 目录结果**一击直达**（有历史 agent 时） / 选类型后直接创建 | PM P0-1 | v1 点目录 → 选类型 → prompt 页 + 第二次弹键盘，退化成老流程 |
| 7 | 输入框放弹层底部 + 结果区限高 + visualViewport 补偿 | PM P0-2 | 弹层 `bottom-full` 向上长，v1 顶部输入框会被 40 条结果顶出屏 |
| 8 | 目录零结果时**立即触发刷新** | PM P0-3 | 「刚 clone 的 repo」是核心场景，10 分钟 TTL 下必然搜不到 |
| 9 | 每段 6 条、按段内最高分排段序 | PM P1-2 | 每段 20 条 × 48px 远超弹层高度；固定「目录在前」会埋掉笔记 |
| 10 | 删 `/api/vault/search`，不留兼容壳 | CTO MINOR-6 / PM P1-7 | 前端 rust-embed 进同一二进制，不存在版本错位 |
| 11 | 点笔记**复用最近的 doc tab**；`target` 只存内存 | PM P1-5 / CTO MINOR-7 | 每点一次新开 tab，手机上越开越多，且每个 tab 常驻挂载一份 VaultReader |
| 12 | 删 QuickTargets `onEmpty` + `failed` | PM P2-1 | 首屏有搜索框后空壳论据不成立；`Sidebar.tsx:519` 是唯一调用方 |

## 背景

两个入口都缺「搜」：

1. **New Session 选目录**只能逐层点（`Sidebar.tsx` `pick-dir`），每层一次
   `GET /api/directories`，JuiceFS 上带 8s abort。QuickTargets Top5
   （`2026-09-13-quick-targets-design.md`）只覆盖**用过的**目录；找一个从没开过的 repo
   仍要点 5 层。
2. **VaultReader 搜索**（`web.rs:3523` `vault_search_filter`）：
   - 纯子串 `contains`：`zmx` 搜不到 `zeromux`，`gsai` 搜不到 `github-search/ai`；
   - 只索引 `.md`，**不含文件夹**；
   - **不排序**，按遍历序截前 100；
   - 索引**只在启动时同步建一次**（`main.rs:434`），新笔记重启前搜不到，且这一次遍历
     让启动阻塞 46s。

### 实测规模（2026-09-25）

`$HOME` 目录（跳过 dot / node_modules / target / __pycache__；Rust `read_dir + file_type`
模拟实现冷缓存口径）：

| maxdepth | 目录数 | 耗时 |
|---|---|---|
| 5 | 274 | 1.2s |
| 6 | 650 | 3.7s |
| 7 | 2462 | 8.0s |

vault（`~/s3-workspace/keith-space/obsidian`，JuiceFS）：2124 个文件夹（其中子树含 .md 的
409 个）、9680 个文件（662 个 `.md`），完整遍历 **46s**。

nucleo 性能（CTO 实测）：128 字符 / 64 atom 最坏查询扫 7000 条 13.8ms；常规查询亚毫秒。

结论：不能现场遍历；内存全量匹配毫秒级。

## 目标 / 非目标

目标：
- New Session 首屏搜索框：同一次输入出「目录」「笔记」两段结果，fzf 式子序列匹配 + 排序。
  - 点目录 = 以它为 work_dir 建会话（有历史 agent 则一击直达）。
  - 点笔记 = 在 Obsidian doc tab 打开；点笔记文件夹 = doc tab 定位到该文件夹。
- VaultReader 搜索框换成同一匹配器，结果含文件夹。
- vault 索引异步 + **实时**（本机写入的新建/改名/删除笔记与文件夹约 1s 内可搜——防抖 300ms、最迟 1s 强制对账；修「新笔记重启前搜不到」
  + 启动 46s 阻塞）。

非目标（明确不做）：
- 全文搜索（只搜路径/名字）；拼音匹配（`kaoyan` 不命中 `考研`）。
- `$HOME` 之外的目录；dot 目录；vault 之外的 `.md` 文件（New Session 的「笔记」段只含 vault）。
- 对 `$HOME` 目录索引做文件系统监听（`target/`、`node_modules` 等噪音变动过多；轮询已够）。
- 其他主机直写 JuiceFS 的 vault 变更做到实时（只保证 ≤6h 内被周期全量兜住）。
- 索引非 `.md` 文件（图片 / pdf / canvas / base）：VaultReader 打不开它们（`vault.ts:13` 只放行目录与 `.md`），
  搜到也无落点。以后若 VaultReader 支持打开，再扩展。
- 命中字符高亮；↑/↓ 键盘导航（只做 Enter = 打开第一条）。
- DirectoryPicker（定时任务表单，低频）与 Sidebar `pick-dir` 加搜索——接口通用，以后只是接线。

## 后端

### 1. `src/fuzzy_index.rs`（新模块）

```rust
pub enum EntryKind { Dir, VaultDir, VaultNote }
pub struct IndexEntry {
    pub path: String,        // Dir: 绝对路径；Vault*: vault 相对路径（note 带 .md）
    pub kind: EntryKind,
    haystack: String,        // 参与匹配的串：Dir 为 ~ 缩写路径；Vault 为相对路径（note 去 .md）
    basename_off: usize,     // haystack 中 basename 起始字节偏移，供 basename 加权
}
pub struct PathIndex { pub entries: Vec<IndexEntry>, pub built_at_ms: i64, pub truncated: bool }

pub struct IndexSlot {
    cur: RwLock<Option<Arc<PathIndex>>>,  // None = 从未建成
    rebuilding: AtomicBool,
}
```

vault 的 `PathIndex` 与 wikilink 用的 `VaultIndex`（字段不变）**在同一次遍历中产出**，
装进同一个快照 `VaultSnapshot { paths: PathIndex, wiki: VaultIndex }`，
`AppState.vault_index: Option<Arc<VaultIndex>>` 改为 `vault: Option<IndexSlot<VaultSnapshot>>`。
`IndexSlot` 对快照类型泛型化；目录侧快照即 `PathIndex`。现有调用方只有 `vault_search`（删）
与 `vault_resolve`（改读快照），影响面已 grep 确认。

#### 1a. 目录索引

- 根 `$HOME`，`maxdepth = 6`，条目上限 5000，**BFS**（截断时丢最深层，而非随机子树）。
- 跳过规则与 `list_directories` 一致：`file_type()` 不跟 symlink；跳过 `.` 开头；跳过
  `node_modules | target | __pycache__`。**不排除 vault 子树**。
- 守卫：对每个候选的**遍历路径词法形式**过 `path_hits_sensitive_dir` + `read_hits_home_dotdir`
  （纵深防御——跳过 `.` 开头已使其在构造上不命中）。**不 canonicalize**：JuiceFS 上约 10ms/次，
  650 条多 6.5s。

#### 1b. vault 索引（收录规则）

vault 快照由 1d 的 watcher 线程从其模型构建（初始全量与增量共用一套发布逻辑）；现有同步的
`build_vault_index` 由 1d 的 `full_scan` + 发布取代（既有 wikilink 测试改为对发布出的 `VaultIndex` 断言）。

- `VaultNote`：现有 `.md` 规则不变（后缀大小写不敏感、wikilink basename 表规则不变）；额外记录 `mtime`
  （仅对 `.md` 做 `DirEntry::metadata()`；662 次 stat 在后台全量中约增加数秒；增量对账时新出现的 `.md`
  同样 stat 一次）。
- `VaultDir`：收 **「子树含 `.md`」或「空文件夹」**（无任何非 dot 子项）。前者覆盖笔记文件夹，后者让
  Obsidian 里刚建的空文件夹立即可搜；vault 内 Python 项目的代码目录、只放附件的文件夹两者都不满足，
  被滤掉（VaultReader 进去也只见空列表，口径一致）。发布时自底向上一次性算出。
- 额外跳过 `node_modules | target | __pycache__`（实测这三类目录下 `.md` 数为 0，不影响
  wikilink 覆盖；测试 fixture 固定此行为）。
- watch 集合 = 模型中的目录集合，跳过规则只有一份（`admissible()`，见 1d）。

#### 1c. 状态机

两个 slot 共用：

| 状态 | `cur` | `rebuilding` | 搜索行为 |
|---|---|---|---|
| 首建中 | None | true | 返回该类空结果 + `indexing: true` |
| 就绪 | Some | false | 正常匹配 |
| 全量重建中 | Some | true | 用旧快照正常匹配 + `refreshing: true`（**不是** indexing） |

- **首建**：启动代码先 `rebuilding.store(true)` 再启动构建（目录 slot：`spawn_blocking`；vault slot：
  watcher 线程），保证首建期间的请求 CAS 失败、不会并发第二次遍历。listener bind **不再等待** vault 遍历。
- **复位**：`rebuilding` 由构建闭包内持有的 Drop guard 复位——构建 panic 同样复位。
  vault watcher 线程 panic：线程体内 `catch_unwind` 捕获、记录错误并重新全量（见 1d）。
  构建成功才替换 `cur`，失败 / panic 保留旧快照。

两个 slot 的**刷新触发**不同：

- **目录 slot（轮询）**：CAS `false→true` 成功者发起，失败者什么都不做。
  - 快照年龄 > **2 分钟**（stale-while-revalidate，本次请求用旧快照）；
  - 或：目录段**零结果**且快照年龄 > 30 秒（「刚 clone」逃生口，30s 下限防每次敲键都触发）。
  - 或：用户**打开 New Session 弹层**时快照年龄 > 30 秒——前端打开弹层即发一次 `GET /api/search/warm`
    （仅触发刷新、无返回体），重建约 3.7s，在用户打字期间完成。覆盖「刚 clone 的 repo 名被旧路径命中、
    零结果逃生口不触发」的情况。
  - 只由用户操作触发，空闲零遍历。
- **vault slot（事件驱动，见 1d）**：增量事件直接改快照；只有以下情况走全量重建：
  - watcher 报告需要重扫（`Q_OVERFLOW`、根目录 `IGNORED`、`UNMOUNT`、watcher 线程 panic 重启）；
  - 距上次全量 > **6 小时**（兜底其他主机直写 JuiceFS；由 watcher 线程计时，不依赖搜索请求）。
  - 全量重建完成后**整体替换**快照与 `Inotify` 实例（见 1d）。
  - 全量重建期间（~52s）watcher 线程在遍历：事件照常记入 dirty，但**不发布**，期间新建的笔记在重建
    结束时一并出现（用旧快照照常搜索）。

- `GET /api/search/warm`：已认证即可；只做目录 slot 的「> 30s 则 CAS 刷新」，立即返回 204。
- `vault_resolve` 在首建中返回 503 `"vault indexing"`；前端 `resolveWikiLink` 对 503 提示
  「笔记索引建立中，请稍候」而非「未找到」。

#### 1d. vault watcher（`src/vault_watch.rs`，新模块）

依赖 `inotify = { version = "0.11", default-features = false }`（Linux 专用；关掉默认 `stream`
feature，免拉 tokio/futures-util）。用 `watches().add/remove`（`add_watch`/`rm_watch` 在 0.11 已
deprecated）。不用 `notify` crate：watch 集合需与索引跳过规则逐项一致（不 watch `.obsidian`/`.trash`
—— Obsidian 高频写 `workspace.json`；不跟 symlink；不进噪音目录），`notify` 的递归 watch 无法按规则剪枝。

**核心思路：事件只标脏，按单目录 `read_dir` 对账。** 不按事件类型精细维护、不做 cookie 配对、
不维护计数器。CTO v3 review 实测了精细维护的 4 类失败：`rename(A, 已存在空目录B)` 之后到来的
旧 B `DELETE_SELF` 会误删刚迁入的子树；竞态扫描 + `CREATE` 事件双计；`sed -i` / agent 原子写的
`CREATE tmp → MOVED_FROM tmp → MOVED_TO 已存在.md` 让计数漂移；同目录改名到噪音名是配对事件、
会被当普通改名留在索引。对账模型下这些全部不存在——任何事件序列的终态都由 `read_dir` 的真实
结果决定。

**线程模型**：一个专用 OS 线程（`std::thread::spawn`），不占 tokio worker；它是 vault 快照的
**唯一写者**，搜索请求只读 `Arc` 快照。线程体 `loop { catch_unwind(run); backoff }`，退避指数
增长、上限 10 分钟（release profile 未设 `panic=abort`，`catch_unwind` 有效；不另起监督任务）。

**主循环**：`poll(inotify_fd, timeout)` + 非阻塞 `read_events`（`read_events_blocking` 无超时，
无法实现防抖与 6h 计时；`Inotify` 实现 `AsRawFd`）。`timeout = min(防抖剩余, 距下次 6h 全量)`。

**模型**（线程私有）：
- `dirs: HashMap<目录相对路径, DirNode { wd: i32, children: BTreeMap<名字, Kind(Dir|Md|Other)> }>`
- `wd_to_dir: HashMap<i32, 目录相对路径>`（键用 `WatchDescriptor::get_watch_descriptor_id()`；每个
  `Inotify` 实例各一张表，实例间 wd 编号可重复）。

**事件 → 脏集合**（掩码 `CREATE | DELETE | MOVED_FROM | MOVED_TO | ONLYDIR | DONT_FOLLOW`，
**不订阅** `MODIFY`/`CLOSE_WRITE`——只搜路径；Obsidian 的 `adapter.write` 是原地 `writeFile`，
不产生被订阅事件）：
- 普通事件：`wd_to_dir[wd]` 加入 `dirty`；未知 wd（旧 watch 残留，例如目录被移入 `.trash`）忽略。
- `IGNORED`（非根）：仅当 `wd_to_dir[wd]` 仍指向该 wd 时清表项；**不**删模型——目录删除由父目录
  的对账发现。
- 根目录 `IGNORED` / 任一 `UNMOUNT` / `Q_OVERFLOW`：请求全量重建。

**对账**（防抖到期：最后一个事件后静默 300ms，持续有事件则最迟 1s 强制执行）：
对每个 dirty 目录（按路径深度升序，去掉已被祖先覆盖的）：
1. `read_dir`；失败（目录已不存在）→ 从模型删该目录子树（只删模型与 `wd_to_dir`，**不调**
   `watches().remove`：inode 已走，watch 自然 `IGNORED`；移到 vault 外/`.trash` 的残留 watch 其事件
   带未知 wd 被忽略，下次全量新建实例时统一释放）。
2. 与 `children` 按名字 diff：
   - 消失的子目录 → 删模型子树（同上）；消失的 `.md` → 删条目。
   - 新出现的子项先过 `admissible(rel)` 统一谓词（非 dot、非噪音名 `node_modules|target|__pycache__`、
     `symlink_metadata` 非 symlink、`vault_path_has_dot_component` 为假）；不合规 = 不存在（同目录改名到
     `.k` / `node_modules` 自然等价于移出）。
   - 新子目录 → **先 `watches().add` 再递归 `read_dir`**（竞态方案：`mkdir -p a/b/c && touch
     a/b/c/x.md` 实测 220/220 通过）。对已被 watch 的 inode 再 add 返回**原 wd**（实测），所以目录
     改名在新位置对账时自然把 wd 重新映射到新路径，无需特判。
   - 新 `.md` → 加条目。
   - 同名子项类型变化（文件 ↔ 目录）→ 先删后加。
3. 全部 dirty 目录对账完毕后，**重算** `VaultDir` 收录集合并发布快照（见下）。

单目录 `read_dir` 实测约 27ms（52s / 1894 目录）。新建一篇笔记只脏 1 个目录；大目录改名重扫其
子树（约 27ms × 子目录数），低频可接受。

**发布**：由模型 O(N) 重建 `VaultSnapshot`（`PathIndex` + `VaultIndex` 的 basename 表），`Arc` 原子
换入 slot。`VaultDir` 收录条件（「子树含 `.md`」或「空文件夹」）在此时自底向上一次性重算——不维护
增量计数器，不可能漂移。N≈2500 条目，微秒到亚毫秒级。

**全量（初始 / 重建）**：同一函数 `full_scan(new_inotify)`：自顶向下 BFS，对每个目录**先
`watches().add` 再 `read_dir`**，建模型。
- 期间**每处理 64 个目录非阻塞 drain 一次**新实例事件队列，事件转成 dirty 缓存在内存；BFS 结束后
  对 dirty 对账一次再首次发布。理由：`max_queued_events = 16384`（实测写 17000 文件恰得 16384 事件
  + `Q_OVERFLOW`），重建恰由突发写入触发，52s 不读队列会「溢出 → 重建」循环。
- 根目录 `read_dir` 失败（例如 JuiceFS 卸载后到重挂前 vault 路径不存在或为空挂载点）= 构建失败，
  保留旧快照与旧实例，退避重试——不能「成功」建出一个空索引。
- 成功后用新实例替换旧实例（drop 旧实例即释放全部旧 watch）；重建期间旧实例继续被读取、其事件
  也进 dirty，替换后统一对账，无丢事件窗口。
- 连续两次重建之间至少间隔 60s（突发未结束时防循环）。
- 实测全量 BFS + 挂 watch 51.5s，与不挂 watch 的 51.6–53.6s 相同（`add` 累计 11.6s 被遍历 IO 掩盖）。

**资源**：watch 数 ≈ vault 目录数（~1900；uid 1000 当前已用 2232，上限 248967）；实例数 1–2
（上限 128）。`watches().add` 失败（`ENOSPC` 等）记 warn、该目录仅靠 6h 全量兜底，不重试风暴。

### 2. 匹配（`nucleo-matcher 0.3`）

- 每请求 `Matcher::new(Config::DEFAULT.match_paths())`（`Send`，100 次 new 共 281µs，不共享、不加锁）；
  `Pattern::parse(q, CaseMatching::Smart, Normalization::Smart)`（空格分词 AND，fzf 语法 `^ $ ' !`）。
- `full = pattern.score(haystack)`；`base = pattern.score(haystack[basename_off..])`；
  **`text = max(full, base + 20)`**。实测 `zmx`/`zeromux` 对 `.../zeromux` 与 `.../zeromux/docs`
  全路径分相同，basename 加权才能把 repo 本身排在其子目录前。
- **丢弃 `score == 0`**：纯否定查询（`!docs`）对所有条目返回 `Some(0)`，否则会返回任意 20 条。
- **frecency 加分**（仅 Dir / VaultNote；VaultDir 无 frecency）：
  - 取该用户 `candidates(user_id, kind)`（既有，`LIMIT 16` 按 `last_ms`——只有最近 16 行能加分，接受）；
  - 按 path 聚合：`s = Σ decayed_score`，`bonus = floor(12 · s / (s + 1))`，上限 12；
  - 12 < nucleo 单字符匹配分 16（`score.rs:6` `SCORE_MATCH`），frecency 不会压过更好的文本匹配。
- Dir 结果额外带 `agent`：该 path 下 `decayed_score` 最高的那一行的 agent（经 `coerceAgent` 同款
  白名单校验，不合法则为 null）。无历史则 null。
- 排序：`text + bonus` 降序；**同分**依次按：
  1. 非空优先（`VaultDir` 空文件夹排在同分笔记与非空文件夹之后）——防 116 个空真题骨架挤掉真笔记；
  2. `mtime` 降序（笔记取自身；文件夹取子树内最新 `.md` 的 mtime，发布时自底向上一并算出；Dir 无 mtime
     视为 0）——让「今天刚写的单词笔记」在 10 篇同分中排第一；
  3. haystack 长度升序。

### 3. 接口 `GET /api/search?q=&scope=all|dirs|notes&limit=`

```json
{
  "dirs":  [{ "path": "/home/ubuntu/…/zeromux", "display": "zeromux", "hint": "~/s3-workspace/…/ai", "agent": "claude" }],
  "notes": [{ "path": "projects/x/_index.md", "kind": "note", "display": "_index", "hint": "projects/x" },
            { "path": "projects/x", "kind": "folder", "display": "x", "hint": "projects" }],
  "indexing":   { "dirs": false, "notes": false },
  "refreshing": { "dirs": false, "notes": false },
  "truncated":  { "dirs": false, "notes": false }
}
```

- `display/hint` 复用 `dir_display_hint` / `note_display_hint`。
- `limit` 默认 6，上限 50。
- `q`：trim 后为空 → 空结果；长度按 **`chars().count()` ≤ 128**（按字节会误伤中文），超出 400。
- **authz**：
  - `dirs`：所有已认证用户，与 `/api/directories` 同级——后者本就允许非 admin 逐层枚举 `$HOME`
    非 dot 目录，本接口信息集相同，**不是新泄漏**。
  - `notes`：沿用 `vault_base()`（admin + vault 已配置）；不满足时 `notes` 恒为空、不报错
    （New Session 首屏不因非 admin 整块失败）。
  - frecency 按 `user.id` 查（`candidates` 已 owner-scoped）。
- **删除** `/api/vault/search`、`vault_search`、`vault_search_filter` 及前端 `getVaultSearch`。

依赖：`nucleo-matcher = "0.3"`（纯 Rust）、`inotify = "0.11"`（vault watcher）。

## 前端

### 4. New Session 首屏（`Sidebar.tsx` `step === 'quick'`）

布局（弹层 `absolute bottom-full`，向上生长，锚在底部 New session 按钮）：

```
┌ 新建会话 ───────────────┐
│ [结果区 / QuickTargets] │  ← max-h-[40vh] overflow-y-auto，内容变长只在此区滚动
│ 其他目录…               │  ← 常驻
│ Obsidian 笔记库         │  ← vaultEnabled 时
│ [🔍 搜索目录或笔记…   ] │  ← 输入框在底部：贴近锚点与拇指，结果变长不移动它
└─────────────────────────┘
```

- **键盘**：手机不 `autoFocus`（主路径仍是 QuickTargets 一击，自动弹键盘会盖住它）；桌面 `autoFocus`。
  手机键盘弹起时，弹层底部用 `visualViewport`（`height + offsetTop` 相对 `innerHeight` 的差）
  上抬，参照 `TerminalView.tsx:391-410` 的现有做法。
- 输入 `maxLength={128}`；防抖 150ms；monotonic `reqRef` 守卫（发请求前 bump，await 后比对）。
- 查询词存 Sidebar 级 state：从结果进 `pick-type` 再返回 `quick` 时保留；`openTypePicker` 时清空。
- Enter = 打开第一条结果。
- 弹层打开时调一次 `warmSearchIndex()`（`GET /api/search/warm`，失败静默）。

结果呈现：
- 空查询：保持现状（QuickTargets + 其他目录… + Obsidian）。
- 有查询：结果区替换 QuickTargets 为两段「目录」「笔记」，每段 ≤ 6 条，**段序按段内最高分**。
  - 笔记段仅在 `vaultEnabled` 时渲染（非 admin / 未配置 vault 时整段不出现，不显示「无匹配」）。
  - 行样式复用 QuickTargets 行（≥48px，display + hint 两行，行首图标 = 会开出什么）。
    实现上把 QuickTargets 的行渲染抽成共享组件，而非复制。

点击行为：
- **目录行，`agent` 非 null** → `onCreate(agent, path)` + `closeAfterCreate()`（一击直达，同 QuickTargets）。
  行尾 `⋮` 操作单：「换 agent 类型」「带 prompt 打开」（复用 QuickTargets 操作单；无「从列表移除」）。
- **目录行，`agent` 为 null** → `setPendingDir(path)` + `pick-type`，选完类型**直接创建**，不进
  prompt 页（新增 `pendingSkipPrompt` 标志；QuickTargets「换 agent 类型」的既有流程不变）。
  tmux 仍走 `pick-terminal-mode`。
- **笔记行 / 笔记文件夹行** → `onOpenVault({ path, kind })` + `closeAfterCreate()`。

边界态：

| 状态 | 目录段 | 笔记段 |
|---|---|---|
| 首建中（`indexing`） | 「正在建立目录索引…」 | 「正在建立笔记索引…」 |
| 刷新中且零结果 | 「索引刷新中…」，前端 4s 后自动重查一次 | 「无匹配笔记」（全量重建时仍用旧快照，零结果即真无匹配） |
| 零结果 | 「未找到（仅索引 6 层内）· 用「其他目录…」浏览」 | 「无匹配笔记」 |
| `truncated` | 不提示（Top 6 远小于上限） | 不提示 |
| 请求失败 | 结果区静默隐藏 + 行内「重试」；其余入口照常 | 同左 |

QuickTargets 清理：删除 `onEmpty` prop 与 `failed` state（`Sidebar.tsx:519` 为唯一调用方）。
全新库首屏 = 搜索框 + 其他目录… + Obsidian；开 Terminal/Claude 比现在多 1 tap，可接受。

### 5. App / doc tab

- `Sidebar` 新增 prop `onOpenVault(target: { path: string; kind: 'note' | 'folder' })`，不复用
  `onCreate` 的 `workDir` 参数位。
- `App.handleOpenVault`：若已有 doc tab → 激活**最近创建**的那个并下发 target；否则新建一个。
  （取舍：复用会让该 tab 当前阅读位置被替换——与在 VaultReader 内点链接行为一致；换来的是
  手机上 tab 不无限增长、不多挂载 VaultReader。）
- 下发方式：`docTargets: Record<tabId, { path, kind, nonce }>`（App 内存 state），VaultReader 新 prop
  `target`，`useEffect` 按 `nonce` 消费（note → `openNote`；folder → `setMode('list')` + `setCwd` + `setQuery('')`）。
- `target` **不持久化**（`saveDocTabs` 不变）：刷新页面回到列表模式，与 `docTabs.ts:5-6` 既有设计一致。

### 6. VaultReader 搜索

- 搜索框改调 `/api/search?scope=notes&limit=50`，结果含文件夹（`Folder` 图标），显示 display + hint。
- 点笔记 → `openNote`；点文件夹 → `setCwd(path)` **并 `setQuery('')`**（否则 `query` 非空时仍渲染
  结果列表，点击看似无反应）。
- 既有 `searchReqRef` 守卫保留；`indexing` 时显示「笔记索引建立中…」；截断提示改为「仅显示前 50 条」。

## 测试

Rust（`fuzzy_index.rs` `#[cfg(test)]`，临时目录 fixture）：
- 遍历：跳 dot / symlink / 噪音名；maxdepth；上限 + BFS 截断丢最深层；vault 子树**被包含**。
- VaultDir：收子树含 `.md` 的文件夹与空文件夹；只含非 md 文件的代码目录与 `__pycache__` 不收。
- 同一次遍历产出的 `VaultIndex` 与现有 `build_vault_index` 行为一致（复用既有 wikilink 测试）。
- 匹配：`zmx`→zeromux；`gsai`→github-search/ai；`考研`→考研英语；basename 加权使 repo 排在子目录前；
  `!docs` 不返回 score 0 条目；frecency 加分让等分者靠前但不压过多一个字符的更好匹配；按 path 聚合多 agent 行。
- 状态机：首建中搜索不触发第二次构建；刷新中返回旧快照 + `refreshing`；构建 panic 后 `rebuilding` 复位
  且旧快照保留；目录 slot 2 分钟 TTL 与零结果 30s 下限。

vault watcher（`vault_watch.rs` `#[cfg(test)]`）：对账核心为纯函数
`reconcile(dir, listing: &[(名字, Kind)], &mut Model) -> Vec<新子目录>` 做无 IO 单测；另用真实
inotify + 临时目录做集成测：
- 新建 `.md` / 新建空文件夹 → 防抖后可搜；非 `.md` 文件不入索引，但使父目录不再「空」（新建文件夹后拖入
  一张图，该文件夹会从结果消失、写入 md 后再出现——有意行为，由此测试固定）。
- `mkdir -p a/b/c && touch a/b/c/x.md`（竞态）→ `a`、`a/b`、`a/b/c`、`x.md` 全部入索引。
- 文件改名；文件夹改名 → 新路径下全部子项可搜、旧路径消失；改名后在其子目录新建文件仍被捕获（re-add 返回原 wd）。
- `rename(A, 已存在空目录 B)` → B 下为 A 的内容，不被随后的旧 B `IGNORED` 误删。
- `sed -i n.md`（`CREATE tmp → MOVED_FROM tmp → MOVED_TO n.md`）→ 索引中只有 `n.md`，无临时文件、无重复。
- 同目录改名到 `.k` / `node_modules` → 按移出处理；移入 `.trash` → 删除；从 vault 外移入 → 新建。
- 删除最后一个 md → 文件夹按「空 / 非空」规则正确进出索引（发布时重算）。
- `.obsidian/workspace.json` 写入不产生任何事件（未 watch）。
- 模拟 `Q_OVERFLOW` → 全量重建，重建期间旧快照可搜，BFS 期间队列被 drain；两次重建间隔 ≥60s。
- 根目录不可读 → 构建失败、旧快照保留。
- watcher 线程 panic → `catch_unwind` 后重新全量，最终恢复可搜。
- 排序：查「单词」同分时最新 mtime 笔记第一；查「阅读理解」空骨架排在有内容文件夹与笔记之后。
- 接口：非 admin `notes` 为空；空 q；129 个汉字 400、128 个通过；`vault_resolve` 首建中 503。

前端（vitest）：
- 首屏：输入 → 两段渲染、段序按最高分；stale 响应被丢弃（**先注释守卫验红**）；
  有 agent 的目录行一击调用 `onCreate`；无 agent 行进 pick-type 后直接创建、不进 pick-prompt；
  笔记行调用 `onOpenVault`；非 vaultEnabled 不渲染笔记段；返回 quick 保留查询词。
- `resolveWikiLink` 对 503 返回「索引中」而非 null（`api.ts:459` 现为 `if (!res.ok) return null`）。
- 弹层打开调用一次 `warmSearchIndex`。
- VaultReader：`target` nonce 变化打开笔记 / 定位文件夹并清空查询；搜索结果点文件夹清空查询。
- App：已有 doc tab 时复用最近创建的，不新增 tab。

手机真机验收（iOS Safari）：键盘弹起时输入框与结果区前 3 条可见；结果区滚动不带动输入框。

## 风险

- vault 全量遍历 + 挂 watch ≈ 52s（实测 51.5s）JuiceFS 元数据操作：启动一次 + 每 6 小时一次 + 溢出时（间隔 ≥60s）。
- inotify 只覆盖经本机 FUSE 挂载点的写入；其他主机直写同一 JuiceFS 的变更最迟 6 小时后可搜。
  当前所有写入方（zeromux agent、本机 Obsidian 容器、remotely-save 同步落盘）均经本机 FUSE 挂载点。
  Obsidian 容器当前 bind mount 宿主 JuiceFS 挂载（同一 superblock）；若日后改为容器内自挂 juicefs，
  它就成了「其他客户端」，实时性失效。
- Mac 端新笔记的可搜时效 = remotely-save 拉取周期 + ~1s，不是本功能能缩短的。
- watch 数 ≈ vault 目录数（~1900，上限 248967）；Obsidian 在 vault 内新建大量目录（如解压附件包）
  时线性增长；`ENOSPC` 时该目录退化为 6 小时周期全量（1d）。
- 本机 JuiceFS 重新挂载会使所有 watch 失效（内核对 superblock 上全部 watch 发 `UNMOUNT` + `IGNORED`）→
  请求全量重建；卸载到重挂的间隙根 `read_dir` 失败，按构建失败退避重试，不会建出空索引。
  `zeromux.service` 不依赖 `juicefs.service`，两者独立重启。
- 启动后前 ~52s 内 vault 搜索 / wikilink 解析不可用（`indexing` / 503）——相比现在整站 46s 不可用是净改善。
- deploy.sh 的 90s 健康检查窗口可在本改动上线后另议缩短（本 spec 不改）。
- 5000 条目录上限：当前 650，余量充足。
