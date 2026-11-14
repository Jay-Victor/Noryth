import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import pino from 'pino'
import { ProjectRegistry } from '../../src/main/project/registry'
import { ProjectService } from '../../src/main/project/service'
import type { AppInfo } from '../../src/shared/schema/project'

export function tempDir(prefix = 'noryth-test-'): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), prefix))
  return {
    path,
    cleanup: () => rmSync(path, { recursive: true, force: true })
  }
}

export function vecExtensionPath(): string {
  return resolve(process.cwd(), 'resources/native/vec0.dll')
}

export function silentLogger(): pino.Logger {
  return pino({ level: 'silent' })
}

export function appInfo(): AppInfo {
  return {
    name: 'Noryth',
    version: '0.1.0',
    electron: '45.2.3',
    chrome: '156',
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    schemaVersion: 1,
    packaged: false
  }
}

export function makeService(userDataDir: string): {
  service: ProjectService
  registry: ProjectRegistry
  events: Array<{ projectId: string; readOnly: boolean }>
} {
  const registry = new ProjectRegistry(join(userDataDir, 'projects.json'))
  const events: Array<{ projectId: string; readOnly: boolean }> = []
  const service = new ProjectService({
    registry,
    appVersion: '0.1.0',
    windowId: 'win_test',
    logger: silentLogger(),
    vecExtension: vecExtensionPath(),
    emit: (event) => events.push({ projectId: event.projectId, readOnly: event.readOnly }),
    appInfo
  })
  return { service, registry, events }
}
