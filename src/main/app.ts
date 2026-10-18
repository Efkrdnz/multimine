import { join, basename, resolve } from 'node:path'
import type { Api } from '@shared/api'
import type { AgentSpec, AppSettings, MainEvent, McpServerConfig, PlanWindow, ProjectTab, ProviderKind } from '@shared/types'
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
import { crashPrompt } from '@shared/run/crash'
import { Runner, suggestCommand } from './run/runner'
import { checkPlugin } from './plugins/check'
import { checkUploads } from './media/attachments'
import type { ImageUpload } from '@shared/types'
import { validateManifest } from './plugins/manifest'
import { DRAFTS, pluginChatName, pluginCommand } from '@shared/pluginMaker'
import type { InstallResult } from './chat/engine'
import type { PluginInfo } from '@shared/types'
import { existsSync } from 'node:fs'
import { cp } from 'node:fs/promises'

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
  /** Loads a page in a hidden window and returns the errors it reports (a tool a chat made, before it installs). */
  loadTest?: (url: string) => Promise<string[]>
  /** An event from a project that is not on screen (for desktop notifications). */
  background?: (e: MainEvent, dir: string) => void
}

/** One open project: its chats, run button, file watcher and terminals. */
export interface Workspace {
  dir: string
  project: ProjectStore
  engine: Engine
  runner: Runner
  terminals: Terminals
  files: ProjectFiles
  watcher: ProjectWatcher
  /** Its chat on screen when it was last on screen. */
  activeChat: string | null
}

/** The main-process side of the API: owns settings, the open projects, their engines and the bus server. */
export class MultimineApp implements Omit<Api, 'pickProject' | 'openPath' | 'mediaUrl' | 'ideOpenExternal' | 'pluginPickAndInstall' | 'testNotification'> {
  readonly config: AppConfig
  readonly hub = new McpHub()
  /** Which providers are out of usage right now: app-wide, so it survives switching projects. */
  readonly health: ProviderHealth
  readonly planLimits: PlanLimits
  readonly providers: ProviderRegistry
  private bus: BusServer
  readonly plugins: PluginRegistry
  private pluginCtx: PluginContext
  /** Every open project, in the order of their tabs; each keeps working while another is on screen. */
  private spaces = new Map<string, Workspace>()
  /** The project on screen: the API acts on it, and only its events reach the window. */
  private current: Workspace | null = null
  private tabsTimer: ReturnType<typeof setTimeout> | null = null

  get project(): ProjectStore | null {
    return this.current?.project ?? null
  }
  get engine(): Engine | null {
    return this.current?.engine ?? null
  }
  /** The run button of the project on screen. */
  get runner(): Runner | null {
    return this.current?.runner ?? null
  }
  get terminals(): Terminals | null {
    return this.current?.terminals ?? null
  }
  /** The chat on screen: where a tool's 'active' messages go. */
  private get activeChat(): string | null {
    return this.current?.activeChat ?? null
  }
  private set activeChat(id: string | null) {
    if (this.current) this.current.activeChat = id
  }

  constructor(private readonly o: AppOptions) {
    this.config = new AppConfig(o.userDataDir, o.cipher)
    this.providers = new ProviderRegistry(o.mockScript, o.mockDelayMs, o.providerOverrides)
    // a chat in any open project calls back here, on screen or not
    this.bus = new BusServer((chatId) => {
      const ws = this.spaceOfChat(chatId)
      const chat = ws?.project.get(chatId)
      return ws && chat ? { tools: ws.engine.coordinationTools(chat) } : null
    })
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
    if (this.tabsTimer) clearTimeout(this.tabsTimer)
    this.providers.release()
    for (const ws of this.spaces.values()) await this.stopSpace(ws, 'Multimine closed.')
    this.spaces.clear()
    this.current = null
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
    return { settings: this.config.settings, keyed: this.config.keyedProviders(), project: this.project?.info() ?? null, projects: this.listProjects(), planLimits: this.planLimits.list() }
  }

  // ---------------------------------------------------------------- open projects (tabs)

