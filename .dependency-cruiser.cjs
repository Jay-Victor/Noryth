/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'renderer-no-main',
      severity: 'error',
      comment: 'renderer 只能通过 preload 的 window.noryth 访问主进程',
      from: { path: '^src/renderer' },
      to: { path: '^src/main' }
    },
    {
      name: 'renderer-no-node-core',
      severity: 'error',
      comment: 'renderer 没有文件、SQL、网络权限',
      from: { path: '^src/renderer' },
      to: { dependencyTypes: ['core'] }
    },
    {
      name: 'renderer-no-electron',
      severity: 'error',
      comment: 'renderer 不得直接 import electron',
      from: { path: '^src/renderer' },
      to: { path: '^electron$' }
    },
    {
      name: 'shared-no-node-core',
      severity: 'error',
      comment: 'shared 两端共用，必须是纯 TS',
      from: { path: '^src/shared' },
      to: { dependencyTypes: ['core'] }
    },
    {
      name: 'shared-no-electron',
      severity: 'error',
      from: { path: '^src/shared' },
      to: { path: '^electron$' }
    },
    {
      name: 'shared-no-main-renderer',
      severity: 'error',
      from: { path: '^src/shared' },
      to: { path: '^src/(main|renderer)' }
    },
    {
      name: 'main-no-renderer',
      severity: 'error',
      from: { path: '^src/main' },
      to: { path: '^src/renderer' }
    },
    {
      name: 'db-no-agents-scheduler',
      severity: 'error',
      comment: '存储层不知道业务',
      from: { path: '^src/main/db' },
      to: { path: '^src/main/(agents|scheduler)' }
    },
    {
      name: 'tools-no-node-core',
      severity: 'error',
      comment: '工具只能调 repos 与 services；不得直接读文件、发网络、开子进程',
      from: { path: '^src/main/tools' },
      to: { dependencyTypes: ['core'] }
    },
    {
      name: 'no-circular',
      severity: 'warn',
      from: {},
      to: { circular: true }
    }
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    exclude: { path: '(^|/)(out|release|coverage|test-results|playwright-report)/' }
  }
}
