import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { roleTemplate } from '@shared/templates'
import type { MainEvent } from '@shared/types'
import { MultimineApp } from '../../src/main/app'
import type { MockScript } from '../../src/main/providers/mock'

const cipher = { encrypt: (s: string) => `x${s}`, decrypt: (s: string) => s.slice(1) }

const approvalId = (out: string) => /approval_id: (\S+)/.exec(out)?.[1] ?? ''

/**
 * The pipeline from the plan, driven by scripted mock agents: the user asks Mastermind; Mastermind
 * delegates design, runs the council, is refused by the gate, asks for approval, implements, and the
 * Context Handler updates the map. Everything is asserted from what lands on disk and on the bus.
 */
const script: MockScript = (req) => {
  const { agent, prompt } = req
  if (agent.role === 'critic') {
    return [{ text: JSON.stringify({ objections: [{ issue: 'a', severity: 'low' }, { issue: 'b', severity: 'low' }, { issue: 'c', severity: 'medium' }], approve: true, wouldApproveIf: '', rebuttals: ['agree with b'] }) }]
  }
  if (agent.id === 'mastermind' && prompt.startsWith('Make stronger attacks')) {
    return [
      { tool: { name: 'delegate', args: { agent: 'designer', task: 'Design a stronger attack' } } },
      { tool: { name: 'run_council', args: (o) => ({ plan_md: o[0] }) } },
      { tool: { name: 'delegate', args: { agent: 'Implementer', task: 'Build it' } } }, // refused: no approval
      { tool: { name: 'request_approval', args: (o) => ({ title: 'Stronger attack', plan_md: `${o[0]}\n\n${o[1]}` }) } },
      { tool: { name: 'delegate', args: (o) => ({ agent: 'implementer', task: 'Build the approved plan', approval_id: approvalId(o[3]) }) } },
      { text: 'Done: designed, reviewed, approved and built.' }
    ]
  }
  if (agent.id === 'designer') {
    return [
      { tool: { name: 'ask_user', args: { questions: [{ question: 'Element?', options: [{ label: 'Fire' }, { label: 'Void' }] }] } } },
      { tool: { name: 'report', args: (o) => ({ summary: `Designed a ${/-> (\w+)/.exec(o[0])?.[1]} lance`, plan_md: '# Plan\n- add skill' }) } }
    ]
  }
  if (agent.id === 'implementer') {
    return [
      { tool: { name: 'write_file', args: { path: 'src/Lance.java', content: 'class Lance {}' } } },
      { tool: { name: 'report', args: { summary: 'Added Lance', files: ['src/Lance.java'] } } }
    ]
  }
  if (agent.role === 'context-handler' && prompt.includes('Build the context set')) {
    return [{ tool: { name: 'update_context', args: { file: 'index.md', content: '# Index\n' } } }, { tool: { name: 'report', args: { summary: 'bootstrapped' } } }]
  }
  if (agent.role === 'context-handler') {
    return [
      { tool: { name: 'update_context', args: { file: 'changelog.md', content: '# Changelog\n- Lance added (src/Lance.java)\n' } } },
      { tool: { name: 'report', args: { summary: 'context updated' } } }
    ]
  }
  if (agent.id === 'a' || agent.id === 'b') {
    // a and b message each other with wait: the second must be refused, not deadlock
    return [{ tool: { name: 'message_agent', args: { to: agent.id === 'a' ? 'b' : 'a', message: 'ping' } } }, { text: 'ok' }]
  }
  return [{ text: 'ok' }]
}

