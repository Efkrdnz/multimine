import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AgentSpec, MainEvent, MediaItem, PluginInfo, PluginPermission } from '@shared/types'
import { insideProject } from '../orchestrator/workspace'
import { list as listDir } from '../ide/fs'
import { MediaStore } from '../media/capture'
import { readJson, writeJson } from '../store/fsx'

/** What each API method needs. Methods missing here need no permission. */
export const METHOD_PERMISSION: Record<string, PluginPermission | null> = {
  info: null,
  'storage.get': null,
  'storage.set': null,
  'ui.toast': null,
  'team.list': 'team:read',
  send: 'agents:message',
  'files.list': 'project:read',
  'files.read': 'project:read',
  'files.write': 'project:write',
  'media.show': 'media:write',
  'media.list': 'media:read'
}

/** What the API may touch. The app supplies it; the API never sees keys, settings or providers. */
export interface PluginContext {
  projectDir(): string | null
  projectName(): string | null
  team(): AgentSpec[]
  /** Hands a message from a tool to an agent: logged on the bus, shown in that agent's chat. */
  send(pluginId: string, pluginName: string, to: string, text: string): Promise<void>
  addMedia(item: MediaItem): Promise<void>
  media(): MediaItem[]
  emit(e: MainEvent): void
  storageDir: string
}

export class PluginRefused extends Error {}

/**
 * Every call a plugin makes comes through here: the method must exist, the plugin must be enabled
 * and hold the permission the method needs, and every path stays inside the open project.
 */
export async function callPlugin(ctx: PluginContext, plugin: PluginInfo, method: string, args: unknown[]): Promise<unknown> {
  if (!(method in METHOD_PERMISSION)) throw new PluginRefused(`Unknown method ${method}`)
  if (!plugin.enabled) throw new PluginRefused(`${plugin.manifest.name} is disabled`)
  const need = METHOD_PERMISSION[method]
  if (need && !plugin.granted.includes(need)) throw new PluginRefused(`${plugin.manifest.name} does not have the "${need}" permission`)
  const id = plugin.manifest.id
  const a = (i: number) => args[i]
  const project = () => {
    const dir = ctx.projectDir()
    if (!dir) throw new PluginRefused('No project is open')
    return dir
  }
  switch (method) {
    case 'info':
      return { pluginId: id, apiVersion: 1, project: ctx.projectName() }
    case 'storage.get': {
      const store = await readJson<Record<string, unknown>>(join(ctx.storageDir, `${id}.json`), {})
      return store[String(a(0))] ?? null
    }
    case 'storage.set': {
      const file = join(ctx.storageDir, `${id}.json`)
      const store = await readJson<Record<string, unknown>>(file, {})
      store[String(a(0))] = a(1)
      if (JSON.stringify(store).length > 2_000_000) throw new PluginRefused('Plugin storage is limited to 2 MB')
      await writeJson(file, store)
      return true
    }
    case 'ui.toast':
      ctx.emit({ type: 'toast', level: 'info', text: `${plugin.manifest.name}: ${String(a(0)).slice(0, 300)}` })
      return true
    case 'team.list':
      return ctx.team().map((x) => ({ id: x.id, name: x.name, role: x.role, provider: x.provider, model: x.model }))
    case 'send': {
      const to = String(a(0) || 'mastermind')
      if (!ctx.team().some((x) => x.id === to)) throw new PluginRefused(`No agent "${to}"`)
      await ctx.send(id, plugin.manifest.name, to, String(a(1) ?? '').slice(0, 100_000))
      return true
    }
    case 'files.list':
      return listDir(project(), String(a(0) ?? ''))
    case 'files.read': {
      const buf = await readFile(insideProject(project(), String(a(0))))
      if (buf.length > 20_000_000) throw new PluginRefused('File too large')
      return a(1) === 'base64' ? buf.toString('base64') : buf.toString('utf8')
    }
    case 'files.write': {
      const full = insideProject(project(), String(a(0)))
      await mkdir(dirname(full), { recursive: true })
      await writeFile(full, a(2) === 'base64' ? Buffer.from(String(a(1)), 'base64') : String(a(1)))
      return true
    }
    case 'media.show': {
      const src = String(a(0))
      const store = new MediaStore(join(project(), '.multimine', 'media'))
      const title = a(1) ? String(a(1)) : undefined
      const item = /^(https?:|data:)/.test(src) ? await store.fromUrl(src, `plugin:${id}`, plugin.manifest.name, title) : await store.fromFile(insideProject(project(), src), `plugin:${id}`, title)
      if (!item) throw new PluginRefused('Not a recognised image, video, audio or 3D file')
      await ctx.addMedia(item)
      return { id: item.id, path: item.path, kind: item.kind }
    }
    case 'media.list':
      return ctx.media().map((m) => ({ id: m.id, kind: m.kind, path: m.path, title: m.title, source: m.source, agentId: m.agentId, ts: m.ts }))
  }
  throw new PluginRefused(`Unknown method ${method}`)
}
