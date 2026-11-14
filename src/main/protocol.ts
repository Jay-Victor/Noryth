import { protocol } from 'electron'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8'
}

/**
 * 自定义 app:// 协议：打包后不用 file:// 加载 ES module（null origin 会被 CORS 拦）。
 * 只提供 renderer 目录内的静态文件，路径穿越直接 403。
 */
export function registerAppProtocol(rendererDir: string, csp: string): void {
  const root = resolve(rendererDir)
  protocol.handle('app', async (request) => {
    const url = new URL(request.url)
    if (url.host !== 'noryth') return new Response('not found', { status: 404 })
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
    const target = normalize(join(root, relative))
    if (!target.startsWith(root + sep) && target !== root) {
      return new Response('forbidden', { status: 403 })
    }
    try {
      const data = await readFile(target)
      const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream'
      return new Response(data, {
        status: 200,
        headers: {
          'content-type': type,
          'content-security-policy': csp,
          'cache-control': 'no-store'
        }
      })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}
