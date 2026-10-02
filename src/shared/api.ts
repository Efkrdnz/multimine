import type { AgentSpec, AppSettings, CliStatus, GhItem, GitCommit, GitStatus, MainEvent, McpServerConfig, ModelEntry, ProjectInfo, ProviderKind } from './types'

/** Everything the renderer can ask of the main process. One method, one IPC channel. */
export interface Api {
  init(): Promise<{ settings: AppSettings; keyed: string[]; project: ProjectInfo | null }>
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
  clearChat(agentId: string): Promise<void>

  newSession(name?: string): Promise<void>
  switchSession(id: string): Promise<void>
  renameSession(id: string, name: string): Promise<void>
  deleteSession(id: string): Promise<void>
  duplicateSession(id: string): Promise<void>

  answer(id: string, answers: Record<string, string>, note?: string): Promise<void>
  decide(id: string, approved: boolean, note?: string): Promise<void>

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

  contextFiles(): Promise<{ file: string; text: string }[]>
  openPath(path: string): Promise<void>
  mediaUrl(path: string): Promise<string>
}

export type ApiMethod = keyof Api

export const API_METHODS: ApiMethod[] = [
  'init', 'pickProject', 'openProject', 'closeProject', 'saveMultimineMd',
  'saveAgent', 'deleteAgent', 'setPosition',
  'send', 'stop', 'retry', 'clearChat',
  'newSession', 'switchSession', 'renameSession', 'deleteSession', 'duplicateSession',
  'answer', 'decide',
  'updateSettings', 'setKey', 'detectClis', 'refreshModels', 'testMcp',
  'gitStatus', 'gitInit', 'gitDiff', 'gitStage', 'gitUnstage', 'gitCommit', 'gitLog', 'gitShow', 'gitBranches', 'gitCheckout', 'gitPull', 'gitPush',
  'ghInfo', 'ghList', 'ghCreatePr',
  'contextFiles', 'openPath', 'mediaUrl'
]

export interface Bridge {
  api: Api
  onEvent(cb: (e: MainEvent) => void): () => void
}
