import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Twilio's signature on a webhook: HMAC-SHA1, keyed with the auth token, over the full URL Twilio
 * requested followed by every POST parameter (sorted by name) as name then value, in base64.
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params)
    .sort()
    .map((k) => k + params[k])
    .join('')
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64')
}

/** Whether a webhook really comes from Twilio (anyone on the internet can reach the tunnel). */
export function validSignature(authToken: string, url: string, params: Record<string, string>, signature: string | undefined): boolean {
  if (!signature || !authToken) return false
  const want = Buffer.from(twilioSignature(authToken, url, params))
  const got = Buffer.from(signature)
  return want.length === got.length && timingSafeEqual(want, got)
}

export interface TwilioAuth {
  accountSid: string
  authToken: string
}

/** The few calls to Twilio's REST API Multimine makes: point the number at the tunnel, and place calls. */
export class TwilioClient {
  constructor(
    private readonly auth: TwilioAuth,
    private readonly fetcher: typeof fetch = fetch,
    private readonly base = 'https://api.twilio.com/2010-04-01'
  ) {}

  private async request<T>(method: 'GET' | 'POST', path: string, form?: Record<string, string>): Promise<T> {
    const res = await this.fetcher(`${this.base}/Accounts/${encodeURIComponent(this.auth.accountSid)}${path}`, {
      method,
      headers: {
        authorization: `Basic ${Buffer.from(`${this.auth.accountSid}:${this.auth.authToken}`).toString('base64')}`,
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {})
      },
      body: form ? new URLSearchParams(form).toString() : undefined
    }).catch((e: Error & { cause?: { code?: string } }) => {
      throw new Error(`Could not reach Twilio${e.cause?.code ? ` (${e.cause.code})` : ''}. Is this computer online?`)
    })
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      const why = typeof body.message === 'string' ? body.message : `HTTP ${res.status}`
      throw new Error(res.status === 401 ? 'Twilio did not accept the Account SID and auth token.' : `Twilio: ${why}`)
    }
    return body as T
  }

  /** The id of one of the account's numbers, by the number itself (+15551234567). */
  async numberSid(phoneNumber: string): Promise<string> {
    const r = await this.request<{ incoming_phone_numbers?: { sid: string }[] }>('GET', `/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(phoneNumber)}`)
    const sid = r.incoming_phone_numbers?.[0]?.sid
    if (!sid) throw new Error(`${phoneNumber} is not a number on this Twilio account.`)
    return sid
  }

  /** Calls to the number go to `url` from now on. */
  async setVoiceUrl(numberSid: string, url: string): Promise<void> {
    await this.request('POST', `/IncomingPhoneNumbers/${encodeURIComponent(numberSid)}.json`, { VoiceUrl: url, VoiceMethod: 'POST' })
  }

  /** Rings `to` from `from`; when it is answered, Twilio asks `url` what to say. Resolves to the call's id. */
  async call(o: { to: string; from: string; url: string; statusCallback?: string; ringSeconds?: number }): Promise<string> {
    const r = await this.request<{ sid: string }>('POST', '/Calls.json', {
      To: o.to,
      From: o.from,
      Url: o.url,
      Method: 'POST',
      Timeout: String(o.ringSeconds ?? 30),
      ...(o.statusCallback ? { StatusCallback: o.statusCallback, StatusCallbackMethod: 'POST' } : {})
    })
    return r.sid
  }
}
