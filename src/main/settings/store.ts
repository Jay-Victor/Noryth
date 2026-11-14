import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { SettingsSchema, SettingsPatchSchema, type Settings, type SettingsPatch } from '../../shared/schema/project'

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
    const next = SettingsSchema.parse({ ...this.read(), ...SettingsPatchSchema.parse(patch) })
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(tmp, this.file)
    return next
  }
}
