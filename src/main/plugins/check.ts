import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import { Script } from 'node:vm'
import type { PluginManifest, PluginPermission } from '@shared/types'
import { readJson } from '../store/fsx'
import { validateManifest } from './manifest'
import { BUILTIN } from './registry'

export interface PluginCheck {
  manifest?: PluginManifest
  /** What stops it from installing. */
  errors: string[]
  /** What is worth fixing but does not stop it. */
  warnings: string[]
}

const MAX_FILES = 300
const MAX_BYTES = 20_000_000

/** What a call in the page needs, so a plugin that calls it without asking fails here and not in front of the user. */
const NEEDS: { pattern: RegExp; perm: PluginPermission; what: string }[] = [
  { pattern: /\bmultimine\.(chats|team)\.list\b/, perm: 'team:read', what: 'multimine.chats.list' },
  { pattern: /\bmultimine\.(send|task)\s*\(/, perm: 'agents:message', what: 'multimine.send / task' },
  { pattern: /\bmultimine\.(files\.(list|read)|ide\.open)\b/, perm: 'project:read', what: 'multimine.files.read / list' },
  { pattern: /\bmultimine\.files\.(write|remove)\b/, perm: 'project:write', what: 'multimine.files.write / remove' },
  { pattern: /\bmultimine\.media\.list\b/, perm: 'media:read', what: 'multimine.media.list' },
  { pattern: /\bmultimine\.media\.show\b/, perm: 'media:write', what: 'multimine.media.show' },
  { pattern: /\bfetch\s*\(|\bnew\s+WebSocket\b|\bXMLHttpRequest\b|<(script|link|img)\b[^>]*\b(src|href)=["']https?:/i, perm: 'network', what: 'the network (fetch, WebSocket or a remote file)' }
]

async function files(dir: string): Promise<{ rel: string; size: number }[]> {
  const out: { rel: string; size: number }[] = []
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (out.length > MAX_FILES) return
      const full = join(d, e.name)
      // an MCP server's dependencies are its own business
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && e.name !== '.git') await walk(full)
      } else if (e.isFile()) out.push({ rel: relative(dir, full).split('\\').join('/'), size: (await stat(full)).size })
    }
  }
  await walk(dir)
  return out
}

