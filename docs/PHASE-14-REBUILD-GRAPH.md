# 阶段 14 · 记忆重建、关系图与嵌入升级

> 阶段 14 / 18（M1 第 4 阶段）｜ 依赖：13 ｜ 下游：15–18
> 对应：`docs/DEV-PLAN.md` §10.5–§10.7、§12.6（M1-4、M1-5、M1-20）
>
> **一句话目标**：改稿后能按章重建记忆（旧记忆 inactive），关系能回放，检索从 hash 降级切到 bge。

## 1 本阶段要证明什么

| # | 假设 | 验证方式 |
|---|---|---|
| 1 | 按章重建不物理删除 | 旧条目 `inactive`；新条目 `active`；历史可追溯 |
| 2 | 重建幂等 | 同一 job 重放 `duplicate`；不双写 |
| 3 | 关系图可按 as-of 回放 | 滑杆切换边值；来源可点开 |
| 4 | bge 权重可用且不拖垮启动 | 冷启动 <1.5s；512 维；缺失时明确降级 |
| 5 | 索引重建不混模型 | 向量通道按 `embedding_model` 过滤；混合模型不互相召回 |

## 2 范围

### 2.1 做

- M1-4：按章重建 + 审计（T40 从 `enabled=false` 到实现）。
- M1-5：关系图（节点 / 边 / 回放 / 来源）。
- M1-20：bge 权重随包 + `index.rebuild`（系统能力 + IPC）。
- 记忆台 tabs 补齐（关系图、审计；`tool_call` 面板在阶段 18）。
- 不新增迁移：`memory.rebuild` / `index.rebuild` 的 job type 已在 0001 的 CHECK 里。

### 2.2 不做

- 全量重建整个项目（M2；M1 只按章 + 按模型）。
- 关系图编辑（只读；边由记忆应用写）。
- 自动识别关系变化（仍由提案）。
- 低分归档（P2）。

## 3 交付物

| 交付物 | 路径 | 验收 |
|---|---|---|
| T40 重建 | `src/main/memory/rebuild.ts` | 旧条 inactive；新提案 → apply；审计 |
| 关系图 | `src/renderer/pages/memory/RelationshipGraph.tsx` | SVG 节点 / 边；滑杆；来源面板 |
| 关系投影 | `src/main/world/relations.ts` | as-of 过滤；单 / 双向 |
| bge | `resources/models/bge-small-zh-v1.5/*`、`src/main/memory/embed/*` | 冷启动 / 维度 / 失败降级 |
| 索引重建 | `src/main/memory/reindex.ts` + IPC | 分批；可恢复；`author_confirm` |
| 测试 | `tests/unit/memory/rebuild.test.ts`、`tests/e2e/memory-m1.spec.ts` | `E2E-M1-REBUILD-01` |

## 4 任务分解

| ID | 任务 | 依赖 | 完成标准 |
|---|---|---|---|
| M1-4 | 按章重建 + 审计 | H3、G3 | inactive / active 计数；不物理删 |
| M1-5 | 关系图 + 回放 | M1-3、M1-4 | 回放与来源；私有记忆不显示 |
| M1-20 | bge 权重随包 | J4、ADR-0004 | 冷启动 <1.5s；包体目标 <250MB |
| M1-20 | `index.rebuild` | H3、M1-20 | 分批、可恢复、`author_confirm` |
| 记忆台 | 关系图 / 审计 tab | M1-4、M1-5 | 三 tab 可导航；只读 |

## 5 实现要点

### 5.1 按章重建

```
memory.rebuild(chapterId) [author_confirm]
  → 校验令牌 + 幂等键 memory.rebuild:<project>:<chapter>:<finalRevision>
  → 读当前 final revision；未定稿 / 无 final → invalid_args
  → 事务外：以 final 构建 extraction input，生成新条目（模型调用）
  → 单事务：
      旧条目 source_chapter_id = chapter → status='inactive'
      旧事实 / 边按来源映射 → valid_to_seq = 新 seq
      写新 memory_entry + memory_vec + memory_fts + world_fact + belief + edge + 审计
      消费令牌；job=applied
  → 失败整体回滚：旧条目仍 active、旧事实/边未关、令牌可重试
  → 输出 inactive_count / rebuilt_count
```

