import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { MainEvent } from '@shared/types'
import { MultimineApp } from '../../src/main/app'
import type { TurnRequest } from '../../src/main/providers/types'

let dir: string
let app: MultimineApp
let chat: string
let events: MainEvent[]
const seen: TurnRequest[] = []

const FIREBALL = 'class Fireball {\n  static final int MANA_COST = 20;\n  static final float COOLDOWN = 2.5f;\n}\n'

// what a chat would send: two links that match, one that does not
const TABLE = {
  id: 'spells',
  name: 'Spells',
  columns: [
    { key: 'name', label: 'Spell' },
    { key: 'mana', label: 'Mana usage', type: 'number' },
    { key: 'cooldown', label: 'Cooldown', type: 'number' },
    { key: 'damage', label: 'Base damage', type: 'number' }
  ],
  rows: [
    {
      id: 'fireball',
      file: 'src/Fireball.java',
      cells: { name: 'Fireball', mana: 18, cooldown: 2.5, damage: 8 },
      links: {
        mana: { file: 'src/Fireball.java', line: 2, before: 'MANA_COST = ', after: ';' },
        cooldown: { file: 'src/Fireball.java', line: 9, before: 'COOLDOWN = ', after: ';' },
        damage: { file: 'src/Fireball.java', line: 4, before: 'DAMAGE = ', after: ';' }
      }
    }
  ]
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mm-tables-'))
  seen.length = 0
  events = []
  await mkdir(join(dir, 'p', 'src'), { recursive: true })
  await writeFile(join(dir, 'p', 'src', 'Fireball.java'), FIREBALL)
  app = new MultimineApp({
    userDataDir: join(dir, 'u'),
    cipher: { encrypt: (s) => s, decrypt: (s) => s },
    emit: (e) => events.push(e),
    mockDelayMs: 0,
    skipDetect: true,
    mockScript: (req) => {
      seen.push(req)
      // a /table turn: the stand-in "builds" the table by calling the real tool
      if (req.prompt.includes('# Make or change a table')) return [{ tool: { name: 'save_table', args: TABLE } }, { text: 'Saved the spells table.' }]
      return [{ text: 'ok' }]
    }
  })
  await app.start()
  await app.openProject(join(dir, 'p'))
  chat = app.project!.list()[0].id
})

afterEach(async () => {
  await app.shutdown()
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

it('/table keeps what the user typed, gives the turn the table instructions, and names the chat after it', async () => {
  await app.engine!.send(chat, '/table every spell with mana usage and cooldown')
  const msg = app.engine!.chats[chat].find((m) => m.role === 'user')!
  expect(msg).toMatchObject({ text: '/table every spell with mana usage and cooldown', command: 'table' })
  expect(seen[0].prompt).toContain('## Request\nevery spell with mana usage and cooldown')
  expect(seen[0].prompt).toContain('`save_table`')
  for (let i = 0; i < 50 && app.project!.get(chat)!.name === 'New chat'; i++) await new Promise((r) => setTimeout(r, 10))
  expect(app.project!.get(chat)!.name).toBe('Table: every spell with mana usage and cooldown')
})

it('save_table checks every link against the code, keeps the ones that match, and says which did not', async () => {
  await app.engine!.send(chat, '/table spells')
  const saved = JSON.parse(await readFile(join(dir, 'p', '.multimine', 'tables', 'spells.json'), 'utf8'))
  const row = saved.rows[0]
  // the code is the truth: mana is 20 there, not the 18 the chat wrote
  expect(row.cells.mana).toBe(20)
  // the cooldown was on another line than the chat said: found and corrected
  expect(row.links.cooldown.line).toBe(3)
  expect(row.links.damage).toBeUndefined()
  const tool = app.engine!.chats[chat].flatMap((m) => m.tools ?? []).find((t) => t.name === 'save_table')!
  expect(tool.output).toContain('2 of 3 links match the code')
  expect(tool.output).toContain('fireball.damage: "DAMAGE = ...;" is not in src/Fireball.java')
  // a card in the chat, and the Tables tool hears about it
  const card = app.engine!.chats[chat].find((m) => m.table)!.table!
  expect(card).toMatchObject({ id: 'spells', name: 'Spells', rows: 1, columns: 4, links: 3, verified: 2 })
  expect(card.preview.rows[0]).toMatchObject({ name: 'Fireball', mana: '20' })
  expect(events).toContainEqual({ type: 'tables-changed', id: 'spells' })
})

it('gives every chat the tables switched on as context, and keeps the switch when a chat saves again', async () => {
  await app.engine!.send(chat, '/table spells')
  await app.engine!.send(chat, 'hello')
  expect(seen[1].system).not.toContain('## Project tables')
  const t = (await app.engine!.tables.get('spells'))!
  await app.engine!.tables.save({ ...t, context: true })
  await app.engine!.send(chat, 'what does fireball cost?')
  expect(seen[2].system).toContain('## Project tables')
  expect(seen[2].system).toContain('| Fireball | 20 | 2.5 | 8 |')
  // the chat saves the table again without saying anything about context: it stays on
  await app.engine!.send(chat, '/table spells again')
  expect((await app.engine!.tables.get('spells'))!.context).toBe(true)
  const read = app.engine!.coordinationTools(app.project!.get(chat)!).find((x) => x.name === 'read_table')!
  expect((await read.handler({})).text).toBe('spells: Spells (1 rows; Spell, Mana usage, Cooldown, Base damage) - context')
  expect(JSON.parse((await read.handler({ id: 'spells' })).text).rows[0].cells.mana).toBe(20)
})
