import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MainEvent } from '@shared/types'
import { DRAFTS, parsePluginCommand, pluginCommand, pluginMakerPrompt } from '@shared/pluginMaker'
import { checkPlugin } from '../../src/main/plugins/check'
import { servePlugin } from '../../src/main/plugins/protocol'
import { inToolDrafts } from '../../src/main/chat/workspace'
import { MultimineApp } from '../../src/main/app'
import type { MockScript } from '../../src/main/providers/mock'

const cipher = { encrypt: (s: string) => `x${s}`, decrypt: (s: string) => s.slice(1) }

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mm-maker-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

const manifest = (patch: object = {}) => JSON.stringify({ id: 'loot-roller', name: 'Loot Roller', version: '1.0.0', api: 2, description: 'Rolls loot.', icon: { glyph: 'Dices', gradient: ['#f59e0b', '#8b5cf6'] }, entry: 'index.html', window: { width: 600, height: 500 }, permissions: ['project:read'], ...patch })
const page = (script: string, sdk = true) => `<!doctype html><html><head><meta charset="utf-8">${sdk ? '<script src="mmplugin://sdk/multimine.js"></script>' : ''}</head><body><div id="out"></div><script type="module">${script}</script></body></html>`
const GOOD = "const text = await multimine.files.read('data/loot.json')\ndocument.getElementById('out').textContent = text"

async function tool(files: Record<string, string>, at = join(dir, 'loot-roller')): Promise<string> {
  await mkdir(at, { recursive: true })
  for (const [n, t] of Object.entries(files)) {
    await mkdir(join(at, n, '..'), { recursive: true })
    await writeFile(join(at, n), t)
  }
  return at
}

