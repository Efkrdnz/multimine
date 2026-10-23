import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { newChat } from '@shared/chat'
import { workPrompt } from '@shared/ideas'
import { COOP_RULES, PLAN_RULES, parseModes, turnModes } from '@shared/modes'
import { MultimineApp } from '../../src/main/app'
import { withModes } from '../../src/main/chat/engine'
import type { MockScript } from '../../src/main/providers/mock'
import type { TurnRequest } from '../../src/main/providers/types'

const cipher = { encrypt: (s: string) => s, decrypt: (s: string) => s }

let dir: string
let app: MultimineApp
let seen: TurnRequest[]
let script: MockScript

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mm-modes-'))
  seen = []
  script = () => [{ text: 'ok' }]
  app = new MultimineApp({ userDataDir: join(dir, 'u'), cipher, emit: () => undefined, mockScript: (req) => (seen.push(req), script(req)), mockDelayMs: 0, skipDetect: true })
  await app.start()
  await app.openProject(join(dir, 'p'))
})

afterEach(async () => {
  await app.shutdown()
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

const until = async <T>(get: () => T | undefined | false, what: string): Promise<T> => {
  for (let i = 0; i < 1000; i++) {
    const v = get()
    if (v) return v
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`timed out waiting for ${what}`)
}
const pendingItem = () => until(() => app.engine!.inbox.pending()[0], 'a question')
const toolNames = (r: TurnRequest) => r.tools.map((t) => t.name)

it('reads /plan and /coop off the front of a message, and a message over its chat', () => {
  expect(parseModes('/plan /coop  add a mana bar')).toEqual({ modes: { plan: true, coop: true }, text: 'add a mana bar' })
  expect(parseModes('/coop /table spells')).toEqual({ modes: { coop: true }, text: '/table spells' })
  expect(parseModes('/planet x')).toEqual({ modes: {}, text: '/planet x' })
  expect(parseModes('  hello')).toEqual({ modes: {}, text: '  hello' })
  const chat = { planMode: true, coop: false }
  expect(turnModes(chat, {})).toEqual({ plan: true, coop: false })
  expect(turnModes(chat, { modes: { plan: false, coop: true } })).toEqual({ plan: false, coop: true })
  // a command has its own flow: the chat's plan mode does not hold it up, only an explicit /plan
  expect(turnModes(chat, { command: 'table' })).toEqual({ plan: false, coop: false })
  expect(turnModes(chat, { command: 'table', modes: { plan: true } }).plan).toBe(true)
})

it("plans in Claude's own plan mode, and read only everywhere else", () => {
  const plan = { plan: true, coop: true }
  const claude = withModes(newChat('a', { provider: 'claude-cli', model: '', effort: 'medium', permissions: 'write', autoApprove: true }), plan)
  expect(claude).toMatchObject({ planMode: true, coop: true, permissions: 'write' })
  const codex = withModes(newChat('b', { provider: 'codex-cli', model: '', effort: 'medium', permissions: 'write', autoApprove: true }), plan)
  expect(codex).toMatchObject({ planMode: false, permissions: 'read' })
  const talker = withModes(newChat('c', { provider: 'openai', model: '', effort: 'medium', permissions: 'chat', autoApprove: false }), plan)
  expect(talker.permissions).toBe('chat')
})

it('/plan on a provider without plan mode: read only, the plan comes in for approval, then the go-ahead follows by itself', async () => {
  script = (req) =>
    toolNames(req).includes('present_plan')
      ? [{ tool: { name: 'present_plan', args: { plan: '1. Add the bar\n2. Hook it to mana' } } }, { text: 'Approved; waiting for the go-ahead.' }]
      : req.prompt.includes('The plan is approved')
        ? [{ text: 'Built it.' }]
        : [{ text: 'ok' }]
  const chat = await app.createChat()
  const turn = app.engine!.send(chat.id, '/plan Add a mana bar')
  const item = await pendingItem()
  expect(item).toMatchObject({ askedBy: chat.id, planMd: '1. Add the bar\n2. Hook it to mana' })
  expect(item.title).toContain('approve this plan?')
  await app.decide(item.id, true, 'Keep it small')
  await turn

  const plan = seen[0]
  expect(plan.prompt).toBe('Add a mana bar')
  expect(plan.agent.permissions).toBe('read')
  expect(plan.system).toContain(PLAN_RULES)
  expect(toolNames(plan)).toContain('present_plan')
  expect(toolNames(plan)).not.toContain('write_file')

  await until(() => app.engine!.chats[chat.id].some((m) => m.role === 'assistant' && m.text === 'Built it.' && !m.streaming), 'the go-ahead turn')
  const go = seen[1]
  expect(go.prompt).toBe('The plan is approved: carry it out now.\n\nThe user adds: Keep it small')
  expect(go.agent.permissions).toBe('write')
  expect(go.system).not.toContain(PLAN_RULES)
  expect(toolNames(go)).not.toContain('present_plan')

  const asked = app.engine!.chats[chat.id].filter((m) => m.role === 'user')
  expect(asked.map((m) => [m.text, m.modes])).toEqual([
    ['Add a mana bar', { plan: true }],
    [go.prompt, { plan: false, coop: false }]
  ])
  expect(app.project!.get(chat.id)?.name).toBe('Add a mana bar')
})

it('a plan sent back comes back to the chat with the feedback, and nothing follows', async () => {
  let tries = 0
  script = (req) => (toolNames(req).includes('present_plan') && tries++ === 0 ? [{ tool: { name: 'present_plan', args: { plan: 'Rewrite everything' } } }, { text: 'Will revise.' }] : [{ text: 'ok' }])
  const chat = await app.createChat({ planMode: true })
  const turn = app.engine!.send(chat.id, 'Fix the crash')
  await app.decide((await pendingItem()).id, false, 'Too big: just fix the null check')
  await turn
  const tool = app.engine!.chats[chat.id].find((m) => m.role === 'assistant')!.tools!.find((t) => t.name === 'present_plan')!
  expect(tool.status).toBe('error')
  expect(tool.output).toContain('Not approved. The user says: Too big: just fix the null check')
  await new Promise((r) => setTimeout(r, 50))
  expect(seen).toHaveLength(1)
  // the chat's plan mode holds every turn
  await app.engine!.send(chat.id, 'Try again')
  expect(seen[1].system).toContain(PLAN_RULES)
})

it('coop: a chat setting, or one message', async () => {
  const partner = await app.createChat({ coop: true })
  await app.engine!.send(partner.id, 'A shop for the village')
  expect(seen[0].system).toContain(COOP_RULES)
  expect(seen[0].agent.coop).toBe(true)

  const chat = await app.createChat()
  await app.engine!.send(chat.id, '/coop A boss fight')
  expect(seen[1].system).toContain(COOP_RULES)
  expect(seen[1].prompt).toBe('A boss fight')
  expect(seen[1].system).not.toContain(PLAN_RULES)
  await app.engine!.send(chat.id, 'thanks')
  expect(seen[2].system).not.toContain(COOP_RULES)
})

it('tools send in plan or coop: the Idea Book works an idea as asked', async () => {
  const chat = await app.createChat()
  await app.pluginCall('idea-book', 'send', [chat.id, workPrompt({ title: 'Mana ring' }, 'coop'), { coop: true }])
  await until(() => seen.length === 1 && !app.engine!.busy(chat.id), 'the turn')
  const msg = app.engine!.chats[chat.id].find((m) => m.role === 'user')!
  expect(msg.modes).toEqual({ coop: true })
  expect(msg.text).toContain('together with the user')
  expect(seen[0].system).toContain(COOP_RULES)
  // api 2's planMode still means plan, now for any provider
  const { chatId } = (await app.pluginCall('idea-book', 'send', ['new', '# Plan this\n\nA quest log', { planMode: true }])) as { chatId: string }
  const plan = await until(() => app.engine!.chats[chatId]?.find((m) => m.role === 'user'), 'the new chat')
  expect(plan.modes).toEqual({ plan: true })
})
