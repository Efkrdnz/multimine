import { basename } from 'node:path'
import { newChat, providerLocked } from '@shared/chat'
import type { AgentSpec, AgentStatus, ChatMessage, InboxItem, MainEvent } from '@shared/types'
import { Engine, type TurnResult } from '../chat/engine'
import { ChatStore } from '../store/chats'
import { ProjectStore } from '../store/project'
import type { AppConfig } from '../store/appConfig'
import type { ProviderRegistry } from '../providers/registry'
import type { ProviderHealth } from '../providers/limits'
import type { PlanLimits } from '../providers/planLimits'
import type { McpHub } from '../mcp/hub'
import type { ToolDef } from '../providers/types'
import { snapshot, tuesdaySystem, type SnapshotProject } from './prompt'
import { tuesdayTools, type TuesdayHost } from './tools'
import { phoneRule } from '../phone/talk'
import { telegramRule } from '../telegram/text'
import type { WaitingItem } from '@shared/types'

/** Tuesday's chat id: one conversation, app-wide. */
export const TUESDAY_ID = 'tuesday'

export interface TuesdayDeps {
  /** Where its conversation is kept: under the user-data folder, never in a project. */
  dir: string
  config: AppConfig
  providers: ProviderRegistry
  health: ProviderHealth
  planLimits: PlanLimits
  hub: McpHub
  busUrl: (chatId: string) => string | undefined
  emit: (e: MainEvent) => void
  host: TuesdayHost
  /** Tuesday's own questions and approvals changed (a paid fallback, a loop-guard pause). */
  inboxChanged: () => void
  /** Everything waiting on the user (a phone turn is told about it, to save a tool call). */
  waiting: () => WaitingItem[]
}

/**
 * Tuesday: the assistant above every chat in every open project. Its conversation runs on an
 * engine of its own (so it streams, falls back and keeps its history like any chat), with its own
 * system prompt and tools, and each of the user's messages carries a short look at the workspace.
 */
export class Tuesday {
  engine: Engine | null = null
  private project: ProjectStore | null = null
  private status: { status: AgentStatus; activity?: string; detail?: string } = { status: 'idle' }
  /** Said once with the next phone turn: how a call Tuesday placed opened. */
  private phoneNote: string | null = null
  /** The next Telegram turn came as a voice note. */
  private voiceNote = false
  /** Where the turn running now came from: a hard stop it passes on waits for the PIN there. */
  currentVia: 'phone' | 'telegram' | null = null

  constructor(private readonly d: TuesdayDeps) {}

  /** The chat Tuesday runs as, from its settings; any provider, model or effort left out follow the new-chat defaults. */
  spec(before?: AgentSpec): AgentSpec {
    const t = this.d.config.settings.tuesday
    const defaults = this.d.config.settings.chatDefaults
    const base = before ?? newChat(TUESDAY_ID, defaults)
    return {
      ...base,
      id: TUESDAY_ID,
      name: t.name.trim() || 'Tuesday',
      provider: t.provider ?? defaults.provider,
      model: t.model ?? (t.provider && t.provider !== defaults.provider ? '' : defaults.model),
      effort: t.effort ?? defaults.effort,
      // it works through its tools, never on files
      permissions: 'chat',
      autoApprove: false,
      planMode: false,
      coop: false,
      mcp: []
    }
  }

  async start(): Promise<void> {
    if (this.engine) return
    const project = await ProjectStore.open(this.d.dir)
    const store = new ChatStore(project.paths)
    const saved = (await store.list()).find((c) => c.id === TUESDAY_ID)
    await store.save(this.spec(saved))
    this.project = project
    this.engine = new Engine({
      project,
      store,
      config: this.d.config,
      providers: this.d.providers,
      health: this.d.health,
      planLimits: this.d.planLimits,
      hub: this.d.hub,
      busUrl: this.d.busUrl,
      checkpoints: false,
      emit: (e) => this.relay(e),
      tools: () => this.tools(),
      system: (agent) => tuesdaySystem(agent.name),
      decorate: (_id, prompt, msg) => {
        this.currentVia = msg.via ?? null
        if (msg.via === 'telegram') {
          const voice = this.voiceNote
          this.voiceNote = false
          return [this.snapshot(), telegramRule(this.d.waiting(), voice), prompt].join('\n\n')
        }
        if (msg.via !== 'phone') return `${this.snapshot()}\n\n${prompt}`
        const note = this.phoneNote
        this.phoneNote = null
        return [this.snapshot(), phoneRule(this.d.waiting()), note ?? '', prompt].filter(Boolean).join('\n\n')
      }
    })
    await this.engine.open()
  }