  /**
   * Where an open project's events go: the window, if it is on screen. A project in the background
   * keeps its chats, run and terminals going; the window hears its terminals (a tab may be watching
   * them later), its toasts (named) and tools it made, and its tab's badge follows its chats.
   */
  private route(ws: Workspace, e: MainEvent): void {
    if (ws === this.current) this.o.emit(e)
    else if (e.type === 'terminal-data' || e.type === 'terminal-exit' || e.type === 'plugin-installed') this.o.emit(e)
    else if (e.type === 'toast') this.o.emit({ ...e, text: `${basename(ws.dir)}: ${e.text}` })
    else this.o.background?.(e, ws.dir)
    if (e.type === 'status' || e.type === 'inbox' || e.type === 'run') this.tabsSoon()
  }

  /** The open projects, as their tabs show them. */
  listProjects(): ProjectTab[] {
    return [...this.spaces.values()].map((ws) => ({
      dir: ws.dir,
      name: basename(ws.dir),
      active: ws === this.current,
      busy: ws.project.list().filter((c) => ws.engine.busy(c.id)).length,
      waiting: ws.engine.inbox.pending().length,
      running: ws.runner.state.status === 'running'
    }))
  }

  private tabsSoon(now = false): void {
    if (this.tabsTimer) clearTimeout(this.tabsTimer)
    this.tabsTimer = null
    const send = () => this.o.emit({ type: 'projects', projects: this.listProjects() })
    if (now) send()
    else this.tabsTimer = setTimeout(send, 120)
  }

  /** The open project a chat belongs to. */
  spaceOfChat(chatId: string): Workspace | undefined {
    for (const ws of this.spaces.values()) if (ws.project.get(chatId)) return ws
    return undefined
  }

  /** A chat's name and project folder, whichever open project it is in (for notifications). */
  chatName(chatId: string): string {
    return this.spaceOfChat(chatId)?.project.get(chatId)?.name ?? chatId
  }

  dirOfChat(chatId: string): string | undefined {
    return this.spaceOfChat(chatId)?.dir
  }

  private async saveTabs(): Promise<void> {
    await this.config.update({ openProjects: [...this.spaces.keys()], activeProject: this.current?.dir })
  }

  /** Opens the projects that were open last time (those still there), and `extra` on top. */
  async restoreProjects(extra?: string | null): Promise<void> {
    const { openProjects = [], activeProject } = this.config.settings
    for (const dir of openProjects) if (existsSync(dir) && dir !== extra) await this.openProject(dir).catch(() => undefined)
    if (extra) await this.openProject(extra)
    else if (activeProject && this.spaces.has(activeProject)) await this.switchProject(activeProject)
  }

  /**
   * Opens a project in a new tab and puts it on screen; the projects already open keep running.
   * One that is open already just comes on screen.
   */
  async openProject(dir: string): Promise<void> {
    const key = resolve(dir)
    if (this.spaces.has(key)) return this.switchProject(key)
    const project = await ProjectStore.open(key)
    await this.detectDefaults()
    const ws = { dir: key, project, activeChat: null } as Workspace
    const emit = (e: MainEvent) => this.route(ws, e)
    ws.runner = new Runner(key, emit)
    ws.terminals = new Terminals(emit)
    ws.files = new ProjectFiles(key)
    ws.watcher = new ProjectWatcher()
    ws.engine = new Engine({
      health: this.health,
      planLimits: this.planLimits,
      project,
      store: new ChatStore(project.paths),
      config: this.config,
      providers: this.providers,
      emit,
      hub: this.hub,
      busUrl: (id) => this.bus.url(id),
      plugins: {
        list: async () => (await this.plugins.list(key)).map((p) => ({ id: p.manifest.id, name: p.manifest.name })),
        install: (id, chatId) => this.installMadeTool(id, chatId, ws)
      }
    })
    this.spaces.set(key, ws)
    // on screen before it loads, so what it loads reaches the window
    this.current = ws
    await ws.engine.open()
    ws.watcher.start(
      key,
      (path, kind) => this.route(ws, { type: 'file-changed', path, kind }),
      () => ws.files.invalidate()
    )
    this.o.emit({ type: 'run', state: ws.runner.state })
    this.o.emit({ type: 'run-output', lines: [], reset: true })
    await this.pluginsChanged()
    await this.config.addRecent(key)
    await this.saveTabs()
    this.o.emit({ type: 'settings', settings: this.config.settings })
    this.tabsSoon(true)
  }

