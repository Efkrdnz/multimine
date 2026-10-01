import { readdir, readFile } from 'node:fs/promises'
import { join, relative, basename } from 'node:path'
import type { Api } from '@shared/api'
import { MASTERMIND_ID, type AgentSpec, type AppSettings, type MainEvent, type McpServerConfig, type ProviderKind } from '@shared/types'
import { AppConfig, type Cipher } from './store/appConfig'
import { ProjectStore } from './store/project'
import { SessionStore } from './store/sessions'
import { ProviderRegistry } from './providers/registry'
import { listVendorModels } from './providers/aiSdk'
import { detectClaude, detectCodex } from './providers/detect'
import type { MockScript } from './providers/mock'
import { Engine } from './orchestrator/engine'
import { BusServer } from './mcp/busServer'
import { McpHub } from './mcp/hub'

export interface AppOptions {
  userDataDir: string
  cipher: Cipher
  emit: (e: MainEvent) => void
  mockScript?: MockScript
  mockDelayMs?: number
  /** Skip CLI detection when choosing Mastermind's provider (tests). */
  forceMockMastermind?: boolean
}

/** The main-process side of the API: owns settings, the open project, the engine and the bus server. */
export class MultimineApp implements Omit<Api, 'pickProject' | 'openPath' | 'mediaUrl'> {
  readonly config: AppConfig
  readonly hub = new McpHub()
  readonly providers: ProviderRegistry
  project: ProjectStore | null = null
  engine: Engine | null = null
  private bus: BusServer

  constructor(private readonly o: AppOptions) {
    this.config = new AppConfig(o.userDataDir, o.cipher)
    this.providers = new ProviderRegistry(o.mockScript, o.mockDelayMs)
    this.bus = new BusServer((agentId) => {
      const agent = this.project?.get(agentId)
      return agent && this.engine ? this.engine.coordinationTools(agent) : null
    })
  }

  async start(): Promise<void> {
    await this.config.load()
    await this.bus.start()
  }

  async shutdown(): Promise<void> {
    this.engine?.inbox?.cancelAll('Multimine closed.')
    await this.hub.closeAll()
    await this.bus.stop()
  }

  private emitProject(): void {
    this.o.emit({ type: 'project', project: this.project?.info() ?? null })
  }

  private need(): { project: ProjectStore; engine: Engine } {
    if (!this.project || !this.engine) throw new Error('No project is open')
    return { project: this.project, engine: this.engine }
  }

  async init() {
    return { settings: this.config.settings, keyed: this.config.keyedProviders(), project: this.project?.info() ?? null }
  }

  async openProject(dir: string): Promise<void> {
    let defaults: Partial<AgentSpec> = {}
    if (!this.o.forceMockMastermind) {
      const claude = await detectClaude(this.config.settings.claudePath)
      if (claude.installed) defaults = { provider: 'claude-cli', model: 'claude-opus-5-5', effort: 'high' }
    }
    const project = await ProjectStore.open(dir, defaults)
    const sessions = new SessionStore(project.paths)
    this.engine?.inbox?.cancelAll('Another project was opened.')
    this.project = project
    this.engine = new Engine({
      project,
      sessions,
      config: this.config,
      providers: this.providers,
      emit: this.o.emit,
      hub: this.hub,
      busUrl: (id) => this.bus.url(id)
    })
    this.emitProject()
    await this.engine.open()
    await this.config.addRecent(dir)
    this.o.emit({ type: 'settings', settings: this.config.settings })
  }

  async closeProject(): Promise<void> {
    this.engine?.inbox?.cancelAll('The project was closed.')
    this.project = null
    this.engine = null
    this.emitProject()
  }

  async saveMultimineMd(text: string): Promise<void> {
    await this.need().project.saveMultimineMd(text)
    this.emitProject()
  }

  async saveAgent(agent: AgentSpec, isNew: boolean): Promise<AgentSpec> {
    const { project, engine } = this.need()
    if (isNew) return engine.createAgent(agent, 'user')
    if (!project.get(agent.id)) throw new Error(`No agent ${agent.id}`)
    const saved = await project.saveAgent(agent.id === MASTERMIND_ID ? { ...agent, role: 'mastermind', gated: false } : agent)
    this.emitProject()
    return saved
  }

  async deleteAgent(id: string): Promise<void> {
    await this.need().project.deleteAgent(id)
    this.emitProject()
  }

