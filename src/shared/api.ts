import type { AgentSpec, AgentStatus, ChatMessage, WaitingItem, ImageUpload, ProjectTab, RunState, UpdateState, AppSettings, CliStatus, GhItem, GitCommit, GitStatus, IdeEntry, IdeHit, MainEvent, McpServerConfig, ModelEntry, PlanWindow, PluginInfo, PluginManifest, PluginPermission, ProjectInfo, ProviderKind, TerminalInfo, TerminalKind } from './types'

/** Everything the renderer can ask of the main process. One method, one IPC channel. */
export interface Api {
  init(): Promise<{ settings: AppSettings; keyed: string[]; project: ProjectInfo | null; projects: ProjectTab[]; planLimits: PlanWindow[] }>
  pickProject(): Promise<string | null>
  /** Opens a project in a new tab (or brings it on screen if it is open); the others keep running. */
  openProject(dir: string): Promise<void>
  /** Closes a project's tab, the one on screen by default; its chats and run stop. */
  closeProject(dir?: string): Promise<void>
  /** Puts another open project on screen; nothing stops. */
  switchProject(dir: string): Promise<void>
  saveMultimineMd(text: string): Promise<void>

  /** A new chat on the defaults from Settings; `patch` wins over them. */
  createChat(patch?: Partial<AgentSpec>): Promise<AgentSpec>
  /** Changes a chat's settings or name. */
  saveChat(chat: AgentSpec): Promise<AgentSpec>
  deleteChat(id: string): Promise<void>
  /** The chat on screen: where a tool's messages to 'active' go. */
  setActiveChat(id: string | null): Promise<void>

  /** `quick`: this message runs on the light tier of the chat's provider. `images`: attached images (at most 10). */
  send(agentId: string, text: string, opts?: { quick?: boolean; images?: ImageUpload[] }): Promise<void>
  stop(agentId: string): Promise<void>
  retry(agentId: string): Promise<void>
  /** A new conversation in the same chat: the messages stay, the agent starts clean with a short recap. */
  freshStart(agentId: string): Promise<boolean>
  clearChat(agentId: string): Promise<void>
  /** One file's diff from the turn a reply ran: before the turn against after it. */
  turnDiff(agentId: string, messageId: string, path: string): Promise<string>
  /** Puts back the files a reply's turn changed; files changed since come back as conflicts unless `force`. */
  turnUndo(agentId: string, messageId: string, force?: boolean): Promise<{ undone: boolean; conflicts: string[] }>

  /** Answers a question waiting in any open project (or Tuesday's own). */
  answer(id: string, answers: Record<string, string>, note?: string): Promise<void>
  decide(id: string, approved: boolean, note?: string, always?: boolean): Promise<void>

  /** Tuesday: its conversation, what it is doing, the chat it runs as, and everything waiting on the user. */
  tuesdayInit(): Promise<{ messages: ChatMessage[]; status: AgentStatus; activity?: string; detail?: string; spec: AgentSpec; waiting: WaitingItem[] }>
  tuesdaySend(text: string): Promise<void>
  tuesdayStop(): Promise<void>
  /** A new conversation with Tuesday: the messages stay, it starts clean with a short recap. */
  tuesdayFresh(): Promise<boolean>
  tuesdayClear(): Promise<void>

  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  setKey(provider: string, key: string | null): Promise<string[]>
  detectClis(): Promise<{ claude: CliStatus; codex: CliStatus }>
  refreshModels(provider: ProviderKind): Promise<ModelEntry[]>
  testMcp(server: McpServerConfig): Promise<{ ok: boolean; tools: string[]; error?: string }>

  gitStatus(): Promise<GitStatus>
  gitInit(): Promise<void>
  gitDiff(path: string, staged: boolean, untracked: boolean): Promise<string>
  gitStage(paths: string[]): Promise<void>
  gitUnstage(paths: string[]): Promise<void>
  gitCommit(message: string): Promise<string>
  gitLog(): Promise<GitCommit[]>
  gitShow(hash: string): Promise<string>
  gitBranches(): Promise<{ current: string; local: string[] }>
  gitCheckout(name: string, create: boolean): Promise<void>
  gitPull(): Promise<string>
  gitPush(): Promise<string>
  ghInfo(): Promise<{ repo: string | null; auth: 'token' | 'gh' | null }>
  ghList(kind: 'pulls' | 'issues'): Promise<GhItem[]>
  ghCreatePr(title: string, body: string, base?: string): Promise<GhItem>