  /** Puts another open project on screen. Nothing stops: the one leaving keeps its chats and run going. */
  async switchProject(dir: string): Promise<void> {
    const ws = this.spaces.get(resolve(dir))
    if (!ws) throw new Error(`${dir} is not open`)
    if (ws === this.current) return
    this.current = ws
    ws.engine.publish()
    this.o.emit({ type: 'run', state: { ...ws.runner.state, problems: [...ws.runner.state.problems] } })
    this.o.emit({ type: 'run-output', lines: ws.runner.output(), reset: true })
    await this.pluginsChanged()
    await this.saveTabs()
    this.tabsSoon(true)
  }

  private async stopSpace(ws: Workspace, reason: string): Promise<void> {
    ws.terminals.closeAll()
    await ws.runner.stop()
    await ws.watcher.stop()
    await ws.engine.close(reason)
    for (const c of ws.project.list()) this.providers.release(`${c.id}|`)
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

  /**
   * Closes a project's tab (the one on screen by default): its chats, run and terminals stop. The
   * last project used comes on screen, or the welcome screen when none is left.
   */
  async closeProject(dir?: string): Promise<void> {
    const ws = dir ? this.spaces.get(resolve(dir)) : this.current
    if (!ws) return
    this.spaces.delete(ws.dir)
    await this.stopSpace(ws, 'The project was closed.')
    if (ws === this.current) {
      this.current = null
      const next = [...this.spaces.values()].at(-1)
      if (next) await this.switchProject(next.dir)
      else {
        this.emitProject()
        await this.pluginsChanged()
      }
    }
    await this.saveTabs()
    this.tabsSoon(true)
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

  async send(agentId: string, text: string, opts?: { quick?: boolean; images?: ImageUpload[] }): Promise<void> {
    const { engine } = this.need()
    const images = Array.isArray(opts?.images) ? opts.images : []
    const bad = checkUploads(images)
    if (bad) throw new Error(bad)
    if (!text.trim() && !images.length) return
    void engine
      .send(agentId, text, 'user', { quick: !!opts?.quick, images })
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

  turnDiff(agentId: string, messageId: string, path: string) {
    return this.need().engine.turnDiff(agentId, messageId, path)
  }

  turnUndo(agentId: string, messageId: string, force?: boolean) {
    return this.need().engine.undoTurn(agentId, messageId, !!force)
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

  // ---------------------------------------------------------------- tools chats make

  /** A tool's draft folder in the project: where a chat writes it. */
  private draftDir(id: string, projectDir = this.need().project.dir): string {
    if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(id)) throw new Error(`"${id}" is not a plugin id: 2-40 lowercase letters, digits or dashes`)
    return join(projectDir, DRAFTS, id)
  }

  /** A draft as a plugin with nothing granted, for the hidden load test (mmplugin://draft--<id>/). */
  async draftPlugin(id: string): Promise<PluginInfo | undefined> {
    // the project on screen first, then any other open one (a chat in the background may be making it)
    const order = [this.current, ...this.spaces.values()].filter((w): w is Workspace => !!w)
    for (const ws of order) {
      let dir: string
      try {
        dir = this.draftDir(id, ws.dir)
      } catch {
        return undefined
      }
      const res = validateManifest(await readJson<unknown>(join(dir, 'plugin.json'), null))
      if (res.ok) return { manifest: res.manifest, source: 'project', native: false, dir, enabled: true, granted: [], pending: [] }
    }
    return undefined
  }

  /**
   * Installs a tool a chat wrote: checked (manifest, files, permissions against the calls it makes,
   * scripts), loaded once in a hidden window to catch errors, then copied into the user's plugins.
   * The window is told, and asks the user to allow it before it runs.
   */
  async installMadeTool(id: string, chatId: string, ws: Workspace | null = this.current): Promise<InstallResult> {
    if (!ws) throw new Error('No project is open')
    const project = ws.project
    const dir = this.draftDir(id, project.dir)
    if (!existsSync(join(dir, 'plugin.json'))) return { installed: false, errors: [`there is no ${DRAFTS}/${id}/plugin.json: write the tool's files there first`], warnings: [] }
    const check = await checkPlugin(dir, id)
    if (check.errors.length || !check.manifest) return { installed: false, errors: check.errors, warnings: check.warnings }
    const m = check.manifest
    const pageErrors = this.o.loadTest ? await this.o.loadTest(`mmplugin://draft--${id}/${m.entry ?? 'index.html'}?mmhost=check`) : []
    if (pageErrors.length) return { installed: false, errors: pageErrors.map((e) => `when the page loaded it reported: ${e}`), warnings: check.warnings }
    const before = await this.plugins.find(id, project.dir)
    await this.plugins.install(dir)
    await this.pluginsChanged()
    const update = before?.source === 'user'
    this.o.emit({ type: 'plugin-installed', id, chatId, update })
    return { installed: true, name: m.name, version: m.version, permissions: m.permissions, update, errors: [], warnings: check.warnings }
  }

  /**
   * Has a chat make a tool (or change one: its installed files are copied into the drafts first,
   * unless the draft there is already that version). `to` is 'new', 'active' or a chat id.
   * Resolves to the chat doing it.
   */
  async pluginMake(request: string, to: string, editId?: string): Promise<string> {
    const { project, engine } = this.need()
    if (!request.trim()) throw new Error('Say what the tool should do.')
    if (editId) {
      const p = await this.plugins.find(editId, project.dir)
      if (!p || p.native) throw new Error(`No tool ${editId} to change.`)
      const dir = this.draftDir(editId)
      const draft = await readJson<{ version?: string } | null>(join(dir, 'plugin.json'), null)
      if (draft?.version !== p.manifest.version) await cp(p.dir, dir, { recursive: true, force: true, filter: (src) => !/[\\/](\.git|node_modules)([\\/]|$)/.test(src) })
    }
    const body = pluginCommand(request, editId)
    let id = to === 'active' ? this.activeChat : to === 'new' ? null : to
    if (!id || !project.get(id)) id = (await engine.createChat({ name: pluginChatName(body).slice(0, 48) })).id
    this.activeChat = id
    void engine
      .send(id, body, 'user')
      .then((r) => this.reportError(id!, r.error))
      .catch((e) => this.reportError(id!, String((e as Error).message ?? e)))
    return id
  }

  // ---------------------------------------------------------------- IDE

  private ide(): ProjectFiles {
    this.need()
    return this.current!.files
  }

  private term(): Terminals {
    this.need()
    return this.current!.terminals
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
    return Terminals.available()
  }

  /** The terminals of the project on screen (they keep running while another project is). */
  async terminalList() {
    return this.term().list()
  }

  /** A shell in the project root; for `claude`/`codex`, with that CLI started in it. */
  async terminalOpen(kind: TerminalKind, cols: number, rows: number) {
    const { project } = this.need()
    if (kind === 'shell') return this.term().open(project.dir, kind, cols, rows, 'Terminal')
    const label = kind === 'claude' ? 'Claude Code' : 'Codex'
    const startup = kind === 'claude' ? this.config.settings.claudePath || 'claude' : this.config.settings.codexPath || 'codex'
    return this.term().open(project.dir, kind, cols, rows, label, shellQuote(startup))
  }

  async terminalWrite(id: string, data: string) {
    this.current?.terminals.write(id, data)
  }

  async terminalResize(id: string, cols: number, rows: number) {
    this.current?.terminals.resize(id, cols, rows)
  }

  async terminalClose(id: string) {
    this.current?.terminals.close(id)
  }

  // ---------------------------------------------------------------- the run button

  private run(): Runner {
    this.need()
    return this.runner!
  }

  async runInfo() {
    const runner = this.run()
    const [config, suggested] = await Promise.all([runner.config(), suggestCommand(this.need().project.dir)])
    return { command: config?.command ?? null, suggested, state: runner.state, lines: runner.output() }
  }

  async runStart(command?: string): Promise<void> {
    const runner = this.run()
    const cmd = command?.trim() || (await runner.config())?.command || (await suggestCommand(this.need().project.dir)) || ''
    if (!cmd) throw new Error('Set the command that starts the game first.')
    if ((await runner.config())?.command !== cmd) await runner.saveConfig({ command: cmd })
    await runner.start(cmd)
  }

  async runStop(): Promise<void> {
    await this.runner?.stop()
  }

  /** A problem from the run, with the code it points at, as a message to a chat. */
  async runSend(problemId: string, to: string): Promise<string> {
    const { engine } = this.need()
    const runner = this.run()
    const problem = runner.find(problemId)
    if (!problem) throw new Error('That problem is from an earlier run.')
    const body = crashPrompt(problem, { command: runner.state.command, code: runner.state.status === 'exited' ? runner.state.code : undefined })
    const id = await engine.fromTool('Run', to, body, this.activeChat ?? undefined)
    this.activeChat = id
    return id
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
