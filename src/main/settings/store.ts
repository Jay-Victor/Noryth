import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { SettingsSchema, SettingsPatchSchema, type Settings, type SettingsPatch } from '../../shared/schema/project'

/**
 * settings.json 读写（PHASE-01 A6 / PHASE-10 I1–I4）。
 *
 * Key 永远不在这里：Key 由 `settings/secrets.ts` 加密后单独存 secrets.bin。
 * 外观按浅合并写入，其余键保持「整体替换」语义，避免旧调用方（项目打开、
 * 探测快照）互相覆盖掉对方没碰过的字段。
 */
export class SettingsStore {
  constructor(private readonly file: string) {}

  read(): Settings {
    if (!existsSync(this.file)) return SettingsSchema.parse({})
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      const parsed = SettingsSchema.safeParse(raw)
      return parsed.success ? parsed.data : SettingsSchema.parse({})
    } catch {
      return SettingsSchema.parse({})
    }
  }

  write(patch: SettingsPatch): Settings {
    const parsed = SettingsPatchSchema.parse(patch)
    const current = this.read()
    const merged: Record<string, unknown> = { ...current, ...parsed }
    if (parsed.appearance !== undefined) {
      merged.appearance = { ...current.appearance, ...parsed.appearance }
      // 旧字段与外观里的主题保持一致：仍读 theme 的调用方不会分叉。
      if (parsed.appearance.theme !== undefined) merged.theme = parsed.appearance.theme
    }
    if (parsed.routing !== undefined) {
      // 开关 / 触发条件 / 冷却是浅合并；agents 是按整张表替换（UI 每次提交完整表，
      // 这样删掉某一行才真的生效），避免旧备用家在作者清空后又被合并回来。
      merged.routing = {
        ...current.routing,
        ...parsed.routing,
        ...(parsed.routing.agents === undefined ? { agents: current.routing.agents } : {})
      }
    }
    const next = SettingsSchema.parse(merged)
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(tmp, this.file)
    return next
  }
}
