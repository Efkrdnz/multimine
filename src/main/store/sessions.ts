import { readdir, rm, cp } from 'node:fs/promises'
import { join } from 'node:path'
import { newId } from '@shared/ids'
import type { BusEvent, ChatMessage, InboxItem, MediaItem, SessionMeta } from '@shared/types'
import type { ProjectPaths } from './paths'
import { appendLine, readJson, readLines, writeJson, writeAtomic } from './fsx'

/**
 * A session is a folder: its meta, one JSONL per agent chat, the bus log, the inbox and the media
 * index. Agents belong to the project; everything they said belongs to a session.
 */
export class SessionStore {
  constructor(private readonly paths: ProjectPaths) {}

  private file(id: string, name: string): string {
    return join(this.paths.session(id), name)
  }

  async list(): Promise<SessionMeta[]> {
    let dirs: string[] = []
    try {
      dirs = await readdir(this.paths.sessions)
    } catch {
      return []
    }
    const metas: SessionMeta[] = []
    for (const d of dirs) {
      const meta = await readJson<SessionMeta | null>(this.file(d, 'session.json'), null)
      if (meta) metas.push(meta)
    }
    return metas.sort((a, b) => b.updated - a.updated)
  }

  async create(name?: string): Promise<SessionMeta> {
    const now = Date.now()
    const meta: SessionMeta = { id: newId('s'), name: name || `Session ${new Date(now).toLocaleString()}`, created: now, updated: now, resume: {} }
    await writeJson(this.file(meta.id, 'session.json'), meta)
    return meta
  }

  async get(id: string): Promise<SessionMeta | null> {
    return readJson<SessionMeta | null>(this.file(id, 'session.json'), null)
  }

  async save(meta: SessionMeta): Promise<void> {
    await writeJson(this.file(meta.id, 'session.json'), meta)
  }

  async rename(id: string, name: string): Promise<SessionMeta | null> {
    const meta = await this.get(id)
    if (!meta) return null
    meta.name = name
    meta.updated = Date.now()
    await this.save(meta)
    return meta
  }

  async remove(id: string): Promise<void> {
    await rm(this.paths.session(id), { recursive: true, force: true })
  }

  /** Copies chats and logs; provider resume ids are dropped so the copy forks rather than shares a thread. */
  async duplicate(id: string): Promise<SessionMeta | null> {
    const src = await this.get(id)
    if (!src) return null
    const copy = await this.create(`${src.name} (copy)`)
    await cp(this.paths.session(id), this.paths.session(copy.id), { recursive: true, force: true })
    await this.save(copy)
    return copy
  }

  async loadChats(id: string, agentIds: string[]): Promise<Record<string, ChatMessage[]>> {
    const out: Record<string, ChatMessage[]> = {}
    for (const a of agentIds) {
      const lines = await readLines<ChatMessage>(this.file(id, join('chats', `${a}.jsonl`)))
      // a message is appended once per final state; the last copy of an id wins
      const byId = new Map<string, ChatMessage>()
      for (const m of lines) byId.set(m.id, m)
      // within one millisecond a reply cannot precede the message it answers, whatever order the lines landed in
      out[a] = [...byId.values()].sort((x, y) => x.ts - y.ts || Number(x.role !== 'user') - Number(y.role !== 'user'))
    }
    return out
  }

  async appendChat(id: string, message: ChatMessage): Promise<void> {
    await appendLine(this.file(id, join('chats', `${message.agentId}.jsonl`)), { ...message, streaming: false })
  }

  async clearChat(id: string, agentId: string): Promise<void> {
    await writeAtomic(this.file(id, join('chats', `${agentId}.jsonl`)), '')
  }

  async appendBus(id: string, event: BusEvent): Promise<void> {
    await appendLine(this.file(id, 'bus.jsonl'), event)
  }

  async loadBus(id: string): Promise<BusEvent[]> {
    return readLines<BusEvent>(this.file(id, 'bus.jsonl'))
  }

  async saveInbox(id: string, items: InboxItem[]): Promise<void> {
    await writeJson(this.file(id, 'inbox.json'), items)
  }

  async loadInbox(id: string): Promise<InboxItem[]> {
    return readJson<InboxItem[]>(this.file(id, 'inbox.json'), [])
  }

  async saveMedia(id: string, items: MediaItem[]): Promise<void> {
    await writeJson(this.file(id, 'media.json'), items)
  }

  async loadMedia(id: string): Promise<MediaItem[]> {
    return readJson<MediaItem[]>(this.file(id, 'media.json'), [])
  }

  async savePlan(id: string, planId: string, md: string): Promise<string> {
    const path = this.file(id, join('plans', `${planId}.md`))
    await writeAtomic(path, md)
    return path
  }
}
