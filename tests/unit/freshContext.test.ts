import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { roleTemplate } from '@shared/templates'
import { MultimineApp } from '../../src/main/app'
import type { MockScript } from '../../src/main/providers/mock'

let dir: string
let app: MultimineApp
const seen: { prompt: string; resumeId?: string }[] = []

const script: MockScript = (req) => {
  if (req.agent.id !== 'worker') return [{ text: 'ok' }]
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
  app = new MultimineApp({ userDataDir: join(dir, 'u'), cipher: { encrypt: (s) => s, decrypt: (s) => s }, emit: () => undefined, mockScript: script, mockDelayMs: 0, forceMockMastermind: true })
  await app.start()
  await app.openProject(join(dir, 'p'))
  await app.saveAgent({ ...roleTemplate('designer', ''), name: 'Worker', provider: 'mock', model: 'mock' }, true)
})

afterEach(async () => {
  await app.shutdown()
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

it('a delegated task starts clean unless it continues the agent\'s last task', async () => {
  const e = app.engine!
  await e.relay('mastermind', 'worker', 'build the furnace', 'delegate', true)
  await e.relay('mastermind', 'worker', 'build the anvil', 'delegate', true)
  await e.relay('mastermind', 'worker', 'make the anvil heavier', 'delegate', true, undefined, { continueSession: true })
  expect(seen.map((s) => s.resumeId)).toEqual([undefined, undefined, 't2'])
})

it('a fresh start keeps the chat, forgets the conversation, and hands the next turn a recap', async () => {
  const e = app.engine!
  await e.send('worker', 'Make a fire sword')
  await e.send('worker', 'Now make it glow')
  expect(seen[1].resumeId).toBe('t1')
  expect(await e.freshStart('worker')).toBe(true)
  const line = e.chats.worker.at(-1)!
  expect(line).toMatchObject({ role: 'system', fresh: true })
  expect(line.recap).toContain('User: Make a fire sword')
  expect(line.recap).toContain('You: reply 2')
  await e.send('worker', 'Add a sound')
  expect(seen[2].resumeId).toBeUndefined()
  expect(seen[2].prompt).toMatch(/^# Where we left off\n[\s\S]*Make a fire sword[\s\S]*# Now\nAdd a sound$/)
  // the turn after that continues the new conversation, with no recap
  await e.send('worker', 'Louder')
  expect(seen[3].resumeId).toBe('t3')
  expect(seen[3].prompt).toBe('Louder')
  // the earlier messages are still on screen
  expect(e.chats.worker.some((m) => m.text === 'Make a fire sword')).toBe(true)
})

it('says how large the conversation was at its last call', async () => {
  await app.engine!.send('worker', 'hi')
  const reply = app.engine!.chats.worker.at(-1)!
  expect(reply.usage?.context).toBe(200 + 30_000 + 300)
})

it('a new chat is named after the first thing the user says', async () => {
  await app.newSession()
  expect(app.engine!.session.name).toBe('New chat')
  await app.engine!.send('worker', 'Design a nebula portal block\nwith particles')
  for (let i = 0; i < 50 && app.engine!.session.name === 'New chat'; i++) await new Promise((r) => setTimeout(r, 10))
  expect(app.engine!.session.name).toBe('Design a nebula portal block')
  await app.engine!.send('worker', 'something else')
  await new Promise((r) => setTimeout(r, 30))
  expect(app.engine!.session.name).toBe('Design a nebula portal block')
})

it('moves an unedited lean Mastermind onto the instructions that know about clean contexts', async () => {
  const proj = join(dir, 'old')
  await mkdir(join(proj, '.multimine', 'agents'), { recursive: true })
  await writeFile(join(proj, '.multimine', 'agents', 'mastermind.md'), await readFile(join(__dirname, '..', 'fixtures', 'legacy', 'mastermind-lean.md'), 'utf8'))
  await app.openProject(proj)
  expect(app.project!.get('mastermind')!.purpose).toContain('continue_previous')
})
