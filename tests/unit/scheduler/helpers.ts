import { verifyDatabase, type VerifyReport } from '../../../src/main/db/verify'
import type { WriteTestWorld } from '../../support/write-world'

/** 调度器测试统一用同一份校验口径；镜像在单测里不检查（没有发布循环）。 */
export function fullVerify(world: WriteTestWorld): VerifyReport {
  return verifyDatabase(world.handle.db, { projectDir: world.dir, checkMirror: false })
}
