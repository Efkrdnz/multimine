import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { MultimineApp } from '../../src/main/app'
import { Checkpoints, parseChanges } from '../../src/main/chat/checkpoints'
import { undoNote } from '../../src/main/chat/engine'
import type { MockScript } from '../../src/main/providers/mock'

const cipher = { encrypt: (s: string) => `x${s}`, decrypt: (s: string) => s.slice(1) }

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mm-cp-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

it('reads git diff output into changed files', () => {
  const z = (...parts: string[]) => parts.map((p) => `${p}\0`).join('')
  const status = z('M', 'src/A.java', 'A', 'src/B.java', 'D', 'old.txt', 'M', 'icon.png')
  const counts = z('3\t1\tsrc/A.java', '10\t0\tsrc/B.java', '0\t4\told.txt', '-\t-\ticon.png')
  expect(parseChanges(status, counts).files).toEqual([
    { path: 'icon.png', status: 'M', add: 0, del: 0, binary: true },
    { path: 'old.txt', status: 'D', add: 0, del: 4 },
    { path: 'src/A.java', status: 'M', add: 3, del: 1 },
    { path: 'src/B.java', status: 'A', add: 10, del: 0 }
  ])
  expect(parseChanges(status, counts, 2)).toMatchObject({ more: 2 })
})

it('snapshots a folder that is not a repository, lists a change, and undoes it', async () => {
  await mkdir(join(dir, 'src'))
  await mkdir(join(dir, 'build'))
  await writeFile(join(dir, 'src', 'Spell.java'), 'int mana = 20;\n')
  await writeFile(join(dir, 'build', 'out.class'), 'x')
  const cp = new Checkpoints(dir)
  const before = (await cp.snapshot('before'))!
  expect(before).toMatch(/^[0-9a-f]{40}$/)
  await writeFile(join(dir, 'src', 'Spell.java'), 'int mana = 25;\n')
  await writeFile(join(dir, 'src', 'Bolt.java'), 'class Bolt {}\n')
  await writeFile(join(dir, 'build', 'out.class'), 'changed build output is never part of a turn')
  const after = (await cp.snapshot('after'))!
  const { files } = await cp.changes(before, after)
  expect(files.map((f) => `${f.status} ${f.path}`)).toEqual(['A src/Bolt.java', 'M src/Spell.java'])
  expect(await cp.diff(before, after, 'src/Spell.java')).toContain('+int mana = 25;')
  // nothing outside .multimine was made a repository
  expect(existsSync(join(dir, '.git'))).toBe(false)

  // a file changed again since the turn is a conflict, left alone unless forced
  await writeFile(join(dir, 'src', 'Spell.java'), 'int mana = 30;\n')
  expect(await cp.undo({ before, after })).toEqual({ undone: false, conflicts: ['src/Spell.java'] })
  expect(await readFile(join(dir, 'src', 'Spell.java'), 'utf8')).toBe('int mana = 30;\n')
  expect(await cp.undo({ before, after }, true)).toMatchObject({ undone: true })
  expect(await readFile(join(dir, 'src', 'Spell.java'), 'utf8')).toBe('int mana = 20;\n')
  expect(existsSync(join(dir, 'src', 'Bolt.java'))).toBe(false)
})

it('never touches the project repository, its index or its branches', async () => {
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' })
  git('init', '-q')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  await writeFile(join(dir, 'a.txt'), 'one\n')
  git('add', 'a.txt')
  git('commit', '-qm', 'first')
  await writeFile(join(dir, 'a.txt'), 'two\n')
  git('add', 'a.txt') // staged by the user
  const status = git('status', '--porcelain')
  const cp = new Checkpoints(dir)
  const before = (await cp.snapshot('before'))!
  await writeFile(join(dir, 'a.txt'), 'three\n')
  await cp.undo({ before, after: (await cp.snapshot('after'))! })
  expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('two\n')
  expect(git('status', '--porcelain')).toBe(status)
  expect(git('branch', '--list').trim()).toMatch(/^\* (main|master)$/)
})

it('a turn that writes a file shows its changes under the reply, and Undo puts them back and tells the chat', async () => {
  const prompts: string[] = []
  const script: MockScript = (req) => {
    prompts.push(req.prompt)
    if (req.prompt.includes('buff the fireball')) return [{ tool: { name: 'write_file', args: { path: 'src/Fireball.java', content: 'int mana = 30;\n' } } }, { text: 'Buffed.' }]
    return [{ text: 'ok' }]
  }
  const app = new MultimineApp({ userDataDir: join(dir, 'user'), cipher, emit: () => undefined, mockScript: script, mockDelayMs: 0, skipDetect: true })
  await app.start()
  await mkdir(join(dir, 'proj', 'src'), { recursive: true })
  await writeFile(join(dir, 'proj', 'src', 'Fireball.java'), 'int mana = 20;\n')
  await app.openProject(join(dir, 'proj'))
  try {
    const chat = await app.createChat({ autoApprove: true })
    await app.engine!.send(chat.id, 'buff the fireball')
    const reply = app.engine!.chats[chat.id].find((m) => m.role === 'assistant')!
    expect(reply.changes?.files).toEqual([{ path: 'src/Fireball.java', status: 'M', add: 1, del: 1 }])
    expect(await app.turnDiff(chat.id, reply.id, 'src/Fireball.java')).toContain('-int mana = 20;')

    // a turn that changes nothing has no changes row
    await app.engine!.send(chat.id, 'just talk')
    expect(app.engine!.chats[chat.id].filter((m) => m.role === 'assistant')[1].changes).toBeUndefined()

    expect(await app.turnUndo(chat.id, reply.id)).toEqual({ undone: true, conflicts: [] })
    expect(await readFile(join(dir, 'proj', 'src', 'Fireball.java'), 'utf8')).toBe('int mana = 20;\n')
    expect(app.engine!.chats[chat.id].find((m) => m.id === reply.id)?.changes?.undone).toBeGreaterThan(0)
    await expect(app.turnUndo(chat.id, reply.id)).rejects.toThrow(/already undone/)
    // the chat's own context still has the edit: its next message says it was undone
    await app.engine!.send(chat.id, 'what now')
    expect(prompts.at(-1)).toContain(undoNote(['src/Fireball.java']))
    expect(await readFile(join(dir, 'proj', '.multimine', '.gitignore'), 'utf8')).toContain('history.git/')
  } finally {
    await app.shutdown()
  }
})
