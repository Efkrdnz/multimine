import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { MainEvent } from '@shared/types'
import { IDEAS_PATH, SIDE_IDEAS_RULE, parseBook, sameIdea, workPrompt } from '@shared/ideas'
import { MultimineApp } from '../../src/main/app'
import type { MockScript } from '../../src/main/providers/mock'
import type { TurnRequest } from '../../src/main/providers/types'

const cipher = { encrypt: (s: string) => `x${s}`, decrypt: (s: string) => s.slice(1) }

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mm-ideas-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

it('reads a book leniently and knows two titles that say the same thing', () => {
  const book = parseBook({ sideIdeas: true, ideas: [{ id: 'a', title: ' Chain lightning ', status: 'weird', tags: ['Spell', 3] }, { id: 'b' }, 'junk'] })
  expect(book).toEqual({ sideIdeas: true, ideas: [{ id: 'a', title: 'Chain lightning', tags: ['spell'], status: 'open', from: 'you', created: 0 }] })
  expect(sameIdea('Chain Lightning!', 'chain lightning')).toBe(true)
  expect(workPrompt({ title: 'Mana regen ring', details: 'Restores 1 mana a second.', tags: ['item'] })).toBe('# Idea: Mana regen ring\n\nRestores 1 mana a second.\nTags: item\n\nWork on this idea from the Idea Book: plan it briefly, then build it. Ask if something about it is unclear.')
})

it('/idea brainstorms: the ideas go to the book to review, the chat gets a card, and repeats are skipped', async () => {
  const seen: TurnRequest[] = []
  const events: MainEvent[] = []
  const script: MockScript = (req) => {
    seen.push(req)
    if (req.prompt.includes('# Brainstorm ideas'))
      return [
        {
          tool: {
            name: 'save_ideas',
            args: {
              ideas: [
                { title: 'Chain lightning', details: 'Jumps to three nearby enemies.', tags: ['spell'] },
                { title: 'Frost nova', details: 'Freezes everything around you.', tags: ['spell', 'aoe'] },
                { title: 'Mana shield', tags: ['spell'] }
              ]
            }
          }
        },
        { text: 'Saved 2 spell ideas for you to review.' }
      ]
    return [{ text: 'ok' }]
  }
  const app = new MultimineApp({ userDataDir: join(dir, 'user'), cipher, emit: (e) => events.push(e), mockScript: script, mockDelayMs: 0, skipDetect: true })
  await app.start()
  const proj = join(dir, 'proj')
  await mkdir(join(proj, '.multimine'), { recursive: true })
  // one already in the book: the chat is told, and it is not saved twice
  await writeFile(join(proj, IDEAS_PATH), JSON.stringify({ sideIdeas: false, ideas: [{ id: 'old', title: 'Mana Shield', status: 'open', from: 'you', created: 1 }] }))
  await app.openProject(proj)
  try {
    const chat = await app.createChat()
    await app.engine!.send(chat.id, '/idea new spells for the fire school')
    expect(app.project!.get(chat.id)?.name).toBe('Ideas: new spells for the fire school')
    expect(seen[0].prompt).toContain('The user wants ideas about: new spells for the fire school')
    expect(seen[0].prompt).toContain('Already in the Idea Book (do not repeat): Mana Shield.')
    const book = parseBook(JSON.parse(await readFile(join(proj, IDEAS_PATH), 'utf8')))
    expect(book.ideas.map((i) => [i.title, i.status, i.from])).toEqual([
      ['Mana Shield', 'open', 'you'],
      ['Chain lightning', 'proposed', 'Ideas: new spells for the fire school'],
      ['Frost nova', 'proposed', 'Ideas: new spells for the fire school']
    ])
    expect(book.ideas[1]).toMatchObject({ chatId: chat.id, details: 'Jumps to three nearby enemies.', tags: ['spell'] })
    const msgs = app.engine!.chats[chat.id]
    expect(msgs.find((m) => m.ideas)?.ideas).toEqual({ count: 2, titles: ['Chain lightning', 'Frost nova'] })
    const tool = msgs.find((m) => m.role === 'assistant')!.tools!.find((t) => t.name === 'save_ideas')!
    expect(tool.output).toContain('Saved 2 ideas to the Idea Book for the user to review; 1 already there (Mana shield)')
    expect(events.some((e) => e.type === 'ideas-changed')).toBe(true)
    expect(msgs.find((m) => m.role === 'user')?.command).toBe('idea')
  } finally {
    await app.shutdown()
  }
})

it('side ideas: chats are told only while it is on, so off costs nothing', async () => {
  const seen: TurnRequest[] = []
  const app = new MultimineApp({ userDataDir: join(dir, 'user'), cipher, emit: () => undefined, mockScript: (req) => (seen.push(req), [{ text: 'ok' }]), mockDelayMs: 0, skipDetect: true })
  await app.start()
  const proj = join(dir, 'proj')
  await app.openProject(proj)
  try {
    const chat = await app.createChat()
    await app.engine!.send(chat.id, 'hello')
    expect(seen[0].system).not.toContain('Side ideas')
    await writeFile(join(proj, IDEAS_PATH), JSON.stringify({ sideIdeas: true, ideas: [] }))
    await app.engine!.send(chat.id, 'again')
    expect(seen[1].system).toContain(SIDE_IDEAS_RULE)
    // a chat that can only talk cannot call tools: it is not told
    const talker = await app.createChat({ permissions: 'chat' })
    await app.engine!.send(talker.id, 'hi')
    expect(seen[2].system).not.toContain('Side ideas')
  } finally {
    await app.shutdown()
  }
})