  async setPosition(id: string, x: number, y: number): Promise<void> {
    await this.need().project.setPosition(id, x, y)
  }

  async send(agentId: string, text: string): Promise<void> {
    const { engine } = this.need()
    void engine.send(agentId, text, 'user').then((r) => {
      if (r.error && r.error !== 'Stopped.') this.o.emit({ type: 'toast', level: 'error', text: `${this.project?.get(agentId)?.name ?? agentId}: ${r.error.slice(0, 300)}` })
    })
  }

  async retry(agentId: string): Promise<void> {
    const { engine } = this.need()
    void engine.retry(agentId)?.then((r) => {
      if (r.error && r.error !== 'Stopped.') this.o.emit({ type: 'toast', level: 'error', text: `${this.project?.get(agentId)?.name ?? agentId}: ${r.error.slice(0, 300)}` })
    })
  }

  async stop(agentId: string): Promise<void> {
    this.engine?.stop(agentId)
  }

  async clearChat(agentId: string): Promise<void> {
    const { engine } = this.need()
    const sessions = new SessionStore(this.project!.paths)
    await sessions.clearChat(engine.session.id, agentId)
    delete engine.session.resume[agentId]
    await sessions.save(engine.session)
    engine.chats[agentId] = []
    this.o.emit({ type: 'chat-reset', chats: engine.chats })
  }

  async newSession(name?: string): Promise<void> {
    await this.need().engine.newSession(name)
  }

  async switchSession(id: string): Promise<void> {
    await this.need().engine.switchSession(id)
  }

  async renameSession(id: string, name: string): Promise<void> {
    const sessions = new SessionStore(this.need().project.paths)
    const meta = await sessions.rename(id, name)
    if (meta && this.engine!.session.id === id) this.engine!.session.name = name
    await this.engine!.emitSessions()
  }

  async deleteSession(id: string): Promise<void> {
    const { engine, project } = this.need()
    const sessions = new SessionStore(project.paths)
    await sessions.remove(id)
    if (engine.session.id === id) await engine.open()
    else await engine.emitSessions()
  }

  async duplicateSession(id: string): Promise<void> {
    const { engine, project } = this.need()
    const copy = await new SessionStore(project.paths).duplicate(id)
    if (copy) await engine.switchSession(copy.id)
  }

  async answer(id: string, answers: Record<string, string>, note?: string): Promise<void> {
    this.need().engine.inbox.answer(id, answers, note)
  }

  async decide(id: string, approved: boolean, note?: string): Promise<void> {
    this.need().engine.inbox.decide(id, approved, note)
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const before = this.config.settings.mcpServers
    const settings = await this.config.update(patch)
    if (patch.mcpServers) for (const s of before) await this.hub.drop(s.id)
    this.o.emit({ type: 'settings', settings })
    return settings
  }

  async setKey(provider: string, key: string | null): Promise<string[]> {
    await this.config.setKey(provider, key)
    return this.config.keyedProviders()
  }

  async detectClis() {
    const [claude, codex] = await Promise.all([detectClaude(this.config.settings.claudePath), detectCodex(this.config.settings.codexPath)])
    return { claude, codex }
  }

  async refreshModels(provider: ProviderKind) {
    const list = await listVendorModels(provider, this.config.getKey(provider), this.config.settings.baseUrls[provider])
    await this.updateSettings({ catalog: { ...this.config.settings.catalog, [provider]: list } })
    return list
  }

  async testMcp(server: McpServerConfig) {
    try {
      const tools = await this.hub.test(server)
      return { ok: true, tools: tools.map((t) => t.name) }
    } catch (e) {
      return { ok: false, tools: [], error: (e as Error).message }
    }
  }

  async contextFiles(): Promise<{ file: string; text: string }[]> {
    const { project } = this.need()
    const out: { file: string; text: string }[] = []
    const walk = async (dir: string) => {
      for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const full = join(dir, e.name)
        if (e.isDirectory()) await walk(full)
        else if (e.name.endsWith('.md')) out.push({ file: relative(project.paths.context, full).split('\\').join('/'), text: await readFile(full, 'utf8') })
      }
    }
    await walk(project.paths.context)
    return out.sort((a, b) => (a.file === 'index.md' ? -1 : b.file === 'index.md' ? 1 : a.file.localeCompare(b.file)))
  }

  projectName(): string {
    return this.project ? basename(this.project.dir) : ''
  }
}