  async stop(): Promise<void> {
    await this.engine?.close('Multimine closed.')
    this.d.providers.release(`${TUESDAY_ID}|`)
  }

  tools(): ToolDef[] {
    return tuesdayTools(this.d.host)
  }

  /** The open projects as the snapshot shows them. */
  snapshot(now = Date.now()): string {
    const cur = this.d.host.current()
    const projects: SnapshotProject[] = this.d.host.spaces().map((ws) => ({
      name: basename(ws.dir),
      current: ws === cur,
      focused: ws === cur && ws.activeChat ? ws.project.get(ws.activeChat)?.name : undefined,
      game: ws.runner.state.status === 'running' ? 'running' : undefined,
      waiting: ws.engine.inbox.pending().length,
      chats: ws.project.list().map((chat) => ({ chat, ...ws.engine.activityOf(chat.id) }))
    }))
    return snapshot(projects, now)
  }

  /** Its engine's events, as the window knows Tuesday's: its messages and status; the rest is its own business. */
  private relay(e: MainEvent): void {
    switch (e.type) {
      case 'chat-upsert':
        if (e.message.agentId === TUESDAY_ID) this.d.emit({ type: 'tuesday-upsert', message: e.message })
        break
      case 'chat-reset':
        this.d.emit({ type: 'tuesday-reset', messages: e.chats[TUESDAY_ID] ?? [] })
        break
      case 'status':
        this.status = { status: e.status, activity: e.activity, detail: e.detail }
        this.d.emit({ type: 'tuesday-status', ...this.status })
        break
      case 'inbox':
        this.d.inboxChanged()
        break
      case 'toast':
        this.d.emit({ ...e, text: `${this.spec().name}: ${e.text}` })
        break
    }
  }

  /** What the panel opens on. */
  state(): { messages: ChatMessage[]; status: AgentStatus; activity?: string; detail?: string; spec: AgentSpec } {
    const chat = this.project?.get(TUESDAY_ID)
    return { messages: this.engine?.chats[TUESDAY_ID] ?? [], ...this.status, spec: chat ?? this.spec() }
  }

  /** Its own pending questions and approvals. */
  pending(): InboxItem[] {
    return this.engine?.inbox.pending() ?? []
  }

  async send(text: string): Promise<TurnResult> {
    if (!this.engine) throw new Error(`${this.spec().name} is not running.`)
    // a provider change it could not take mid-reply is taken now
    if (!this.engine.busy(TUESDAY_ID)) await this.applySettings().catch(() => undefined)
    return this.engine.send(TUESDAY_ID, text, 'user')
  }

  /** What the caller said on the phone; `note` (once) tells Tuesday how a call it placed opened. */
  async sendPhone(text: string, note?: string): Promise<TurnResult> {
    if (!this.engine) throw new Error(`${this.spec().name} is not running.`)
    if (note) this.phoneNote = note
    return this.engine.send(TUESDAY_ID, text, 'user', { via: 'phone' })
  }

  /** What the user wrote (or said in a voice note) on Telegram. */
  async sendTelegram(text: string, voice = false): Promise<TurnResult> {
    if (!this.engine) throw new Error(`${this.spec().name} is not running.`)
    if (voice) this.voiceNote = true
    return this.engine.send(TUESDAY_ID, text, 'user', { via: 'telegram' })
  }

  stopTurn(): void {
    this.engine?.stop(TUESDAY_ID)
  }

  /** A new conversation: the messages stay on screen, Tuesday starts clean with a short recap. */
  freshStart(): Promise<boolean> {
    return this.engine?.freshStart(TUESDAY_ID) ?? Promise.resolve(false)
  }

  clear(): Promise<void> {
    return this.engine?.clearChat(TUESDAY_ID) ?? Promise.resolve()
  }

  /**
   * Its settings changed. Another provider means another conversation (each lives in its
   * provider's session): a fresh start first, so the switch goes through.
   */
  async applySettings(): Promise<void> {
    const engine = this.engine
    const before = this.project?.get(TUESDAY_ID)
    if (!engine || !before) return
    const next = this.spec(before)
    if (JSON.stringify(next) === JSON.stringify(before)) return
    if (next.provider !== before.provider && providerLocked(engine.chats[TUESDAY_ID] ?? [])) {
      // mid-reply it keeps its provider; the next message picks the change up
      if (engine.busy(TUESDAY_ID)) return
      await engine.freshStart(TUESDAY_ID)
    }
    await engine.saveChat(next)
  }
}
