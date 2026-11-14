# ADR-0001 向量检索：sqlite-vec（Plan A）

- 状态：已决定
- 日期：2026-11-14
- 对应：PHASE-01 S1、DEV-PLAN §5.6 / §12.3.1

## 背景

记忆检索需要按 `character_id + as_of` 过滤后再做向量近邻。DEV-PLAN 给出两条路线：

- Plan A：`sqlite-vec` loadable extension，与状态同库，无双写；
- Plan B：`memory_entry_embedding(embedding BLOB)` + 进程内余弦。

S1 的通过线：dev 与 NSIS 打包产物都能 `loadExtension`，20k 条查询 P95 < 80ms。

## 证据（本机 Windows 11，Electron 45.2.3 / better-sqlite3 13.1.1 / sqlite-vec 0.1.9）

| 项 | 结果 |
|---|---|
| Electron main 加载扩展 | 通过，`vec_version() = v0.1.9`，SQLite 3.54.1 |
| vec0 DDL | `CREATE VIRTUAL TABLE memory_vec USING vec0(memory_id TEXT PRIMARY KEY, embedding FLOAT[512])` 可用 |
| 写入 20,000 条 512 维向量 | 597ms（单事务） |
| 40 次 top-10 查询 | P95 = 33.64ms |
| 打包产物 | `release/win-unpacked` 启动后建项目成功；0001 迁移包含 vec0 虚拟表，证明打包 main 也加载了扩展 |

说明：打包验证使用 `Noryth.exe` 实际创建项目（迁移包含 `CREATE VIRTUAL TABLE ... USING vec0`），不是只打开窗口。

## 决定

采用 **Plan A：sqlite-vec**。

- 扩展以 `resources/native/vec0.dll` 随包分发（`extraResources` → `resources/native`），开发期由 `scripts/prepare-native.mjs` 从 `node_modules` 复制；不依赖 asar 内的 node_modules 布局。
- `memory_vec` 虚拟表在 `0001_init.sql` 中创建；建库必须先加载扩展，缺失时报 `vector_unavailable`。
- 维度 512，模型 `bge-small-zh-v1.5`（见 ADR-0004）。

## 后果

- Windows x64 之外的平台不能加载扩展；与 PRD 的 Windows 首发范围一致。
- 升级 sqlite-vec 需要重新跑打包冒烟（`loadExtension` + 20k 查询）。
- `asarUnpack` 保留 `**/vec0.*` 与 `sqlite-vec*/**`，因为 `better-sqlite3` 的 `.node` 也需要解包。

## 回退

如果后续 Electron 升级导致扩展不可加载：

1. 不改 `0001`，新增 `0002_embedding_blob.sql` 增加 BLOB 列；
2. `memory_vec` 保留但不再写入；
3. 检索走进程内余弦（DEV-PLAN Plan B）；
4. 在 ADR 追加记录，不删除本文件。
