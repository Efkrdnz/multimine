import type { AgentSpec, AppSettings, CliStatus, GhItem, GitCommit, GitStatus, IdeEntry, IdeHit, MainEvent, McpServerConfig, ModelEntry, PlanWindow, PluginInfo, PluginManifest, PluginPermission, ProjectInfo, ProviderKind, TerminalInfo, TerminalKind } from './types'

/** Everything the renderer can ask of the main process. One method, one IPC channel. */
export interface Api {
  init(): Promise<{ settings: AppSettings; keyed: string[]; project: ProjectInfo | null; planLimits: PlanWindow[] }>
  pickProject(): Promise<string | null>
  openProject(dir: string): Promise<void>
  closeProject(): Promise<void>
  saveMultimineMd(text: string): Promise<void>

  saveAgent(agent: AgentSpec, isNew: boolean): Promise<AgentSpec>
  deleteAgent(id: string): Promise<void>
  setPosition(id: string, x: number, y: number): Promise<void>

  send(agentId: string, text: string): Promise<void>
  stop(agentId: string): Promise<void>
  retry(agentId: string): Promise<void>
  /** A new conversation with one agent: the chat stays, the agent starts clean with a short recap. */
  freshStart(agentId: string): Promise<boolean>
  clearChat(agentId: string): Promise<void>

  newSession(name?: string): Promise<void>
  switchSession(id: string): Promise<void>
  renameSession(id: string, name: string): Promise<void>
  deleteSession(id: string): Promise<void>
  duplicateSession(id: string): Promise<void>

  answer(id: string, answers: Record<string, string>, note?: string): Promise<void>
  decide(id: string, approved: boolean, note?: string, always?: boolean): Promise<void>

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
  syncContext(): Promise<boolean>
  terminalAvailable(): Promise<{ ok: boolean; error?: string }>
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

  /** Shows a sample desktop notification; false when the system does not support them. */
  testNotification(): Promise<boolean>

  contextFiles(): Promise<{ file: string; text: string }[]>
  openPath(path: string): Promise<void>
  mediaUrl(path: string): Promise<string>
}

export type ApiMethod = keyof Api

export const API_METHODS: ApiMethod[] = [
  'init', 'pickProject', 'openProject', 'closeProject', 'saveMultimineMd',
  'saveAgent', 'deleteAgent', 'setPosition',
  'send', 'stop', 'retry', 'clearChat', 'freshStart',
  'newSession', 'switchSession', 'renameSession', 'deleteSession', 'duplicateSession',
  'answer', 'decide',
  'updateSettings', 'setKey', 'detectClis', 'refreshModels', 'testMcp',
  'gitStatus', 'gitInit', 'gitDiff', 'gitStage', 'gitUnstage', 'gitCommit', 'gitLog', 'gitShow', 'gitBranches', 'gitCheckout', 'gitPull', 'gitPush',
  'ghInfo', 'ghList', 'ghCreatePr',
  'ideList', 'ideFind', 'ideGrep', 'ideRead', 'ideWrite', 'ideOpenExternal', 'syncContext',
  'terminalAvailable', 'terminalOpen', 'terminalWrite', 'terminalResize', 'terminalClose',
  'pluginList', 'pluginPickAndInstall', 'pluginInstall', 'pluginSetEnabled', 'pluginRevoke', 'pluginRemove', 'pluginCall',
  'testNotification', 'contextFiles', 'openPath', 'mediaUrl'
]

export interface Bridge {
  api: Api
  onEvent(cb: (e: MainEvent) => void): () => void
}
