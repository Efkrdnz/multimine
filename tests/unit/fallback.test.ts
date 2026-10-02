import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { roleTemplate } from '@shared/templates'
import type { MainEvent } from '@shared/types'
import { MultimineApp } from '../../src/main/app'
import { ProviderHealth, failureOf } from '../../src/main/providers/limits'
import { friendlyClaudeError } from '../../src/main/providers/claudeCli'
import { buildBrief } from '../../src/main/orchestrator/continuation'
import type { AgentEvent, ProviderAdapter, TurnRequest } from '../../src/main/providers/types'

describe('what counts as out of usage', () => {
  it('recognises real provider messages and leaves ordinary errors alone', () => {
    expect(failureOf("Claude AI usage limit reached|1760000000")).toBe('usage')
    expect(failureOf(friendlyClaudeError('Failed to authenticate: OAuth session expired and could not be refreshed'))).toBe('auth')
    expect(failureOf("You've hit your usage limit. Upgrade to Pro or try again in 3 hours.")).toBe('usage')
    expect(failureOf('You exceeded your current quota, please check your plan and billing details.')).toBe('usage')
    expect(failureOf('429 Too Many Requests')).toBe('rate')
    expect(failureOf('Incorrect API key provided: sk-...')).toBe('auth')
    expect(failureOf("TypeError: Cannot read properties of undefined (reading 'x')")).toBeNull()
    expect(failureOf('Build failed: compilation error in BloodService.java')).toBeNull()
  })
})

describe('provider health', () => {
  it('expires at the reset time, and a warning never softens an exhaustion', () => {
    const h = new ProviderHealth()
    const now = 1_000_000
    h.mark('claude-cli', 'near', 'five hour limit', 'near', undefined, now)
    expect(h.fresh('claude-cli', now)).toBe(false)
    expect(h.usable('claude-cli', now)).toBe(true)
    h.mark('claude-cli', 'exhausted', 'usage', 'usage', (now + 60_000) / 1000, now)
    h.mark('claude-cli', 'near', 'warn', 'near', undefined, now)
    expect(h.usable('claude-cli', now)).toBe(false)
    expect(h.usable('claude-cli', now + 61_000)).toBe(true)
  })
})

it('the brief carries the task, what was done, the diff and the last words', () => {
  const b = buildBrief({
    task: 'Move tier 5 skills to tier 3',
    history: [{ role: 'user', text: 'earlier' }],
    tools: [{ id: '1', name: 'Edit', input: { file_path: 'MagicContent.java' }, output: 'ok', status: 'done' }, { id: '2', name: 'Bash', input: { command: './gradlew test' }, status: 'running' }],
    partial: 'Moved 4 of 9 skills.',
    diffStat: ' MagicContent.java | 8 ++++----',
    previous: 'Claude sub Opus 5.5',
    reason: 'it ran out of usage'
  })
  expect(b).toContain('Do not start over')
  expect(b).toContain('Move tier 5 skills to tier 3')
  expect(b).toContain('Edit({"file_path":"MagicContent.java"}) -> ok')
  expect(b).toContain('was running when it stopped')
  expect(b).toContain('MagicContent.java | 8')
  expect(b).toContain('Moved 4 of 9 skills.')
})

/** A fake provider: runs a script of events, recording every request it got. */
function fake(events: (req: TurnRequest) => AgentEvent[]): ProviderAdapter & { seen: TurnRequest[] } {
  const seen: TurnRequest[] = []
  return {
    seen,
    async *run(req) {
      seen.push(req)
      for (const ev of events(req)) yield ev
    }
  }
}

async function setup(overrides: ConstructorParameters<typeof MultimineApp>[0]['providerOverrides']) {
  const dir = await mkdtemp(join(tmpdir(), 'mm-fb-'))
  const events: MainEvent[] = []
  const app = new MultimineApp({ userDataDir: join(dir, 'u'), cipher: { encrypt: (s) => s, decrypt: (s) => s }, emit: (e) => events.push(e), mockDelayMs: 0, forceMockMastermind: true, providerOverrides: overrides })
  await app.start()
  await app.openProject(join(dir, 'p'))
  return { app, dir, events }
}

