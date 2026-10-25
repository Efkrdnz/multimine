import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WaitingItem } from '@shared/types'
import { MultimineApp } from '../../src/main/app'
import type { MockScript } from '../../src/main/providers/mock'
import type { TurnRequest } from '../../src/main/providers/types'
import type { TgUpdate } from '../../src/main/telegram/api'
import { itemMessage } from '../../src/main/telegram/text'
import { transcriber, voicer } from '../../src/main/telegram/voice'
import { encodeOggOpus, oggCrc } from '../../src/main/telegram/ogg'
import { tableCsv } from '../../src/main/telegram/share'
import { writeFile } from 'node:fs/promises'
import { TUESDAY_ID } from '../../src/main/tuesday/tuesday'

const cipher = { encrypt: (s: string) => s, decrypt: (s: string) => s }
const ME = 4242
const STRANGER = 777

/** Telegram's Bot API (and Groq's transcription), as far as Tuesday uses them. */
function fakeTelegram() {
  const calls: { method: string; body: Record<string, any> }[] = []
  const gemini: string[] = []
  const queue: TgUpdate[] = []
  let nextId = 100
  let updateId = 1
  const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { headers: { 'content-type': 'application/json' } })
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    if (u.startsWith('https://api.groq.com/')) return new Response(JSON.stringify({ text: 'tell it snow' }), { headers: { 'content-type': 'application/json' } })
    if (u.startsWith('https://generativelanguage.googleapis.com/')) {
      const model = /models\/([^:]+):/.exec(u)![1]
      gemini.push(model)
      const speech = String(init?.body).includes('"AUDIO"')
      if (speech && model === 'gemini-3.1-flash-tts-preview') return new Response(JSON.stringify({ error: { message: `models/${model} is not found` } }), { status: 404 })
      if (!speech) return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'use the ice biome' }] } }] }))
      const pcm = Buffer.alloc(4800)
      for (let i = 0; i < 2400; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 8) * 6000), i * 2)
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm.toString('base64') } }] } }] }))
    }
    if (u.includes('/file/bot')) return new Response(Buffer.from('OggS-voice'))
    const method = u.split('/').pop()!
    const body = init?.body instanceof FormData ? Object.fromEntries(init.body.entries()) : init?.body ? JSON.parse(String(init.body)) : {}
    if (method !== 'getUpdates') calls.push({ method, body })
    switch (method) {
      case 'getMe':
        return ok({ id: 1, first_name: 'Tuesday', username: 'tuesday_test_bot' })
      case 'getUpdates': {
        for (let i = 0; i < 10 && !queue.length && !init?.signal?.aborted; i++) await new Promise((r) => setTimeout(r, 5))
        return ok(queue.splice(0))
      }
      case 'sendMessage':
        return ok({ message_id: nextId++, chat: { id: body.chat_id, type: 'private' }, date: Math.floor(Date.now() / 1000), text: body.text })
      case 'getFile':
        return ok({ file_path: 'voice/file_1.oga' })
      default:
        return ok(true)
    }
  }) as typeof fetch
  const message = (chat: number, patch: Record<string, unknown>) =>
    queue.push({ update_id: updateId++, message: { message_id: nextId++, chat: { id: chat, type: 'private' }, from: { id: chat, first_name: chat === ME ? 'Efe' : 'Someone' }, date: Math.floor(Date.now() / 1000), ...patch } })
  return {
    calls,
    gemini,
    fetcher,
    text: (chat: number, text: string) => message(chat, { text }),
    voice: (chat: number) => message(chat, { voice: { file_id: 'f1', duration: 2 } }),
    tap: (chat: number, data: string, messageId: number) => queue.push({ update_id: updateId++, callback_query: { id: `cb${updateId}`, from: { id: chat }, data, message: { message_id: messageId, chat: { id: chat, type: 'private' }, date: 0 } } }),
    sentTexts: () => calls.filter((c) => c.method === 'sendMessage').map((c) => String(c.body.text))
  }
}

const until = async <T>(get: () => T | undefined | false | Promise<T | undefined | false>, what: string): Promise<T> => {
  for (let i = 0; i < 1000; i++) {
    const v = await get()
    if (v) return v
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`timed out waiting for ${what}`)
}

