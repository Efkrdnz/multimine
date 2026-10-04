import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { roleTemplate } from '@shared/templates'
import { MultimineApp } from '../../src/main/app'
import type { MockScript } from '../../src/main/providers/mock'

let dir: string
let app: MultimineApp
const handler: { prompt: string; resumeId?: string }[] = []

// a writer that reports a change each turn; the Context Handler just answers
const script: MockScript = (req) => {
  if (req.agent.role === 'context-handler') {
    handler.push({ prompt: req.prompt, resumeId: req.resumeId })
    return [{ event: { type: 'resume', id: `ctx-${handler.length}` } }, { text: 'updated' }]
  }
  return [{ tool: { name: 'report', args: { summary: `did ${req.prompt}`, files: [`src/${req.prompt}.java`] } } }, { text: 'done' }]
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mm-ctx-'))
  handler.length = 0
  app = new MultimineApp({ userDataDir: join(dir, 'u'), cipher: { encrypt: (s) => s, decrypt: (s) => s }, emit: () => undefined, mockScript: script, mockDelayMs: 0, forceMockMastermind: true })
  await app.start()
  await app.openProject(join(dir, 'p'))
  await app.saveAgent({ ...roleTemplate('implementer', ''), name: 'Writer', provider: 'mock', model: 'mock', autoApprove: true }, true)
  await app.saveAgent({ ...roleTemplate('context-handler', ''), provider: 'mock', model: 'mock' }, true)
  for (let i = 0; i < 100 && !handler.length; i++) await new Promise((r) => setTimeout(r, 10)) // its bootstrap
  handler.length = 0
})

afterEach(async () => {
  await app.shutdown()
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

it('batches the tasks of a busy spell into one update, in a fresh session, once the team is quiet', async () => {
  await app.updateSettings({ contextIdleMinutes: 0.003 }) // 180 ms
  for (const t of ['Fire', 'Ice', 'Wind']) await app.engine!.send('writer', t)
  expect(handler).toHaveLength(0)
  expect(app.engine!.contextPending()).toBe(3)
  for (let i = 0; i < 100 && !handler.length; i++) await wait(10)
  await wait(50)
  expect(handler).toHaveLength(1)
  for (const t of ['did Fire', 'did Ice', 'did Wind', 'src/Wind.java']) expect(handler[0].prompt).toContain(t)
  expect(handler[0].resumeId).toBeUndefined()
  // the next batch does not resume the last one either
  await app.engine!.send('writer', 'Earth')
  for (let i = 0; i < 100 && handler.length < 2; i++) await wait(10)
  expect(handler[1].resumeId).toBeUndefined()
  expect(handler[1].prompt).toContain('did Earth')
  expect(handler[1].prompt).not.toContain('did Fire')
})

it('waits for Sync when set to manual, and goes at once when set to each task', async () => {
  await app.updateSettings({ contextUpdates: 'manual', contextIdleMinutes: 0.001 })
  await app.engine!.send('writer', 'Fire')
  await wait(150)
  expect(handler).toHaveLength(0)
  expect(await app.syncContext()).toBe(true)
  for (let i = 0; i < 100 && !handler.length; i++) await wait(10)
  expect(handler[0].prompt).toContain('did Fire')
  expect(await app.syncContext()).toBe(false)

  await app.updateSettings({ contextUpdates: 'each' })
  await app.engine!.send('writer', 'Ice')
  for (let i = 0; i < 100 && handler.length < 2; i++) await wait(10)
  expect(handler[1].prompt).toContain('did Ice')
})
