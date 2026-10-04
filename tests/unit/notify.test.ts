import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { InboxItem, MainEvent, NotificationSettings } from '@shared/types'
import { MultimineApp } from '../../src/main/app'
import { DEFAULT_NOTIFICATIONS, messageFor, Notifier, type Note } from '../../src/main/notify'

const item = (id: string, patch: Partial<InboxItem> = {}): InboxItem => ({ id, ts: 1, kind: 'question', askedBy: 'designer', title: 'Element?', status: 'pending', questions: [{ question: 'Which element should the lance use?', options: [] }], ...patch })
const NAMES: Record<string, string> = { designer: 'Designer', implementer: 'Implementer', mastermind: 'Mastermind' }

function rig(settings: Partial<NotificationSettings> = {}, focused = false) {
  const shown: Note[] = []
  const state = { focused, settings: { ...DEFAULT_NOTIFICATIONS, ...settings } }
  const n = new Notifier({ show: (x) => shown.push(x), isFocused: () => state.focused, settings: () => state.settings, agentName: (id) => NAMES[id] ?? id, groupMs: 0 })
  return { n, shown, state }
}

describe('notifications', () => {
  it('words each kind of waiting', () => {
    expect(messageFor(item('q'), 'Designer')).toEqual({ title: 'Designer has a question', body: 'Which element should the lance use?', itemId: 'q', agentId: 'designer' })
    expect(messageFor(item('a', { kind: 'approval', askedBy: 'mastermind', title: 'Stronger attacks' }), 'Mastermind').title).toBe('Mastermind needs your approval')
    expect(messageFor(item('p', { kind: 'approval', permission: true, title: 'git push' }), 'Implementer')).toMatchObject({ title: 'Implementer needs permission', body: 'git push' })
    const w = messageFor(item('w', { kind: 'approval', permission: true, watchdog: true, title: 'wants to launch `gradlew runClient` for the third time' }), 'Implementer')
    expect(w).toMatchObject({ title: 'Implementer is paused', body: 'Implementer wants to launch `gradlew runClient` for the third time' })
    expect(messageFor(item('l', { kind: 'approval', title: 'x'.repeat(300) }), 'A').body.length).toBe(120)
  })

  it('notifies once per new item, only when the window is elsewhere', () => {
    const { n, shown, state } = rig()
    n.handle({ type: 'inbox', items: [item('q1')] })
    n.handle({ type: 'inbox', items: [item('q1')] })
    expect(shown.map((s) => s.itemId)).toEqual(['q1'])
    state.focused = true
    n.handle({ type: 'inbox', items: [item('q1'), item('q2')] })
    expect(shown).toHaveLength(1)
    state.settings.whenFocused = true
    n.handle({ type: 'inbox', items: [item('q3')] })
    expect(shown.map((s) => s.itemId)).toEqual(['q1', 'q3'])
  })

  it('stays quiet when off, and for what is already settled', () => {
    const off = rig({ enabled: false })
    off.n.handle({ type: 'inbox', items: [item('q1')] })
    expect(off.shown).toEqual([])
    const auto = rig()
    auto.n.handle({ type: 'inbox', items: [item('q1', { status: 'auto' }), item('q2', { status: 'answered' })] })
    expect(auto.shown).toEqual([])
  })

  it('groups what arrives together', () => {
    const { n, shown } = rig()
    n.handle({ type: 'inbox', items: [item('q1'), item('q2', { askedBy: 'implementer', kind: 'approval', permission: true }), item('q3', { askedBy: 'mastermind', kind: 'approval' })] })
    expect(shown).toEqual([{ title: 'Designer and 2 others need you', body: 'Which element should the lance use?', itemId: 'q1', agentId: 'designer' }])
    const one = rig()
    one.n.handle({ type: 'inbox', items: [item('a'), item('b')] })
    expect(one.shown[0].title).toBe('Designer needs you (2)')
  })

  it('says a chat finished only when asked to', () => {
    const run = (s: Partial<NotificationSettings>) => {
      const r = rig(s)
      const st = (status: 'working' | 'idle', agentId = 'mastermind') => r.n.handle({ type: 'status', agentId, status })
      st('working')
      st('idle')
      st('working', 'designer')
      st('idle', 'designer')
      return r.shown
    }
    expect(run({})).toEqual([])
    expect(run({ onFinish: true })).toEqual([
      { title: 'Mastermind finished', body: 'Open Multimine to see the reply.', agentId: 'mastermind' },
      { title: 'Designer finished', body: 'Open Multimine to see the reply.', agentId: 'designer' }
    ])
  })

  it('hears a real chat asking the user', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mm-note-'))
    const shown: Note[] = []
    let notifier!: Notifier
    const app = new MultimineApp({
      userDataDir: join(dir, 'user'),
      cipher: { encrypt: (s) => s, decrypt: (s) => s },
      emit: (e: MainEvent) => notifier?.handle(e),
      mockScript: (req) => (req.agent.name === 'Designer' ? [{ tool: { name: 'ask_user', args: { questions: [{ question: 'Fire or void?', options: [{ label: 'Fire' }, { label: 'Void' }] }] } } }] : [{ text: 'ok' }]),
      mockDelayMs: 0,
      skipDetect: true
    })
    notifier = new Notifier({ show: (x) => shown.push(x), isFocused: () => false, settings: () => app.config.settings.notifications, agentName: (id) => app.project?.get(id)?.name ?? id, groupMs: 0 })
    try {
      await app.start()
      await app.openProject(join(dir, 'proj'))
      const designer = await app.createChat({ name: 'Designer' })
      const turn = app.engine!.send(designer.id, 'design it')
      for (let i = 0; i < 300 && !app.engine!.inbox.pending().length; i++) await new Promise((r) => setTimeout(r, 10))
      expect(shown).toEqual([expect.objectContaining({ title: 'Designer has a question', body: 'Fire or void?', agentId: designer.id })])
      await app.answer(app.engine!.inbox.pending()[0].id, { 'Fire or void?': 'Void' })
      await turn
      expect(shown).toHaveLength(1)
    } finally {
      await app.shutdown()
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
    }
  })
})
