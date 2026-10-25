import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PhoneSettings, WaitingItem } from '@shared/types'
import { MultimineApp } from '../../src/main/app'
import { Phone, e164, inQuietHours } from '../../src/main/phone/phone'
import { phoneGreeting, spokenItem } from '../../src/main/phone/talk'
import { TwilioClient, twilioSignature, validSignature } from '../../src/main/phone/twilio'
import { goodbye, speakable } from '../../src/main/phone/twiml'
import { cloudflaredAsset, tunnelUrl } from '../../src/main/phone/tunnel'
import { AppConfig } from '../../src/main/store/appConfig'
import type { MockScript } from '../../src/main/providers/mock'
import type { TurnRequest } from '../../src/main/providers/types'
import { TUESDAY_ID } from '../../src/main/tuesday/tuesday'

const cipher = { encrypt: (s: string) => s, decrypt: (s: string) => s }
const BASE = 'https://phone.test'

/** Twilio's REST API, as far as the phone uses it. */
function fakeTwilio() {
  const calls: { url: string; method: string; body: string }[] = []
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    calls.push({ url: u, method: init?.method ?? 'GET', body: String(init?.body ?? '') })
    const json = u.includes('/IncomingPhoneNumbers.json?') ? { incoming_phone_numbers: [{ sid: 'PN1' }] } : u.endsWith('/Calls.json') ? { sid: 'CA9' } : {}
    return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { calls, fetcher }
}

const fixedUrl = () => ({ start: async () => BASE, stop: async () => undefined })

const settings = (patch: Partial<PhoneSettings> = {}): PhoneSettings => ({
  enabled: true,
  accountSid: 'AC1',
  twilioNumber: '+1 555 000 1111',
  myNumber: '+1 (555) 222-3333',
  language: 'en-US',
  voice: 'Polly.Joanna-Neural',
  callWhenAway: true,
  awayMinutes: 10,
  quietHours: { enabled: false, from: '23:00', to: '08:00' },
  publicUrl: '',
  ...patch
})

const until = async <T>(get: () => T | undefined | false | Promise<T | undefined | false>, what: string): Promise<T> => {
  for (let i = 0; i < 1000; i++) {
    const v = await get()
    if (v) return v
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`timed out waiting for ${what}`)
}

