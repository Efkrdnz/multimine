import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_TIERS, downshift } from '@shared/economy'
import { roleTemplate } from '@shared/templates'
import type { EconomySettings, MainEvent } from '@shared/types'
import { MultimineApp } from '../../src/main/app'

const eco: EconomySettings = { enabled: true, concise: true, downshift: true, tiers: DEFAULT_TIERS }
const opus = { provider: 'claude-cli' as const, model: 'claude-opus-5-5', effort: 'xhigh' as const }

describe('downshift', () => {
  it('steps light and standard tasks down, never heavy ones', () => {
    expect(downshift(opus, 'light', eco)).toEqual({ model: 'claude-haiku-4-5-20251001', effort: 'low', difficulty: 'light' })
    expect(downshift(opus, 'standard', eco)).toEqual({ model: 'claude-sonnet-5-5', effort: 'medium', difficulty: 'standard' })
    expect(downshift(opus, 'heavy', eco)).toBeNull()
    expect(downshift(opus, undefined, eco)).toBeNull()
  })

  it('does nothing with economy or downshifting off, or when nothing would get cheaper', () => {
    expect(downshift(opus, 'light', { ...eco, enabled: false })).toBeNull()
    expect(downshift(opus, 'light', { ...eco, downshift: false })).toBeNull()
    expect(downshift({ provider: 'claude-cli', model: 'claude-haiku-4-5-20251001', effort: 'low' }, 'light', eco)).toBeNull()
    // no tier for the provider: same model, lower effort only
    expect(downshift({ provider: 'codex-cli', model: 'gpt-6-astra', effort: 'xhigh' }, 'standard', eco)).toEqual({ model: 'gpt-6-astra', effort: 'medium', difficulty: 'standard' })
  })
})

it('a light delegation runs on the cheaper settings for that task only and says so', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mm-eco-'))
  const seen: string[] = []
  const events: MainEvent[] = []
  const app = new MultimineApp({
    userDataDir: join(dir, 'u'),
    cipher: { encrypt: (s) => s, decrypt: (s) => s },
    emit: (e) => events.push(e),
    mockDelayMs: 0,
    forceMockMastermind: true,
    mockScript: (req) => {
      if (req.agent.id === 'mastermind' && req.prompt === 'go') return [{ tool: { name: 'delegate', args: { agent: 'worker', task: 'rename a field', difficulty: 'light' } } }]
      if (req.agent.id === 'worker') {
        seen.push(`${req.agent.effort}|${req.system.includes('Economy mode')}`)
        return [{ text: 'done' }]
      }
      return [{ text: 'ok' }]
    }
  })
  await app.start()
  await app.updateSettings({ economy: { ...eco, tiers: {} } })
  await app.openProject(join(dir, 'p'))
  await app.saveAgent({ ...roleTemplate('custom', ''), name: 'Worker', provider: 'mock', effort: 'xhigh' }, true)
  await app.engine!.send('mastermind', 'go')
  expect(seen).toEqual(['low|true'])
  expect(events.some((e) => e.type === 'status' && e.agentId === 'worker' && e.temp?.effort === 'low')).toBe(true)
  expect(app.project!.get('worker')!.effort).toBe('xhigh')
  // asked directly afterwards, the worker is itself again
  await app.engine!.send('worker', 'hi')
  expect(seen[1]).toBe('xhigh|true')
  expect(app.engine!.systemPrompt(app.project!.get('mastermind')!)).toContain('difficulty')
  await app.shutdown()
  await rm(dir, { recursive: true, force: true })
})
