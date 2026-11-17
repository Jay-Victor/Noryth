# 阶段 17 · DOCX 导出

> 阶段 17 / 18（M1 第 7 阶段）｜ 依赖：16 ｜ 下游：18
> 对应：`docs/DEV-PLAN.md` §5.5、§9.8、§12.6（M1-6、M1-14）
>
> **一句话目标**：Markdown / TXT 之外，导出可投稿的 DOCX；导出仍是快照，不是新真相。

## 1 本阶段要证明什么

| # | 假设 | 验证方式 |
|---|---|---|
| 1 | DOCX 可被 Word / WPS 打开 | 解压检查 `word/document.xml`；本机 Word/WPS 打开一次 |
| 2 | 导出只读 | 不产生 revision；hash 与当前 revision 一致 |
| 3 | 批注可选且不改正文 | 「仅正文」/「正文 + 批注」两档输出不同 |
| 4 | 30 章导出不卡 | <2s（不含模型）；内存不飙 |
| 5 | 文件可复现 | 同 revision 两次导出文本一致（zip 时间戳归一） |

## 2 范围

### 2.1 做

- M1-6：DOCX 导出（章标题、正文、分页、可选目录）。
- M1-14：导出批注与格式选项（仅正文 / 正文 + 批注；字体 / 字号 / 行距）。
- 引入 `docx` 纯 JS 库（无原生模块）；输出到 `exports/`。
- 扩展现有 `export.run`：`format: 'md' | 'txt' | 'docx'`，保持只读。

### 2.2 不做

- PDF、EPUB（M2 / 不做）。
- 封面生成、插图、排版模板市场。
- 导入 DOCX、云导出 / 分享。
- Word 原生批注（跨版本兼容差；用章末「修订建议」小节）。

## 3 交付物

| 交付物 | 路径 | 验收 |
|---|---|---|
| DOCX 生成 | `src/main/doc/export-docx.ts` | 可打开；标题 / 段落 / 分页 |
| 选项 schema | `src/shared/schema/export.ts` | format、scope、includeNotes、toc、font |
| UI | `src/renderer/pages/write/ExportDialog.tsx` | 三档选项；预估文件名 |
| 测试 | `tests/unit/doc/docx.test.ts`、`tests/e2e/export.spec.ts` | `E2E-M1-DOCX-01` |
| 依赖 | `package.json` | `docx` 纯 JS；打包冒烟 |

## 4 任务分解

| ID | 任务 | 依赖 | 完成标准 |
|---|---|---|---|
| M1-6 | DOCX 生成 | G3、B3 | 可打开；章节顺序正确 |
| M1-14 | 选项（批注 / 字体 / 行距） | M1-6、A4 | 两档输出不同；XML 断言通过 |
| M1-6 | 导出性能 + 安全 | G3、B3 | 30 章 <2s；无 Key / 正文外泄；路径不越界 |
| M1-6 | E2E DOCX 回归 | M1-6、M1-14 | `E2E-M1-DOCX-01` |

## 5 实现要点

### 5.1 生成

- 输入：范围（当前章 / 全书）、revision 清单（final 优先；未定稿章可选 draft 并标「草稿」）。
- 结构：标题页（书名 / 作者 / 日期）→ 目录（可选）→ 每章标题 + 场景分隔 + 拍正文段落。
- 段落：中文首行缩进 2 字符；行距 1.5；默认「宋体」/ 西文 Times New Roman；字号 12pt（可配 10.5 / 12 / 14）。
- 分页：每章前分页；场景间空行，不分页。
- 批注：`includeNotes` 时在章末附「修订建议」小节（来自最近报告），不写 Word 批注；标题明确「仅建议，未改正文」。
- 文件属性：`revision` / `content_hash` 写 core properties；文件名 `exports/<书名>-<日期>.docx`。
- 只读：从 `revision_beat` 清单渲染；不调用 `commitBeat`；不写 `outbox`；不产生 revision。
- 未定稿章：`draft.get_chapter` 只读快照，标注「草稿」，不冒充定稿。

### 5.2 选项 schema

```ts
{
  format: 'md' | 'txt' | 'docx',
  scope: 'chapter' | 'book',
  includeNotes: boolean,
  toc: boolean,
  font: '宋体' | '思源宋体',
  fontSize: 10.5 | 12 | 14,
  lineSpacing: 1.15 | 1.5 | 2
}
```

- 默认：`docx`、`book`、`includeNotes=false`、`toc=true`、宋体 12 / 1.5。
- 选项只影响导出，不改项目设置；不写 `settings.json`。
- 文件名冲突：追加序号，不覆盖已有导出。
- 路径校验：目标必须在项目 `exports/` 下；拒绝 `..` 与绝对路径注入。

### 5.3 测试

- 解压 DOCX 检查 `word/document.xml` 含所有章标题与每章首段；不含 Key、日志、`secrets.bin` 字符串。
- 同 revision 两次导出：文本内容一致；zip 时间戳固定（2000-01-01）保证可复现。
- Word 兼容：本机 Word / WPS 打开一次（手工清单）；CI 只做 XML 断言。
- 性能：30 章 14 万字 <2s；内存 <600MB。
- 批注档：正文段落逐字一致，仅文末多出「修订建议」；two files diff 断言。

