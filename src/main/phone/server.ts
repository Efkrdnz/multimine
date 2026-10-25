import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { validSignature } from './twilio'
import { goodbye, hangup, keypad, listen, pause, redirect, reject, response, say, speakable, type Voice } from './twiml'

/** Tuesday's side of a call. */
export interface PhoneBrain {
  /** The first thing said when a call starts (after the PIN, on a call in). */
  greeting(outbound: boolean): string
  /** One exchange: what the caller said, Tuesday's written reply. */
  reply(heard: string, call: { sid: string; outbound: boolean }): Promise<string>
  /** A hard stop the caller allowed with the PIN: what to say once it is done. */
  allowHardStop(itemId: string, approve: boolean): string
}

export interface PhoneServerOptions {
  authToken: () => string
  pin: () => string
  /** The user's own number: the only one that may call in. */
  userNumber: () => string
  voice: () => Voice
  /** Where Twilio reaches this server (the tunnel); null until it is up. */
  publicBase: () => string | null
  brain: PhoneBrain
  /** A call started or ended. */
  onCall?: (call: { sid: string; outbound: boolean } | null) => void
  /** How long a request waits for Tuesday's reply before Twilio hears "one moment" (Twilio gives up at 15 s). */
  waitMs?: { first: number; next: number }
}

interface Session {
  sid: string
  outbound: boolean
  authed: boolean
  pinTries: number
  silences: number
  waits: number
  turn?: Promise<string>
  turnStarted: number
  /** A hard stop waiting for the PIN on the keypad. */
  hardStop?: { itemId: string; title: string; approve: boolean }
  lastAt: number
  ended: boolean
}

const digitsOf = (n: string) => n.replace(/\D/g, '')
const sleep = (ms: number) => new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))

function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > 64_000) req.destroy()
      else chunks.push(c)
    })
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))))
    req.on('error', reject)
  })
}

/**
 * The webhooks Twilio calls during a phone call, on loopback (the tunnel brings Twilio here). Every
 * request must carry Twilio's signature. Calls in come only from the user's number and need the PIN;
 * calls Multimine places go to the user's number. While Tuesday thinks, Twilio is kept waiting with
 * short pauses and redirects, since it gives up on a webhook after 15 seconds.
 */
export class PhoneServer {
  private server: Server | null = null
  private sessions = new Map<string, Session>()
  port = 0

  constructor(private readonly o: PhoneServerOptions) {}

  async start(): Promise<number> {
    if (this.server) return this.port
    this.server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    this.port = (this.server.address() as AddressInfo).port
    return this.port
  }

  async stop(): Promise<void> {
    const s = this.server
    this.server = null
    if (s) await new Promise((r) => s.close(() => r(undefined)))
    this.sessions.clear()
  }

  /** The call going on now, if any (Tuesday's tools ask, for a hard stop that needs the PIN). */
  activeCall(): { sid: string; outbound: boolean } | null {
    const now = Date.now()
    const s = [...this.sessions.values()].filter((x) => x.authed && !x.ended && now - x.lastAt < 10 * 60_000).sort((a, b) => b.lastAt - a.lastAt)[0]
    return s ? { sid: s.sid, outbound: s.outbound } : null
  }

  /** A hard stop the caller wants allowed: after Tuesday's reply, the keypad takes the PIN. */
  armHardStop(sid: string, itemId: string, title: string, approve: boolean): void {
    const s = this.sessions.get(sid)
    if (s) s.hardStop = { itemId, title, approve }
  }

  private url(path: string): string {
    return `${this.o.publicBase()}${path}`
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (code: number, body: string, type = 'text/xml') => {
      res.writeHead(code, { 'content-type': type }).end(body)
    }
    try {
      const base = this.o.publicBase()
      const path = new URL(req.url ?? '/', 'http://local').pathname
      if (req.method !== 'POST' || !base || !path.startsWith('/voice/')) return send(404, 'not found', 'text/plain')
      const params = await readForm(req)
      // Twilio signs the exact URL it requested: the public address plus the path and query
      if (!validSignature(this.o.authToken(), `${base}${req.url}`, params, req.headers['x-twilio-signature'] as string | undefined)) return send(403, 'bad signature', 'text/plain')
      send(200, await this.route(path, params))
    } catch (e) {
      if (!res.headersSent) send(200, response(say(`Sorry, something went wrong: ${(e as Error).message}`, this.o.voice()), hangup()))
    }
  }

  private session(sid: string, outbound: boolean): Session {
    let s = this.sessions.get(sid)
    if (!s) {
      s = { sid, outbound, authed: false, pinTries: 0, silences: 0, waits: 0, turnStarted: 0, lastAt: Date.now(), ended: false }
      this.sessions.set(sid, s)
      // what is left of calls long over
      for (const [k, x] of this.sessions) if (Date.now() - x.lastAt > 3_600_000) this.sessions.delete(k)
    }
    s.lastAt = Date.now()
    return s
  }

