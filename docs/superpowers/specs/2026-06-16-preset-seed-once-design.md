# 预设库首启播种（seed-once）设计

> 承接 [prompt-presets feature](2026-06-15-prompt-presets-design.md)、其[复审 + `{{input}}` 插值](2026-06-15-prompt-presets-fixes.md)，以及[内容设计（8 条）](2026-06-16-preset-content-library-design.md)。本文档把"8 条预设只活在 Markdown 里、靠人手 POST 才进线上库"这个结构缺口补上：**让 8 条随二进制版本化发布，首启自动播种**。

## 问题

内容设计文档定义了 8 条专业级预设，但它们**只存在于一份 Markdown**。要进到线上产品，得有人手动发 8 次 `POST /api/prompts`。任何一次全新部署 / 新数据库，用户看到的都是空态（`还没有常用 prompt`）——今天这次提交所"关于"的精心评审过的内容，从不随二进制发布，也不是运行代码读取的事实源。

## 目标 / 非目标

- ✅ 8 条预设作为**版本化、内嵌进二进制**的内容，首启确定性地出现在库里。
- ✅ 播种后库**完全归用户所有**：增/改/删/排序跨重启都生效；删光 8 条**不会**在下次启动复活。
- ✅ 对**已存在内容**的库（用户手动 POST 过，或将来已部署过）不堆叠、不产生近似重复。
- ❌ "恢复默认 / restore defaults"按钮（YAGNI——8 条留在二进制里，将来要做是一行的事，现在不做）。
- ❌ 每次启动 upsert 内建项（会复活用户删除的项 / 覆盖用户编辑——被 CTO+PM 双否）。
- ❌ 改动任何前端 / 路由 / 内容本身（8 条文案沿用内容设计文档，逐字内嵌）。

## 设计

### 播种判定：`PRAGMA user_version`，而非"表为空"

PM 锁定的头号风险：线上 DB 跨 `./deploy.sh` 持久存在，"新部署 ≠ 新 DB"。因此**不能**用"表为空"做判定（会复活被删项 / 在每次升级时重注）。用 SQLite 的 `PRAGMA user_version`（库头里的一个整数，零 DDL）作"是否已播种"标记。

**判定与动作（单次持锁、单个事务内完成）：**

```
v = PRAGMA user_version
if v >= 1:            # 已播种过 → 永不再碰，尊重用户所有删/改
    return Ok(0)
count = SELECT COUNT(*) FROM prompt_presets
tx:                   # 插入 + 标记同处一个事务（全或无）
  if count == 0:      # 全新空库才插，绝不堆叠到用户已有内容上
    for i, (title, body) in SEED_PRESETS.enumerate():
      INSERT (id=short_uuid, title, body, now, now, sort_order=i+1)
  PRAGMA user_version = 1   # SQLite 把 user_version 存在库头，写入是事务性的
commit
return Ok(inserted_count)
```

`user_version` 的写入与 8 条插入**同处一个事务**：SQLite 把 `user_version` 存在数据库头里、其写入受事务约束，所以"播种内容 + 已播种标记"原子落盘（要么都成、要么都不成）。播种中途崩溃整体回滚，下次启动从零干净重播，**不存在"有行但未标记"的可达中间态**去复活被删项。空表检查仍然防止堆叠到用户手填的库上。

### 为什么"`user_version` 闸 + 空表检查 + 单事务"覆盖所有可达态

| 场景 | v | 表 | 结果 |
|---|---|---|---|
| 全新 DB | 0 | 空 | 插 8 条 + v=1（同事务）✓ |
| 用户已手动 POST 过 | 0 | 非空 | **跳过插入**，仅 v=1（不堆叠/不重复）✓ |
| 用户删光 8 条后重启 | 1 | 空 | 啥都不做（不复活）✓ |
| 播种事务中途崩溃 | 0 | 空（整体回滚，含 v） | 下次启动干净重播 ✓ |