  ideList(dir: string): Promise<IdeEntry[]>
  ideFind(query: string): Promise<IdeHit[]>
  ideGrep(query: string): Promise<IdeHit[]>
  ideRead(path: string): Promise<{ text: string; binary: boolean; tooBig: boolean }>
  ideWrite(path: string, text: string): Promise<void>
  ideOpenExternal(path: string, app: 'idea' | 'code' | 'system'): Promise<void>
  terminalAvailable(): Promise<{ ok: boolean; error?: string }>
  /** The terminals of the project on screen, still running from before. */
  terminalList(): Promise<TerminalInfo[]>
  terminalOpen(kind: TerminalKind, cols: number, rows: number): Promise<TerminalInfo>
  terminalWrite(id: string, data: string): Promise<void>
  terminalResize(id: string, cols: number, rows: number): Promise<void>
  terminalClose(id: string): Promise<void>

  pluginList(): Promise<{ plugins: PluginInfo[]; broken: { dir: string; errors: string[] }[] }>
  pluginPickAndInstall(): Promise<PluginManifest | null>
  pluginInstall(dir: string): Promise<PluginManifest>
  pluginSetEnabled(id: string, enabled: boolean, grant?: PluginPermission[]): Promise<void>
  pluginRevoke(id: string, perm: PluginPermission): Promise<void>
  pluginRemove(id: string): Promise<void>
  pluginCall(id: string, method: string, args: unknown[]): Promise<unknown>
  /** Has a chat ('new', 'active' or an id) make a tool from a description, or change the tool `editId`; resolves to the chat. */
  pluginMake(request: string, to: string, editId?: string): Promise<string>

  /** The run button: its saved command, the one Multimine suggests for this project, the current run and its output. */
  runInfo(): Promise<{ command: string | null; suggested: string | null; state: RunState; lines: string[] }>
  /** Starts the game (with `command`, saved as the project's from then on, or the saved one). */
  runStart(command?: string): Promise<void>
  runStop(): Promise<void>
  /** Sends a problem from the run to a chat ('active', 'new' or an id); resolves to the chat it went to. */
  runSend(problemId: string, to: string): Promise<string>

  /** Where Multimine's own update stands; `updateCheck` looks now; `updateInstall` restarts on the downloaded version. */
  updateState(): Promise<UpdateState>
  updateCheck(): Promise<UpdateState>
  updateInstall(): Promise<void>

  /** Shows a sample desktop notification; false when the system does not support them. */
  testNotification(): Promise<boolean>

  openPath(path: string): Promise<void>
  mediaUrl(path: string): Promise<string>
}

export type ApiMethod = keyof Api

export const API_METHODS: ApiMethod[] = [
  'init', 'pickProject', 'openProject', 'closeProject', 'switchProject', 'saveMultimineMd',
  'createChat', 'saveChat', 'deleteChat', 'setActiveChat',
  'send', 'stop', 'retry', 'clearChat', 'freshStart', 'turnDiff', 'turnUndo',
  'answer', 'decide',
  'tuesdayInit', 'tuesdaySend', 'tuesdayStop', 'tuesdayFresh', 'tuesdayClear',
  'updateSettings', 'setKey', 'detectClis', 'refreshModels', 'testMcp',
  'gitStatus', 'gitInit', 'gitDiff', 'gitStage', 'gitUnstage', 'gitCommit', 'gitLog', 'gitShow', 'gitBranches', 'gitCheckout', 'gitPull', 'gitPush',
  'ghInfo', 'ghList', 'ghCreatePr',
  'ideList', 'ideFind', 'ideGrep', 'ideRead', 'ideWrite', 'ideOpenExternal',
  'terminalAvailable', 'terminalList', 'terminalOpen', 'terminalWrite', 'terminalResize', 'terminalClose',
  'pluginList', 'pluginPickAndInstall', 'pluginInstall', 'pluginSetEnabled', 'pluginRevoke', 'pluginRemove', 'pluginCall', 'pluginMake',
  'runInfo', 'runStart', 'runStop', 'runSend',
  'updateState', 'updateCheck', 'updateInstall',
  'testNotification', 'openPath', 'mediaUrl'
]

export interface Bridge {
  api: Api
  onEvent(cb: (e: MainEvent) => void): () => void
}
