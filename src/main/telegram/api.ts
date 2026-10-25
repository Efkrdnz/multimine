/** The parts of Telegram's Bot API Tuesday uses. Plain HTTPS: no tunnel, no webhook. */

export interface TgUser {
  id: number
  first_name?: string
  username?: string
}

export interface TgMessage {
  message_id: number
  chat: { id: number; type: string }
  from?: TgUser
  date: number
  text?: string
  voice?: { file_id: string; duration: number; mime_type?: string }
  audio?: { file_id: string; duration: number; mime_type?: string }
}

export interface TgCallback {
  id: string
  from: TgUser
  message?: TgMessage
  data?: string
}

export interface TgUpdate {
  update_id: number
  message?: TgMessage
  callback_query?: TgCallback
}

/** A row of buttons under a message: label and the data a tap sends back (at most 64 bytes). */
export type Buttons = { text: string; data: string }[][]

export class TelegramApi {
  constructor(
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly base = 'https://api.telegram.org'
  ) {}

  private async call<T>(method: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const res = await this.fetcher(`${this.base}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal
    }).catch((e: Error & { cause?: { code?: string } }) => {
      if (signal?.aborted) throw e
      throw new Error(`Could not reach Telegram${e.cause?.code ? ` (${e.cause.code})` : ''}. Is this computer online?`)
    })
    const r = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string }
    if (!r.ok) throw new Error(res.status === 401 || res.status === 404 ? 'Telegram did not accept the bot token.' : `Telegram: ${r.description ?? `HTTP ${res.status}`}`)
    return r.result as T
  }

  getMe(): Promise<TgUser> {
    return this.call('getMe')
  }

  /** Waits up to `timeout` seconds for anything new after `offset`. */
  getUpdates(offset: number, timeout: number, signal?: AbortSignal): Promise<TgUpdate[]> {
    return this.call('getUpdates', { offset, timeout, allowed_updates: ['message', 'callback_query'] }, signal)
  }

  sendMessage(chatId: number, text: string, o: { buttons?: Buttons; silent?: boolean } = {}): Promise<TgMessage> {
    return this.call('sendMessage', {
      chat_id: chatId,
      text: text.slice(0, 4096),
      disable_notification: !!o.silent,
      link_preview_options: { is_disabled: true },
      ...(o.buttons ? { reply_markup: { inline_keyboard: o.buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) } } : {})
    })
  }

  /** Changes a message's text, and takes its buttons away. */
  editMessage(chatId: number, messageId: number, text: string): Promise<unknown> {
    return this.call('editMessageText', { chat_id: chatId, message_id: messageId, text: text.slice(0, 4096), reply_markup: { inline_keyboard: [] } })
  }

  deleteMessage(chatId: number, messageId: number): Promise<unknown> {
    return this.call('deleteMessage', { chat_id: chatId, message_id: messageId })
  }

  answerCallback(id: string, text?: string): Promise<unknown> {
    return this.call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) })
  }

  /** "typing…" or "recording a voice message…" for about five seconds. */
  chatAction(chatId: number, action: 'typing' | 'record_voice'): Promise<unknown> {
    return this.call('sendChatAction', { chat_id: chatId, action })
  }

  /** A file someone sent (a voice note), downloaded. */
  async download(fileId: string): Promise<Buffer> {
    const f = await this.call<{ file_path?: string }>('getFile', { file_id: fileId })
    if (!f.file_path) throw new Error('Telegram gave no file to download.')
    const res = await this.fetcher(`${this.base}/file/bot${this.token}/${f.file_path}`)
    if (!res.ok) throw new Error(`Could not download the voice note (HTTP ${res.status}).`)
    return Buffer.from(await res.arrayBuffer())
  }

  /** A voice note (OGG/Opus), with an optional caption. */
  async sendVoice(chatId: number, ogg: Buffer, caption?: string): Promise<TgMessage> {
    const form = new FormData()
    form.append('chat_id', String(chatId))
    if (caption) form.append('caption', caption.slice(0, 1024))
    form.append('voice', new Blob([new Uint8Array(ogg)], { type: 'audio/ogg' }), 'reply.ogg')
    const res = await this.fetcher(`${this.base}/bot${this.token}/sendVoice`, { method: 'POST', body: form })
    const r = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: TgMessage; description?: string }
    if (!r.ok) throw new Error(`Telegram: ${r.description ?? `HTTP ${res.status}`}`)
    return r.result as TgMessage
  }
}