describe('the pieces', () => {
  const w = (item: Partial<WaitingItem['item']>): WaitingItem => ({ item: { id: 'q1', ts: 0, kind: 'question', askedBy: 'c', title: '', status: 'pending', ...item }, dir: '/p', project: 'forge', chat: 'Spells' })
  it('turns what waits into a message with answer buttons', () => {
    const q = itemMessage(w({ questions: [{ question: 'Which element?', options: [{ label: 'Fire', description: 'Burns over time' }, { label: 'Ice' }] }] }))
    expect(q.text).toContain('❓ forge · Spells\n\nWhich element?\n\n• Fire: Burns over time\n• Ice')
    expect(q.buttons).toEqual([[{ text: 'Fire', data: 'o:q1:0' }], [{ text: 'Ice', data: 'o:q1:1' }]])
    expect(itemMessage(w({ questions: [{ question: 'A?', options: [{ label: 'x' }] }, { question: 'B?', options: [{ label: 'y' }] }] })).buttons).toBeUndefined()
    expect(itemMessage(w({ kind: 'approval', hardStop: true, permission: true, title: 'git push', planMd: 'git push origin main' })).buttons?.[0][0]).toEqual({ text: '🔑 Allow with PIN', data: 'y:q1' })
    expect(itemMessage(w({ kind: 'approval', planMd: '1. Add the bar' })).text).toContain('has a plan for you to approve:\n\n1. Add the bar')
  })
  it('understands voice notes, and speaks, with whichever key there is or the one picked', () => {
    expect(transcriber(() => undefined)).toBeNull()
    expect(transcriber((p) => (p === 'google' ? 'g' : undefined))).toBe('google')
    expect(transcriber((p) => (p === 'openai' || p === 'groq' ? 'k' : undefined))).toBe('groq')
    const all = () => 'k'
    expect(transcriber(all, 'google')).toBe('google')
    expect(voicer(all, 'google')).toBe('google')
    expect(voicer(all, 'groq')).toBe('openai')
    expect(voicer((p) => (p === 'google' ? 'g' : undefined))).toBe('google')
    expect(voicer((p) => (p === 'groq' ? 'g' : undefined))).toBeNull()
  })

  it('packs speech into an Ogg Opus file, as Telegram plays voice notes', () => {
    const ogg = encodeOggOpus(Buffer.alloc(24000 * 2), 24000)
    expect(ogg.subarray(0, 4).toString()).toBe('OggS')
    expect(ogg.includes(Buffer.from('OpusHead'))).toBe(true)
    // every page's checksum holds
    let off = 0
    let pages = 0
    while (off < ogg.length) {
      const segs = ogg[off + 26]
      const len = 27 + segs + [...ogg.subarray(off + 27, off + 27 + segs)].reduce((a, b) => a + b, 0)
      const pageBuf = Buffer.from(ogg.subarray(off, off + len))
      const crc = pageBuf.readUInt32LE(22)
      pageBuf.writeUInt32LE(0, 22)
      expect(oggCrc(pageBuf)).toBe(crc)
      off += len
      pages++
    }
    expect(pages).toBeGreaterThanOrEqual(3)
    expect(() => encodeOggOpus(Buffer.alloc(10), 44100)).toThrow('44100')
  })

  it('writes a table as CSV a spreadsheet opens', () => {
    const csv = tableCsv({ id: 't', name: 'Spells', context: false, updated: 0, columns: [{ key: 'name', label: 'Name', type: 'text' }, { key: 'mana', label: 'Mana', type: 'number' }], rows: [{ id: 'r', cells: { name: 'Fire, big "one"', mana: 12.5 } }] })
    expect(csv).toBe('﻿Name,Mana\r\n"Fire, big ""one""",12.5\r\n')
  })
})

