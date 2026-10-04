import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { MultimineApp } from '../../src/main/app'
import type { MockScript } from '../../src/main/providers/mock'

let dir: string
let app: MultimineApp
let worker: string
const seen: { prompt: string; resumeId?: string }[] = []

const script: MockScript = (req) => {
  if (req.agent.name !== 'Worker') return [{ text: 'ok' }]
  seen.push({ prompt: req.prompt, resumeId: req.resumeId })
  return [
    { event: { type: 'resume', id: `t${seen.length}` } },
    { event: { type: 'call-usage', input: 100, cacheRead: 20_000, cacheWrite: 400, output: 50 } },
    { event: { type: 'call-usage', input: 200, cacheRead: 30_000, cacheWrite: 300, output: 80 } },
    { text: `reply ${seen.length}` }
  ]
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mm-fresh-'))
  seen.length = 0
  app = new MultimineApp({ userDataDir: join(dir, 'u'), cipher: { encrypt: (s) => s, decrypt: (s) => s }, emit: () => undefined, mockScript: script, mockDelayMs: 0, skipDetect: true })
  await app.start()
  await app.openProject(join(dir, 'p'))
  worker = (await app.createChat({ name: 'Worker' })).id
})

afterEach(async () => {
  await app.shutdown()
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

it('each turn continues the conversation the chat already has', async () => {
  const e = app.engine!
  await e.send(worker, 'build the furnace')
  await e.send(worker, 'build the anvil')
  expect(seen.map((s) => s.resumeId)).toEqual([undefined, 't1'])
})

it('a fresh start keeps the chat, forgets the conversation, and hands the next turn a recap', async () => {
  const e = app.engine!
  await e.send(worker, 'Make a fire sword')
  await e.send(worker, 'Now make it glow')
  expect(seen[1].resumeId).toBe('t1')
  expect(await e.freshStart(worker)).toBe(true)
  const line = e.chats[worker].at(-1)!
  expect(line).toMatchObject({ role: 'system', fresh: true })
  expect(line.recap).toContain('User: Make a fire sword')
  expect(line.recap).toContain('You: reply 2')
  await e.send(worker, 'Add a sound')
  expect(seen[2].resumeId).toBeUndefined()
  expect(seen[2].prompt).toMatch(/^# Where we left off\n[\s\S]*Make a fire sword[\s\S]*# Now\nAdd a sound$/)
  // the turn after that continues the new conversation, with no recap
  await e.send(worker, 'Louder')
  expect(seen[3].resumeId).toBe('t3')
  expect(seen[3].prompt).toBe('Louder')
  // the earlier messages are still on screen
  expect(e.chats[worker].some((m) => m.text === 'Make a fire sword')).toBe(true)
})

it('says how large the conversation was at its last call', async () => {
  await app.engine!.send(worker, 'hi')
  const reply = app.engine!.chats[worker].at(-1)!
  expect(reply.usage?.context).toBe(200 + 30_000 + 300)
})

it('a new chat is named after the first thing the user says', async () => {
  const chat = await app.createChat()
  expect(chat.name).toBe('New chat')
  await app.engine!.send(chat.id, '## Design a nebula portal block\nwith particles')
  for (let i = 0; i < 50 && app.project!.get(chat.id)!.name === 'New chat'; i++) await new Promise((r) => setTimeout(r, 10))
  expect(app.project!.get(chat.id)!.name).toBe('Design a nebula portal block')
  await app.engine!.send(chat.id, 'something else')
  await new Promise((r) => setTimeout(r, 30))
  expect(app.project!.get(chat.id)!.name).toBe('Design a nebula portal block')
})
