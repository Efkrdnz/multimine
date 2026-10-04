import { join, basename } from 'node:path'
import type { Api } from '@shared/api'
import type { AgentSpec, AppSettings, MainEvent, McpServerConfig, PlanWindow, ProviderKind } from '@shared/types'
import { AppConfig, type Cipher } from './store/appConfig'
import { ProjectStore } from './store/project'
import { ChatStore } from './store/chats'
import { ProviderRegistry } from './providers/registry'
import { listVendorModels } from './providers/aiSdk'
import { detectClaude, detectCodex } from './providers/detect'
import type { MockScript } from './providers/mock'
import type { ProviderAdapter } from './providers/types'
import { Engine } from './chat/engine'
import { BusServer } from './mcp/busServer'
import { McpHub } from './mcp/hub'
import { ProviderHealth } from './providers/limits'
import { PlanLimits } from './providers/planLimits'
import { PluginRegistry, pluginMcpServer } from './plugins/registry'
import { callPlugin, type PluginContext } from './plugins/api'
import type { PluginPermission } from '@shared/types'
import { Git, GitHub, githubRepo } from './git/git'
import { ProjectFiles, list as listDir } from './ide/fs'
import { Terminals, shellQuote } from './ide/terminals'
import { ProjectWatcher } from './ide/watcher'
import { readJson, writeJson } from './store/fsx'
import type { TerminalKind } from '@shared/types'

export interface AppOptions {
  userDataDir: string
  cipher: Cipher
  emit: (e: MainEvent) => void
  mockScript?: MockScript
  mockDelayMs?: number
  /** Stand-in adapters for real providers (tests). */
  providerOverrides?: Partial<Record<ProviderKind, ProviderAdapter>>
  /** Skip CLI detection when choosing what a first chat runs on (tests). */
  skipDetect?: boolean
}

/** The main-process side of the API: owns settings, the open project, the engine and the bus server. */
export class MultimineApp implements Omit<Api, 'pickProject' | 'openPath' | 'mediaUrl' | 'ideOpenExternal' | 'pluginPickAndInstall' | 'testNotification'> {
  readonly config: AppConfig
  readonly hub = new McpHub()
  /** Which providers are out of usage right now: app-wide, so it survives switching projects. */
  readonly health: ProviderHealth
  readonly planLimits: PlanLimits
  readonly providers: ProviderRegistry
  project: ProjectStore | null = null
  engine: Engine | null = null
  private bus: BusServer
  readonly terminals: Terminals
  readonly plugins: PluginRegistry
  private pluginCtx: PluginContext
  private watcher: ProjectWatcher | null = null
  private files: ProjectFiles | null = null
  /** The chat on screen: where a tool's 'active' messages go. */
  private activeChat: string | null = null

  constructor(private readonly o: AppOptions) {
    this.config = new AppConfig(o.userDataDir, o.cipher)
    this.providers = new ProviderRegistry(o.mockScript, o.mockDelayMs, o.providerOverrides)
    this.bus = new BusServer((chatId) => {
      const chat = this.project?.get(chatId)
      if (!chat || !this.engine) return null
      return { tools: this.engine.coordinationTools(chat) }
    })
    this.terminals = new Terminals(o.emit)
    this.health = new ProviderHealth((h) => o.emit({ type: 'provider-health', health: h }))
    this.planLimits = new PlanLimits((windows, warning) => {
      o.emit({ type: 'plan-limits', windows, warning })
      if (warning) o.emit({ type: 'toast', level: 'error', text: warning })
      void writeJson(join(o.userDataDir, 'plan-limits.json'), windows).catch(() => undefined)
    })
    this.plugins = new PluginRegistry(
      join(o.userDataDir, 'plugins'),
      () => this.config.settings.plugins ?? {},
      async (plugins) => {
        await this.config.update({ plugins })
      }
    )
    this.pluginCtx = {
      projectDir: () => this.project?.dir ?? null,
      projectName: () => (this.project ? basename(this.project.dir) : null),
      chats: () => this.project?.list() ?? [],
      activeChat: () => this.activeChat,
      busy: (id) => this.engine?.busy(id) ?? false,
      send: async (_pluginId, name, to, text, opts) => {
        if (!this.engine) throw new Error('No project is open')
        return this.engine.fromTool(name, to, text, this.activeChat ?? undefined, opts)
      },
      addMedia: async (item) => {
        await this.engine?.addMedia(item)
      },
      media: () => this.engine?.media ?? [],
      emit: o.emit,
      storageDir: join(o.userDataDir, 'plugin-data')
    }
  }

  async start(): Promise<void> {
    await this.config.load()
    const saved = await readJson<PlanWindow[]>(join(this.o.userDataDir, 'plan-limits.json'), [])
    if (Array.isArray(saved)) this.planLimits.restore(saved)
    await this.bus.start()
  }

  async shutdown(): Promise<void> {
    this.providers.release()
    this.terminals.closeAll()
    await this.watcher?.stop()
    await this.engine?.close('Multimine closed.')
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
    return { settings: this.config.settings, keyed: this.config.keyedProviders(), project: this.project?.info() ?? null, planLimits: this.planLimits.list() }
  }

