/**
 * Voice notes to text, with whichever key the user has: Groq (Whisper; a free tier), OpenAI, or
 * Google (Gemini; a free tier). And text to a voice note, with an OpenAI key.
 */

export type KeyOf = (provider: 'groq' | 'openai' | 'google') => string | undefined

/** Which service turns voice notes into text, if any. */
export function transcriber(key: KeyOf): 'groq' | 'openai' | 'google' | null {
  return key('groq') ? 'groq' : key('openai') ? 'openai' : key('google') ? 'google' : null
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

/** What a voice note says. `language` is a two-letter hint ('en', 'tr'), or none to detect it. */
export async function transcribe(ogg: Buffer, key: KeyOf, language?: string, fetcher: typeof fetch = fetch): Promise<string> {
  const which = transcriber(key)
  if (which === 'groq') return whisper('https://api.groq.com/openai/v1/audio/transcriptions', key('groq')!, 'whisper-large-v3-turbo', ogg, language, fetcher)
  if (which === 'openai') return whisper('https://api.openai.com/v1/audio/transcriptions', key('openai')!, 'gpt-4o-mini-transcribe', ogg, language, fetcher)
  if (which === 'google') {
    const res = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${encodeURIComponent(key('google')!)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ inline_data: { mime_type: 'audio/ogg', data: ogg.toString('base64') } }, { text: 'Transcribe this voice message exactly, in its own language. Reply with the words only.' }] }]
      })
    })
    const r = (await res.json().catch(() => ({}))) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; error?: { message?: string } }
    if (!res.ok) throw new Error(r.error?.message ?? `HTTP ${res.status}`)
    return (r.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim()
  }
  throw new Error('No key to understand voice notes with.')
}

/** A reply as a voice note (OGG/Opus, what Telegram plays as one), with an OpenAI key. */
export async function speak(text: string, openaiKey: string, fetcher: typeof fetch = fetch): Promise<Buffer> {
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
