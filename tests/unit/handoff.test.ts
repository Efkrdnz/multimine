import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { roleTemplate } from '@shared/templates'
import { MultimineApp } from '../../src/main/app'

it('a handoff that outlives the wait cap returns early and delivers its report later', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mm-handoff-'))
  const app = new MultimineApp({
    userDataDir: join(dir, 'u'),
    cipher: { encrypt: (s) => s, decrypt: (s) => s },
    emit: () => undefined,
    mockDelayMs: 4,
    forceMockMastermind: true,
    mockScript: (req) => {
      if (req.agent.id === 'mastermind' && req.prompt === 'go') return [{ tool: { name: 'delegate', args: { agent: 'builder', task: 'build it' } } }]
      if (req.agent.id === 'builder') return [{ text: 'word '.repeat(80) }, { tool: { name: 'report', args: { summary: 'built it' } } }]
      return [{ text: 'thanks' }]
    }
  })
  await app.start()
  await app.updateSettings({ handoffWaitMinutes: 0.002 }) // ~120ms
  await app.openProject(join(dir, 'p'))
  await app.saveAgent({ ...roleTemplate('custom', ''), name: 'Builder', provider: 'mock' }, true)
  const engine = app.engine!

  const first = await engine.send('mastermind', 'go')
  const handoff = engine.chats.mastermind.at(-1)!.tools![0].output!
  expect(handoff).toContain('still working')
  expect(first.error).toBeUndefined()

  // the builder finishes on its own and Mastermind gets the report as a new turn
  for (let i = 0; i < 300 && !engine.chats.mastermind.some((m) => m.text.includes('## Report from Builder')); i++) await new Promise((r) => setTimeout(r, 10))
  const incoming = engine.chats.mastermind.find((m) => m.text.includes('## Report from Builder'))!
  expect(incoming.text).toContain('built it')
  expect(engine.bus.some((b) => b.kind === 'report' && b.from === 'builder' && b.to === 'mastermind')).toBe(true)
  await app.shutdown()
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})
