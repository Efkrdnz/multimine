import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { roleTemplate } from '@shared/templates'
import { MultimineApp } from '../../src/main/app'

let dir: string
let app: MultimineApp

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mm-perm-'))
  app = new MultimineApp({ userDataDir: join(dir, 'u'), cipher: { encrypt: (s) => s, decrypt: (s) => s }, emit: () => undefined, mockDelayMs: 0, forceMockMastermind: true })
  await app.start()
  await app.openProject(join(dir, 'p'))
  await app.saveAgent({ ...roleTemplate('implementer', ''), name: 'Auto', provider: 'mock', autoApprove: true }, true)
  await app.saveAgent({ ...roleTemplate('implementer', ''), name: 'Careful', provider: 'mock', autoApprove: false }, true)
})

afterEach(async () => {
  await app.shutdown()
  await rm(dir, { recursive: true, force: true })
})

it('auto-approved agents are never stopped for ordinary actions', async () => {
  expect(await app.engine!.approveAction('auto', 'run: ./gradlew build', './gradlew build')).toBe(true)
  expect(app.engine!.inbox.pending()).toHaveLength(0)
})

// the item lands in the inbox after its bus entry is written: wait for it rather than for a fixed time
const pendingItem = async () => {
  for (let i = 0; i < 500; i++) {
    const it = app.engine!.inbox.pending()[0]
    if (it) return it
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('nothing was asked')
}

it('a push asks even an auto-approved agent, as a permission balloon', async () => {
  const pending = app.engine!.approveAction('auto', 'git push', 'git push origin main', true)
  const item = await pendingItem()
  expect(item.permission).toBe(true)
  expect(item.askedBy).toBe('auto')
  await app.decide(item.id, false)
  expect(await pending).toBe(false)
})

it('with auto-approve off every action asks, and the request_permission tool always does', async () => {
  const careful = app.engine!.approveAction('careful', 'run: ls', 'ls')
  await app.decide((await pendingItem()).id, true)
  expect(await careful).toBe(true)

  const tool = app.engine!.coordinationTools(app.project!.get('auto')!).find((t) => t.name === 'request_permission')!
  const out = tool.handler({ action: 'git push origin main' })
  await app.decide((await pendingItem()).id, true)
  expect((await out).text).toBe('ALLOWED')
})
