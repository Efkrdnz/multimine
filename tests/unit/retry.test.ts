import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { MultimineApp } from '../../src/main/app'

it('retry runs the last incoming message again after a failed turn', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mm-retry-'))
  let calls = 0
  const app = new MultimineApp({
    userDataDir: join(dir, 'u'),
    cipher: { encrypt: (s) => s, decrypt: (s) => s },
    emit: () => undefined,
    mockDelayMs: 0,
    skipDetect: true,
    // first turn fails like an expired login, the second succeeds
    mockScript: () => (++calls === 1 ? [{ tool: { name: 'nope', args: {} } }] : [{ text: 'all good' }])
  })
  await app.start()
  await app.openProject(join(dir, 'p'))
  const engine = app.engine!
  const id = app.project!.list()[0].id
  await engine.send(id, 'build the context set')
  const result = await engine.retry(id)!
  expect(result.text).toBe('all good')
  const msgs = engine.chats[id]
  expect(msgs.filter((m) => m.role === 'user').map((m) => m.text)).toEqual(['build the context set', 'build the context set'])
  expect(msgs.at(-1)!.text).toBe('all good')
  await app.shutdown()
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})