  private async route(path: string, p: Record<string, string>): Promise<string> {
    const v = this.o.voice()
    const sid = p.CallSid ?? ''
    switch (path) {
      case '/voice/incoming': {
        if (!digitsOf(p.From ?? '') || digitsOf(p.From ?? '') !== digitsOf(this.o.userNumber())) return response(reject())
        if (!this.o.pin()) return response(say('Calls in are off until a PIN is set in Multimine.', v), hangup())
        this.session(sid, false)
        return response(keypad(this.url('/voice/pin'), 'Hi. Your PIN, please.', v, this.o.pin().length), say('Goodbye.', v), hangup())
      }
      case '/voice/pin': {
        const s = this.sessions.get(sid)
        if (!s) return response(hangup())
        s.lastAt = Date.now()
        if ((p.Digits ?? '') === this.o.pin()) {
          s.authed = true
          this.o.onCall?.({ sid, outbound: false })
          return response(listen(this.url('/voice/heard'), this.o.brain.greeting(false), v))
        }
        if (++s.pinTries >= 3) {
          s.ended = true
          return response(say('Sorry, that is not it.', v), hangup())
        }
        return response(keypad(this.url('/voice/pin'), 'That is not it. Try again.', v, this.o.pin().length), hangup())
      }
      case '/voice/outbound': {
        const s = this.session(sid, true)
        s.authed = true
        this.o.onCall?.({ sid, outbound: true })
        return response(listen(this.url('/voice/heard'), this.o.brain.greeting(true), v), say('I will leave it in the app. Bye.', v), hangup())
      }
      case '/voice/heard': {
        const s = this.sessions.get(sid)
        if (!s?.authed) return response(hangup())
        s.lastAt = Date.now()
        const heard = (p.SpeechResult ?? '').trim()
        if (!heard) {
          if (++s.silences >= 2) return this.end(s, 'I will let you go. Talk later.')
          return response(listen(this.url('/voice/heard'), 'Are you still there?', v))
        }
        s.silences = 0
        if (goodbye(heard)) return this.end(s, 'Bye.')
        s.turn = this.o.brain.reply(heard, { sid, outbound: s.outbound })
        s.turnStarted = Date.now()
        s.waits = 0
        return this.whenReady(s, this.o.waitMs?.first ?? 6000)
      }
      case '/voice/wait': {
        const s = this.sessions.get(sid)
        if (!s?.authed) return response(hangup())
        s.lastAt = Date.now()
        return this.whenReady(s, this.o.waitMs?.next ?? 9000)
      }
      case '/voice/hardstop': {
        const s = this.sessions.get(sid)
        if (!s?.authed) return response(hangup())
        s.lastAt = Date.now()
        const h = s.hardStop
        s.hardStop = undefined
        if (!h) return response(listen(this.url('/voice/heard'), 'Anything else?', v))
        if ((p.Digits ?? '') !== this.o.pin()) return response(listen(this.url('/voice/heard'), `I left ${h.title} for you to decide in the app. Anything else?`, v))
        return response(listen(this.url('/voice/heard'), `${this.o.brain.allowHardStop(h.itemId, h.approve)} Anything else?`, v))
      }
      case '/voice/status': {
        const s = this.sessions.get(sid)
        if (s && ['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(p.CallStatus ?? '')) this.end(s)
        return response()
      }
    }
    return response(hangup())
  }

  private end(s: Session, words?: string): string {
    const was = !s.ended
    s.ended = true
    if (was) this.o.onCall?.(null)
    return response(words ? say(words, this.o.voice()) : '', hangup())
  }

  /** Tuesday's reply if it comes within `ms`; otherwise a pause, and Twilio asks again. */
  private async whenReady(s: Session, ms: number): Promise<string> {
    const v = this.o.voice()
    if (!s.turn) return response(listen(this.url('/voice/heard'), 'Go ahead.', v))
    const turn = s.turn
    const r = await Promise.race([turn.then((t) => ({ t }), (e: Error) => ({ e })), sleep(ms)])
    if (r !== 'timeout') {
      s.turn = undefined
      const text = 'e' in r ? `Sorry, that went wrong: ${r.e.message}` : speakable(r.t) || 'Done.'
      if (s.hardStop) return response(say(text, v), keypad(this.url('/voice/hardstop'), `To allow ${s.hardStop.title}, enter your PIN, then the pound key.`, v), listen(this.url('/voice/heard'), 'Anything else?', v))
      return response(listen(this.url('/voice/heard'), text, v))
    }
    if (Date.now() - s.turnStarted > 3 * 60_000) {
      s.turn = undefined
      return response(listen(this.url('/voice/heard'), 'This is taking a while. I will keep at it, and the answer will be in the app. Anything else?', v))
    }
    s.waits++
    const words = s.waits === 1 ? say('One moment.', v) : s.waits % 3 === 0 ? say('Still on it.', v) : ''
    return response(words, pause(1), redirect(this.url('/voice/wait')))
  }
}