describe('checking a tool before it installs', () => {
  it('passes a tool that loads the SDK and asks for what it uses', async () => {
    const r = await checkPlugin(await tool({ 'plugin.json': manifest(), 'index.html': page(GOOD) }), 'loot-roller')
    expect(r.errors).toEqual([])
    expect(r.manifest?.name).toBe('Loot Roller')
  })

  it('names every problem a chat would otherwise leave for the user to find', async () => {
    const at = await tool({
      'plugin.json': manifest({ id: 'loot-roller', permissions: ['media:read'], icon: { file: 'icon.png' } }),
      'index.html': page("await multimine.files.write('a.json', '{}')\nmultimine.send('new', 'hi')\nconst x = {", false) + '<script src="app.js"></script>',
      'helper.js': 'function ok() { return 1 }\nconst y = await fetch("https://example.com")'
    })
    const { errors, warnings } = await checkPlugin(at, 'other-id')
    const all = errors.join('\n')
    expect(all).toContain('the id is "loot-roller" but the folder is "other-id"')
    expect(all).toContain('the icon icon.png is not in the folder')
    expect(all).toContain('index.html loads app.js, which is not in the folder')
    expect(all).toMatch(/index\.html <script> #1 line 3: Unexpected/)
    // top-level await is a syntax error in a classic script
    expect(all).toMatch(/helper\.js line 2: await is only valid/)
    expect(all).toContain('never loads it')
    expect(all).toContain('does not ask for "project:write"')
    expect(all).toContain('does not ask for "agents:message"')
    expect(all).toContain('does not ask for "network"')
    expect(warnings.join('\n')).toContain('asks for "media:read" but nothing in it seems to use')
  })

  it('refuses a built-in id, programs and a missing manifest', async () => {
    expect((await checkPlugin(await tool({ 'plugin.json': manifest({ id: 'tables' }), 'index.html': page('') }, join(dir, 'tables')))).errors.join()).toContain("built-in tool's id")
    expect((await checkPlugin(await tool({ 'plugin.json': manifest(), 'index.html': page(GOOD), 'run.bat': 'del *' }))).errors.join()).toContain('may not carry programs')
    expect((await checkPlugin(join(dir, 'nothing'))).errors[0]).toContain('no plugin.json')
  })

  it('serves a draft with no permissions, from its own origin', async () => {
    const at = await tool({ 'plugin.json': manifest(), 'index.html': page(GOOD) })
    const draft = async (id: string) => (id === 'loot-roller' ? { manifest: JSON.parse(manifest()), source: 'project' as const, native: false, dir: at, enabled: true, granted: [], pending: [] } : undefined)
    const res = await servePlugin('mmplugin://draft--loot-roller/index.html', async () => undefined, draft)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-security-policy')).toContain("script-src mmplugin://draft--loot-roller mmplugin://sdk")
    expect(res.headers.get('content-security-policy')).toContain("connect-src 'none'")
    expect((await servePlugin('mmplugin://draft--nope/index.html', async () => undefined, draft)).status).toBe(404)
  })
})

describe('the /plugin command', () => {
  it('reads a new tool or a change, and builds the prompt with the guide', () => {
    expect(parsePluginCommand('/plugin a loot roller', () => undefined)).toEqual({ request: 'a loot roller' })
    expect(parsePluginCommand('/plugin change loot-roller: make the button red', () => 'Loot Roller')).toEqual({ request: 'make the button red', editing: { id: 'loot-roller', name: 'Loot Roller' } })
    expect(pluginCommand('red button', 'loot-roller')).toBe('/plugin change loot-roller: red button')
    const p = pluginMakerPrompt({ request: 'a loot roller' }, ['hello', 'tables'], '# Writing a Multimine plugin\nthe guide')
    expect(p).toContain(`\`${DRAFTS}/<id>/\``)
    expect(p).toContain('none of: hello, tables')
    expect(p).toContain('call install_plugin with the id')
    expect(p).toContain('# Writing a Multimine plugin')
  })

  it('lets a chat write in the tool drafts without asking, and nowhere else', () => {
    expect(inToolDrafts('/p', '.multimine/tool-drafts/loot/index.html')).toBe(true)
    expect(inToolDrafts('/p', '/p/.multimine/tool-drafts/loot/plugin.json')).toBe(true)
    expect(inToolDrafts('/p', '.multimine/tool-drafts')).toBe(false)
    expect(inToolDrafts('/p', '.multimine/tool-drafts/../chats/x')).toBe(false)
    expect(inToolDrafts('/p', 'src/Main.java')).toBe(false)
  })
})

it('a chat makes a tool, install_plugin sends it back to fix a problem, then installs it and the window is told', async () => {
  const events: MainEvent[] = []
  const prompts: string[] = []
  const plugin = (perms: string[]) => manifest({ permissions: perms })
  const script: MockScript = (req) => {
    prompts.push(req.prompt)
    if (req.prompt.includes('Make a Multimine tool'))
      return [
        { tool: { name: 'write_file', args: { path: `${DRAFTS}/loot-roller/plugin.json`, content: plugin([]) } } },
        { tool: { name: 'write_file', args: { path: `${DRAFTS}/loot-roller/index.html`, content: page(GOOD) } } },
        // forgot to ask for project:read: the check says so, and the chat fixes it
        { tool: { name: 'install_plugin', args: { id: 'loot-roller' } } },
        { tool: { name: 'write_file', args: { path: `${DRAFTS}/loot-roller/plugin.json`, content: plugin(['project:read']) } } },
        { tool: { name: 'install_plugin', args: { id: 'loot-roller' } } },
        { text: 'Made Loot Roller: it is under Tools in the sidebar.' }
      ]
    if (req.prompt.includes('Change the tool "Loot Roller"'))
      return [
        { tool: { name: 'write_file', args: { path: `${DRAFTS}/loot-roller/plugin.json`, content: manifest({ version: '1.1.0' }) } } },
        { tool: { name: 'install_plugin', args: { id: 'loot-roller' } } },
        { text: 'Changed.' }
      ]
    return [{ text: 'ok' }]
  }
  const app = new MultimineApp({ userDataDir: join(dir, 'user'), cipher, emit: (e) => events.push(e), mockScript: script, mockDelayMs: 0, skipDetect: true })
  await app.start()
  await app.openProject(join(dir, 'proj'))
  try {
    // a Supervised chat: writing the tool's files asks nothing, since they land in the drafts
    const chatId = await app.pluginMake('a loot roller for data/loot.json', 'new')
    const chat = app.project!.get(chatId)!
    expect(chat).toMatchObject({ name: 'Tool: a loot roller for data/loot.json', autoApprove: false })
    await new Promise<void>((done) => {
      const t = setInterval(() => !app.engine!.busy(chatId) && app.engine!.chats[chatId].some((m) => m.role === 'assistant' && !m.streaming) && (clearInterval(t), done()), 20)
    })
    expect(app.engine!.inbox.items).toEqual([])
    expect(prompts[0]).toContain('# Writing a Multimine plugin')
    const reply = app.engine!.chats[chatId].find((m) => m.role === 'assistant')!
    const installs = reply.tools!.filter((t) => t.name === 'install_plugin')
    expect(installs[0].status).toBe('error')
    expect(installs[0].output).toContain('does not ask for "project:read"')
    expect(installs[1].output).toContain('Installed "Loot Roller" v1.0.0. It asks to: project:read.')
    expect(events.filter((e) => e.type === 'plugin-installed')).toEqual([{ type: 'plugin-installed', id: 'loot-roller', chatId, update: false }])
    // installed for every project, and not yet allowed: the user decides
    const installed = await app.plugins.find('loot-roller')
    expect(installed).toMatchObject({ source: 'user', enabled: false, pending: ['project:read'] })
    expect(existsSync(join(dir, 'user', 'plugins', 'loot-roller', 'index.html'))).toBe(true)
    expect(await readFile(join(dir, 'proj', '.multimine', '.gitignore'), 'utf8')).toContain('tool-drafts/')

    // changing it: a new chat gets the tool's files in the drafts and installs the new version
    await rm(join(dir, 'proj', DRAFTS), { recursive: true })
    const second = await app.pluginMake('add a reroll button', 'new', 'loot-roller')
    expect(existsSync(join(dir, 'proj', DRAFTS, 'loot-roller', 'index.html'))).toBe(true)
    await new Promise<void>((done) => {
      const t = setInterval(() => !app.engine!.busy(second) && app.engine!.chats[second].some((m) => m.role === 'assistant' && !m.streaming) && (clearInterval(t), done()), 20)
    })
    expect(prompts.at(-1)).toContain('Change the tool "Loot Roller"')
    expect(prompts.at(-1)).toContain('add a reroll button')
    expect((await app.plugins.find('loot-roller'))?.manifest.version).toBe('1.1.0')
    expect(events.filter((e) => e.type === 'plugin-installed').at(-1)).toMatchObject({ id: 'loot-roller', update: true })

    // a read-only chat cannot install
    const reader = await app.createChat({ permissions: 'read' })
    const install = app.engine!.coordinationTools(reader).find((t) => t.name === 'install_plugin')!
    expect((await install.handler({ id: 'loot-roller' })).text).toContain('read only')
  } finally {
    await app.shutdown()
  }
})
