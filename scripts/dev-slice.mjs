#!/usr/bin/env node
/**
 * 开发切片启动器（PHASE-05 V1）：
 *   pnpm dev:slice
 *
 * 设置 NORYTH_SLICE=1 后启动 electron-vite dev；切片 IPC 只在未打包构建注册。
 * 打开项目后访问 `#/dev/slice`（或在窗口地址栏执行 location.hash = '#/dev/slice'）。
 * 这是开发脚手架，不进正式导航，也不参与打包。
 */
import { spawn } from 'node:child_process'

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const child = spawn(pnpm, ['exec', 'electron-vite', 'dev'], {
  stdio: 'inherit',
  env: { ...process.env, NORYTH_SLICE: '1' },
  shell: process.platform === 'win32'
})

child.on('exit', (code) => {
  process.exit(code ?? 0)
})

child.on('error', (error) => {
  console.error('failed to start electron-vite dev:', error.message)
  process.exit(1)
})