- T40 是**整章重建**（作者已用 `author_confirm` 授权），不逐条提案；结果可在记忆台逐条复核、软失效。
- 重建事务复用 `memory/apply.ts` 的写入原语（单事务 + 审计 + 向量）；不新建第二个世界状态写入口。
- 不物理删除；`memory_audit(action='rebuild')` 一条汇总 + 每条 `invalidate`。
- 世界事实 / 边的来源映射：`source_type='event'` → `source_id` 是拍 → 拍所属章；`source_type='memory'` → `source_id` 是记忆条目 → `source_chapter_id`；`source_type='author'` 不因重建失效（作者手写优先）。
- 只读 final revision；初稿不参与；未定稿或无 final → `invalid_args`。
- 关系边按 `(from, to, axis)` 关旧插新；世界单值槽复用 apply 规则。
- `author_confirm` 令牌由主进程在作者点击「按章重建」时签发（10 分钟、只存 hash）；重试复用，成功后才消费。重开再定稿由 `finalize` 自动入队时，G6 记录即授权，不再单独签发。
- 若作者想逐条审提案，走阶段 09 的抽取/提案流程；T40 不混用两套语义。

### 5.2 关系图

- 节点 = 角色（active）；边 = `relationship_edge`，三轴分色（trust / intimacy / tension）。
- as-of 过滤：`since_seq <= as_of AND (valid_to_seq IS NULL OR valid_to_seq > as_of)`。
- 宽度 = `|value|`；虚线 = 单向（无反向边）；不显示私有记忆文本。
- 点边 → 来源（`source_type` / `source_id` → 章 / 拍 / 记忆）；只读。
- 布局用确定性圆环（同数据同坐标，便于测试）；不做拖拽持久化、不做力导向动画。
- >50 角色时分页/聚焦某角色邻域；不为性能引入 canvas（SVG + memo 足够）。

### 5.3 bge 与索引

- 权重：`model.onnx` + tokenizer + config 放 `resources/models/bge-small-zh-v1.5/`；`extraResources` 已就位。
- 运行时：把 `@huggingface/transformers` 从 devDependency 提升为 dependency，并在打包时带上 onnxruntime 原生模块；`asarUnpack` 覆盖 `.node`。
- 启动：懒启动，warmup 2 条；空闲 5 分钟退出；失败降级 `hash-bigram-v1`，写日志与 UI 提示。
- `index.rebuild`：按 `memory_entry.embedding_model != target` 分批 32 条重算；每批一个事务；失败可重试；`author_confirm`；不阻塞正文。
- 检索：向量通道只查 `embedding_model = 当前模型`；关键词通道不限；混合模型时 UI 显示「索引待重建」。
- 体积 / 冷启动门槛：>250MB 或 >1.5s → 回退 q4 / 更小模型（ADR-0004 D7）。

## 6 验收清单

- [ ] `E2E-M1-REBUILD-01`：定稿 → 应用记忆 → 重开定稿 → 重建 → 旧条 inactive、新条 active、关系 / 事实有效期正确；`db.verify()` 绿。
- [ ] 重建重放 `duplicate`，不双写；无令牌 `gate_required`；失败令牌可重试。
- [ ] 关系图 as-of 回放：两个 as_of 边值不同；点边显示来源；无私有记忆文本。
- [ ] 确定性布局：同数据两次渲染节点坐标一致（容差 1px）。
- [ ] bge 冷启动 <1.5s、单条 <120ms、512 维（本机）；缺失时降级不崩。
- [ ] `index.rebuild` 中途杀进程 → 重启可续；无半条向量。
- [ ] 记忆台关系图 / 审计 tab 可用；按章重建按钮不再禁用。
- [ ] 打包后 `resources/models` 存在，安装冒烟仍 PASS。

## 7 风险与回退

| 风险 | 触发 | 回退 |
|---|---|---|
| 重建误删 | 物理删除 | 只 inactive；审计；测试 |
| 关系图性能 | 30 角色卡顿 | 圆环布局；SVG memo；邻域聚焦 |
| bge 体积 | 安装包 >250MB | q4 / 更小模型；权重可选下载（M2） |
| 混合模型召回错 | 语义乱 | 按模型过滤；关键词兜底；UI 提示 |
| `index.rebuild` 长事务 | WAL 膨胀 | 分批提交；可恢复 |

## 8 进入下一阶段的条件

1. 重建链路通过，旧记忆 inactive 可追溯。
2. 关系图回放与来源可用，且不泄露私有记忆。
3. bge 或明确降级有记录；打包冒烟 PASS。
4. `index.rebuild` 有 `author_confirm` 与恢复路径。
5. 检索隔离回归仍通过（跨角色 0 命中）。
