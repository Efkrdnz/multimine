import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { roleTemplate } from '@shared/templates'
import { serializeAgentFile } from '@shared/agentFile'
import type { MainEvent } from '@shared/types'
import { addUsage, usageLine } from '@shared/usage'
import { MultimineApp } from '../../src/main/app'
import type { MockScript } from '../../src/main/providers/mock'
import { CallMeter, costAdded } from '../../src/main/providers/claudeCli'
import { DEFAULT_WATCHDOG, Watchdog, weighted } from '../../src/main/orchestrator/watchdog'

const T0 = 1_000_000
const call = (cacheRead: number, output = 500) => ({ input: 200, cacheRead, cacheWrite: 1000, output })

describe('usage accounting', () => {
  it('weighs tokens as they are priced', () => {
    expect(weighted({ input: 1000, cacheRead: 10_000, cacheWrite: 800, output: 100 })).toBe(1000 + 1000 + 1000 + 500)
  })

  it('trips the usage budget once it is spent, and asks again only after half as much more', () => {
    const wd = new Watchdog(DEFAULT_WATCHDOG, T0)
    const step = (n: number) => wd.check('Bash', { command: `ls ${n}` }, T0 + n)
    expect(step(0)).toBeNull()
    // 100k of context read back each call weighs 10k + the rest; 3M weighted is about 230 such calls
    let trip = null
    let n = 0
    while (!trip && n < 1000) {
      wd.spend(call(100_000))
      trip = step(++n)
    }
    expect(trip).toMatchObject({ kind: 'usage' })
    expect(trip!.title).toMatch(/^has used a lot of usage on this task: \d+ model calls, \d+M tokens of context$/)
    expect(n).toBeGreaterThan(200)
    expect(n).toBeLessThan(260)
    const at = n
    let again = null
    while (!again && n < 2000) {
      wd.spend(call(100_000))
      again = step(++n)
    }
    expect(again).toMatchObject({ kind: 'usage' })
    expect(n - at).toBeGreaterThan(100)
    expect(n - at).toBeLessThan(130)
    expect(new Watchdog({ ...DEFAULT_WATCHDOG, usageBudget: 0 }, T0).check('Bash', { command: 'ls' }, T0)).toBeNull()
  })

  it('counts each API message once, however often it streams in', () => {
    const m = new CallMeter()
    expect(m.see('a', { input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 1 })).toEqual({ input: 10, cacheRead: 1000, cacheWrite: 0, output: 1 })
    expect(m.see('a', { input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 1 })).toBeNull()
    expect(m.see('a', { input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 50 })).toEqual({ input: 0, cacheRead: 0, cacheWrite: 0, output: 49 })
    m.see('b', { input_tokens: 5, cache_creation_input_tokens: 300, output_tokens: 7 })
    expect(m.total).toEqual({ input: 15, cacheRead: 1000, cacheWrite: 300, output: 57, calls: 2 })
  })

  it('takes only what a turn added to a resumed session\'s running cost', () => {
    const seen = new Map<string, number>()
    expect(costAdded(seen, 's1', undefined, 0.4)).toBeCloseTo(0.4)
    expect(costAdded(seen, 's1', 's1', 0.9)).toBeCloseTo(0.5)
    // resumed from before this app started: nothing to subtract, so nothing is claimed
    expect(costAdded(new Map(), 's2', 's2', 7)).toBeUndefined()
    expect(costAdded(seen, 's3', undefined, undefined)).toBeUndefined()
  })

  it('says a usage in one line, cached context apart', () => {
    const u = addUsage(undefined, { inputTokens: 1200, outputTokens: 800, cacheRead: 1_400_000, cacheWrite: 30_000, calls: 41, costUsd: 0.8412 })
    expect(usageLine(u)).toBe('1.2k in · 1.4M cached · 800 out · 41 calls · ≈$0.841')
    expect(usageLine({ inputTokens: 12, outputTokens: 3 })).toBe('12 in · 3 out')
  })
})