describe('the pieces', () => {
  it("checks Twilio's signature on a webhook", () => {
    const params = { CallSid: 'CA1', From: '+15552223333', Digits: '1234' }
    const sig = twilioSignature('tok', `${BASE}/voice/pin`, params)
    expect(validSignature('tok', `${BASE}/voice/pin`, params, sig)).toBe(true)
    expect(validSignature('tok', `${BASE}/voice/pin`, { ...params, Digits: '9999' }, sig)).toBe(false)
    expect(validSignature('other', `${BASE}/voice/pin`, params, sig)).toBe(false)
    expect(validSignature('tok', `${BASE}/voice/pin`, params, undefined)).toBe(false)
    // the order the parameters came in does not matter: Twilio sorts them
    expect(twilioSignature('tok', 'u', { b: '2', a: '1' })).toBe(twilioSignature('tok', 'u', { a: '1', b: '2' }))
  })

  it('turns a written reply into something to say, and hears a goodbye', () => {
    expect(speakable('**Spells** finished.\n\n- Added `fireball`\n- See [the PR](https://x.y/1)')).toBe('Spells finished. Added fireball. See the PR')
    expect(speakable('```ts\nconst a = 1\n```\nDone')).toBe('(there is code in the app). Done')
    const long = speakable(`${'This is a sentence. '.repeat(60)}`, 100)
    expect(long.length).toBeLessThan(140)
    expect(long.endsWith('The rest is in the app.')).toBe(true)
    expect(goodbye('Okay, bye!')).toBe(true)
    expect(goodbye("that's all")).toBe(true)
    expect(goodbye('tell spells goodbye is the answer')).toBe(false)
  })

  it('knows the quiet hours, phone numbers and the tunnel', () => {
    const q = { enabled: true, from: '23:00', to: '08:00' }
    const at = (h: number, m = 0) => new Date(2026, 0, 1, h, m)
    expect(inQuietHours(q, at(23, 30))).toBe(true)
    expect(inQuietHours(q, at(3))).toBe(true)
    expect(inQuietHours(q, at(8))).toBe(false)
    expect(inQuietHours(q, at(14))).toBe(false)
    expect(inQuietHours({ ...q, from: '12:00', to: '13:00' }, at(12, 30))).toBe(true)
    expect(inQuietHours({ ...q, enabled: false }, at(3))).toBe(false)
    expect(e164('+1 (555) 222-3333')).toBe('+15552223333')
    expect(e164('90 532 000 00 00')).toBe('+905320000000')
    expect(tunnelUrl('2026 INF |  https://brave-otter-12.trycloudflare.com  |')).toBe('https://brave-otter-12.trycloudflare.com')
    expect(tunnelUrl('connecting...')).toBeNull()
    expect(cloudflaredAsset('win32', 'x64')).toBe('cloudflared-windows-amd64.exe')
    expect(cloudflaredAsset('darwin', 'arm64')).toBe('cloudflared-darwin-arm64.tgz')
  })

  it('says what is waiting in a sentence', () => {
    const w = (item: Partial<WaitingItem['item']>): WaitingItem => ({ item: { id: 'x', ts: 0, kind: 'question', askedBy: 'c', title: '', status: 'pending', ...item }, dir: '/p', project: 'forge', chat: 'Spells' })
    const q = w({ questions: [{ question: 'Which element?', options: [{ label: 'Fire' }, { label: 'Ice' }, { label: 'Void' }] }] })
    expect(spokenItem(q)).toBe('Spells asks: Which element? The options are Fire, Ice or Void.')
    expect(spokenItem(w({ kind: 'approval', permission: true, title: 'run: npm test' }))).toBe('Spells wants your OK to run npm test.')
    expect(spokenItem(w({ kind: 'approval', hardStop: true, permission: true, title: 'git push' }))).toBe('Spells wants to git push, which needs your PIN.')
    expect(phoneGreeting('Tuesday', true, [q], 0)).toBe("Hi, it's Tuesday. Spells asks: Which element? The options are Fire, Ice or Void. What should I tell it?")
    expect(phoneGreeting('Tuesday', true, [q, q], 0)).toContain('2 things are waiting for you. First: Spells asks')
    expect(phoneGreeting('Tuesday', false, [q], 2)).toBe('Hi, Tuesday here. 2 chats are working, and 1 thing is waiting for you. What can I do?')
    expect(phoneGreeting('Tuesday', false, [], 0)).toBe('Hi, Tuesday here. All quiet. What can I do?')
  })

  it("calls Twilio's API the way it expects", async () => {
    const { calls, fetcher } = fakeTwilio()
    const t = new TwilioClient({ accountSid: 'AC1', authToken: 'tok' }, fetcher)
    expect(await t.numberSid('+15550001111')).toBe('PN1')
    await t.setVoiceUrl('PN1', `${BASE}/voice/incoming`)
    expect(await t.call({ to: '+15552223333', from: '+15550001111', url: `${BASE}/voice/outbound` })).toBe('CA9')
    expect(calls[0].url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC1/IncomingPhoneNumbers.json?PhoneNumber=%2B15550001111')
    expect(calls[1]).toMatchObject({ method: 'POST', url: 'https://api.twilio.com/2010-04-01/Accounts/AC1/IncomingPhoneNumbers/PN1.json' })
    expect(new URLSearchParams(calls[1].body).get('VoiceUrl')).toBe(`${BASE}/voice/incoming`)
    expect(Object.fromEntries(new URLSearchParams(calls[2].body))).toMatchObject({ To: '+15552223333', From: '+15550001111', Url: `${BASE}/voice/outbound` })
    const denied = new TwilioClient({ accountSid: 'AC1', authToken: 'bad' }, (async () => new Response('{}', { status: 401 })) as typeof fetch)
    await expect(denied.numberSid('+1')).rejects.toThrow('did not accept')
  })
})

describe('a call to Tuesday', () => {
  let dir: string
  let app: MultimineApp
  let seen: TurnRequest[]
  let script: MockScript
  let twilio: ReturnType<typeof fakeTwilio>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mm-phone-'))
    seen = []
    script = () => [{ text: 'ok' }]
    twilio = fakeTwilio()
    app = new MultimineApp({
      userDataDir: join(dir, 'u'),
      cipher,
      emit: () => undefined,
      mockScript: (req) => (seen.push(req), script(req)),
      mockDelayMs: 0,
      skipDetect: true,
      fetcher: twilio.fetcher,
      phonePublicUrl: fixedUrl
    })
    await app.start()
    await mkdir(join(dir, 'forge'))
    await app.openProject(join(dir, 'forge'))
    await app.phoneSetSecrets('tok', '2468')
    await app.updateSettings({ phone: settings() })
    await until(async () => (await app.phoneState()).status === 'ready', 'the phone')
  })

  afterEach(async () => {
    await app.shutdown()
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
  })

  /** A webhook from Twilio, signed as Twilio signs it. */
  const hook = async (path: string, params: Record<string, string>, sign = true) => {
    const res = await fetch(`http://127.0.0.1:${app.phone.server.port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(sign ? { 'x-twilio-signature': twilioSignature('tok', `${BASE}${path}`, params) } : {}) },
      body: new URLSearchParams(params).toString()
    })
    return { status: res.status, xml: await res.text() }
  }
  const call = { CallSid: 'CA1', From: '+15552223333', To: '+15550001111' }
  const pinned = async () => {
    await hook('/voice/incoming', call)
    return hook('/voice/pin', { ...call, Digits: '2468' })
  }

  it('points the Twilio number at the tunnel, and keeps the secrets out of the settings', async () => {
    const set = twilio.calls.find((c) => c.method === 'POST' && c.url.endsWith('/IncomingPhoneNumbers/PN1.json'))!
    expect(new URLSearchParams(set.body).get('VoiceUrl')).toBe(`${BASE}/voice/incoming`)
    const st = await app.phoneState()
    expect(st).toMatchObject({ status: 'ready', url: BASE, secrets: { token: true, pin: true } })
    expect(JSON.stringify(app.config.settings)).not.toContain('2468')
    await expect(app.phoneSetSecrets(undefined, '12')).rejects.toThrow('4 to 8 digits')
  })

  it('answers only Twilio, only from your number, and only with the PIN', async () => {
    expect((await hook('/voice/incoming', call, false)).status).toBe(403)
    expect((await hook('/voice/incoming', { ...call, From: '+15559999999' })).xml).toContain('<Reject/>')
    const asked = (await hook('/voice/incoming', call)).xml
    expect(asked).toContain('input="dtmf"')
    expect(asked).toContain('numDigits="4"')
    expect(asked).toContain('Your PIN, please.')
    expect((await hook('/voice/heard', { ...call, SpeechResult: 'hello' })).xml).toContain('<Hangup/>')
    expect((await hook('/voice/pin', { ...call, Digits: '1111' })).xml).toContain('Try again.')
    const greeted = (await hook('/voice/pin', { ...call, Digits: '2468' })).xml
    expect(greeted).toContain('input="speech"')
    expect(greeted).toContain('Hi, Tuesday here. All quiet. What can I do?')
    expect(greeted).toContain('voice="Polly.Joanna-Neural"')
    expect((await app.phoneState()).call).toMatchObject({ outbound: false })
  })

  it('talks with Tuesday: spoken replies, a moment while it thinks, and goodbye', async () => {
    script = (req) => (req.agent.id === TUESDAY_ID ? [{ text: '**Spells** is working.\n- one\n- two' }] : [{ text: 'ok' }])
    await pinned()
    const said = (await hook('/voice/heard', { ...call, SpeechResult: "what's going on" })).xml
    expect(said).toContain('<Say voice="Polly.Joanna-Neural">Spells is working. one. two</Say>')
    expect(said).toContain('action="https://phone.test/voice/heard"')
    const req = seen.find((r) => r.agent.id === TUESDAY_ID)!
    expect(req.prompt).toContain('[On the phone with the user.')
    expect(req.prompt.endsWith("what's going on")).toBe(true)
    const msg = (await app.tuesdayInit()).messages.find((m) => m.role === 'user')!
    expect(msg).toMatchObject({ text: "what's going on", via: 'phone' })

    // a slow reply: Twilio hears "one moment" and comes back for it
    script = (req) => (req.agent.id === TUESDAY_ID ? new Promise((r) => setTimeout(() => r([{ text: 'Done thinking.' }]), 9000)) : [{ text: 'ok' }])
    const held = (await hook('/voice/heard', { ...call, SpeechResult: 'think hard' })).xml
    expect(held).toContain('One moment.')
    expect(held).toContain('<Redirect method="POST">https://phone.test/voice/wait</Redirect>')
    expect((await hook('/voice/wait', call)).xml).toContain('Done thinking.')

    expect((await hook('/voice/heard', { ...call, SpeechResult: '' })).xml).toContain('Are you still there?')
    const bye = (await hook('/voice/heard', { ...call, SpeechResult: 'ok bye' })).xml
    expect(bye).toContain('<Hangup/>')
    expect((await app.phoneState()).call).toBeNull()
  }, 20_000)

  it('allows a hard stop only with the PIN on the keypad', async () => {
    const chat = await app.createChat({ name: 'Builder' })
    const push = app.engine!.approveAction(chat.id, 'git push', 'git push origin main', true)
    const item = await until(() => app.engine!.inbox.pending()[0], 'the push')
    script = (req) => {
      if (req.agent.id !== TUESDAY_ID) return [{ text: 'ok' }]
      // the phone turn lists what waits, with ids
      const id = new RegExp(`\\[(${item.id})\\]`).exec(req.prompt)?.[1]
      return id ? [{ tool: { name: 'answer', args: { id, approve: true, user_confirmed: true } } }, { text: 'Enter your PIN to push.' }] : [{ text: 'Nothing to push.' }]
    }
    await pinned()
    const said = (await hook('/voice/heard', { ...call, SpeechResult: 'yes push it' })).xml
    expect(said).toContain('Enter your PIN to push.')
    expect(said).toContain('action="https://phone.test/voice/hardstop"')
    expect(said).toContain('To allow git push, enter your PIN')
    // Tuesday's word alone allowed nothing
    expect(app.engine!.inbox.get(item.id)?.status).toBe('pending')
    const done = (await hook('/voice/hardstop', { ...call, Digits: '2468' })).xml
    expect(done).toContain('Done: git push is allowed.')
    expect(await push).toBe(true)
  })

  it('opens a call it places with what is waiting, and tells Tuesday how it opened', async () => {
    const chat = await app.createChat({ name: 'Builder' })
    void app.engine!.askUser(chat.id, [{ question: 'Which biome?', options: [{ label: 'Desert' }, { label: 'Snow' }] }])
    await until(() => app.engine!.inbox.pending()[0], 'the question')
    const out = { CallSid: 'CA2', From: '+15550001111', To: '+15552223333' }
    const greeted = (await hook('/voice/outbound', out)).xml
    expect(greeted).toContain("Hi, it's Tuesday. Builder asks: Which biome? The options are Desert or Snow. What should I tell it?")
    await hook('/voice/heard', { ...out, SpeechResult: 'snow' })
    const req = seen.find((r) => r.agent.id === TUESDAY_ID)!
    expect(req.prompt).toContain('You called them because something waits on them, and opened with: "Hi, it\'s Tuesday. Builder asks: Which biome?')
    expect(req.prompt).toContain('forge / Builder asks: Which biome?')
  })
})

describe('calling when you are away', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mm-away-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
  })

  it('calls once per waiting question, only when the computer is idle, not too often and not at night', async () => {
    const config = new AppConfig(dir, cipher)
    await config.load()
    await config.setKey('twilio-token', 'tok')
    await config.update({ phone: settings() })
    const twilio = fakeTwilio()
    let clock = new Date(2026, 0, 1, 14, 0).getTime()
    let idle = 0
    const item = (id: string, ts: number): WaitingItem => ({ item: { id, ts, kind: 'question', askedBy: 'c', title: 'Which element?', status: 'pending' }, dir: '/p', project: 'forge', chat: 'Spells' })
    let waiting: WaitingItem[] = [item('q1', clock - 120_000)]
    const phone = new Phone({
      config,
      userDataDir: dir,
      emit: () => undefined,
      waiting: () => waiting,
      idleSeconds: () => idle,
      fetcher: twilio.fetcher,
      publicUrl: fixedUrl,
      now: () => clock,
      tickMs: 3_600_000,
      brain: { greeting: () => 'hi', reply: async () => 'ok', allowHardStop: () => 'done' }
    })
    try {
      expect((await phone.apply()).status).toBe('ready')
      const placed = () => twilio.calls.filter((c) => c.url.endsWith('/Calls.json'))
      idle = 120
      expect(await phone.tick()).toBe(false)
      idle = 11 * 60
      expect(await phone.tick()).toBe(true)
      expect(Object.fromEntries(new URLSearchParams(placed()[0].body))).toMatchObject({ To: '+15552223333', From: '+15550001111', Url: `${BASE}/voice/outbound`, StatusCallback: `${BASE}/voice/status` })
      // not again for the same question
      expect(await phone.tick()).toBe(false)
      // a new one, but the last call was just now
      waiting = [...waiting, item('q2', clock - 90_000)]
      expect(await phone.tick()).toBe(false)
      clock += 6 * 60_000
      expect(await phone.tick()).toBe(true)
      // a question asked moments ago waits a minute first
      clock += 6 * 60_000
      waiting = [item('q3', clock - 5_000)]
      expect(await phone.tick()).toBe(false)
      // never at night
      await config.update({ phone: settings({ quietHours: { enabled: true, from: '00:00', to: '23:59' } }) })
      clock += 60_000
      expect(await phone.tick()).toBe(false)
      expect(placed()).toHaveLength(2)
    } finally {
      await phone.stop()
    }
  })

  it('says what is missing instead of connecting', async () => {
    const config = new AppConfig(dir, cipher)
    await config.load()
    await config.update({ phone: settings({ accountSid: '', myNumber: '' }) })
    const phone = new Phone({ config, userDataDir: dir, emit: () => undefined, waiting: () => [], publicUrl: fixedUrl, brain: { greeting: () => '', reply: async () => '', allowHardStop: () => '' } })
    const st = await phone.apply()
    expect(st).toMatchObject({ status: 'error', detail: 'Missing the Account SID, the auth token, your number.' })
    await phone.stop()
  })
})