  async openProject(dir: string): Promise<void> {
    const project = await ProjectStore.open(dir)
    await this.detectDefaults()
    await this.engine?.close('Another project was opened.')
    this.providers.release()
    this.project = project
    this.activeChat = null
    this.engine = new Engine({
      health: this.health,
      planLimits: this.planLimits,
      project,
      store: new ChatStore(project.paths),
      config: this.config,
      providers: this.providers,
      emit: this.o.emit,
      hub: this.hub,
      busUrl: (id) => this.bus.url(id)
    })
    await this.engine.open()
    await this.startWatching(project.dir)
    await this.pluginsChanged()
    await this.config.addRecent(dir)
    this.o.emit({ type: 'settings', settings: this.config.settings })
  }

  /**
   * The first time Multimine runs, new chats start on the Claude Code login if there is one; the
   * offline stand-in otherwise. Settings -> General changes it from then on.
   */
  private async detectDefaults(): Promise<void> {
    if (this.config.settings.chatDefaults.provider !== 'mock' || this.config.settings.chatDefaultsChosen || this.o.skipDetect) return
    const claude = await detectClaude(this.config.settings.claudePath)
    if (claude.installed) await this.config.update({ chatDefaults: { ...this.config.settings.chatDefaults, provider: 'claude-cli', model: 'claude-opus-5-5', effort: 'high' } })
  }

  async closeProject(): Promise<void> {
    this.terminals.closeAll()
    await this.watcher?.stop()
    this.watcher = null
    await this.engine?.close('The project was closed.')
    this.providers.release()
    this.project = null
    this.engine = null
    this.activeChat = null
    this.emitProject()
  }

  async saveMultimineMd(text: string): Promise<void> {
    await this.need().project.saveMultimineMd(text)
    this.emitProject()
  }

  async createChat(patch?: Partial<AgentSpec>): Promise<AgentSpec> {
    const chat = await this.need().engine.createChat(patch ?? {})
    this.activeChat = chat.id
    return chat
  }

  async saveChat(chat: AgentSpec): Promise<AgentSpec> {
    return this.need().engine.saveChat(chat)
  }

  async deleteChat(id: string): Promise<void> {
    await this.need().engine.deleteChat(id)
    if (this.activeChat === id) this.activeChat = null
  }

  async setActiveChat(id: string | null): Promise<void> {
    this.activeChat = id
  }

  async send(agentId: string, text: string, opts?: { quick?: boolean }): Promise<void> {
    const { engine } = this.need()
    void engine
      .send(agentId, text, 'user', { quick: !!opts?.quick })
      .then((r) => this.reportError(agentId, r.error))
      .catch((e) => this.reportError(agentId, String((e as Error).message ?? e)))
  }

  async retry(agentId: string): Promise<void> {
    const { engine } = this.need()
    void engine
      .retry(agentId)
      ?.then((r) => this.reportError(agentId, r.error))
      .catch((e) => this.reportError(agentId, String((e as Error).message ?? e)))
  }

  /** A turn that ended on an error says so in a toast too, unless the user stopped it. */
  private reportError(agentId: string, error?: string): void {
    if (error && error !== 'Stopped.') this.o.emit({ type: 'toast', level: 'error', text: `${this.project?.get(agentId)?.name ?? agentId}: ${error.slice(0, 300)}` })
  }

  async stop(agentId: string): Promise<void> {
    this.engine?.stop(agentId)
  }

  async freshStart(agentId: string): Promise<boolean> {
    return this.need().engine.freshStart(agentId)
  }

  async clearChat(agentId: string): Promise<void> {
    await this.need().engine.clearChat(agentId)
  }

  async answer(id: string, answers: Record<string, string>, note?: string): Promise<void> {
    this.need().engine.inbox.answer(id, answers, note)
  }