因为插入与 `user_version=1` 在**同一事务**里，不存在"行已落盘但标记没落盘"的中间态——这正是把标记移进事务（而非 commit 后单独写）消除的窗口：否则"commit 后、置 v 前崩溃，用户再删光"会让下次启动错误重播。空表检查独立地防止堆叠到用户手填的库上。

### 8 条插入必须内联在单次持锁内（避免死锁）

`PromptPresetStore.conn` 是 `std::sync::Mutex`（非重入）。播种方法持锁后，**绝不能**调 `self.create()`（8 次各自再 `lock()` → 死锁）或 `self.list()`。所有 SQL 内联，复用模块私有的 `short_uuid()` / `now_iso()`。8 条插入用一个 `tx`（彼此原子），不复用 `create()` 的逐条事务。

### 接入点：`main.rs` 显式调用，不放进 `open()`

`open()` 保持纯净（现有单测在 tmpdir 上 `open()` 后断言 `list().len()==0` / 精确计数——若 `open()` 自动播种会全挂，且把 store 耦死到某一数据集）。新增独立方法 `seed_if_unseeded(&self, presets: &[(&str,&str)]) -> Result<usize, String>`，在 `main.rs` `PromptPresetStore::open(...)` 之后显式调用，`eprintln!` 播种条数（失败用 `expect`——内容是版本化编译期固定的，播种失败应在启动时炸出而非静默跳过）。

### 内容源：`src/prompts_seed.rs`

```rust
/// 版本化的预设内容，首启播种。人读源是 docs/.../2026-06-16-preset-content-library-design.md；
/// 这里是机器事实源。改文案两处都要动。
pub const SEED_PRESETS: &[(&str, &str)] = &[
    ("🔍 Explore codebase", r#"Task: Map how this codebase handles {{input}} ..."#),
    // ... 共 8 条，逐字取自内容设计文档
];
```

emoji 标题 + 多行 `{{input}}` body 用 `r#"..."#` 原始字符串，无需转义（无 body 含 `"#`）；`{{...}}` 在普通字面量里不是 Rust 格式语法，不会被 `format!` 处理（也不会对其 `format!`）。

## 测试（TDD，全在 `src/prompts.rs` 的 `#[cfg(test)]`）

1. `seed_inserts_eight_on_fresh_db`：`open` tmp → `seed_if_unseeded(SEED_PRESETS)` 返回 8；`list()` 长度 8，顺序、标题与 `SEED_PRESETS` 一致。
2. `seed_is_idempotent`：连播两次 → 仍 8 条（第二次返回 0）。
3. `seed_does_not_resurrect_after_delete_all`：播种 → 删光 → 再播种返回 0，`list()` 为空。
4. `seed_skips_when_prepopulated`：`open` → `create("x","y")` → `seed_if_unseeded` 返回 0，`list()` 仅那 1 条用户预设（无 8 条堆叠）；再播种仍不变。
5. `seed_content_within_caps`：遍历 `SEED_PRESETS`，断言每条 title 非空且 `chars().count() <= TITLE_MAX`、body 非空且 `<= BODY_MAX`（防将来文案回归超长被静默跳过）。
6. （回归）现有 `open`-后-空库断言保持通过（因 `open()` 不变）。

## 影响的文件

- 新增 `src/prompts_seed.rs`（8 条内容 const）。
- 改 `src/prompts.rs`：加 `seed_if_unseeded()` + 5 个测试；`mod` 引用 seed（或在 main.rs 引）。
- 改 `src/main.rs`：`mod prompts_seed;` + open 后一行播种调用 + 日志。
- 无前端 / 路由 / 内容文案改动。

## 部署后验证

`./deploy.sh --build` 后：① 全新身份打开应见 8 个 chip（sidebar + composer 两处）；② 删一条、重启服务，该条不复活；③ 若线上库此前已有用户预设，升级后不应出现重复的 8 条（仅标记已播种）。
