import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { MainEvent } from '@shared/types'
import { MultimineApp } from '../../src/main/app'
import type { MockScript } from '../../src/main/providers/mock'

let dir: string
let app: MultimineApp
let events: MainEvent[]
let first: string
const seen: { agent: string; prompt: string; resumeId?: string }[] = []

const script: MockScript = (req) => {
  seen.push({ agent: req.agent.id, prompt: req.prompt, resumeId: req.resumeId })
  return [{ event: { type: 'resume', id: `t-${seen.length}` } }, { text: 'ok' }]
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mm-lapi-'))
  events = []
  seen.length = 0
  app = new MultimineApp({ userDataDir: join(dir, 'u'), cipher: { encrypt: (s) => s, decrypt: (s) => s }, emit: (e) => events.push(e), mockScript: script, mockDelayMs: 0, skipDetect: true })
  await app.start()
  await app.openProject(join(dir, 'p'))
  first = app.project!.list()[0].id
})

afterEach(async () => {
  await app.shutdown()
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 300 && !ok(); i++) await new Promise((r) => setTimeout(r, 10))
  expect(ok()).toBe(true)
}

it('a task to a new chat starts one, named after it, with the message from the tool', async () => {
  const r = (await app.pluginCall('logic-board', 'task', ['new', 'Build "Sneak Shot"', 'the brief'])) as { chatId: string }
  expect(r.chatId).not.toBe(first)
  expect(app.project!.get(r.chatId)!.name).toBe('Logic Board: Build "Sneak Shot"')
  await until(() => seen.some((s) => s.agent === r.chatId))
  const prompt = seen.find((s) => s.agent === r.chatId)!.prompt
  expect(prompt).toContain('## From Logic Board')
  expect(prompt).toContain('# Build "Sneak Shot"\n\nthe brief')
  // nothing waits on the user: pressing the button was the request
  expect(app.engine!.inbox.pending()).toEqual([])
})

it("a message to the active chat goes to the one on screen and continues its conversation; api 1's mastermind means the same", async () => {
  await app.engine!.send(first, 'earlier chat')
  await app.setActiveChat(first)
  expect(await app.pluginCall('data-tables', 'send', ['active', 'rebalance these rows'])).toEqual({ chatId: first })
  await until(() => seen.filter((s) => s.agent === first).length === 2)
  expect(seen.filter((s) => s.agent === first)[1].resumeId).toBe('t-1')
  expect(await app.pluginCall('data-tables', 'send', ['mastermind', 'and these'])).toEqual({ chatId: first })
  await expect(app.pluginCall('data-tables', 'send', ['nobody', 'x'])).rejects.toThrow('No chat')
})

it('lists the chats, and marks the one on screen', async () => {
  const other = await app.createChat({ name: 'Other' })
  await app.setActiveChat(first)
  const list = (await app.pluginCall('ui-sketcher', 'chats.list', [])) as { id: string; name: string; active: boolean; busy: boolean }[]
  expect(list.map((c) => [c.id, c.active])).toEqual([
    [other.id, false],
    [first, true]
  ])
  // api 1 plugins still get a team, every chat a custom agent
  const team = (await app.pluginCall('ui-sketcher', 'team.list', [])) as { role: string }[]
  expect(team.every((m) => m.role === 'custom')).toBe(true)
  expect(await app.pluginCall('ui-sketcher', 'info', [])).toMatchObject({ apiVersion: 2 })
})

it('opens a project file in the IDE at a line, and nothing outside the project', async () => {
  await app.pluginCall('logic-board', 'ide.open', ['src\\Shot.java', 42])
  expect(events).toContainEqual({ type: 'ide-open', path: 'src/Shot.java', line: 42 })
  await expect(app.pluginCall('logic-board', 'ide.open', ['../../etc/passwd', 1])).rejects.toThrow('outside the project')
})