describe('pipeline', () => {
  let dir: string
  let app: MultimineApp
  let events: MainEvent[]

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mm-pipe-'))
    events = []
    app = new MultimineApp({ userDataDir: join(dir, 'user'), cipher, emit: (e) => events.push(e), mockScript: script, mockDelayMs: 0, forceMockMastermind: true })
    await app.start()
    await app.openProject(join(dir, 'proj'))
    // context updates wait for a quiet spell; a short one here
    await app.updateSettings({ contextIdleMinutes: 0.001 })
    for (const role of ['designer', 'implementer', 'context-handler'] as const) {
      const t = roleTemplate(role)
      // created by the user: context-handler creation kicks off a bootstrap turn
      await app.saveAgent({ ...t, provider: 'mock', model: 'mock' }, true)
    }
  })

  afterEach(async () => {
    await app.shutdown()
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
  })

  it('creates the project layout and a Mastermind', async () => {
    const p = join(dir, 'proj')
    expect(existsSync(join(p, 'multimine.md'))).toBe(true)
    expect(existsSync(join(p, '.multimine', 'agents', 'mastermind.md'))).toBe(true)
    expect(await readFile(join(p, '.multimine', '.gitignore'), 'utf8')).toContain('sessions/')
    expect(app.project!.list().map((a) => a.id)).toEqual(['mastermind', 'context-handler', 'designer', 'implementer'])
  })

  it('runs design -> council -> gate -> approval -> implement -> context update', async () => {
    const engine = app.engine!
    // answer the designer's question and approve the plan as the user would, from the inbox
    const answering = (async () => {
      for (let i = 0; i < 400; i++) {
        for (const item of engine.inbox.pending()) {
          if (item.kind === 'question') await app.answer(item.id, { 'Element?': 'Void' })
          else await app.decide(item.id, true, 'go')
        }
        await new Promise((r) => setTimeout(r, 10))
      }
    })()
    const result = await engine.send('mastermind', 'Make stronger attacks')
    expect(result.error).toBeUndefined()
    expect(result.text).toContain('Done')

    const mm = engine.chats.mastermind.at(-1)!
    const outputs = mm.tools!.map((t) => t.output ?? '')
    expect(outputs[0]).toContain('Designed a Void lance')
    expect(outputs[1]).toContain('Council verdict: PASSES')
    expect(outputs[2]).toContain('gated')
    expect(outputs[3]).toContain('APPROVED')
    expect(outputs[4]).toContain('Added Lance')

    expect(await readFile(join(dir, 'proj', 'src', 'Lance.java'), 'utf8')).toBe('class Lance {}')
    // the context update runs after the implementer's turn; wait for it
    for (let i = 0; i < 200 && !existsSync(join(dir, 'proj', '.multimine', 'context', 'changelog.md')); i++) await new Promise((r) => setTimeout(r, 10))
    expect(await readFile(join(dir, 'proj', '.multimine', 'context', 'changelog.md'), 'utf8')).toContain('Lance')

    const kinds = engine.bus.map((b) => `${b.kind}:${b.from}->${b.to}`)
    expect(kinds).toContain('delegate:mastermind->designer')
    expect(kinds).toContain('question:designer->mastermind')
    expect(kinds).toContain('critique:mastermind->council')
    expect(kinds).toContain('approval:mastermind->user')
    expect(kinds).toContain('delegate:mastermind->implementer')
    expect(kinds).toContain('context:implementer->context-handler')

    const sessionDir = join(dir, 'proj', '.multimine', 'sessions', engine.session.id)
    expect((await readFile(join(sessionDir, 'bus.jsonl'), 'utf8')).split('\n').length).toBeGreaterThan(8)
    expect(JSON.parse(await readFile(join(sessionDir, 'inbox.json'), 'utf8')).filter((i: any) => i.approved)).toHaveLength(1)
    expect(events.some((e) => e.type === 'council' && e.critics.length === 3)).toBe(true)
    void answering
  })

  it('answers for the user in automation mode', async () => {
    await app.updateSettings({ automation: true })
    const res = await app.engine!.send('designer', 'design something')
    expect(res.text).toContain('Fire lance') // recommended (first) option
    const item = app.engine!.inbox.items.find((i) => i.kind === 'question')!
    expect(item.status).toBe('auto')
    expect(item.autoReason).toBeTruthy()
  })

  it('refuses a wait that would deadlock two agents', async () => {
    const a = await app.saveAgent({ ...roleTemplate('custom', ''), name: 'A', provider: 'mock' }, true)
    await app.saveAgent({ ...roleTemplate('custom', ''), name: 'B', provider: 'mock' }, true)
    expect(a.id).toBe('a')
    await app.engine!.send('a', 'go')
    const outputs = app.engine!.chats.b.flatMap((m) => m.tools ?? []).map((t) => t.output)
    expect(outputs.join('\n')).toContain('deadlock')
  })

  it('persists chats per session and keeps sessions apart', async () => {
    await app.engine!.send('mastermind', 'hello')
    const first = app.engine!.session.id
    await app.newSession('Second')
    expect(app.engine!.chats.mastermind ?? []).toHaveLength(0)
    await app.switchSession(first)
    expect(app.engine!.chats.mastermind.map((m) => m.role)).toEqual(['user', 'assistant'])
  })
})
