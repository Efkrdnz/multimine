import type { AgentSpec, AppSettings, CliStatus, MainEvent, McpServerConfig, ModelEntry, ProjectInfo, ProviderKind } from './types'

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

  contextFiles(): Promise<{ file: string; text: string }[]>
  openPath(path: string): Promise<void>
  mediaUrl(path: string): Promise<string>
}

export type ApiMethod = keyof Api

export const API_METHODS: ApiMethod[] = [
  'init', 'pickProject', 'openProject', 'closeProject', 'saveMultimineMd',
  'saveAgent', 'deleteAgent', 'setPosition',
  'send', 'stop', 'clearChat',
  'newSession', 'switchSession', 'renameSession', 'deleteSession', 'duplicateSession',
  'answer', 'decide',
  'updateSettings', 'setKey', 'detectClis', 'refreshModels', 'testMcp',
  'contextFiles', 'openPath', 'mediaUrl'
]

export interface Bridge {
  api: Api
  onEvent(cb: (e: MainEvent) => void): () => void
}
