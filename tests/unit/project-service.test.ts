import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { AppError } from '../../src/shared/domain/app-error'
import { LOCK_FILE } from '../../src/main/lock'
import { LATEST_SCHEMA_VERSION } from '../../src/main/db/migrations'
import { validateNewProjectPath } from '../../src/main/project/paths'
import { makeService, tempDir } from './helpers'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function setup(): { userData: string; parent: string; cleanup: () => void } {
  const userData = tempDir('noryth-userdata-')
  const parent = tempDir('noryth-parent-')
  cleanups.push(userData.cleanup, parent.cleanup)
  return { userData: userData.path, parent: parent.path, cleanup: () => undefined }
}

const input = (parentDir: string, folderName: string) => ({
  parentDir,
  folderName,
  title: '黑漆匣子',
  genre: '悬疑',
  targetWords: 100_000,
  pov: 'third_limited' as const,
  boundaries: ''
})

describe('project service', () => {
  it('新建项目：五个子目录 + db + project 行 + G0，且登记到项目库', () => {
    const { userData, parent } = setup()
    const { service, registry } = makeService(userData)
    try {
      const result = service.create(input(parent, '黑漆匣子'))
      const dir = join(parent, '黑漆匣子')
      expect(result.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
      for (const sub of ['manuscript', 'assets', 'exports', 'backups', 'logs']) {
        expect(existsSync(join(dir, sub))).toBe(true)
      }
      expect(existsSync(join(dir, 'noryth.db'))).toBe(true)

      const db = new Database(join(dir, 'noryth.db'), { readonly: true })
      try {
        const project = db.prepare('SELECT * FROM project LIMIT 1').get() as Record<string, unknown>
        expect(project.title).toBe('黑漆匣子')
        expect(project.setup_state).toBe('pending')
        expect(project.schema_version).toBe(LATEST_SCHEMA_VERSION)
        expect(project.embedding_model).toBe('bge-small-zh-v1.5')
        const gate = db.prepare("SELECT * FROM gate_record WHERE gate_id = 'G0'").get() as Record<string, unknown>
        expect(gate.entity_id).toBe(result.projectId)
        expect(gate.actor).toBe('author')
        expect(JSON.parse(String(gate.payload_json)).title).toBe('黑漆匣子')
      } finally {
        db.close()
      }

      expect(registry.find(result.projectId)?.path).toBe(dir)
      expect(service.list()).toHaveLength(1)
      expect(service.currentResult()?.project.id).toBe(result.projectId)
      expect(existsSync(join(dir, LOCK_FILE))).toBe(true)
    } finally {
      service.dispose()
    }
  })

  it('重复创建到同一目录会失败，且不破坏已存在项目', () => {
    const { userData, parent } = setup()
    const { service } = makeService(userData)
    try {
      service.create(input(parent, '重复'))
      expect(() => service.create(input(parent, '重复'))).toThrowError(AppError)
      const list = service.list()
      expect(list).toHaveLength(1)
      expect(list[0]?.available).toBe(true)
    } finally {
      service.dispose()
    }
  })

  it('另一窗口持有锁时只读打开，写操作被拒绝', () => {
    const { userData, parent } = setup()
    const { service } = makeService(userData)
    try {
      const created = service.create(input(parent, '只读项目'))
      const dir = join(parent, '只读项目')
      // 模拟另一窗口持有活锁
      writeFileSync(
        join(dir, LOCK_FILE),
        JSON.stringify({
          pid: process.pid,
          host: hostname(),
          windowId: 'win_other',
          appVersion: '0.1.0',
          heartbeatAt: new Date().toISOString()
        })
      )
      // 本窗口先释放自己的项目，再尝试打开
      service.close(created.projectId)
      const opened = service.open({ path: dir })
      expect(opened.readOnly).toBe(true)
      expect(opened.readOnlyReason).toBe('locked')
      expect(service.isReadOnly()).toBe(true)
      try {
        service.updateMeta({ projectId: created.projectId, title: '改标题' })
        throw new Error('updateMeta should have thrown')
      } catch (error) {
        expect(error).toBeInstanceOf(AppError)
        expect((error as AppError).code).toBe('project_locked')
      }
    } finally {
      service.dispose()
    }
  })

  it('schema 更高的项目只读打开，不迁移', () => {
    const { userData, parent } = setup()
    const { service } = makeService(userData)
    try {
      const created = service.create(input(parent, '未来项目'))
      const file = join(parent, '未来项目', 'noryth.db')
      service.close(created.projectId)
      const db = new Database(file)
      try {
        db.prepare('INSERT INTO _migration (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)').run(
          99,
          'future',
          'x'.repeat(64),
          new Date().toISOString()
        )
      } finally {
        db.close()
      }
      const opened = service.open({ path: join(parent, '未来项目') })
      expect(opened.readOnly).toBe(true)
      expect(opened.readOnlyReason).toBe('schema_newer')
      expect(opened.project.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
    } finally {
      service.dispose()
    }
  })

  it('打开不存在路径返回 project_not_found', () => {
    const { userData, parent } = setup()
    const { service } = makeService(userData)
    try {
      expect(() => service.open({ path: join(parent, '不存在') })).toThrowError(AppError)
      try {
        service.open({ path: join(parent, '不存在') })
      } catch (error) {
        expect((error as AppError).code).toBe('project_not_found')
      }
    } finally {
      service.dispose()
    }
  })

  it('路径失效的项目在列表里显示 available=false', () => {
    const { userData, parent } = setup()
    const { service, registry } = makeService(userData)
    try {
      const created = service.create(input(parent, '会移动的项目'))
      service.close(created.projectId)
      registry.update(created.projectId, { path: join(parent, '已搬家') })
      const summary = service.list()[0]
      expect(summary?.available).toBe(false)
      expect(summary?.chapterCount).toBe(0)
    } finally {
      service.dispose()
    }
  })

  it('重新定位指向另一个项目时拒绝', () => {
    const { userData, parent } = setup()
    const { service } = makeService(userData)
    try {
      const a = service.create(input(parent, '项目A'))
      const b = service.create(input(parent, '项目B'))
      expect(() => service.relocate({ projectId: a.projectId, path: join(parent, '项目B') })).toThrowError(
        /different project/
      )
      expect(b.projectId).not.toBe(a.projectId)
    } finally {
      service.dispose()
    }
  })

  it('重新定位成功更新登记路径', () => {
    const { userData, parent } = setup()
    const { service, registry } = makeService(userData)
    try {
      const created = service.create(input(parent, '旧位置'))
      service.close(created.projectId)
      const moved = join(parent, '新位置')
      renameSync(join(parent, '旧位置'), moved)
      const result = service.relocate({ projectId: created.projectId, path: moved })
      expect(result.path).toBe(moved)
      expect(registry.find(created.projectId)?.path).toBe(moved)
      expect(service.list()[0]?.available).toBe(true)
    } finally {
      service.dispose()
    }
  })

  it('更新元数据写入 project 表并刷新摘要', () => {
    const { userData, parent } = setup()
    const { service } = makeService(userData)
    try {
      const created = service.create(input(parent, '改标题'))
      const updated = service.updateMeta({ projectId: created.projectId, title: '新标题', targetWords: 300_000 })
      expect(updated.title).toBe('新标题')
      expect(updated.targetWords).toBe(300_000)
      const db = new Database(join(parent, '改标题', 'noryth.db'), { readonly: true })
      try {
        expect((db.prepare('SELECT title FROM project').get() as { title: string }).title).toBe('新标题')
      } finally {
        db.close()
      }
      expect(readFileSync(join(userData, 'projects.json'), 'utf8')).toContain('新标题')
    } finally {
      service.dispose()
    }
  })

  it('关闭后释放锁文件', () => {
    const { userData, parent } = setup()
    const { service } = makeService(userData)
    const created = service.create(input(parent, '释放锁'))
    const dir = join(parent, '释放锁')
    expect(existsSync(join(dir, LOCK_FILE))).toBe(true)
    expect(service.close(created.projectId)).toBe(true)
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false)
    service.dispose()
  })
})

describe('path validation', () => {
  it('保留名、非法字符、非空目录被拒绝', () => {
    const { parent } = setup()
    expect(validateNewProjectPath({ parentDir: parent, folderName: 'CON' }).ok).toBe(false)
    expect(validateNewProjectPath({ parentDir: parent, folderName: 'a:b' }).ok).toBe(false)
    expect(validateNewProjectPath({ parentDir: parent, folderName: 'x'.repeat(200) }).ok).toBe(false)
    expect(validateNewProjectPath({ parentDir: join(parent, 'nope'), folderName: 'x' }).ok).toBe(false)
  })

  it('同步盘路径给出警告但仍可用', () => {
    const base = tempDir('noryth-onedrive-')
    cleanups.push(base.cleanup)
    const oneDrive = join(base.path, 'OneDrive', '写作')
    mkdirSync(oneDrive, { recursive: true })
    const check = validateNewProjectPath({ parentDir: oneDrive, folderName: '同步项目' })
    expect(check.ok).toBe(true)
    expect(check.warnings.join(' ')).toContain('同步盘')
  })

  it('磁盘空间与目标路径回传', () => {
    const { parent } = setup()
    const check = validateNewProjectPath({ parentDir: parent, folderName: '空间' })
    expect(check.ok).toBe(true)
    expect(check.freeBytes).toBeGreaterThan(0)
    expect(check.targetPath.endsWith('空间')).toBe(true)
  })

  it('五个子目录常量与创建流程一致', () => {
    const { userData, parent } = setup()
    const { service } = makeService(userData)
    try {
      service.create(input(parent, '目录清单'))
      const entries = readdirSync(join(parent, '目录清单')).filter(
        (name) => !name.endsWith('.db-wal') && !name.endsWith('.db-shm')
      )
      expect(entries.sort()).toEqual(['assets', 'backups', 'exports', 'logs', 'manuscript', 'noryth.db', '.noryth.lock'].sort())
    } finally {
      service.dispose()
    }
  })
})
