import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import type { PluginInfo } from '@shared/types'
import sdk from './sdk/multimine.js?raw'

const TYPES: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm'
}

/**
 * The content policy a plugin page runs under: code and styles from its own folder (and the SDK),
 * no frames, and no network at all unless the user granted it.
 */
export function pluginCsp(p: PluginInfo): string {
  const own = `mmplugin://${p.manifest.id}`
  const net = p.granted.includes('network')
  return [
    `default-src 'none'`,
    `script-src ${own} mmplugin://sdk 'unsafe-inline' 'unsafe-eval'`,
    `style-src ${own} 'unsafe-inline'${net ? ' https:' : ''}`,
    `img-src ${own} data: blob:${net ? ' https:' : ''}`,
    `font-src ${own} data:${net ? ' https:' : ''}`,
    `media-src ${own} data: blob:${net ? ' https:' : ''}`,
    `connect-src ${net ? 'https: wss: http:' : "'none'"}`,
    `worker-src blob: ${own}`,
    `frame-src 'none'`,
    `form-action 'none'`
  ].join('; ')
}

/**
 * Answers mmplugin://<id>/<path>: a file from an enabled web plugin's folder, never outside it.
 * mmplugin://sdk/multimine.js is the SDK.
 */
export async function servePlugin(url: string, find: (id: string) => Promise<PluginInfo | undefined>): Promise<Response> {
  const u = new URL(url)
  const host = u.hostname
  if (host === 'sdk') return new Response(sdk, { headers: { 'content-type': 'text/javascript' } })
  const p = await find(host)
  if (!p || p.native) return new Response('not found', { status: 404 })
  let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || p.manifest.entry || 'index.html'
  rel = normalize(rel).replace(/\\/g, '/')
  // a disabled plugin serves nothing but its icon, which the Tools grid shows before it is enabled
  const icon = 'file' in p.manifest.icon ? normalize(p.manifest.icon.file).replace(/\\/g, '/') : null
  if (!p.enabled && rel !== icon) return new Response('not found', { status: 404 })
  if (rel.startsWith('..')) return new Response('not found', { status: 404 })
  try {
    const body = await readFile(join(p.dir, rel))
    const type = TYPES[extname(rel).toLowerCase()] ?? 'application/octet-stream'
    return new Response(body, { headers: { 'content-type': type, 'content-security-policy': pluginCsp(p), 'x-content-type-options': 'nosniff' } })
  } catch {
    return new Response('not found', { status: 404 })
  }
}