describe('usage in a session', () => {
  let dir: string
  let app: MultimineApp
  let events: MainEvent[]
  const resumes: Record<string, (string | undefined)[]> = {}
  let n = 0

  const script: MockScript = (req) => {
    ;(resumes[req.agent.id] ??= []).push(req.resumeId)
    const resume = { event: { type: 'resume' as const, id: `thread-${++n}` } }
    if (req.agent.id === 'spender')
      return [
        resume,
        ...Array.from({ length: 4 }, () => ({ event: { type: 'call-usage' as const, input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } })),
        { tool: { name: 'run_command', args: { command: 'echo more' } } },
        { text: 'done' }
      ]
    return [resume, { event: { type: 'usage' as const, inputTokens: 10, outputTokens: 5, cacheRead: 2000, cacheWrite: 100, calls: 3 } }, { text: 'ok' }]
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mm-usage-'))
    events = []
    n = 0
    for (const k of Object.keys(resumes)) delete resumes[k]
    app = new MultimineApp({ userDataDir: join(dir, 'user'), cipher: { encrypt: (s) => s, decrypt: (s) => s }, emit: (e) => events.push(e), mockScript: script, mockDelayMs: 0, forceMockMastermind: true })
    await app.start()
    await app.openProject(join(dir, 'proj'))
    await app.saveAgent({ ...roleTemplate('custom', ''), name: 'Worker', provider: 'mock', model: 'mock', permissions: 'write', autoApprove: true }, true)
    await app.saveAgent({ ...roleTemplate('custom', ''), name: 'Spender', provider: 'mock', model: 'mock', permissions: 'write', autoApprove: true }, true)
  })

  afterEach(async () => {
    await app.shutdown()
    await rm(dir, { recursive: true, force: true })
  })

  it('starts every delegated task fresh, and a follow-up resumes the task it follows', async () => {
    await app.engine!.send('worker', 'hello')
    await app.engine!.send('worker', 'first task', 'mastermind', 'delegate')
    await app.engine!.send('worker', 'second task', 'mastermind', 'delegate')
    await app.engine!.send('worker', 'also fix the typo', 'mastermind', 'message')
    expect(resumes.worker).toEqual([undefined, undefined, undefined, 'thread-3'])
  })

  it('adds up each agent\'s share with cached context apart', async () => {
    await app.engine!.send('worker', 'one')
    await app.engine!.send('worker', 'two')
    const last = events.filter((e): e is Extract<MainEvent, { type: 'usage' }> => e.type === 'usage').at(-1)!
    // the mock adds its own plain count at the end of every turn
    expect(last.byAgent!.worker).toMatchObject({ cacheRead: 4000, cacheWrite: 200, calls: 6 })
    expect(last.total.cacheRead).toBe(4000)
  })

  it('pauses a turn that has spent its usage budget before its next step', async () => {
    const turn = app.engine!.send('spender', 'build it')
    let item
    for (let i = 0; i < 500 && !item; i++) {
      item = app.engine!.inbox.pending().find((x) => x.watchdog)
      if (!item) await new Promise((r) => setTimeout(r, 10))
    }
    expect(item!.title).toContain('has used a lot of usage on this task: 4 model calls, 4.0M tokens of context')
    await app.decide(item!.id, true)
    expect((await turn).text).toContain('done')
  })
})

describe('the old Implementer default', () => {
  it('is lowered from xhigh to high once, and a value set by hand afterwards stays', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mm-mig-'))
    try {
      const proj = join(dir, 'proj')
      await mkdir(join(proj, '.multimine', 'agents'), { recursive: true })
      const old = { ...roleTemplate('implementer', 'implementer'), effort: 'xhigh' as const }
      const mine = { ...roleTemplate('implementer', 'builder'), name: 'Builder', model: 'claude-sonnet-5-5', effort: 'xhigh' as const }
      await writeFile(join(proj, '.multimine', 'agents', 'implementer.md'), serializeAgentFile(old))
      await writeFile(join(proj, '.multimine', 'agents', 'builder.md'), serializeAgentFile(mine))
      const events: MainEvent[] = []
      const app = new MultimineApp({ userDataDir: join(dir, 'user'), cipher: { encrypt: (s) => s, decrypt: (s) => s }, emit: (e) => events.push(e), mockDelayMs: 0, forceMockMastermind: true })
      await app.start()
      await app.openProject(proj)
      expect(app.project!.get('implementer')!.effort).toBe('high')
      expect(app.project!.get('builder')!.effort).toBe('xhigh')
      expect(events.some((e) => e.type === 'toast' && e.text.includes('Implementer: effort lowered from xhigh to high'))).toBe(true)
      // set back by hand: the migration has run and leaves it
      await app.saveAgent({ ...app.project!.get('implementer')!, effort: 'xhigh' }, false)
      await app.openProject(proj)
      expect(app.project!.get('implementer')!.effort).toBe('xhigh')
      expect(await readFile(join(proj, '.multimine', 'agents', 'implementer.md'), 'utf8')).toContain('effort: xhigh')
      await app.shutdown()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
