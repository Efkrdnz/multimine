import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MainEvent } from '@shared/types'
import { MultimineApp } from '../../src/main/app'
import type { MockScript } from '../../src/main/providers/mock'

const cipher = { encrypt: (s: string) => `x${s}`, decrypt: (s: string) => s.slice(1) }

/**
 * One chat doing a task end to end on the mock provider: it asks the user a question, writes a
 * file (which a Supervised chat asks permission for), and answers. Everything is asserted from
 * what lands on disk and in the chat.
 */
const script: MockScript = (req) => {
  const { prompt } = req
  if (prompt.includes('Make a lance')) {
    return [
      { tool: { name: 'ask_user', args: { questions: [{ question: 'Element?', options: [{ label: 'Fire' }, { label: 'Void' }] }] } } },
      { tool: { name: 'write_file', args: (o) => ({ path: 'src/Lance.java', content: `class ${/-> (\w+)/.exec(o[0])?.[1]}Lance {}` }) } },
      { text: 'Added the lance.' }
    ]
  }
  if (prompt.includes('slow')) return [{ event: { type: 'thinking', delta: 'hm' } }, { text: 'slow done' }]
  return [{ text: 'ok' }]
}

/** Answers what the chats ask, as the user would from the chat: the question, then every permission. */
function answerAll(app: MultimineApp, answers: Record<string, string>): () => void {
  let on = true
  void (async () => {
    while (on) {
      for (const item of app.engine?.inbox.pending() ?? []) {
        if (item.kind === 'question') await app.answer(item.id, answers)
        else await app.decide(item.id, true)
      }
      await new Promise((r) => setTimeout(r, 5))
    }
  })()
  return () => (on = false)
}

describe('chats', () => {
  let dir: string
  let app: MultimineApp
  let events: MainEvent[]

  const start = async () => {
    app = new MultimineApp({ userDataDir: join(dir, 'user'), cipher, emit: (e) => events.push(e), mockScript: script, mockDelayMs: 0, skipDetect: true })
    await app.start()
    await app.openProject(join(dir, 'proj'))
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mm-pipe-'))
    events = []
    await start()
  })

  afterEach(async () => {
    await app.shutdown()
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
  })

  it('creates the project layout and a first chat on the defaults', async () => {
    const p = join(dir, 'proj')
    expect(existsSync(join(p, 'multimine.md'))).toBe(true)
    const ignore = await readFile(join(p, '.multimine', '.gitignore'), 'utf8')
    expect(ignore).toContain('chats/')
    expect(ignore).toContain('media/')
    const chats = app.project!.list()
    expect(chats).toHaveLength(1)
    expect(chats[0]).toMatchObject({ name: 'New chat', provider: 'mock', permissions: 'write', autoApprove: false })
    expect(existsSync(join(p, '.multimine', 'chats', chats[0].id, 'chat.json'))).toBe(true)
    expect(existsSync(join(p, '.multimine', 'agents'))).toBe(false)
  })

  it('asks the user, asks before a Supervised write, does the task, and takes its name from the request', async () => {
    const id = app.project!.list()[0].id
    const stop = answerAll(app, { 'Element?': 'Void' })
    const result = await app.engine!.send(id, 'Make a lance for the knight')
    stop()
    expect(result.error).toBeUndefined()
    expect(result.text).toBe('Added the lance.')
    expect(await readFile(join(dir, 'proj', 'src', 'Lance.java'), 'utf8')).toBe('class VoidLance {}')
    const asked = app.engine!.inbox.items
    expect(asked.map((i) => (i.kind === 'question' ? 'question' : i.permission ? 'permission' : 'approval'))).toEqual(['question', 'permission'])
    expect(asked.every((i) => i.askedBy === id)).toBe(true)
    expect(app.project!.get(id)!.name).toBe('Make a lance for the knight')
  })

  it('a Full access chat writes without asking', async () => {
    const chat = await app.createChat({ autoApprove: true })
    const stop = answerAll(app, { 'Element?': 'Fire' })
    await app.engine!.send(chat.id, 'Make a lance')
    stop()
    expect(app.engine!.inbox.items.filter((i) => i.permission)).toHaveLength(0)
    expect(await readFile(join(dir, 'proj', 'src', 'Lance.java'), 'utf8')).toBe('class FireLance {}')
  })

  it('runs different chats at once, and one chat\'s turns in order', async () => {
    const a = app.project!.list()[0].id
    const b = (await app.createChat()).id
    const order: string[] = []
    await Promise.all([
      app.engine!.send(a, 'slow one').then(() => order.push('a1')),
      app.engine!.send(a, 'second').then(() => order.push('a2')),
      app.engine!.send(b, 'hello').then(() => order.push('b1'))
    ])
    expect(order.indexOf('a1')).toBeLessThan(order.indexOf('a2'))
    expect(app.engine!.chats[a].filter((m) => m.role === 'assistant').map((m) => m.text)).toEqual(['slow done', 'ok'])
    expect(app.engine!.chats[b].filter((m) => m.role === 'assistant').map((m) => m.text)).toEqual(['ok'])
  })

  it('keeps chats, their names and their messages across a restart, most recent first', async () => {
    const first = app.project!.list()[0].id
    await app.engine!.send(first, 'hello there')
    const second = await app.createChat()
    await app.engine!.send(second.id, 'second chat')
    await app.shutdown()
    await start()
    const chats = app.project!.list()
    expect(chats.map((c) => c.name)).toEqual(['second chat', 'hello there'])
    expect(app.engine!.chats[first].map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('deletes a chat and its folder; the last one is replaced by a fresh chat', async () => {
    const only = app.project!.list()[0].id
    await app.deleteChat(only)
    expect(existsSync(join(dir, 'proj', '.multimine', 'chats', only))).toBe(false)
    const now = app.project!.list()
    expect(now).toHaveLength(1)
    expect(now[0].id).not.toBe(only)
  })

  it('a tool can start a new chat, named after its message, or write to the one on screen', async () => {
    const first = app.project!.list()[0].id
    const created = await app.engine!.fromTool('UI Sketcher', 'new', '# Build the inventory screen\n\ndetails')
    expect(created).not.toBe(first)
    expect(app.project!.get(created)!.name).toBe('UI Sketcher: Build the inventory screen')
    const msg = app.engine!.chats[created][0]
    expect(msg.from).toBe('tool:UI Sketcher')
    expect(msg.text).toContain('## From UI Sketcher')
    expect(await app.engine!.fromTool('Data Tables', 'active', 'rebalance', first)).toBe(first)
  })

  it('opens a project from the multi-agent version: its old files stay, and it gets a chat', async () => {
    const old = join(dir, 'old')
    await mkdir(join(old, '.multimine', 'agents'), { recursive: true })
    await writeFile(join(old, '.multimine', 'agents', 'mastermind.md'), '---\nname: Mastermind\nrole: mastermind\n---\nbrief')
    await writeFile(join(old, '.multimine', '.gitignore'), 'sessions/\nmedia/\nlayout.json\n')
    await app.openProject(old)
    expect(app.project!.list()).toHaveLength(1)
    expect(existsSync(join(old, '.multimine', 'agents', 'mastermind.md'))).toBe(true)
    expect(await readFile(join(old, '.multimine', '.gitignore'), 'utf8')).toBe('sessions/\nmedia/\nlayout.json\nchats/\n')
  })
})
