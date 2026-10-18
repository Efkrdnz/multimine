import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { MOCK_DEFAULTS, newChat } from '@shared/chat'
import { MultimineApp } from '../../src/main/app'
import { ATTACH_DIR, attachmentNote, checkUploads } from '../../src/main/media/attachments'
import { userContent } from '../../src/main/providers/claudeCli'
import { codexArgs } from '../../src/main/providers/codexCli'
import type { TurnRequest } from '../../src/main/providers/types'

const cipher = { encrypt: (s: string) => `x${s}`, decrypt: (s: string) => s.slice(1) }
// a 1x1 red PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mm-img-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

it('refuses what a provider would not take', () => {
  expect(checkUploads([{ name: 'a.png', mime: 'image/png', data: PNG }])).toBeNull()
  expect(checkUploads([{ name: 'a.bmp', mime: 'image/bmp', data: PNG }])).toContain('only PNG, JPEG, GIF and WebP')
  expect(checkUploads([{ name: 'big.png', mime: 'image/png', data: 'A'.repeat(11_000_000) }])).toContain('big.png is over 8 MB')
  expect(checkUploads(Array.from({ length: 11 }, () => ({ name: 'a.png', mime: 'image/png', data: PNG })))).toContain('At most 10')
})

it('hands images to Claude as image blocks before the text, and to Codex as --image before the prompt', () => {
  const images = [{ path: '/p/.multimine/media/attachments/a.png', mime: 'image/png', data: PNG }]
  expect(userContent({ prompt: 'hi' })).toBe('hi')
  expect(userContent({ prompt: 'what is wrong here?', images })).toEqual([
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
    { type: 'text', text: 'what is wrong here?' }
  ])
  const base = { agent: newChat('c', { ...MOCK_DEFAULTS, provider: 'codex-cli', model: 'gpt' }), cwd: '/p', externalMcp: [] } as unknown as TurnRequest
  expect(codexArgs({ ...base, images }).slice(-2)).toEqual(['--image=/p/.multimine/media/attachments/a.png', '-'])
  expect(codexArgs({ ...base, images, resumeId: 'T1' }).slice(-4)).toEqual(['resume', 'T1', '--image=/p/.multimine/media/attachments/a.png', '-'])
  expect(codexArgs(base).some((a) => a.startsWith('--image'))).toBe(false)
})

it('a message with images saves them in the project, shows them on the message, and the turn gets them', async () => {
  const seen: TurnRequest[] = []
  const app = new MultimineApp({
    userDataDir: join(dir, 'user'),
    cipher,
    emit: () => undefined,
    mockScript: (req) => (seen.push(req), [{ text: 'Looked.' }]),
    mockDelayMs: 0,
    skipDetect: true
  })
  await app.start()
  await app.openProject(join(dir, 'proj'))
  try {
    const chat = await app.createChat()
    await app.engine!.send(chat.id, 'why is this texture purple?', 'user', { images: [{ name: 'shot.png', mime: 'image/png', data: PNG, w: 1, h: 1 }] })
    const msg = app.engine!.chats[chat.id].find((m) => m.role === 'user')!
    expect(msg.text).toBe('why is this texture purple?')
    expect(msg.attachments).toHaveLength(1)
    const a = msg.attachments![0]
    expect(a).toMatchObject({ mime: 'image/png', name: 'shot.png', w: 1, h: 1, bytes: 70 })
    expect(a.path.startsWith(`${ATTACH_DIR}/`)).toBe(true)
    expect((await readFile(join(dir, 'proj', a.path))).toString('base64')).toBe(PNG)
    // the provider gets the image, and the prompt says where it is
    expect(seen[0].images).toEqual([{ path: join(dir, 'proj', a.path), mime: 'image/png', data: PNG }])
    expect(seen[0].prompt).toBe(`why is this texture purple?\n\n${attachmentNote([a])}`)
    // a later turn has it in its history as a note, not as the image again
    await app.engine!.send(chat.id, 'and now?')
    expect(seen[1].images).toBeUndefined()
    // an image alone is a message too
    await app.send(chat.id, '', { images: [{ name: 'only.png', mime: 'image/png', data: PNG }] })
    await new Promise((r) => setTimeout(r, 200))
    expect(seen[2].prompt.startsWith('See the attached image.')).toBe(true)
    await expect(app.send(chat.id, 'x', { images: [{ name: 'a.tiff', mime: 'image/tiff', data: PNG }] })).rejects.toThrow('only PNG')
    // saved with the message, so it comes back after a restart
    const lines = await readFile(join(dir, 'proj', '.multimine', 'chats', chat.id, 'messages.jsonl'), 'utf8')
    expect(lines).toContain(a.path)
    expect(existsSync(join(dir, 'proj', ATTACH_DIR))).toBe(true)
  } finally {
    await app.shutdown()
  }
})
