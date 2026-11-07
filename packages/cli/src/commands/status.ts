import type { Settings } from '@noryth/core';
import type { StatusSummary } from '@noryth/store';
import type { Warning } from '../output.js';
import { openProject } from './project.js';

export interface ProjectView {
  root: string;
  schemaVersion: number;
  project: StatusSummary['project'];
  branch: StatusSummary['branch'];
  scene: StatusSummary['scene'];
  chapters: StatusSummary['chapters'];
  openClues: number;
  budget: { limitCny: number; spentCny: number | null };
  warnings: Warning[];
}

function view(root: string, status: StatusSummary, settings: Settings, warnings: Warning[]): ProjectView {
  return {
    root,
    schemaVersion: status.project.schemaVersion,
    project: status.project,
    branch: status.branch,
    scene: status.scene,
    chapters: status.chapters,
    openClues: status.openClues,
    budget: { limitCny: settings.budget.perProjectCny, spentCny: null },
    warnings,
  };
}

export function runStatus(dirArg?: string): ProjectView {
  const opened = openProject(dirArg);
  try {
    return view(opened.root, opened.status, opened.settings, opened.warnings);
  } finally {
    opened.close();
  }
}

export function runOpen(dirArg?: string): ProjectView {
  return runStatus(dirArg);
}

export function formatView(v: ProjectView): string[] {
  const lines = [
    `${v.project.name} · schema v${v.schemaVersion}`,
    `  路径   ${v.root}`,
    `  项目   ${v.project.id}`,
    `  分支   ${v.branch.name} · head ${v.branch.headSeq}`,
    v.scene
      ? `  场景   ${v.scene.title} · ${v.scene.state} · ${v.scene.beats}/${v.scene.maxBeats} 拍 · 冲突 ${v.scene.conflictLevel}`
      : '  场景   （无进行中的场景）',
    `  章节   ${v.chapters.count} 章 · ${v.chapters.words.toLocaleString('zh-CN')} 字`,
    `  线索   ${v.openClues} 条未回收`,
    `  预算   ${v.budget.limitCny > 0 ? `上限 ${v.budget.limitCny} 元` : '未设置上限'} · 已花费未统计（P0 无计费数据）`,
  ];
  return lines;
}
