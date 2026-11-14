import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'

export const RegistryEntrySchema = z.strictObject({
  id: z.string().min(1),
  title: z.string(),
  path: z.string().min(1),
  createdAt: z.string(),
  lastOpenedAt: z.string().nullable()
})
export type RegistryEntry = z.infer<typeof RegistryEntrySchema>

const RegistryFileSchema = z.strictObject({
  version: z.literal(1),
  projects: z.array(RegistryEntrySchema)
})

/** 项目库：只存「从哪里打开」，权威状态永远在项目自己的 noryth.db。 */
export class ProjectRegistry {
  constructor(private readonly file: string) {}

  list(): RegistryEntry[] {
    if (!existsSync(this.file)) return []
    try {
      const parsed = RegistryFileSchema.safeParse(JSON.parse(readFileSync(this.file, 'utf8')))
      if (!parsed.success) return []
      return [...parsed.data.projects].sort((a, b) => {
        const at = a.lastOpenedAt ?? a.createdAt
        const bt = b.lastOpenedAt ?? b.createdAt
        return bt.localeCompare(at)
      })
    } catch {
      return []
    }
  }

  find(id: string): RegistryEntry | null {
    return this.list().find((entry) => entry.id === id) ?? null
  }

  findByPath(path: string): RegistryEntry | null {
    return this.list().find((entry) => entry.path.toLowerCase() === path.toLowerCase()) ?? null
  }

  add(entry: RegistryEntry): RegistryEntry {
    const projects = this.list().filter((item) => item.id !== entry.id && item.path !== entry.path)
    projects.push(entry)
    this.write(projects)
    return entry
  }

  update(id: string, patch: Partial<Omit<RegistryEntry, 'id'>>): RegistryEntry | null {
    const projects = this.list()
    const index = projects.findIndex((entry) => entry.id === id)
    if (index < 0) return null
    const next = { ...projects[index]!, ...patch }
    projects[index] = next
    this.write(projects)
    return next
  }

  remove(id: string): boolean {
    const projects = this.list()
    const kept = projects.filter((entry) => entry.id !== id)
    if (kept.length === projects.length) return false
    this.write(kept)
    return true
  }

  private write(projects: RegistryEntry[]): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, projects }, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }
}
