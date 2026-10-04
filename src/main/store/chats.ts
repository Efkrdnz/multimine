import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { parseChat } from '@shared/chat'
import type { AgentSpec, ChatMessage, MediaItem } from '@shared/types'
import type { ProjectPaths } from './paths'
import { appendLine, readJson, readLines, writeAtomic, writeJson } from './fsx'

interface ChatFile extends AgentSpec {
  /** provider -> its own session id (Claude session_id, Codex thread id). */
  resume?: Record<string, string>
}

/**
 * A chat is a folder: `chat.json` (its settings and the provider sessions it resumes) and
 * `messages.jsonl`. The project's media gallery sits beside them, in `.multimine/media/`.
 */
export class ChatStore {
  private resume = new Map<string, Record<string, string>>()

  constructor(private readonly paths: ProjectPaths) {}

  private file(id: string, name: string): string {
    return join(this.paths.chat(id), name)
  }

  /** Every chat, most recently used first. */
  async list(): Promise<AgentSpec[]> {
    let dirs: string[] = []
    try {
      dirs = await readdir(this.paths.chats)
    } catch {
      return []
    }
    const out: AgentSpec[] = []
    for (const d of dirs) {
      const raw = await readJson<ChatFile | null>(this.file(d, 'chat.json'), null)
      if (!raw) continue
      out.push(parseChat(d, raw))
      this.resume.set(d, raw.resume && typeof raw.resume === 'object' ? { ...raw.resume } : {})
    }
    return out.sort((a, b) => b.updated - a.updated)
  }

  async save(chat: AgentSpec): Promise<void> {
    await writeJson(this.file(chat.id, 'chat.json'), { ...chat, resume: this.resume.get(chat.id) ?? {} } satisfies ChatFile)
  }

  async remove(id: string): Promise<void> {
    this.resume.delete(id)
    await rm(this.paths.chat(id), { recursive: true, force: true })
  }

  /** The provider's own session this chat continues, if it has one for that provider. */
  resumeId(id: string, provider: string): string | undefined {
    return this.resume.get(id)?.[provider]
  }

  async setResume(chat: AgentSpec, provider: string, sessionId: string | null): Promise<void> {
    const map = { ...(this.resume.get(chat.id) ?? {}) }
    if (sessionId) map[provider] = sessionId
    else delete map[provider]
    this.resume.set(chat.id, map)
    await this.save(chat)
  }

  /** Forgets every provider session: the next turn starts a new conversation. */
  async forget(chat: AgentSpec): Promise<void> {
    this.resume.set(chat.id, {})
    await this.save(chat)
  }

  async loadMessages(id: string): Promise<ChatMessage[]> {
    const lines = await readLines<ChatMessage>(this.file(id, 'messages.jsonl'))
    // a message is appended once per final state; the last copy of an id wins
    const byId = new Map<string, ChatMessage>()
    for (const m of lines) byId.set(m.id, m)
    // within one millisecond a reply cannot precede the message it answers, whatever order the lines landed in
    return [...byId.values()].sort((x, y) => x.ts - y.ts || Number(x.role !== 'user') - Number(y.role !== 'user'))
  }

  async appendMessage(message: ChatMessage): Promise<void> {
    await appendLine(this.file(message.agentId, 'messages.jsonl'), { ...message, streaming: false })
  }

  async clearMessages(id: string): Promise<void> {
    await writeAtomic(this.file(id, 'messages.jsonl'), '')
  }

  async loadMedia(): Promise<MediaItem[]> {
    return readJson<MediaItem[]>(this.paths.mediaIndex, [])
  }

  async saveMedia(items: MediaItem[]): Promise<void> {
    await writeJson(this.paths.mediaIndex, items)
  }
}
