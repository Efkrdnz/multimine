import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_TIERS, downshift, parseRating } from '@shared/economy'
import type { EconomySettings, MainEvent } from '@shared/types'
import { MultimineApp } from '../../src/main/app'

const eco: EconomySettings = { enabled: true, concise: true, autoRate: false, tiers: DEFAULT_TIERS }
const opus = { provider: 'claude-cli' as const, model: 'claude-opus-5-5', effort: 'xhigh' as const }

describe('downshift', () => {
  it('steps light and standard messages down, never heavy ones', () => {
    expect(downshift(opus, 'light', eco)).toEqual({ model: 'claude-haiku-4-5-20251001', effort: 'low', difficulty: 'light' })
    expect(downshift(opus, 'standard', eco)).toEqual({ model: 'claude-sonnet-5-5', effort: 'medium', difficulty: 'standard' })
    expect(downshift(opus, 'heavy', eco)).toBeNull()
    expect(downshift(opus, undefined, eco)).toBeNull()
  })

  it('does nothing when nothing would get cheaper', () => {
    expect(downshift({ provider: 'claude-cli', model: 'claude-haiku-4-5-20251001', effort: 'low' }, 'light', eco)).toBeNull()
    // no tier for the provider: same model, lower effort only
    expect(downshift({ provider: 'codex-cli', model: 'gpt-6-astra', effort: 'xhigh' }, 'standard', eco)).toEqual({ model: 'gpt-6-astra', effort: 'medium', difficulty: 'standard' })
  })
})

it('Quick runs one message on the light tier and says so; the chat stays itself', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mm-eco-'))
  const seen: string[] = []
  const events: MainEvent[] = []
  const app = new MultimineApp({
    userDataDir: join(dir, 'u'),
    cipher: { encrypt: (s) => s, decrypt: (s) => s },
    emit: (e) => events.push(e),
    mockDelayMs: 0,
    skipDetect: true,
    mockScript: (req) => {
      seen.push(`${req.agent.effort}|${req.system.includes('Economy mode')}`)
      return [{ text: 'done' }]
    }
  })
  await app.start()
  await app.updateSettings({ economy: { ...eco, tiers: {} } })
  await app.openProject(join(dir, 'p'))
  const worker = await app.createChat({ name: 'Worker', effort: 'xhigh' })
  await app.engine!.send(worker.id, 'rename a field', 'user', { quick: true })
  expect(seen).toEqual(['low|true'])
  expect(events.some((e) => e.type === 'status' && e.agentId === worker.id && e.temp?.effort === 'low')).toBe(true)
  expect(app.project!.get(worker.id)!.effort).toBe('xhigh')
  // the next message runs on the chat's own settings again
  await app.engine!.send(worker.id, 'hi')
  expect(seen[1]).toBe('xhigh|true')
  await app.shutdown()
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

it("economy's rating runs easy messages cheaper, and never a heavy one", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mm-rate-'))
  const turns: string[] = []
  const app = new MultimineApp({
    userDataDir: join(dir, 'u'),
    cipher: { encrypt: (s) => s, decrypt: (s) => s },
    emit: () => undefined,
    mockDelayMs: 0,
    skipDetect: true,
    mockScript: (req) => {
      // the rating call: no tools, the rating instructions as its system prompt
      if (req.system.startsWith('Rate how hard')) return [{ text: req.prompt.includes('typo') ? 'light' : 'Heavy - this needs design.' }]
      turns.push(`${req.agent.model}|${req.agent.effort}`)
      return [{ text: 'done' }]
    }
  })
  await app.start()
  await app.updateSettings({ economy: { ...eco, autoRate: true, tiers: { mock: { light: 'mock-small' } } } })
  await app.openProject(join(dir, 'p'))
  const chat = await app.createChat({ model: 'mock', effort: 'high' })
  await app.engine!.send(chat.id, 'fix the typo in the README')
  await app.engine!.send(chat.id, 'redesign the save system')
  expect(turns).toEqual(['mock-small|low', 'mock|high'])
  expect(parseRating('LIGHT.')).toBe('light')
  expect(parseRating('no idea')).toBe('heavy')
  await app.shutdown()
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})
