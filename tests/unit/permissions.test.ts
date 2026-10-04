import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { MultimineApp } from '../../src/main/app'

let dir: string
let app: MultimineApp
let auto: string
let careful: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mm-perm-'))
  app = new MultimineApp({ userDataDir: join(dir, 'u'), cipher: { encrypt: (s) => s, decrypt: (s) => s }, emit: () => undefined, mockDelayMs: 0, skipDetect: true })
  await app.start()
  await app.openProject(join(dir, 'p'))
  auto = (await app.createChat({ name: 'Auto', autoApprove: true })).id
  careful = (await app.createChat({ name: 'Careful', autoApprove: false })).id
})

afterEach(async () => {
  await app.shutdown()
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

it('Full access chats are never stopped for ordinary actions', async () => {
  expect(await app.engine!.approveAction(auto, 'run: ./gradlew build', './gradlew build')).toBe(true)
  expect(app.engine!.inbox.pending()).toHaveLength(0)
})

// the item lands in the inbox a moment after the call: wait for it rather than for a fixed time
const pendingItem = async () => {
  for (let i = 0; i < 500; i++) {
    const it = app.engine!.inbox.pending()[0]
    if (it) return it
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('nothing was asked')
}

it('a push asks even a Full access chat', async () => {
  const pending = app.engine!.approveAction(auto, 'git push', 'git push origin main', true)
  const item = await pendingItem()
  expect(item.permission).toBe(true)
  expect(item.askedBy).toBe(auto)
  await app.decide(item.id, false)
  expect(await pending).toBe(false)
})

it('a Supervised chat asks before every action, and the request_permission tool always does', async () => {
  const asked = app.engine!.approveAction(careful, 'run: ls', 'ls')
  await app.decide((await pendingItem()).id, true)
  expect(await asked).toBe(true)

  const tool = app.engine!.coordinationTools(app.project!.get(auto)!).find((t) => t.name === 'request_permission')!
  const out = tool.handler({ action: 'git push origin main' })
  await app.decide((await pendingItem()).id, true)
  expect((await out).text).toBe('ALLOWED')
})