describe('Tuesday on Telegram', () => {
  let dir: string
  let app: MultimineApp
  let seen: TurnRequest[]
  let script: MockScript
  let tg: ReturnType<typeof fakeTelegram>
  let idle = 0
  let rendered: string[] = []

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mm-telegram-'))
    seen = []
    script = (req) => (req.agent.id === TUESDAY_ID ? [{ text: 'Spells is working on the fireball.' }] : [{ text: 'ok' }])
    tg = fakeTelegram()
    idle = 0
    rendered = []
    app = new MultimineApp({
      userDataDir: join(dir, 'u'),
      cipher,
      emit: () => undefined,
      mockScript: (req) => (seen.push(req), script(req)),
      mockDelayMs: 0,
      skipDetect: true,
      fetcher: tg.fetcher,
      idleSeconds: () => idle,
      telegramPollSeconds: 0,
      renderImage: async (html) => (rendered.push(html), Buffer.from('PNG-of-the-table'))
    })
    await app.start()
    await mkdir(join(dir, 'forge'))
    await app.openProject(join(dir, 'forge'))
    await app.updateSettings({ telegram: { ...app.config.settings.telegram, enabled: true } })
    await app.telegramSetToken('123:abc')
  })

  afterEach(async () => {
    await app.shutdown()
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
  })

  const pair = async () => {
    const code = (await app.telegramState()).pairCode!
    tg.text(ME, `/start ${code}`)
    await until(() => app.config.settings.telegram.ownerChatId === ME, 'pairing')
  }

  it('pairs with whoever sends the code, and answers nobody else', async () => {
    const st = await app.telegramState()
    expect(st).toMatchObject({ status: 'ready', bot: 'tuesday_test_bot', secrets: { token: true } })
    expect(st.pairCode).toMatch(/^\d{6}$/)
    tg.text(STRANGER, '000000')
    await until(() => tg.sentTexts().includes('This is a private assistant.'), 'the refusal')
    await pair()
    expect(app.config.settings.telegram.ownerName).toBe('Efe')
    await until(() => tg.sentTexts().some((t) => t.startsWith('Paired. Hi Efe')), 'the welcome')
    expect((await app.telegramState()).pairCode).toBeUndefined()
    // the code is spent: someone else sending it now gets nowhere
    tg.text(STRANGER, `/start ${st.pairCode}`)
    await until(() => tg.sentTexts().filter((t) => t === 'This is a private assistant.').length === 2, 'the second refusal')
    expect(app.config.settings.telegram.ownerChatId).toBe(ME)
    expect(JSON.stringify(app.config.settings)).not.toContain('123:abc')
  })

  it('talks with Tuesday by text and by voice note, and answers /status without it', async () => {
    await pair()
    tg.text(ME, "what's going on?")
    await until(() => tg.sentTexts().includes('Spells is working on the fireball.'), 'the reply')
    const req = seen.find((r) => r.agent.id === TUESDAY_ID)!
    expect(req.prompt).toContain('[On Telegram with the user, on their phone.')
    expect(req.prompt.endsWith("what's going on?")).toBe(true)
    expect((await app.tuesdayInit()).messages.find((m) => m.role === 'user')).toMatchObject({ via: 'telegram' })

    // no key for voice notes: it says what to do
    tg.voice(ME)
    await until(() => tg.sentTexts().some((t) => t.startsWith("I can't listen to voice notes yet")), 'the no-key reply')
    await app.setKey('groq', 'gsk_test')
    seen.length = 0
    tg.voice(ME)
    await until(() => tg.sentTexts().includes('🎤 "tell it snow"'), 'the transcript')
    await until(() => seen.some((r) => r.agent.id === TUESDAY_ID), 'the voice turn')
    expect(seen.find((r) => r.agent.id === TUESDAY_ID)!.prompt).toContain('(they sent a voice note; this is what it said)')

    tg.text(ME, '/status')
    await until(() => tg.sentTexts().some((t) => t.startsWith('Workspace now')), 'the status')
  })

  it("sends what waits when you're away, one tap answers it, and its message shows what was decided", async () => {
    await pair()
    const chat = await app.createChat({ name: 'Builder' })
    const asked = app.engine!.askUser(chat.id, [{ question: 'Which biome?', options: [{ label: 'Desert' }, { label: 'Snow' }] }])
    await until(() => app.engine!.inbox.pending()[0], 'the question')
    expect(await app.telegram.tick()).toBe(0)
    idle = 10 * 60
    expect(await app.telegram.tick()).toBe(1)
    const sent = tg.calls.filter((c) => c.method === 'sendMessage').at(-1)!
    expect(sent.body.text).toContain('❓ forge · Builder\n\nWhich biome?')
    const id = app.engine!.inbox.pending()[0].id
    expect(sent.body.reply_markup.inline_keyboard).toEqual([[{ text: 'Desert', callback_data: `o:${id}:0` }], [{ text: 'Snow', callback_data: `o:${id}:1` }]])
    expect(await app.telegram.tick()).toBe(0)
    tg.tap(ME, `o:${id}:1`, 100)
    expect((await asked).answers).toEqual({ 'Which biome?': 'Snow' })
    await until(() => tg.calls.some((c) => c.method === 'editMessageText' && String(c.body.text).endsWith('✓ Snow')), 'the edit')

    // answered at the computer instead: the message says so
    const asked2 = app.engine!.askUser(chat.id, [{ question: 'How big?', options: [{ label: 'Small' }, { label: 'Huge' }] }])
    await until(() => app.engine!.inbox.pending()[0], 'the second question')
    await app.telegram.tick()
    await app.answer(app.engine!.inbox.pending()[0].id, { 'How big?': 'Huge' })
    await asked2
    await app.telegram.tick()
    expect(tg.calls.some((c) => c.method === 'editMessageText' && String(c.body.text).endsWith('— answered'))).toBe(true)
  })

  it('allows a hard stop only with the PIN, which is deleted from the chat', async () => {
    await pair()
    await app.phoneSetSecrets(undefined, '2468')
    const chat = await app.createChat({ name: 'Builder', autoApprove: false })
    const push = app.engine!.approveAction(chat.id, 'git push', 'git push origin main', true)
    await until(() => app.engine!.inbox.pending()[0], 'the push')
    const id = app.engine!.inbox.pending()[0].id
    idle = 600
    await app.telegram.tick()
    tg.tap(ME, `y:${id}`, 100)
    await until(() => tg.sentTexts().includes("To allow git push, send your PIN. I'll delete the message right away."), 'the PIN prompt')
    tg.text(ME, '1111')
    await until(() => tg.sentTexts().includes('That is not the PIN. I left git push for you to decide in the app.'), 'the wrong PIN')
    expect(app.engine!.inbox.get(id)?.status).toBe('pending')
    tg.tap(ME, `y:${id}`, 100)
    await until(() => tg.sentTexts().filter((t) => t.startsWith('To allow git push')).length === 2, 'the second prompt')
    tg.text(ME, '2468')
    expect(await push).toBe(true)
    await until(() => tg.sentTexts().includes('Done: git push is allowed.'), 'the confirmation')
    // both PIN messages were deleted
    expect(tg.calls.filter((c) => c.method === 'deleteMessage')).toHaveLength(2)
  })

  it('a hard stop Tuesday passes on in conversation also waits for the PIN', async () => {
    await pair()
    await app.phoneSetSecrets(undefined, '2468')
    const chat = await app.createChat({ name: 'Builder' })
    const push = app.engine!.approveAction(chat.id, 'git push', 'git push origin main', true)
    const item = await until(() => app.engine!.inbox.pending()[0], 'the push')
    script = (req) => (req.agent.id === TUESDAY_ID && req.prompt.includes(`[${item.id}]`) ? [{ tool: { name: 'answer', args: { id: item.id, approve: true, user_confirmed: true } } }, { text: 'Send your PIN and it goes.' }] : [{ text: 'ok' }])
    tg.text(ME, 'yes, push it')
    await until(() => tg.sentTexts().includes("To allow git push, send your PIN. I'll delete the message right away."), 'the PIN prompt')
    expect(app.engine!.inbox.get(item.id)?.status).toBe('pending')
    tg.text(ME, '2468')
    expect(await push).toBe(true)
  })

  it('listens and answers with a Gemini key: a voice note back, from the first Gemini speech model that answers', async () => {
    await pair()
    await app.setKey('google', 'gm_test')
    await app.updateSettings({ telegram: { ...app.config.settings.telegram, voiceReplies: true, speech: 'google' } })
    expect(await app.telegramState()).toMatchObject({ voice: 'google', speaks: 'google' })
    tg.voice(ME)
    await until(() => tg.sentTexts().includes('🎤 "use the ice biome"'), 'the transcript')
    const voice = await until(() => tg.calls.find((c) => c.method === 'sendVoice'), 'the voice reply')
    const ogg = Buffer.from(await (voice.body.voice as Blob).arrayBuffer())
    expect(ogg.subarray(0, 4).toString()).toBe('OggS')
    expect(voice.body.caption).toBe('Spells is working on the fireball.')
    expect(tg.gemini).toEqual(['gemini-flash-latest', 'gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts'])
  })

  it('/tables offers every table; a tap sends its picture and every row as CSV', async () => {
    await pair()
    await app.engine!.tables.save({ id: 'spells', name: 'Spells', context: false, updated: 1, columns: [{ key: 'name', label: 'Name', type: 'text' }, { key: 'element', label: 'Element', type: 'enum', values: ['fire'], colors: { fire: '#d95926' } }], rows: [{ id: 'r1', cells: { name: 'Fireball', element: 'fire' } }] })
    tg.text(ME, '/tables')
    const offer = await until(() => tg.calls.find((c) => c.method === 'sendMessage' && c.body.text === 'Which table?'), 'the offer')
    const button = offer.body.reply_markup.inline_keyboard[0][0]
    expect(button.text).toBe('📊 Spells (forge, 1 rows)')
    tg.tap(ME, button.callback_data, 1)
    const photo = await until(() => tg.calls.find((c) => c.method === 'sendPhoto'), 'the picture')
    expect(photo.body.caption).toBe('Spells · forge · 1 rows')
    expect(rendered[0]).toContain('<h1>Spells</h1>')
    expect(rendered[0]).toContain('Fireball')
    const doc = await until(() => tg.calls.find((c) => c.method === 'sendDocument'), 'the CSV')
    expect(Buffer.from(await (doc.body.document as Blob).arrayBuffer()).toString()).toContain('Fireball,fire')
  })

  it('/screens sends the pictures chats looked at, and Tuesday can send them and tables when asked', async () => {
    await pair()
    const forge = app.project!.dir
    await mkdir(join(forge, 'shots'))
    await writeFile(join(forge, 'shots', 'game.png'), Buffer.from('fake png'))
    await writeFile(join(forge, 'shots', 'menu.png'), Buffer.from('fake png 2'))
    const chat = await app.createChat({ name: 'Builder', autoApprove: true })
    script = (req) => (req.agent.id === TUESDAY_ID ? [{ text: 'ok' }] : [{ tool: { name: 'read_file', args: { path: 'shots/game.png' } } }, { tool: { name: 'run_command', args: { command: 'echo saved shots/menu.png' } } }, { text: 'Looks right.' }])
    await app.engine!.send(chat.id, 'check the game')
    tg.text(ME, '/screens builder')
    const album = await until(() => tg.calls.find((c) => c.method === 'sendMediaGroup'), 'the album')
    const media = JSON.parse(album.body.media)
    expect(media).toHaveLength(2)
    expect(media.map((m: { caption: string }) => m.caption.split('\n')[1]).sort()).toEqual(['game.png', 'menu.png'])
    expect(media[0].caption).toContain('Builder · forge')

    // Tuesday gets the tools once Telegram is paired, and uses them
    const names = app.tuesday.tools().map((t) => t.name)
    expect(names.slice(0, 2)).toEqual(['share_table', 'share_screenshots'])
    const shots = await app.tuesday.tools().find((t) => t.name === 'share_screenshots')!.handler({ chat: 'Builder', count: 1 })
    expect(shots.text).toMatch(/^Sent 1 screenshot to the user's Telegram: Builder \((game|menu)\.png\)\.$/)
    const none = await app.tuesday.tools().find((t) => t.name === 'share_table')!.handler({ table: 'loot' })
    expect(none).toMatchObject({ isError: true })
    expect(none.text).toContain('No table "loot"')
  })
})
