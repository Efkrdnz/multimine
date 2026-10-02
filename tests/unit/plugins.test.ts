import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MainEvent } from '@shared/types'
import { validateManifest } from '../../src/main/plugins/manifest'
import { servePlugin } from '../../src/main/plugins/protocol'
import { BUILTIN } from '../../src/main/plugins/registry'
import { MultimineApp } from '../../src/main/app'

const good = { id: 'hello', name: 'Hello', version: '1.0.0', api: 1, entry: 'index.html', permissions: ['team:read', 'agents:message'] }

describe('manifest', () => {
  it('accepts a good manifest and fills in defaults', () => {
    const r = validateManifest(good)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.manifest.window).toEqual({ width: 900, height: 640 })
      expect(r.manifest.icon).toMatchObject({ glyph: 'Puzzle' })
    }
  })

  it('refuses bad ids, unknown permissions, escaping paths and a newer API', () => {
    const bad = (patch: object) => {
      const r = validateManifest({ ...good, ...patch })
      return r.ok ? [] : r.errors
    }
    expect(bad({ id: 'Bad Id' })[0]).toContain('id')
    expect(bad({ permissions: ['keys:read'] })[0]).toContain('unknown permission')
    expect(bad({ entry: '../../evil.html' })[0]).toContain('inside the plugin folder')
    expect(bad({ api: 2 })[0]).toContain('Update Multimine')
    expect(validateManifest(null).ok).toBe(false)
  })
})

describe('plugin system', () => {
  let dir: string
  let app: MultimineApp
  let events: MainEvent[]

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mm-plug-'))
    events = []
    app = new MultimineApp({ userDataDir: join(dir, 'u'), cipher: { encrypt: (s) => s, decrypt: (s) => s }, emit: (e) => events.push(e), mockDelayMs: 0, forceMockMastermind: true })
    await app.start()
    await app.openProject(join(dir, 'p'))
  })

  afterEach(async () => {
    await app.shutdown()
    await rm(dir, { recursive: true, force: true })
  })

  it('lists the built-in tools enabled, installs a plugin disabled with nothing granted', async () => {
    const before = await app.pluginList()
    expect(before.plugins.map((p) => [p.manifest.id, p.enabled, p.native])).toEqual(BUILTIN.map((m) => [m.id, true, true]))
    expect(BUILTIN.map((m) => m.id)).toContain('ui-sketcher')
    await app.pluginInstall(resolve('examples/plugins/hello'))
    const hello = (await app.pluginList()).plugins.find((p) => p.manifest.id === 'hello')!
    expect(hello.enabled).toBe(false)
    expect(hello.granted).toEqual([])
    expect(hello.pending).toEqual(['team:read', 'agents:message'])
  })

  it('only calls what was granted, and a revoke takes effect at once', async () => {
    await app.pluginInstall(resolve('examples/plugins/hello'))
    await expect(app.pluginCall('hello', 'team.list', [])).rejects.toThrow('disabled')
    await app.pluginSetEnabled('hello', true, ['team:read', 'agents:message', 'project:write' as any])
    const hello = (await app.pluginList()).plugins.find((p) => p.manifest.id === 'hello')!
    expect(hello.granted).toEqual(['team:read', 'agents:message']) // never more than it asked for
    expect(((await app.pluginCall('hello', 'team.list', [])) as any[]).map((a) => a.id)).toContain('mastermind')
    await expect(app.pluginCall('hello', 'files.read', ['README.md'])).rejects.toThrow('project:read')
    await app.pluginCall('hello', 'send', ['mastermind', 'hi from a plugin'])
    expect(app.engine!.bus.some((b) => b.from === 'plugin:hello' && b.to === 'mastermind')).toBe(true)
    for (let i = 0; i < 50 && !app.engine!.chats.mastermind?.some((m) => m.text.includes('Message from Hello Team')); i++) await new Promise((r) => setTimeout(r, 10))
    expect(app.engine!.chats.mastermind.some((m) => m.text.includes('Message from Hello Team'))).toBe(true)
    await app.pluginRevoke('hello', 'agents:message')
    await expect(app.pluginCall('hello', 'send', ['mastermind', 'again'])).rejects.toThrow('agents:message')
  })

  it('keeps file access inside the project and gives each plugin its own storage', async () => {
    const r = await app.pluginCall('ui-sketcher', 'files.write', ['.multimine/sketches/a/sketch.json', '{"v":1}'])
    expect(r).toBe(true)
    expect(await readFile(join(dir, 'p', '.multimine', 'sketches', 'a', 'sketch.json'), 'utf8')).toBe('{"v":1}')
    await expect(app.pluginCall('ui-sketcher', 'files.read', ['../../etc/passwd'])).rejects.toThrow('outside the project')
    await app.pluginCall('ui-sketcher', 'storage.set', ['k', { a: 1 }])
    expect(await app.pluginCall('ui-sketcher', 'storage.get', ['k'])).toEqual({ a: 1 })
    await expect(app.pluginCall('ui-sketcher', 'eval', [])).rejects.toThrow('Unknown method')
  })

  it("brings a plugin's MCP server in and out with the plugin", async () => {
    const src = join(dir, 'tooly')
    await mkdir(src)
    await writeFile(join(src, 'plugin.json'), JSON.stringify({ ...good, id: 'tooly', mcp: { command: 'node', args: ['${PLUGIN_DIR}/server.js'] } }))
    await writeFile(join(src, 'index.html'), '<p>hi</p>')
    await app.pluginInstall(src)
    expect(app.config.settings.mcpServers.some((s) => s.id === 'plugin-tooly')).toBe(false)
    await app.pluginSetEnabled('tooly', true, [])
    const server = app.config.settings.mcpServers.find((s) => s.id === 'plugin-tooly')!
    expect(server.args![0]).toBe(join(dir, 'u', 'plugins', 'tooly', 'server.js'))
    await app.pluginSetEnabled('tooly', false)
    expect(app.config.settings.mcpServers.some((s) => s.id === 'plugin-tooly')).toBe(false)
  })

  it('serves an enabled plugin under a strict policy, and nothing else', async () => {
    await app.pluginInstall(resolve('examples/plugins/hello'))
    const find = (id: string) => app.plugins.find(id, app.project!.dir)
    expect((await servePlugin('mmplugin://hello/index.html', find)).status).toBe(404) // disabled
    await app.pluginSetEnabled('hello', true, ['team:read'])
    const page = await servePlugin('mmplugin://hello/index.html', find)
    expect(page.status).toBe(200)
    const csp = page.headers.get('content-security-policy')!
    expect(csp).toContain("connect-src 'none'")
    expect(csp).toContain("frame-src 'none'")
    expect((await servePlugin('mmplugin://hello/..%2F..%2Fplugin.json', find)).status).toBe(404)
    expect((await servePlugin('mmplugin://ui-sketcher/index.html', find)).status).toBe(404) // native, not served
    expect(await (await servePlugin('mmplugin://sdk/multimine.js', find)).text()).toContain('window.multimine')
  })
})
