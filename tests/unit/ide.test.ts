import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { roleTemplate } from '@shared/templates'
import { ProjectFiles, fuzzyScore, list } from '../../src/main/ide/fs'
import { ManualChangeTracker, ignoredPath } from '../../src/main/ide/watcher'
import { Terminals } from '../../src/main/ide/terminals'
import { MultimineApp } from '../../src/main/app'

describe('ide files', () => {
  it('lists one level, folders first, without build output or Multimine logs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mm-ide-'))
    await mkdir(join(dir, 'src', 'main'), { recursive: true })
    await mkdir(join(dir, 'build'))
    await mkdir(join(dir, '.multimine', 'sessions'), { recursive: true })
    await writeFile(join(dir, 'README.md'), 'x')
    await writeFile(join(dir, 'src', 'main', 'BloodService.java'), 'class BloodService { int pay() { return 25; } }')
    expect((await list(dir)).map((e) => e.name)).toEqual(['.multimine', 'src', 'README.md'])
    expect((await list(dir, '.multimine')).map((e) => e.name)).toEqual([])
    const files = new ProjectFiles(dir)
    expect((await files.findFiles('bldsrv'))[0].path).toBe('src/main/BloodService.java')
    expect(await files.grep('return 25')).toEqual([{ path: 'src/main/BloodService.java', line: 1, text: 'class BloodService { int pay() { return 25; } }' }])
    await expect(files.read('../outside.txt')).rejects.toThrow('outside the project')
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
  })

  it('scores a name match above a scattered path match', () => {
    expect(fuzzyScore('blood', 'src/BloodService.java')!).toBeGreaterThan(fuzzyScore('blood', 'b/l/o/o/d.txt')!)
    expect(fuzzyScore('zz', 'abc')).toBeNull()
  })
})

describe('manual change tracking', () => {
  afterEach(() => vi.useRealTimers())

  it('batches after a quiet spell, skips what agents wrote, and nets out add+delete', () => {
    vi.useFakeTimers()
    let agent = false
    const batches: string[][] = []
    const t = new ManualChangeTracker({ quietMs: 1000, isAgentWriting: () => agent, changed: () => undefined, flush: (b) => batches.push([...b.entries()].map(([f, k]) => `${k}:${f}`)) })
    t.record('a.java', 'changed')
    vi.advanceTimersByTime(600)
    t.record('b.java', 'added')
    t.record('b.java', 'changed')
    t.record('tmp.txt', 'added')
    t.record('tmp.txt', 'deleted')
    agent = true
    t.record('agent.java', 'changed')
    t.record('saved-in-ide.java', 'changed', true)
    vi.advanceTimersByTime(999)
    expect(batches).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(batches).toEqual([['changed:a.java', 'added:b.java', 'changed:saved-in-ide.java']])
  })

  it('ignores build output, VCS and Multimine itself', () => {
    expect(ignoredPath('/p', '/p/build/x.class')).toBe(true)
    expect(ignoredPath('/p', '/p/.git/HEAD')).toBe(true)
    expect(ignoredPath('/p', '/p/.multimine/context/index.md')).toBe(true)
    expect(ignoredPath('/p', '/p/src/A.java')).toBe(false)
  })
})

it('a terminal runs a shell in the project root and streams its output', async () => {
  const out: string[] = []
  let exited = false
  const terms = new Terminals((e) => {
    if (e.type === 'terminal-data') out.push(e.data)
    if (e.type === 'terminal-exit') exited = true
  })
  expect((await terms.available()).ok).toBe(true)
  const dir = await mkdtemp(join(tmpdir(), 'mm-term-'))
  const info = await terms.open(dir, 'shell', 80, 24, 'Terminal')
  terms.write(info.id, 'echo "hello $((6*7))"; pwd\r')
  for (let i = 0; i < 100 && !out.join('').includes('hello 42'); i++) await new Promise((r) => setTimeout(r, 30))
  expect(out.join('')).toContain('hello 42')
  expect(out.join('')).toContain(dir)
  terms.write(info.id, 'exit\r')
  for (let i = 0; i < 100 && !exited; i++) await new Promise((r) => setTimeout(r, 30))
  expect(exited).toBe(true)
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

it('manual changes reach the Context Handler as one batch with the diff', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mm-manual-'))
  const prompts: string[] = []
  const app = new MultimineApp({
    userDataDir: join(dir, 'u'),
    cipher: { encrypt: (s) => s, decrypt: (s) => s },
    emit: () => undefined,
    mockDelayMs: 0,
    forceMockMastermind: true,
    manualQuietMs: 50,
    mockScript: (req) => {
      if (req.agent.role === 'context-handler') prompts.push(req.prompt)
      return [{ text: 'ok' }]
    }
  })
  await app.start()
  await app.openProject(join(dir, 'p'))
  await app.saveAgent({ ...roleTemplate('context-handler', ''), provider: 'mock' }, true)
  await new Promise((r) => setTimeout(r, 100)) // its bootstrap turn
  prompts.length = 0
  await app.ideWrite('src/Spell.java', 'class Spell {}')
  for (let i = 0; i < 100 && !prompts.length; i++) await new Promise((r) => setTimeout(r, 20))
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('edited the project by hand')
  expect(prompts[0]).toContain('src/Spell.java')
  await app.shutdown()
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

it('a CLI terminal joins the team as an unsaved agent and leaves when it closes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mm-tagent-'))
  const notes: string[] = []
  const app = new MultimineApp({
    userDataDir: join(dir, 'u'),
    cipher: { encrypt: (s) => s, decrypt: (s) => s },
    emit: (e) => e.type === 'terminal-note' && notes.push(e.text),
    mockDelayMs: 0,
    forceMockMastermind: true
  })
  await app.start()
  await app.updateSettings({ claudePath: 'echo' }) // stands in for `claude`
  await app.openProject(join(dir, 'p'))
  const info = await app.terminalOpen('claude', 80, 24)
  const agent = app.project!.get(info.agentId!)!
  expect(agent.terminal).toBe(true)
  expect(app.project!.list().map((a) => a.id)).toContain(agent.id)
  // a teammate's message is shown to the user, not run
  const res = await app.engine!.send(agent.id, 'please review X', 'mastermind')
  expect(res.text).toContain('terminal session')
  expect(notes[0]).toContain('please review X')
  // delegation to it is refused
  const delegate = app.engine!.coordinationTools(app.project!.get('mastermind')!).find((t) => t.name === 'delegate')!
  expect((await delegate.handler({ agent: agent.id, task: 'x' })).isError).toBe(true)
  await app.terminalClose(info.id)
  for (let i = 0; i < 100 && app.project!.get(agent.id); i++) await new Promise((r) => setTimeout(r, 30))
  expect(app.project!.get(agent.id)).toBeUndefined()
  await app.shutdown()
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})
