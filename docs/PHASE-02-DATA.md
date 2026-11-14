# 阶段 02 · 数据层与状态权威

> 阶段 2 / 10 ｜ 依赖：01 ｜ 下游：03–10
> 对应：`docs/DEV-PLAN.md` §5、§9.2、§12.3（B2–B5）
>
> **一句话目标**：让 SQLite 成为唯一真相：正文、revision、叙事序、镜像、备份都能被复算、校验、恢复。

## 1 本阶段要证明什么

| # | 假设 | 验证方式 |
|---|---|---|
| 1 | PRD §7.3 的六条结构约束能在 DB 层强制 | 逐条写违反约束的测试，必须失败 |
| 2 | 同一份正文两次计算 hash 一致，顺序变化会变 | 固定 fixture 双跑 + 换序 |
| 3 | 一次拍提交只写 1 行正文 + N 行清单，不复制整章 | 检查 SQL 与行数 |
| 4 | Markdown 镜像可失败、可重试、可检测外部改动 | 杀进程/改文件测试 |
| 5 | 备份可恢复，恢复后 `db.verify()` 通过 | `VACUUM INTO` + 恢复演练 |

## 2 范围

### 2.1 做

- B2：repos（project/outline/character/chapter/scene/beat/revision/patch/memory/world/review/job/tool_call）。
- B3：`seq` 分配、revision 清单、内容 hash、`db.verify()`。
- B4：outbox、Markdown 镜像、外部编辑检测。
- B5：备份、恢复、检查点、保留策略。
- 测试 fixture：5 角色、2 章、每章 3 场 24 拍的合成项目。

### 2.2 不做

- 业务状态迁移（拍/章状态机）→ 阶段 07。
- 工具 handler、授权、审计 → 阶段 03。
- 审批/记忆管线 → 阶段 08–09。
- 任何 UI 页面；只允许一个只读的 DB 调试视图。

## 3 交付物

| 交付物 | 路径 | 验收 |
|---|---|---|
| Repos | `src/main/db/repos/*.ts` | 只做 SQL 与映射，不含业务判断 |
| Seq 分配 | `src/main/db/seq.ts` | 只在写事务内递增；`RETURNING` 可用 |
| Revision | `src/main/db/revision.ts`、`hash.ts` | 清单可建、hash 可复算 |
| Outbox | `src/main/db/outbox.ts`、`src/main/doc/mirror.ts` | 原子写、失败重试、hash 校验 |
| 备份 | `src/main/db/backup.ts` | `VACUUM INTO`；恢复校验 schema |
| 校验 | `src/main/db/verify.ts` | 孤儿/双活/单调/镜像五类检查 |
| 测试 | `tests/unit/db/*`、`tests/fixtures/m0-a/*` | 约束逐条覆盖 |

## 4 任务分解

| ID | 任务 | 依赖 | 完成标准 |
|---|---|---|---|
| B2 | repos：project/outline/character/chapter/scene/beat/revision/patch/memory/world/review/job/tool_call | B1 | 单测覆盖 CRUD 与 C1–C9 约束 |
| B3 | `seq` 分配、revision 清单、hash、`db.verify()` | B2 | 双跑 hash 一致；换序 hash 变化 |
| B4 | outbox、Markdown 镜像、外部编辑检测 | B2 | 外部改动 → `file_conflict`，不覆盖 |
| B5 | 备份、恢复、检查点、保留策略 | B2 | `VACUUM INTO` 可打开；恢复校验通过 |

## 5 实现要点

### 5.1 `seq` 分配

```
UPDATE project SET seq_head = seq_head + 1 WHERE id = ? RETURNING seq_head
```

- 只在写事务内调用；一拍一个 seq；同一次记忆应用的多条条目共享同一个 seq。
- `memory_entry.learned_seq` 用来源 `beat.seq`，不重新分配。
- `chapter.covered_until_seq` = 本章 `confirmed/author_edited` 拍的最大 seq。

### 5.2 revision 清单

- `beat` 是正文版本，替换时标 `superseded`，不物理删除。
- `revision` 是清单头，`revision_beat` 是成员；一次提交复制父清单再替换一拍。
- `content_hash` 的规范形式固定为：按 `chapter_scene.ord`、`beat.ord` 拼接 `speaker_type:speaker_id\nbody\n\n`，sha256。
- hash 在插入 revision 前算好，revision 只 INSERT，无 UPDATE/DELETE。

### 5.3 outbox 与镜像

1. 同一事务写 `outbox`。
2. 提交后写临时文件 → `fsync` → `rename`。
3. 磁盘 hash 与 `expected_hash` 不一致 → `publish_pending`，指数退避重试，最多 5 次。
4. 打开/切章/保存前比对 `mtime + size + hash`；不一致冻结该章写入。

### 5.4 备份与校验

- 每章定稿后 `VACUUM INTO backups/checkpoint-<seq>.db`；每日首次打开复制项目文件夹。
- 保留 10 个检查点 + 7 个日备份；恢复前 `integrity_check` + `schema_version`。
- `db.verify()` 检查：`integrity_check`、`foreign_key_check`、孤儿 revision/beat、双活拍、seq 单调、镜像 hash。

### 5.5 repo 边界

- repo 只做「事务内的读写原语」，不判断「能不能写」。
- 任何 `beat.body` 的写入只能通过阶段 07 的 `DocController`；本阶段测试用 test-only writer，并打标记。

## 6 验收清单

- [ ] C1 章内场景顺序唯一；C2 一拍只有一个现行版本；C3 一拍只被替换一次。
- [ ] C4 单值槽同时只有一个有效事实；C5 关系边每轴一条有效边。
- [ ] C6 记忆只被取代一次；C7 任务幂等键唯一；C8 工具幂等键唯一；C9 闸门令牌唯一。
- [ ] 同一清单两次 `hashManifestRows` 结果一致；换顺序结果变化。
- [ ] 一次拍提交后，`revision_beat` 行数 = 场景数 × 拍数。
- [ ] 外部改 `manuscript/ch-001.md` → `file_conflict`，DB 不被覆盖。
- [ ] 杀进程后 outbox 重试成功；hash 相同则跳过。
- [ ] 备份恢复到新目录后 `db.verify()` 全绿。
- [ ] 30 章 / 120k 字合成项目打开 < 800ms。

## 7 风险与回退

| 风险 | 触发 | 回退 |
|---|---|---|
| DDL 约束写错 | 违反约束的测试没失败 | 先在 SQL 层修，不在应用层补 |
| WAL 放在同步盘 | `file_conflict` 频发 | 新建项目时警告；备份改为导出 |
| hash 规范漂移 | 两端 hash 不同 | 规范写进 `hash.ts` 注释 + 固定 fixture |
| 备份占用过大 | `backups/` 膨胀 | 默认保留数可配；只保留检查点与日备份 |

## 8 进入下一阶段的条件

1. `0001_init.sql` 不再改；需要改必须新增迁移。
2. C1–C9 每条都有失败用例与通过用例。
3. `db.verify()` 在 fixture 与合成 30 章项目上都全绿。
4. 镜像冲突、outbox 重试、备份恢复三条路径各演练一次。
5. 没有第二处写 `beat.body` 的代码路径（grep 证明）。
