import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { MainEvent } from '@shared/types'
import { MultimineApp } from '../../src/main/app'
import type { MockScript } from '../../src/main/providers/mock'

const cipher = { encrypt: (s: string) => `x${s}`, decrypt: (s: string) => s.slice(1) }

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mm-tabs-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

const until = async (ok: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

it('a project in another tab keeps working, out of sight, and comes back as it left off', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const script: MockScript = async (req) => {
    if (req.prompt.includes('long job')) {
      await gate
      return [{ text: 'Long job done.' }]
    }
    return [{ text: 'ok' }]
  }
  const events: MainEvent[] = []
  const background: { e: MainEvent; dir: string }[] = []
  const app = new MultimineApp({ userDataDir: join(dir, 'user'), cipher, emit: (e) => events.push(e), background: (e, d) => background.push({ e, dir: d }), mockScript: script, mockDelayMs: 0, skipDetect: true })
  await app.start()
  const a = join(dir, 'mana-mod')
  const b = join(dir, 'hud-test')
  for (const p of [a, b]) await mkdir(p)
  await writeFile(join(a, 'notes.txt'), 'a')
  try {
    await app.openProject(a)
    const chatA = (await app.createChat()).id
    void app.engine!.send(chatA, 'a long job')
    await until(() => app.engine!.busy(chatA))
    const engineA = app.engine!

    // opening another project leaves the first one running
    await app.openProject(b)
    expect(app.project!.dir).toBe(b)
    expect(engineA.busy(chatA)).toBe(true)
    const tabs = app.listProjects()
    expect(tabs.map((t) => [t.name, t.active, t.busy])).toEqual([
      ['mana-mod', false, 1],
      ['hud-test', true, 0]
    ])
    // what A does now reaches the notifier, not the window
    events.length = 0
    release()
    await until(() => !engineA.busy(chatA))
    await until(() => background.some(({ e, dir: d }) => d === a && e.type === 'chat-upsert' && e.message.text === 'Long job done.'))
    expect(events.some((e) => e.type === 'chat-upsert' && e.message.agentId === chatA)).toBe(false)
    await until(() => events.some((e) => e.type === 'projects' && e.projects[0].busy === 0))

    // each project has its own tables
    await app.engine!.saveTable(app.engine!.project.list()[0].id, { id: 'hud', name: 'HUD bits', columns: [{ label: 'Name' }], rows: [{ cells: { name: 'bar' } }] })
    expect((await app.engine!.tables.list()).map((t) => t.id)).toEqual(['hud'])
    expect(await engineA.tables.list()).toEqual([])

    // back to A: it comes on screen with the reply it finished in the background
    events.length = 0
    await app.switchProject(a)
    expect(app.project!.dir).toBe(a)
    const reset = events.find((e) => e.type === 'chat-reset') as Extract<MainEvent, { type: 'chat-reset' }>
    expect(reset.chats[chatA].some((m) => m.text === 'Long job done.')).toBe(true)
    expect(events.find((e) => e.type === 'project')).toMatchObject({ project: { dir: a } })
    expect(events.some((e) => e.type === 'run-output' && e.reset)).toBe(true)
    // opening it again only switches to it
    await app.openProject(a)
    expect(app.listProjects()).toHaveLength(2)

    // the tabs are remembered for next time
    expect(app.config.settings.openProjects).toEqual([a, b])
    expect(app.config.settings.activeProject).toBe(a)

    // closing the one on screen brings the other up; closing the last leaves none
    await app.closeProject()
    expect(app.project!.dir).toBe(b)
    expect(app.listProjects().map((t) => t.name)).toEqual(['hud-test'])
    await app.closeProject(b)
    expect(app.project).toBeNull()
    expect(app.config.settings.openProjects).toEqual([])
  } finally {
    await app.shutdown()
  }
})

it('reopens the tabs that were open last time', async () => {
  const a = join(dir, 'one')
  const b = join(dir, 'two')
  for (const p of [a, b]) await mkdir(p)
  const first = new MultimineApp({ userDataDir: join(dir, 'user'), cipher, emit: () => undefined, mockDelayMs: 0, skipDetect: true })
  await first.start()
  await first.openProject(a)
  await first.openProject(b)
  await first.switchProject(a)
  await first.shutdown()
  const second = new MultimineApp({ userDataDir: join(dir, 'user'), cipher, emit: () => undefined, mockDelayMs: 0, skipDetect: true })
  await second.start()
  try {
    await second.restoreProjects(null)
    expect(second.listProjects().map((t) => [t.name, t.active])).toEqual([
      ['one', true],
      ['two', false]
    ])
  } finally {
    await second.shutdown()
  }
})
