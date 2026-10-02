import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { McpServerConfig, PluginInfo, PluginManifest, PluginPermission, PluginSettings } from '@shared/types'
import { readJson } from '../store/fsx'
import { validateManifest } from './manifest'

/** Plugins that ship inside the app. They render natively but are held to the same API. */
export const BUILTIN: PluginManifest[] = [
  {
    id: 'ui-sketcher',
    name: 'UI Sketcher',
    version: '1.0.0',
    api: 1,
    description: 'Draw a GUI wireframe, preview it, and send it to Mastermind to have it built.',
    icon: { glyph: 'PenTool', gradient: ['#f472b6', '#8b5cf6'] },
    window: { width: 1280, height: 820 },
    permissions: ['team:read', 'agents:message', 'project:read', 'project:write', 'media:read', 'media:write']
  },
  {
    id: 'asset-board',
    name: 'Asset Board',
    version: '1.0.0',
    api: 1,
    description: 'Track the art and sound the project needs, have the Asset Creator make it, review it, and drop the approved file into place.',
    icon: { glyph: 'Boxes', gradient: ['#f59e0b', '#ef4444'] },
    window: { width: 1240, height: 780 },
    permissions: ['team:read', 'agents:message', 'project:read', 'project:write', 'media:read']
  },
  {
    id: 'data-tables',
    name: 'Data Tables',
    version: '1.0.0',
    api: 1,
    description: "Edit the project's JSON and CSV game data as a spreadsheet, chart it, and ask an agent to rebalance it.",
    icon: { glyph: 'Table2', gradient: ['#22c55e', '#0ea5e9'] },
    window: { width: 1280, height: 780 },
    permissions: ['team:read', 'agents:message', 'project:read', 'project:write']
  }
]

export interface Discovered {
  manifest: PluginManifest
  source: PluginInfo['source']
  dir: string
}

async function scan(root: string, source: PluginInfo['source']): Promise<{ found: Discovered[]; broken: { dir: string; errors: string[] }[] }> {
  const found: Discovered[] = []
  const broken: { dir: string; errors: string[] }[] = []
  let names: string[] = []
  try {
    names = await readdir(root)
  } catch {
    return { found, broken }
  }
  for (const name of names) {
    const dir = join(root, name)
    try {
      if (!(await stat(dir)).isDirectory()) continue
    } catch {
      continue
    }
    const res = validateManifest(await readJson<unknown>(join(dir, 'plugin.json'), null))
    if (res.ok) found.push({ manifest: res.manifest, source, dir })
    else broken.push({ dir, errors: res.errors })
  }
  return { found, broken }
}

/**
 * Where plugins come from and what the user allowed each one. A user or project plugin starts
 * disabled with nothing granted; built-in plugins start enabled with their declared permissions.
 */
export class PluginRegistry {
  constructor(
    private readonly userDir: string,
    private readonly settings: () => Record<string, PluginSettings>,
    private readonly save: (plugins: Record<string, PluginSettings>) => Promise<void>
  ) {}

  async discover(projectDir?: string): Promise<{ plugins: Discovered[]; broken: { dir: string; errors: string[] }[] }> {
    const user = await scan(this.userDir, 'user')
    const project = projectDir ? await scan(join(projectDir, '.multimine', 'plugins'), 'project') : { found: [], broken: [] }
    const plugins: Discovered[] = BUILTIN.map((manifest) => ({ manifest, source: 'builtin' as const, dir: '' }))
    // first one wins: a user plugin cannot shadow a built-in, a project one cannot shadow either
    for (const d of [...user.found, ...project.found]) if (!plugins.some((p) => p.manifest.id === d.manifest.id)) plugins.push(d)
    return { plugins, broken: [...user.broken, ...project.broken] }
  }

  state(d: Discovered): PluginInfo {
    const builtin = d.source === 'builtin'
    const s = this.settings()[d.manifest.id]
    const granted = builtin ? d.manifest.permissions : (s?.granted ?? []).filter((p) => d.manifest.permissions.includes(p))
    return {
      manifest: d.manifest,
      source: d.source,
      native: builtin,
      dir: d.dir,
      enabled: builtin ? s?.enabled !== false : !!s?.enabled,
      granted,
      pending: d.manifest.permissions.filter((p) => !granted.includes(p))
    }
  }

  async list(projectDir?: string): Promise<PluginInfo[]> {
    return (await this.discover(projectDir)).plugins.map((d) => this.state(d))
  }

  async find(id: string, projectDir?: string): Promise<PluginInfo | undefined> {
    return (await this.list(projectDir)).find((p) => p.manifest.id === id)
  }

  /** Enabling grants exactly the permissions the user just agreed to. */
  async setEnabled(id: string, enabled: boolean, grant?: PluginPermission[]): Promise<void> {
    const all = { ...this.settings() }
    const cur = all[id] ?? { enabled: false, granted: [] }
    all[id] = { enabled, granted: grant ? [...new Set([...cur.granted, ...grant])] : cur.granted }
    await this.save(all)
  }

  async revoke(id: string, perm: PluginPermission): Promise<void> {
    const all = { ...this.settings() }
    const cur = all[id] ?? { enabled: false, granted: [] }
    all[id] = { ...cur, granted: cur.granted.filter((p) => p !== perm) }
    await this.save(all)
  }

  /** Copies a plugin folder into the user plugins folder, after its manifest checks out. */
  async install(from: string): Promise<PluginManifest> {
    const res = validateManifest(await readJson<unknown>(join(from, 'plugin.json'), null))
    if (!res.ok) throw new Error(`Not a valid plugin: ${res.errors.join('; ')}`)
    if (BUILTIN.some((b) => b.id === res.manifest.id)) throw new Error(`"${res.manifest.id}" is a built-in tool's id.`)
    const to = join(this.userDir, res.manifest.id)
    await mkdir(this.userDir, { recursive: true })
    await rm(to, { recursive: true, force: true })
    // everything but version control: an MCP server may well need its node_modules
    await cp(from, to, { recursive: true, filter: (src) => !/[\\/]\.git([\\/]|$)/.test(src) })
    return res.manifest
  }

  async remove(id: string): Promise<void> {
    if (BUILTIN.some((b) => b.id === id)) throw new Error('Built-in tools cannot be removed.')
    await rm(join(this.userDir, id), { recursive: true, force: true })
    const all = { ...this.settings() }
    delete all[id]
    await this.save(all)
  }
}

/** The MCP server a plugin brings, as a server config, with ${PLUGIN_DIR} filled in. */
export function pluginMcpServer(p: PluginInfo): McpServerConfig | null {
  const m = p.manifest.mcp
  if (!m) return null
  const fill = (s: string) => s.split('${PLUGIN_DIR}').join(p.dir)
  return {
    id: `plugin-${p.manifest.id}`,
    name: `${p.manifest.name} (plugin)`,
    pluginId: p.manifest.id,
    transport: 'stdio',
    command: fill(m.command),
    args: (m.args ?? []).map(fill),
    env: Object.fromEntries(Object.entries(m.env ?? {}).map(([k, v]) => [k, fill(v)]))
  }
}
