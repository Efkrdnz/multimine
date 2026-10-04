import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProjectFiles, fuzzyScore, list } from '../../src/main/ide/fs'
import { ignoredPath } from '../../src/main/ide/watcher'
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

describe('the project watcher', () => {
  it('ignores build output, VCS and Multimine itself', () => {
    expect(ignoredPath('/p', '/p/build/x.class')).toBe(true)
    expect(ignoredPath('/p', '/p/.git/HEAD')).toBe(true)
    expect(ignoredPath('/p', '/p/.multimine/chats/c1/messages.jsonl')).toBe(true)
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

it('a Claude Code terminal is a plain terminal running the CLI in the project folder', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mm-tcli-'))
  const out: string[] = []
  const app = new MultimineApp({
    userDataDir: join(dir, 'u'),
    cipher: { encrypt: (s) => s, decrypt: (s) => s },
    emit: (e) => e.type === 'terminal-data' && out.push(e.data),
    mockDelayMs: 0,
    skipDetect: true
  })
  await app.start()
  await app.updateSettings({ claudePath: 'echo' }) // stands in for `claude`
  await app.openProject(join(dir, 'p'))
  const chatsBefore = app.project!.list().length
  const info = await app.terminalOpen('claude', 80, 24)
  expect(info).toMatchObject({ kind: 'claude', title: 'Claude Code' })
  expect(app.project!.list()).toHaveLength(chatsBefore)
  // the CLI is typed into the shell once it is up: `echo` prints an empty line and returns
  for (let i = 0; i < 100 && !out.join('').includes('echo'); i++) await new Promise((r) => setTimeout(r, 30))
  expect(out.join('')).toContain('echo')
  await app.terminalClose(info.id)
  await app.shutdown()
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})