/** The first line of a syntax error, with where it is. */
function syntaxError(code: string, where: string, module: boolean): string | null {
  let src = code
  if (module) {
    // a module cannot be compiled outside one here: drop its imports and exports and compile the
    // rest as an async body, which still catches what a syntax error would break at load
    src = code
      .replace(/^\s*import\s+[^;'"]*?from\s*['"][^'"]+['"];?/gm, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/^\s*import\s*['"][^'"]+['"];?/gm, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/^(\s*)export\s+default\s+/gm, '$1const __default = ')
      .replace(/^(\s*)export\s+(?=(async\s+)?(function|class|const|let|var)\b)/gm, '$1')
      .replace(/^\s*export\s*\{[^}]*\}\s*(from\s*['"][^'"]+['"])?;?/gm, (m) => m.replace(/[^\n]/g, ' '))
    src = `(async () => {\n${src}\n})`
  }
  try {
    new Script(src, { filename: where })
    return null
  } catch (e) {
    const err = e as Error
    const at = /:(\d+)\s*$/m.exec((err.stack ?? '').split('\n')[0] ?? '')
    // an unexpected end shows on the wrapper's closing line: keep it within the script's own lines
    const line = at ? Math.min(Number(at[1]) - (module ? 1 : 0), code.split('\n').length) : null
    return `${where}${line ? ` line ${line}` : ''}: ${err.message}`
  }
}

/**
 * Checks a plugin folder before it is installed: the manifest, the files it names, its size, that
 * it loads the SDK and asks for every permission its code uses, and that its scripts parse. A chat
 * that made the plugin gets these back and fixes them before the user ever sees the tool.
 */
export async function checkPlugin(dir: string, expectId?: string): Promise<PluginCheck> {
  const errors: string[] = []
  const warnings: string[] = []
  const raw = await readJson<unknown>(join(dir, 'plugin.json'), null)
  if (!raw) return { errors: [`no plugin.json in ${dir}`], warnings }
  const res = validateManifest(raw)
  if (!res.ok) return { errors: res.errors.map((e) => `plugin.json: ${e}`), warnings }
  const m = res.manifest
  if (expectId && m.id !== expectId) errors.push(`plugin.json says the id is "${m.id}" but the folder is "${expectId}": use the same for both`)
  if (BUILTIN.some((b) => b.id === m.id)) errors.push(`"${m.id}" is a built-in tool's id: pick another`)
  if (m.api < 2) warnings.push('api is 1: write against plugin API 2 ("api": 2)')

  let list: { rel: string; size: number }[] = []
  try {
    list = await files(dir)
  } catch (e) {
    return { manifest: m, errors: [...errors, `cannot read the folder: ${(e as Error).message}`], warnings }
  }
  if (list.length > MAX_FILES) errors.push(`more than ${MAX_FILES} files: a tool is a page and a few files`)
  const bytes = list.reduce((n, f) => n + f.size, 0)
  if (bytes > MAX_BYTES) errors.push(`${Math.round(bytes / 1e6)} MB of files: keep it under ${MAX_BYTES / 1e6} MB`)
  const has = (p: string) => list.some((f) => f.rel === p.replace(/^\.\//, ''))
  if (m.entry && !has(m.entry)) errors.push(`the entry page ${m.entry} is not in the folder`)
  if ('file' in m.icon && !has(m.icon.file)) errors.push(`the icon ${m.icon.file} is not in the folder`)

  // the page and its scripts, as the user's window will load them
  const pages = list.filter((f) => /\.html?$/i.test(f.rel))
  const scripts = list.filter((f) => /\.(m?js)$/i.test(f.rel) && !f.rel.startsWith('node_modules/'))
  const server = m.mcp ? new Set(m.mcp.args?.map((a) => a.replace('${PLUGIN_DIR}/', '').replace(/^\.\//, '')) ?? []) : new Set<string>()
  const moduleSrcs = new Set<string>()
  let code = ''
  let loadsSdk = false
  for (const f of pages) {
    const html = await readFile(join(dir, f.rel), 'utf8')
    code += `\n${html}`
    if (/<script\b[^>]*\bsrc=["']mmplugin:\/\/sdk\/multimine\.js["']/i.test(html)) loadsSdk = true
    let n = 0
    for (const s of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const attrs = s[1]
      const isModule = /\btype=["']module["']/i.test(attrs)
      const src = /\bsrc=["']([^"']+)["']/i.exec(attrs)?.[1]
      if (src) {
        if (isModule) moduleSrcs.add(src.replace(/^\.\//, ''))
        if (!/^(mmplugin:|https?:)/i.test(src) && !has(src.split('?')[0])) errors.push(`${f.rel} loads ${src}, which is not in the folder`)
        continue
      }
      n++
      if (s[2].trim()) {
        const bad = syntaxError(s[2], `${f.rel} <script> #${n}`, isModule)
        if (bad) errors.push(bad)
      }
    }
  }
  for (const f of scripts) {
    const js = await readFile(join(dir, f.rel), 'utf8')
    if (server.has(f.rel)) continue // the MCP server runs in Node, not in the page
    code += `\n${js}`
    const isModule = moduleSrcs.has(f.rel) || f.rel.endsWith('.mjs') || /^\s*(import|export)\s/m.test(js)
    const bad = syntaxError(js, f.rel, isModule)
    if (bad) errors.push(bad)
  }
  if (/\bmultimine\./.test(code) && !loadsSdk) errors.push('the page uses window.multimine but never loads it: add <script src="mmplugin://sdk/multimine.js"></script> before your own script')

  for (const need of NEEDS) {
    const uses = need.pattern.test(code)
    if (uses && !m.permissions.includes(need.perm)) errors.push(`it uses ${need.what} but plugin.json does not ask for "${need.perm}"`)
    if (!uses && m.permissions.includes(need.perm)) warnings.push(`it asks for "${need.perm}" but nothing in it seems to use ${need.what}: ask only for what it uses`)
  }
  if (m.mcp && !(m.mcp.args ?? []).some((a) => has(a.replace('${PLUGIN_DIR}/', '')))) warnings.push('mcp: none of its args names a file in the folder')
  if (pages.length && !/<meta\s+charset/i.test(code)) warnings.push('add <meta charset="utf-8"> to the page')
  for (const f of list) if (['.exe', '.dll', '.so', '.dylib', '.bat', '.cmd', '.ps1', '.sh'].includes(extname(f.rel).toLowerCase())) errors.push(`${f.rel}: a tool may not carry programs`)
  return { manifest: m, errors, warnings }
}
