import { encodeOggOpus } from './ogg'

/**
 * Voice notes to text, with whichever key the user has, or the one they picked: Groq (Whisper; a
 * free tier), OpenAI, or Google (Gemini; a free tier). And text to a voice note, with Gemini or
 * OpenAI.
 */

export type SpeechKey = 'groq' | 'openai' | 'google'
export type KeyOf = (provider: SpeechKey) => string | undefined

/** Which service turns voice notes into text: the one picked if it has a key, else the first that does. */
export function transcriber(key: KeyOf, prefer?: SpeechKey | 'auto'): SpeechKey | null {
  if (prefer && prefer !== 'auto' && key(prefer)) return prefer
  return key('groq') ? 'groq' : key('openai') ? 'openai' : key('google') ? 'google' : null
}

/** Which service speaks replies: the one picked if it can (Groq cannot), else OpenAI, else Gemini. */
export function voicer(key: KeyOf, prefer?: SpeechKey | 'auto'): 'openai' | 'google' | null {
  if ((prefer === 'openai' || prefer === 'google') && key(prefer)) return prefer
  return key('openai') ? 'openai' : key('google') ? 'google' : null
}

async function whisper(url: string, key: string, model: string, ogg: Buffer, language: string | undefined, fetcher: typeof fetch): Promise<string> {
  const form = new FormData()
  form.append('model', model)
  if (language) form.append('language', language)
  form.append('file', new Blob([new Uint8Array(ogg)], { type: 'audio/ogg' }), 'voice.ogg')
  const res = await fetcher(url, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form })
  const r = (await res.json().catch(() => ({}))) as { text?: string; error?: { message?: string } }
  if (!res.ok) throw new Error(r.error?.message ?? `HTTP ${res.status}`)
  return (r.text ?? '').trim()
}

/** Gemini models that listen to audio, in order: the first one the key can use is kept. */
const GEMINI_LISTEN = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.0-flash']
let geminiListen: string | null = null

/** What a voice note says. `language` is a two-letter hint ('en', 'tr'), or none to detect it. */
export async function transcribe(ogg: Buffer, key: KeyOf, language?: string, fetcher: typeof fetch = fetch, prefer?: SpeechKey | 'auto'): Promise<string> {
  const which = transcriber(key, prefer)
  if (which === 'groq') return whisper('https://api.groq.com/openai/v1/audio/transcriptions', key('groq')!, 'whisper-large-v3-turbo', ogg, language, fetcher)
  if (which === 'openai') return whisper('https://api.openai.com/v1/audio/transcriptions', key('openai')!, 'gpt-4o-mini-transcribe', ogg, language, fetcher)
  if (which === 'google') {
    let last = ''
    for (const model of geminiListen ? [geminiListen] : GEMINI_LISTEN) {
      const res = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key('google')!)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ inline_data: { mime_type: 'audio/ogg', data: ogg.toString('base64') } }, { text: 'Transcribe this voice message exactly, in its own language. Reply with the words only.' }] }]
        })
      })
      const r = (await res.json().catch(() => ({}))) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; error?: { message?: string } }
      if (res.status === 404) {
        last = r.error?.message ?? 'HTTP 404'
        continue
      }
      if (!res.ok) throw new Error(r.error?.message ?? `HTTP ${res.status}`)
      geminiListen = model
      return (r.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim()
    }
    throw new Error(`No Gemini model answered (${last}).`)
  }
  throw new Error('No key to understand voice notes with.')
}

/** Gemini's speech models, newest first: the first one the key can use is kept. */
const GEMINI_TTS = ['gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts', 'gemini-2.5-flash-tts']
let geminiTts: string | null = null

async function speakGemini(text: string, key: string, fetcher: typeof fetch): Promise<Buffer> {
  let last = ''
  for (const model of geminiTts ? [geminiTts] : GEMINI_TTS) {
    const res = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: text.slice(0, 4000) }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } } }
      })
    })
    const r = (await res.json().catch(() => ({}))) as { candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[]; error?: { message?: string } }
    if (res.status === 404 || (res.status === 400 && /not found|not supported/i.test(r.error?.message ?? ''))) {
      last = r.error?.message ?? `HTTP ${res.status}`
      continue
    }
    if (!res.ok) throw new Error(r.error?.message ?? `HTTP ${res.status}`)
    const audio = r.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData
    if (!audio?.data) throw new Error('Gemini sent no audio.')
    geminiTts = model
    // raw 16-bit mono PCM; the rate is in the type ("audio/L16;codec=pcm;rate=24000")
    const rate = Number(/rate=(\d+)/.exec(audio.mimeType ?? '')?.[1] ?? 24000)
    return encodeOggOpus(Buffer.from(audio.data, 'base64'), rate)
  }
  throw new Error(`No Gemini speech model answered (${last}).`)
}

/** A reply as a voice note (OGG/Opus, what Telegram plays as one), with Gemini or OpenAI. */
export async function speak(text: string, key: KeyOf, fetcher: typeof fetch = fetch, prefer?: SpeechKey | 'auto'): Promise<Buffer> {
  const which = voicer(key, prefer)
  if (which === 'google') return speakGemini(text, key('google')!, fetcher)
  if (which !== 'openai') throw new Error('No key to speak with: add a Gemini or OpenAI key.')
  const openaiKey = key('openai')!
  const res = await fetcher('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { authorization: `Bearer ${openaiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'nova', input: text.slice(0, 4000), response_format: 'opus' })
  })
  if (!res.ok) {
    const r = (await res.json().catch(() => ({}))) as { error?: { message?: string } }
    throw new Error(r.error?.message ?? `HTTP ${res.status}`)
  }
  return Buffer.from(await res.arrayBuffer())
}