## 6 验收清单

- [x] `E2E-M1-DOCX-01`：导出全书 → 文件存在 → 解压 XML 含所有章标题与每章首段 → 无 Key / 日志字符串。（`tests/e2e/export.spec.ts`）
- [x] 仅正文 / 正文 + 批注两档输出不同；批注不改变正文段落。（`tests/unit/doc/docx.test.ts`：仅正文输出是批注档的逐字前缀）
- [x] 30 章导出 <2s；同 revision 两次导出文本一致。（`tests/perf/m0-baseline.spec.ts` + `tests/unit/doc/docx.test.ts` 字节一致）
- [x] 未定稿章导出标「草稿」；不产生 revision。（`tests/unit/doc/docx.test.ts` + E2E revision 计数不变）
- [x] 字体 / 字号 / 行距选项生效（XML 断言）。（`tests/unit/doc/docx.test.ts`）
- [x] 打包后 `docx` 依赖可用（无原生模块）；安装冒烟 PASS。（`pnpm dist` 159MB；`scripts/install-smoke.mjs` 新增 asar 路径断言 + PASS）
- [x] 导出路径不越出 `exports/`；同名文件不覆盖。（`tests/unit/doc/docx.test.ts`）

## 7 风险与回退

| 风险 | 触发 | 回退 |
|---|---|---|
| DOCX 库体积 / 兼容 | 包体增大、Word 打不开 | 纯 JS；按需加载；本机 Word/WPS 验收 |
| 样式与 Word 差异 | 排版错 | 只用基础样式；不做复杂模板 |
| 批注误解 | 以为改了正文 | 章末小节 + 「仅建议」标题 |
| 导出大书内存 | OOM | 分章构建；30 章实测 |
| 覆盖同名文件 | 丢稿 | 追加序号；不自动覆盖 |

## 8 进入下一阶段的条件

1. DOCX 可打开、结构正确、无 Key / 日志。
2. 两档批注与格式选项可用。
3. 30 章导出性能达标，可复现。
4. 导出只读不变式有测试。
5. 打包冒烟含 `docx` 依赖。

## 9 实现记录（2026-11-17）

| 交付 | 落点 | 说明 |
|---|---|---|
| DOCX 生成 | `src/main/doc/export-docx.ts` | 纯 JS `docx`（无原生模块）；标题页 → 目录（`TableOfContents`，条目由 Heading1 生成，Word 打开时更新页码）→ 每章标题分页 + 场景分隔（＊　＊　＊）+ 拍正文段落；首行缩进 2 字符；默认宋体 12pt / 1.5 倍行距 |
| 可复现 | 同上 `normalizeArchive` | zip 条目时间固定 2000-01-01；core 的 created/modified 归一化到导出日零点；目录书签名 `_TocN` 与 bookmark id 按出现顺序重编号（docx 的计数器跨文档累加，不归一化就不可复现） |
| 选项契约 | `src/shared/schema/export.ts` | `format: md \| txt \| docx`、`scope`（缺省按 chapterId 推断）、`includeNotes`、`toc`、`font`、`fontSize`、`lineSpacing`、`author`（只进标题页）；结果补 `format` / `drafts` |
| 统一版本口径 | `src/main/doc/export.ts` | 三档格式都从 `revision_manifest` 渲染：`finalized` 章读 final，其余章读 current draft 并标「草稿」；md 的注释行补 `draft` 标记；不带 revision 的章输出空章节，不退回 live 拍 |
| 批注档 | 同上 + `export-docx.ts` | 章末「修订建议」小节：标题 + 「仅建议，未改正文」+ 报告轮次 / provider + 条目；不写 Word 原生批注 |
| 路径与覆盖 | `export.ts` `resolveTarget` | 固定 `exports/`，解析后必须在目录内；同名追加 `-2`、`-3`，不覆盖 |
| UI | `src/renderer/pages/write/ExportDialog.tsx` + `WritePage.tsx` | 预览 header「导出」；三档格式、本章 / 全书、仅正文 / 正文 + 修订建议、DOCX 字体 / 字号 / 行距 / 目录 / 作者；预估文件名；只读锁下仍可用 |
| 依赖 | `package.json` | `docx@9.15.4` + `fflate@0.8.3`（均纯 JS）；`externalizeDepsPlugin` 保持外部化，随 `node_modules` 进包 |
| 测试 | `tests/unit/doc/docx.test.ts`、`tests/e2e/export.spec.ts` | 解压 XML 断言、字节可复现、两档差异、选项、草稿 / 定稿、同名与越界；`E2E-M1-DOCX-01` |
| 测试基建 | `tests/support/unzip.ts` | 支持 deflate（方法 8），DOCX 与诊断包共用同一个读取器 |

边界说明：

- 导出不产生 revision、不写 outbox、不改正文；只读锁下 `export.run` 仍可用（不是 mutation 通道）。
- 目录页码由 Word / WPS 首次打开时更新（`w:updateFields` + dirty 域）；预生成条目保证不更新也不会是空白目录。
- 未定稿章一律标「草稿 · 尚未定稿」，不冒充定稿；定稿章只读 final 清单，旧 final 不冒充当前稿。
- 本阶段未改 schema（`LATEST_SCHEMA_VERSION = 10`）。
