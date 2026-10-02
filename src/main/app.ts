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
import { Git, GitHub, githubRepo } from './git/git'
import { ProjectFiles, list as listDir } from './ide/fs'
import { Terminals, shellQuote } from './ide/terminals'
import { ManualChangeTracker, ProjectWatcher } from './ide/watcher'
import { writeJson } from './store/fsx'
import { roleTemplate } from '@shared/templates'
import type { TerminalKind } from '@shared/types'

/** What a CLI in the IDE terminal is told about the team, through the MCP server's instructions. */
function terminalInstructions(name: string): string {
  return (
    `You are "${name}", a session in the user's own terminal inside Multimine, connected to its team of agents through ` +
    'this `multimine` server. Use list_agents to see the team; message_agent to ask or tell a teammate something ' +
    '(Mastermind coordinates the team); ask_user for structured questions; request_permission before pushing or ' +
    'destroying work; show_media for anything you generate. Messages teammates send you reach the user as a banner, ' +
    'not as your input, so the user decides what to do with them.'
  )
}

export interface AppOptions {
  userDataDir: string
  cipher: Cipher
  emit: (e: MainEvent) => void
  mockScript?: MockScript
  mockDelayMs?: number
  /** How long the project must be quiet before manual changes go to the Context Handler (default 2 minutes). */
  manualQuietMs?: number
  /** Skip CLI detection when choosing Mastermind's provider (tests). */
  forceMockMastermind?: boolean
}

/** The main-process side of the API: owns settings, the open project, the engine and the bus server. */
export class MultimineApp implements Omit<Api, 'pickProject' | 'openPath' | 'mediaUrl' | 'ideOpenExternal'> {
  readonly config: AppConfig
  readonly hub = new McpHub()
  readonly providers: ProviderRegistry
  project: ProjectStore | null = null
  engine: Engine | null = null
  private bus: BusServer
  readonly terminals: Terminals
  private watcher: ProjectWatcher | null = null
  private tracker: ManualChangeTracker | null = null
  private files: ProjectFiles | null = null

  constructor(private readonly o: AppOptions) {
    this.config = new AppConfig(o.userDataDir, o.cipher)
    this.providers = new ProviderRegistry(o.mockScript, o.mockDelayMs)
    this.bus = new BusServer((agentId) => {
      const agent = this.project?.get(agentId)
      if (!agent || !this.engine) return null
      return { tools: this.engine.coordinationTools(agent), instructions: agent.terminal ? terminalInstructions(agent.name) : undefined }
    })
    this.terminals = new Terminals(o.emit)
  }

  async start(): Promise<void> {
    await this.config.load()
    await this.bus.start()
  }

  async shutdown(): Promise<void> {
    this.terminals.closeAll()
    await this.watcher?.stop()
    this.tracker?.dispose()
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
    await this.startWatching(project.dir)
    await this.config.addRecent(dir)
    this.o.emit({ type: 'settings', settings: this.config.settings })
  }

  async closeProject(): Promise<void> {
    this.terminals.closeAll()
    await this.watcher?.stop()
    this.tracker?.dispose()
    this.watcher = null
    this.tracker = null
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
    if (agent.terminal || project.get(agent.id)?.terminal) throw new Error('A terminal session is not an agent file; close its terminal to remove it.')
    if (isNew) return engine.createAgent(agent, 'user')
    if (!project.get(agent.id)) throw new Error(`No agent ${agent.id}`)
    const saved = await project.saveAgent(agent.id === MASTERMIND_ID ? { ...agent, role: 'mastermind', gated: false } : agent)
    this.emitProject()
    return saved
  }

  async deleteAgent(id: string): Promise<void> {
    if (this.project?.get(id)?.terminal) throw new Error('Close its terminal to remove a terminal session.')
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

  // ---------------------------------------------------------------- IDE

  private async startWatching(dir: string): Promise<void> {
    await this.watcher?.stop()
    this.tracker?.dispose()
    this.files = new ProjectFiles(dir)
    this.tracker = new ManualChangeTracker({
      quietMs: (this.o.manualQuietMs ?? 120_000),
      isAgentWriting: () => this.engine?.agentWriting() ?? false,
      changed: (count, files) => this.o.emit({ type: 'manual-changes', count, files }),
      flush: (batch) => void this.engine?.manualChanges(batch)
    })
    this.watcher = new ProjectWatcher()
    this.watcher.start(
      dir,
      (path, kind) => {
        this.o.emit({ type: 'file-changed', path, kind })
        // without a Context Handler there is nobody to tell, so nothing is collected
        if (this.project?.contextHandler()) this.tracker?.record(path, kind)
      },
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
    // a save in the IDE window is the user's, even while an agent happens to be working
    if (this.project?.contextHandler()) this.tracker?.record(path, 'changed', true)
  }

  async syncContext(): Promise<boolean> {
    if (!this.project?.contextHandler()) return false
    this.tracker?.flushNow()
    return true
  }

  async terminalAvailable() {
    return this.terminals.available()
  }

  /** A shell in the project root; for `claude`/`codex`, the CLI starts in it as a member of the team. */
  async terminalOpen(kind: TerminalKind, cols: number, rows: number) {
    const { project, engine } = this.need()
    if (kind === 'shell') return this.terminals.open(project.dir, kind, cols, rows, 'Terminal')
    const label = kind === 'claude' ? 'Claude Code' : 'Codex'
    const id = project.freeId(`terminal-${kind}`)
    const agent = {
      ...roleTemplate('custom', id),
      id,
      name: `${label} (terminal)`,
      provider: kind === 'claude' ? ('claude-cli' as const) : ('codex-cli' as const),
      model: '',
      color: kind === 'claude' ? '#f59e0b' : '#10b981',
      permissions: 'write' as const,
      terminal: true,
      purpose: 'A live CLI session in the user terminal.'
    }
    project.addVirtual(agent)
    engine.chats[id] ??= []
    this.emitProject()
    const url = this.bus.url(id)
    let startup: string
    if (kind === 'claude') {
      const cfg = join(this.o.userDataDir, `terminal-mcp-${id}.json`)
      await writeJson(cfg, { mcpServers: { multimine: { type: 'http', url } } })
      startup = `${this.config.settings.claudePath || 'claude'} --mcp-config ${shellQuote(cfg)}`
    } else {
      // codex reads a -c value that is not valid TOML as a plain string, so the URL needs no inner quotes
      startup = `${this.config.settings.codexPath || 'codex'} -c ${shellQuote(`mcp_servers.multimine.url=${url}`)}`
    }
    return this.terminals.open(project.dir, kind, cols, rows, label, startup, id, () => {
      this.project?.removeVirtual(id)
      this.emitProject()
    })
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