  async decide(id: string, approved: boolean, note?: string, always?: boolean): Promise<void> {
    this.need().engine.inbox.decide(id, approved, note, always)
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const before = this.config.settings.mcpServers
    // once the user picks new-chat defaults, start-up detection leaves them alone
    const settings = await this.config.update(patch.chatDefaults ? { ...patch, chatDefaultsChosen: true } : patch)
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

  // ---------------------------------------------------------------- plugins

  /** After any change: the plugins' MCP servers follow their plugins, and the window hears about it. */
  private async pluginsChanged(): Promise<void> {
    const { plugins, broken } = await this.plugins.discover(this.project?.dir)
    const infos = plugins.map((d) => this.plugins.state(d))
    const servers = infos.filter((p) => p.enabled && !p.native).map(pluginMcpServer).filter((s): s is NonNullable<typeof s> => !!s)
    const own = this.config.settings.mcpServers.filter((s) => !s.pluginId)
    const next = [...own, ...servers]
    if (JSON.stringify(next) !== JSON.stringify(this.config.settings.mcpServers)) {
      for (const s of this.config.settings.mcpServers.filter((x) => x.pluginId)) await this.hub.drop(s.id)
      await this.updateSettings({ mcpServers: next })
    }
    this.o.emit({ type: 'plugins', plugins: infos, broken })
  }

  async pluginList() {
    const { plugins, broken } = await this.plugins.discover(this.project?.dir)
    return { plugins: plugins.map((d) => this.plugins.state(d)), broken }
  }

  async pluginInstall(dir: string) {
    const m = await this.plugins.install(dir)
    await this.pluginsChanged()
    return m
  }

  async pluginSetEnabled(id: string, enabled: boolean, grant?: PluginPermission[]) {
    const p = await this.plugins.find(id, this.project?.dir)
    if (!p) throw new Error(`No plugin ${id}`)
    // only what the plugin asked for can be granted
    await this.plugins.setEnabled(id, enabled, grant?.filter((g) => p.manifest.permissions.includes(g)))
    await this.pluginsChanged()
  }

  async pluginRevoke(id: string, perm: PluginPermission) {
    await this.plugins.revoke(id, perm)
    await this.pluginsChanged()
  }

  async pluginRemove(id: string) {
    await this.plugins.remove(id)
    await this.pluginsChanged()
  }

  async pluginCall(id: string, method: string, args: unknown[]) {
    const p = await this.plugins.find(id, this.project?.dir)
    if (!p) throw new Error(`No plugin ${id}`)
    return callPlugin(this.pluginCtx, p, method, Array.isArray(args) ? args : [])
  }

  // ---------------------------------------------------------------- IDE

  private async startWatching(dir: string): Promise<void> {
    await this.watcher?.stop()
    this.files = new ProjectFiles(dir)
    this.watcher = new ProjectWatcher()
    this.watcher.start(
      dir,
      (path, kind) => this.o.emit({ type: 'file-changed', path, kind }),
      () => this.files?.invalidate()
    )
  }

  private ide(): ProjectFiles {
    this.need()
    return this.files!
  }

  ideList(dir: string) {
    return listDir(this.need().project.dir, dir)
  }

  ideFind(query: string) {
    return this.ide().findFiles(query)
  }

  ideGrep(query: string) {
    return this.ide().grep(query)
  }

  ideRead(path: string) {
    return this.ide().read(path)
  }

  async ideWrite(path: string, text: string): Promise<void> {
    await this.ide().write(path, text)
  }

  async terminalAvailable() {
    return this.terminals.available()
  }

  /** A shell in the project root; for `claude`/`codex`, with that CLI started in it. */
  async terminalOpen(kind: TerminalKind, cols: number, rows: number) {
    const { project } = this.need()
    if (kind === 'shell') return this.terminals.open(project.dir, kind, cols, rows, 'Terminal')
    const label = kind === 'claude' ? 'Claude Code' : 'Codex'
    const startup = kind === 'claude' ? this.config.settings.claudePath || 'claude' : this.config.settings.codexPath || 'codex'
    return this.terminals.open(project.dir, kind, cols, rows, label, shellQuote(startup))
  }

  async terminalWrite(id: string, data: string) {
    this.terminals.write(id, data)
  }

  async terminalResize(id: string, cols: number, rows: number) {
    this.terminals.resize(id, cols, rows)
  }

  async terminalClose(id: string) {
    this.terminals.close(id)
  }

  // ---------------------------------------------------------------- git and GitHub

  private gitRepo(): Git {
    return new Git(this.need().project.dir)
  }

  private github(): GitHub {
    return new GitHub(this.need().project.dir, () => this.config.getKey('github'))
  }

  gitStatus() {
    return this.gitRepo().status()
  }
  gitInit() {
    return this.gitRepo().init()
  }
  gitDiff(path: string, staged: boolean, untracked: boolean) {
    return this.gitRepo().diff(path, staged, untracked)
  }
  gitStage(paths: string[]) {
    return this.gitRepo().stage(paths)
  }
  gitUnstage(paths: string[]) {
    return this.gitRepo().unstage(paths)
  }
  gitCommit(message: string) {
    return this.gitRepo().commit(message)
  }
  gitLog() {
    return this.gitRepo().log()
  }
  gitShow(hash: string) {
    return this.gitRepo().show(hash)
  }
  gitBranches() {
    return this.gitRepo().branches()
  }
  gitCheckout(name: string, create: boolean) {
    return this.gitRepo().checkout(name, create)
  }
  gitPull() {
    return this.gitRepo().pull()
  }
  gitPush() {
    return this.gitRepo().push()
  }

  async ghInfo() {
    const st = await this.gitRepo().status()
    return { repo: githubRepo(st.remote), auth: await this.github().auth() }
  }

  async ghList(kind: 'pulls' | 'issues') {
    const { repo } = await this.ghInfo()
    if (!repo) throw new Error('This project has no GitHub remote named origin.')
    return this.github().list(repo, kind)
  }

  async ghCreatePr(title: string, body: string, base?: string) {
    const st = await this.gitRepo().status()
    const repo = githubRepo(st.remote)
    if (!repo) throw new Error('This project has no GitHub remote named origin.')
    const gh = this.github()
    return gh.createPr(repo, st.branch, base || (await gh.defaultBranch(repo)), title, body)
  }

  projectName(): string {
    return this.project ? basename(this.project.dir) : ''
  }
}
