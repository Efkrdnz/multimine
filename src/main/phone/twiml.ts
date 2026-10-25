/** TwiML: what Twilio says, listens for and does next on a call. */

export interface Voice {
  /** A Twilio voice ('Polly.Joanna-Neural'), or empty for Twilio's default in `language`. */
  voice: string
  /** For speech recognition (and the default voice): 'en-US', 'tr-TR'... */
  language: string
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

export const response = (...verbs: string[]) => `<?xml version="1.0" encoding="UTF-8"?><Response>${verbs.join('')}</Response>`

export function say(text: string, v: Voice): string {
  const attrs = v.voice ? ` voice="${esc(v.voice)}"` : ` language="${esc(v.language)}"`
  return text.trim() ? `<Say${attrs}>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</Say>` : ''
}

/** Says `prompt`, then listens for the user's words; what they said (or nothing) goes to `action`. */
export function listen(action: string, prompt: string, v: Voice): string {
  return `<Gather input="speech" action="${esc(action)}" method="POST" speechTimeout="auto" language="${esc(v.language)}" actionOnEmptyResult="true">${say(prompt, v)}</Gather>`
}

/** Says `prompt`, then takes digits from the keypad (a PIN), ended by # or once there are `digits`. */
export function keypad(action: string, prompt: string, v: Voice, digits?: number): string {
  return `<Gather input="dtmf" action="${esc(action)}" method="POST" timeout="10" finishOnKey="#"${digits ? ` numDigits="${digits}"` : ''} actionOnEmptyResult="true">${say(prompt, v)}</Gather>`
}

export const redirect = (url: string) => `<Redirect method="POST">${esc(url)}</Redirect>`
export const pause = (seconds: number) => `<Pause length="${Math.max(1, Math.round(seconds))}"/>`
export const hangup = () => '<Hangup/>'
export const reject = () => '<Reject/>'

/**
 * A written reply as something to say out loud: no markdown, code, links or ids, in a length a
 * caller can follow (the rest is in the app).
 */
export function speakable(text: string, max = 700): string {
  let s = text
    .replace(/```[\s\S]*?```/g, ' (there is code in the app) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/^\s*#+\s*/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/[*_~|>]+/g, '')
    .replace(/\s*\n+\s*/g, '. ')
    .replace(/\.\s*\./g, '.')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (s.length > max) {
    const cut = s.slice(0, max)
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '))
    s = `${end > max / 2 ? cut.slice(0, end + 1) : cut}… The rest is in the app.`
  }
  return s
}

/** Something the caller said that means the call is over. */
export const goodbye = (heard: string) => /^(ok(ay)?[, ]+)?(bye|goodbye|good bye|bye bye|that'?s all|hang up|thanks?,? bye|thank you,? bye|talk later|see you)\W*$/i.test(heard.trim())