it('a turn cut by a usage limit carries on, in the same reply, on the next subscription', async () => {
  const claude = fake(() => [
    { type: 'tool-start', id: 't1', name: 'Edit', input: { file_path: 'A.java' } },
    { type: 'tool-end', id: 't1', output: 'edited' },
    { type: 'text', delta: 'Half done.' },
    { type: 'error', message: 'Claude AI usage limit reached' }
  ])
  const codex = fake(() => [{ type: 'text', delta: 'Finished the rest.' }])
  const { app, dir, events } = await setup({ 'claude-cli': claude, 'codex-cli': codex })
  await app.saveAgent({ ...roleTemplate('implementer', ''), name: 'Impl', provider: 'claude-cli', model: 'claude-opus-5-5', gated: false, fallback: [{ provider: 'codex-cli', model: 'gpt-6-astra', effort: 'high' }] }, true)

  const res = await app.engine!.send('impl', 'Do the whole job', 'mastermind')
  expect(res.error).toBeUndefined()
  const reply = app.engine!.chats.impl.at(-1)!
  expect(reply.text).toContain('Half done.')
  expect(reply.text).toContain('↪ *Switched to Codex sub GPT 6 Astra')
  expect(reply.text).toContain('Finished the rest.')
  expect(reply.error).toBeUndefined()
  // the fallback was briefed, not restarted
  expect(codex.seen[0].prompt).toContain('Do not start over')
  expect(codex.seen[0].prompt).toContain('Edit({"file_path":"A.java"}) -> edited')
  expect(codex.seen[0].resumeId).toBeUndefined()
  expect(events.some((e) => e.type === 'status' && e.agentId === 'impl' && e.fallback?.provider === 'codex-cli')).toBe(true)

  // the next task starts straight on the fallback while Claude is out of usage
  await app.engine!.send('impl', 'Next job', 'mastermind')
  expect(claude.seen).toHaveLength(1)
  expect(codex.seen).toHaveLength(2)
  await app.shutdown()
  await rm(dir, { recursive: true, force: true })
})

it('an ordinary error never falls back', async () => {
  const claude = fake(() => [{ type: 'error', message: 'compilation failed' }])
  const codex = fake(() => [{ type: 'text', delta: 'should not run' }])
  const { app, dir } = await setup({ 'claude-cli': claude, 'codex-cli': codex })
  await app.saveAgent({ ...roleTemplate('custom', ''), name: 'A', provider: 'claude-cli', fallback: [{ provider: 'codex-cli', model: 'x', effort: 'high' }] }, true)
  const res = await app.engine!.send('a', 'go')
  expect(res.error).toBe('compilation failed')
  expect(codex.seen).toHaveLength(0)
  await app.shutdown()
  await rm(dir, { recursive: true, force: true })
})

it('a paid fallback asks first, and "always" stops it asking', async () => {
  let n = 0
  const claude = fake(() => [{ type: 'error', message: 'usage limit reached' }])
  const openai = fake(() => [{ type: 'text', delta: `paid run ${++n}` }])
  const { app, dir } = await setup({ 'claude-cli': claude, openai })
  await app.saveAgent({ ...roleTemplate('custom', ''), name: 'B', provider: 'claude-cli', fallback: [{ provider: 'openai', model: 'gpt-6-astra', effort: 'high' }] }, true)
  const run = app.engine!.send('b', 'go')
  for (let i = 0; i < 100 && !app.engine!.inbox.pending().length; i++) await new Promise((r) => setTimeout(r, 10))
  const [item] = app.engine!.inbox.pending()
  expect(item.permission).toBe(true)
  expect(item.alwaysLabel).toBe('Always')
  await app.decide(item.id, true, undefined, true)
  expect((await run).text).toContain('paid run 1')
  expect(app.project!.get('b')!.fallbackPaidOk).toBe(true)

  // Claude is still out: the next task goes straight to the paid key, without asking
  const second = await app.engine!.send('b', 'again')
  expect(second.text).toContain('paid run 2')
  expect(app.engine!.inbox.pending()).toHaveLength(0)
  await app.shutdown()
  await rm(dir, { recursive: true, force: true })
})

it("a Claude warning moves the agent's next task to its fallback before anything is cut", async () => {
  const claude = fake(() => [
    { type: 'limit', state: 'near', detail: 'five hour limit (92% used)' },
    { type: 'text', delta: 'done on claude' }
  ])
  const codex = fake(() => [{ type: 'text', delta: 'done on codex' }])
  const { app, dir } = await setup({ 'claude-cli': claude, 'codex-cli': codex })
  await app.saveAgent({ ...roleTemplate('custom', ''), name: 'C', provider: 'claude-cli', fallback: [{ provider: 'codex-cli', model: 'x', effort: 'high' }] }, true)
  expect((await app.engine!.send('c', 'one')).text).toBe('done on claude')
  expect((await app.engine!.send('c', 'two')).text).toBe('done on codex')
  await app.shutdown()
  await rm(dir, { recursive: true, force: true })
})
