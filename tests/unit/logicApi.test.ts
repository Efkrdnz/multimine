import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { roleTemplate } from '@shared/templates'
import type { MainEvent } from '@shared/types'
import { MultimineApp } from '../../src/main/app'
import type { MockScript } from '../../src/main/providers/mock'

let dir: string
let app: MultimineApp
let events: MainEvent[]
const seen: { agent: string; prompt: string; resumeId?: string }[] = []

const script: MockScript = (req) => {
  seen.push({ agent: req.agent.id, prompt: req.prompt, resumeId: req.resumeId })
  return [{ event: { type: 'resume', id: `t-${seen.length}` } }, { text: 'ok' }]
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mm-lapi-'))
  events = []
  seen.length = 0
  app = new MultimineApp({ userDataDir: join(dir, 'u'), cipher: { encrypt: (s) => s, decrypt: (s) => s }, emit: (e) => events.push(e), mockScript: script, mockDelayMs: 0, forceMockMastermind: true })
  await app.start()
  await app.openProject(join(dir, 'p'))
  await app.saveAgent({ ...roleTemplate('implementer', ''), name: 'Implementer', provider: 'mock', model: 'mock' }, true)
})

afterEach(async () => {
  await app.shutdown()
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 300 && !ok(); i++) await new Promise((r) => setTimeout(r, 10))
  expect(ok()).toBe(true)
}

it('a Build sent to Mastermind carries the user\'s approval, which opens the Implementer\'s gate', async () => {
  const r = (await app.pluginCall('logic-board', 'task', ['mastermind', 'Build "Sneak Shot"', 'the brief'])) as { approvalId: string }
  const item = app.engine!.inbox.get(r.approvalId)!
  expect(item).toMatchObject({ kind: 'approval', approved: true, status: 'answered', title: 'Build "Sneak Shot"', askedBy: 'plugin:logic-board' })
  // answered, so it never notifies or shows as waiting
  expect(app.engine!.inbox.pending()).toEqual([])
  await until(() => seen.some((s) => s.agent === 'mastermind'))
  expect(seen.find((s) => s.agent === 'mastermind')!.prompt).toContain(`the brief\n\napproval_id: ${r.approvalId}`)
  expect(app.engine!.bus.some((b) => b.kind === 'delegate' && b.from === 'plugin:logic-board' && b.to === 'mastermind')).toBe(true)
  // Mastermind's delegate tool takes that id for the gated Implementer
  const delegate = app.engine!.coordinationTools(app.project!.get('mastermind')!).find((t) => t.name === 'delegate')!
  const out = await delegate.handler({ agent: 'implementer', task: 'build it', approval_id: r.approvalId })
  expect(out.isError).toBeFalsy()
})

it('a Build sent straight to an agent is a delegated task in a fresh session', async () => {
  await app.engine!.send('implementer', 'earlier chat')
  const r = await app.pluginCall('logic-board', 'task', ['implementer', 'Build "Sneak Shot"', 'build the board'])
  expect(r).toEqual({ approvalId: null })
  await until(() => seen.filter((s) => s.agent === 'implementer').length === 2)
  const task = seen.filter((s) => s.agent === 'implementer')[1]
  expect(task.resumeId).toBeUndefined()
  expect(task.prompt).toContain('Task from Logic Board')
  expect(task.prompt).toContain('build the board')
  await expect(app.pluginCall('logic-board', 'task', ['nobody', 't', 'x'])).rejects.toThrow('No agent')
})

it('opens a project file in the IDE at a line, and nothing outside the project', async () => {
  await app.pluginCall('logic-board', 'ide.open', ['src\\Shot.java', 42])
  expect(events).toContainEqual({ type: 'ide-open', path: 'src/Shot.java', line: 42 })
  await expect(app.pluginCall('logic-board', 'ide.open', ['../../etc/passwd', 1])).rejects.toThrow('outside the project')
})
