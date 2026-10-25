import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { MainEvent } from '@shared/types'
import { MultimineApp } from '../../src/main/app'
import type { MockScript } from '../../src/main/providers/mock'
import type { TurnRequest } from '../../src/main/providers/types'
import { snapshot } from '../../src/main/tuesday/prompt'
import { TUESDAY_ID } from '../../src/main/tuesday/tuesday'

const cipher = { encrypt: (s: string) => s, decrypt: (s: string) => s }

let dir: string
let app: MultimineApp
let seen: TurnRequest[]
let events: MainEvent[]
let script: MockScript
let forge: string
let quest: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mm-tuesday-'))
  seen = []
  events = []
  script = () => [{ text: 'ok' }]
  app = new MultimineApp({ userDataDir: join(dir, 'u'), cipher, emit: (e) => events.push(e), mockScript: (req) => (seen.push(req), script(req)), mockDelayMs: 0, skipDetect: true })
  await app.start()
  forge = join(dir, 'forge')
  quest = join(dir, 'quest')
  await mkdir(forge)
  await mkdir(quest)
  await app.openProject(forge)
  await app.openProject(quest)
})

afterEach(async () => {
  await app.shutdown()
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

const until = async <T>(get: () => T | undefined | false | Promise<T | undefined | false>, what: string): Promise<T> => {
  for (let i = 0; i < 1000; i++) {
    const v = await get()
    if (v) return v
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`timed out waiting for ${what}`)
}
const tool = (name: string) => app.tuesday.tools().find((t) => t.name === name)!
const call = async (name: string, args: Record<string, unknown>) => tool(name).handler(args)

it('reads the workspace in a few lines', () => {
  const chat = (name: string) => ({ id: name, name, provider: 'mock', model: 'mock' }) as never
  const text = snapshot(
    [
      { name: 'forge', current: false, chats: [{ chat: chat('Spells'), status: 'working', activity: 'Running gradlew', since: 0 }], waiting: 1, game: 'running' },
      { name: 'quest', current: true, focused: 'Story', chats: [{ chat: chat('Story'), status: 'idle' }], waiting: 0 }
    ],
    4 * 60_000
  )
  expect(text).toContain('On screen: quest, chat "Story".')
  expect(text).toContain('- forge (game running): Spells (Running gradlew, 4m)')
  expect(text).toContain('- quest: Story (idle)')
  expect(text).toContain('Waiting for the user: 1')
  expect(snapshot([])).toMatch(/no project is open/)
})

it('runs on its own: its own prompt and tools, every message with a look at the workspace', async () => {
  const r = await app.tuesday.send("What's going on?")
  expect(r.error).toBeUndefined()
  const req = seen.find((x) => x.agent.id === TUESDAY_ID)!
  expect(req.system).toContain('You are Tuesday')
  expect(req.system).not.toContain('save_table')
  expect(req.agent.permissions).toBe('chat')
  expect(req.tools.map((t) => t.name)).toEqual(['overview', 'read_chat', 'send_to_chat', 'stop_chat', 'waiting', 'answer', 'run_game', 'show', 'ideas'])
  expect(req.prompt).toMatch(/^\[Workspace now/)
  expect(req.prompt).toContain('- forge: New chat (idle)')
  expect(req.prompt).toContain('On screen: quest')
  expect(req.prompt.endsWith("What's going on?")).toBe(true)
  // the conversation keeps what the user said, not the snapshot
  const st = await app.tuesdayInit()
  expect(st.messages.map((m) => [m.role, m.text])).toEqual([
    ['user', "What's going on?"],
    ['assistant', 'ok']
  ])
  expect(events.some((e) => e.type === 'tuesday-upsert')).toBe(true)
  // its conversation is not a chat of any project
  expect(app.project!.list().some((c) => c.id === TUESDAY_ID)).toBe(false)
})

it("gives a chat work, reads it, and answers its question only once the user confirmed the read-back", async () => {
  script = (req) => {
    if (req.agent.id === TUESDAY_ID) return req.prompt.includes('Get Spells on it') ? [{ tool: { name: 'send_to_chat', args: { chat: 'Spells', message: 'Add a fireball spell.' } } }, { text: 'Spells is on it.' }] : [{ text: 'ok' }]
    if (req.prompt.includes('Add a fireball spell.')) return [{ tool: { name: 'ask_user', args: { questions: [{ question: 'Which element?', options: [{ label: 'Fire' }, { label: 'Ice' }] }] } } }, { text: 'Added an ice fireball.' }]
    return [{ text: 'ok' }]
  }
  const spells = await app.createChat({ name: 'Spells' })
  await app.tuesday.send('Get Spells on it: a fireball')
  const msgs = () => app.engine!.chats[spells.id] ?? []
  expect(await until(() => msgs().find((m) => m.role === 'user'), 'the brief')).toMatchObject({ from: 'tool:Tuesday' })

  const listed = await until(async () => {
    const w = (await call('waiting', {})).text
    return w.includes('Which element?') && w
  }, 'the question')
  expect(listed).toContain('quest / Spells asks:')
  expect(listed).toContain('options: Fire | Ice')
  const id = /\[([^\]]+)\] quest \/ Spells/.exec(listed)![1]

  const unconfirmed = await call('answer', { id, answers: { '1': 'Ice' }, user_confirmed: false })
  expect(unconfirmed.isError).toBe(true)
  expect(unconfirmed.text).toContain('Read the answer back')
  expect(app.engine!.inbox.get(id)?.status).toBe('pending')

  expect((await call('answer', { id, answers: { '1': 'Ice' }, user_confirmed: true })).text).toBe('Answered "Spells": Which element? -> Ice.')
  await until(() => msgs().some((m) => m.text === 'Added an ice fireball.' && !m.streaming), 'the reply')
  const read = (await call('read_chat', { chat: 'spells' })).text
  expect(read).toContain('"Spells"')
  expect(read).toContain('--- Tuesday')
  expect(read).toContain('ran 1 tool: ask_user')
  expect(read).toContain('Added an ice fireball.')
})

it('never allows a hard stop for the user; an ordinary permission it can, once confirmed', async () => {
  const careful = await app.createChat({ name: 'Careful', autoApprove: false })
  const push = app.engine!.approveAction(careful.id, 'git push', 'git push origin main', true)
  const hard = await until(() => app.engine!.inbox.pending()[0], 'the push')
  expect(hard.hardStop).toBe(true)
  expect((await call('waiting', {})).text).toContain('HARD STOP')
  const refused = await call('answer', { id: hard.id, approve: true, user_confirmed: true })
  expect(refused.isError).toBe(true)
  expect(refused.text).toContain('hard stop')
  await app.decide(hard.id, false)
  expect(await push).toBe(false)

  const run = app.engine!.approveAction(careful.id, 'run: npm test', 'npm test')
  const item = await until(() => app.engine!.inbox.pending()[0], 'the command')
  expect((await call('answer', { id: item.id, approve: true, user_confirmed: true })).text).toBe('Approved for "Careful": run: npm test.')
  expect(await run).toBe(true)
})

it('finds chats and projects by name, says when a name is not enough, and puts things on screen', async () => {
  await app.createChat({ name: 'Spells' })
  await app.switchProject(forge)
  const forgeSpells = await app.createChat({ name: 'Spells' })
  const ambiguous = await call('read_chat', { chat: 'Spells' })
  expect(ambiguous.isError).toBe(true)
  expect(ambiguous.text).toContain('matches several chats')
  expect((await call('read_chat', { chat: 'Spells', project: 'forge' })).text).toContain(`[${forgeSpells.id}] in forge`)

  const overview = (await call('overview', {})).text
  expect(overview).toContain('## forge (on screen)')
  expect(overview).toContain('## quest')

  events.length = 0
  expect((await call('show', { project: 'quest', tool: 'idea book' })).text).toBe('On screen: quest, Idea Book.')
  expect(app.project!.dir).toBe(quest)
  expect(events).toContainEqual({ type: 'tuesday-show', tool: 'idea-book' })
  expect((await call('ideas', { action: 'add', title: 'Mana regen ring' })).text).toBe('Added "Mana regen ring" to the Idea Book of quest.')
  expect((await call('ideas', { action: 'list' })).text).toBe('- Mana regen ring')
})

it('starts work in a new chat in another project, in plan mode', async () => {
  const out = (await call('send_to_chat', { chat: 'new', project: 'forge', message: '# Boss fight\n\nA dragon with three phases.', plan: true })).text
  expect(out).toMatch(/^Sent to "Tuesday: Boss fight" \[\w+\] in forge \(plan first\)/)
  const ws = app.spaceOfChat(/\[(\w+)\]/.exec(out)![1])!
  expect(ws.dir).toBe(forge)
  const msg = await until(() => Object.values(ws.engine.chats).flat().find((m) => m.role === 'user'), 'the message')
  expect(msg.modes).toEqual({ plan: true })
})

it('tells the user when a chat in the background finishes or asks, but not about the chat they are watching', async () => {
  await app.switchProject(forge)
  const bg = await app.createChat({ name: 'Builder' })
  await app.switchProject(quest)
  const ws = app.spaceOfChat(bg.id)!
  events.length = 0
  await ws.engine.send(bg.id, 'build it')
  const notices = () => events.flatMap((e) => (e.type === 'tuesday-notice' ? [e.notice] : []))
  expect(notices()).toContainEqual(expect.objectContaining({ kind: 'done', text: 'Builder finished', dir: forge, chatId: bg.id }))

  const asking = ws.engine.askUser(bg.id, [{ question: 'Which biome?', options: [{ label: 'Desert' }, { label: 'Snow' }] }])
  await until(() => notices().some((n) => n.kind === 'ask'), 'the ask notice')
  expect(notices().find((n) => n.kind === 'ask')?.text).toBe('Builder asks: Which biome?')
  // everything waiting, in every project, and answered from wherever the user is
  const w = app.waiting()
  expect(w).toEqual([expect.objectContaining({ dir: forge, project: 'forge', chat: 'Builder' })])
  await app.answer(w[0].item.id, { 'Which biome?': 'Snow' })
  expect((await asking).answers).toEqual({ 'Which biome?': 'Snow' })

  // the chat on screen says its own things
  const here = await app.createChat({ name: 'Here' })
  await app.setActiveChat(here.id)
  events.length = 0
  await app.engine!.send(here.id, 'hello')
  expect(notices()).toEqual([])
})

it('follows its settings: name, provider and model', async () => {
  await app.updateSettings({ tuesday: { enabled: true, name: 'Friday', provider: 'mock', model: 'mock-small', effort: 'low' } })
  const st = await app.tuesdayInit()
  expect(st.spec).toMatchObject({ id: TUESDAY_ID, name: 'Friday', provider: 'mock', model: 'mock-small', effort: 'low', permissions: 'chat' })
  await app.tuesday.send('hi')
  const req = seen.find((x) => x.agent.id === TUESDAY_ID)!
  expect(req.system).toContain('You are Friday')
  expect(req.agent.model).toBe('mock-small')
})

