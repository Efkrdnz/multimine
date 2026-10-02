// Everything that crosses the IPC boundary or lands on disk is described here.

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORTS)[number]

/** Where an agent's turns are run. CLI kinds ride a subscription login; the rest take an API key. */
export const PROVIDERS = [
  'claude-cli',
  'codex-cli',
  'anthropic',
  'openai',
  'google',
  'groq',
  'xai',
  'openrouter',
  'compatible',
  'mock'
] as const
export type ProviderKind = (typeof PROVIDERS)[number]

/** chat: talks only. read: may read the project. write: may edit it. */
export const PERMISSIONS = ['chat', 'read', 'write'] as const
export type Permission = (typeof PERMISSIONS)[number]

export type Role =
  | 'mastermind'
  | 'planner'
  | 'implementer'
  | 'designer'
  | 'brainstormer'
  | 'context-handler'
  | 'asset-creator'
  | 'critic'
  | 'custom'

export interface AgentSpec {
  /** File slug: `.multimine/agents/<id>.md`. Stable once created. */
  id: string
  name: string
  role: Role
  provider: ProviderKind
  model: string
  effort: Effort
  color: string
  permissions: Permission
  /** External MCP server ids this agent may use. */
  mcp: string[]
  /** Work handed to a gated agent needs an approved plan first. */
  gated: boolean
  /** Claude CLI only: start every turn in plan mode. */
  planMode: boolean
  /**
   * Say yes to every permission prompt this agent raises. Pushing, publishing and destroying
   * history still ask (as a balloon over the agent). Off: every prompt asks.
   */
  autoApprove: boolean
  /** The purpose prompt: the markdown body of the agent file. */
  purpose: string
}

export type AgentStatus = 'idle' | 'thinking' | 'working' | 'waiting' | 'error'

export interface ToolCallView {
  id: string
  name: string
  input: unknown
  output?: string
  status: 'running' | 'done' | 'error'
}

export interface MediaItem {
  id: string
  kind: 'image' | 'video' | 'model' | 'audio'
  /** Absolute path on disk, under `.multimine/media/`. */
  path: string
  /** Where it came from: an MCP tool name or a URL. */
  source: string
  agentId: string
  ts: number
  title?: string
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  costUsd?: number
}

export interface ChatMessage {
  id: string
  agentId: string
  role: 'user' | 'assistant' | 'system'
  /** 'user', or the id of the agent that sent this message in. */
  from: string
  text: string
  thinking?: string
  tools?: ToolCallView[]
  media?: MediaItem[]
  ts: number
  streaming?: boolean
  error?: string
  usage?: Usage
}

export type BusKind =
  | 'message'
  | 'delegate'
  | 'report'
  | 'question'
  | 'answer'
  | 'approval'
  | 'critique'
  | 'context'
  | 'create'

export interface BusEvent {
  id: string
  ts: number
  kind: BusKind
  from: string
  to: string
  summary: string
}

/** A conversation in progress: `to` is working on something `from` handed it, or `from` waits on `to`. */
export interface Channel {
  from: string
  to: string
  kind: BusKind
}

export interface QuestionOption {
  label: string
  description?: string
}

export interface Question {
  question: string
  header?: string
  options: QuestionOption[]
  multiSelect?: boolean
}

export interface InboxItem {
  id: string
  ts: number
  kind: 'question' | 'approval'
  askedBy: string
  title: string
  questions?: Question[]
  planMd?: string
  status: 'pending' | 'answered' | 'auto'
  /** question text -> answer */
  answers?: Record<string, string>
  approved?: boolean
  note?: string
  /** Why Mastermind answered on the user's behalf. */
  autoReason?: string
  /** A quick allow/deny for one action (a command, a push), shown as a balloon over the agent. */
  permission?: boolean
}

export interface SessionMeta {
  id: string
  name: string
  created: number
  updated: number
  /** agent id -> provider session id (Claude session_id, Codex thread id). */
  resume: Record<string, string>
}

export interface McpServerConfig {
  id: string
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

export interface CouncilConfig {
  size: number
  provider: ProviderKind
  model: string
  effort: Effort
  lenses: string[]
  rounds: 1 | 2
}

export interface ModelEntry {
  id: string
  label: string
}

export interface EconomySettings {
  /** The master switch for saving tokens. */
  enabled: boolean
  /** Tell every agent to keep answers and reports short. */
  concise: boolean
  /** Let Mastermind run light and standard tasks on a cheaper model, for that task only. */
  downshift: boolean
  /** Per provider: the model a light and a standard task run on. */
  tiers: Partial<Record<ProviderKind, { light?: string; standard?: string }>>
}

export interface AppSettings {
  automation: boolean
  economy: EconomySettings
  /** How long a handoff blocks its caller before the report is delivered later instead. */
  handoffWaitMinutes: number
  council: CouncilConfig
  /** Provider -> base URL override (compatible, openrouter, ollama...). */
  baseUrls: Partial<Record<ProviderKind, string>>
  catalog: Partial<Record<ProviderKind, ModelEntry[]>>
  mcpServers: McpServerConfig[]
  recentProjects: string[]
  claudePath?: string
  codexPath?: string
}

export interface CouncilCritic {
  id: string
  lens: string
  status: 'thinking' | 'done' | 'error'
}

export interface ProjectInfo {
  dir: string
  name: string
  multimineMd: string
  agents: AgentSpec[]
  layout: Record<string, { x: number; y: number }>
}

export interface GitFile {
  path: string
  /** The old path of a rename. */
  from?: string
  /** Porcelain status letters: index (staged side) and worktree. */
  index: string
  worktree: string
  staged: boolean
  untracked: boolean
}

export interface GitStatus {
  isRepo: boolean
  branch: string
  upstream?: string
  ahead: number
  behind: number
  remote?: string
  files: GitFile[]
}

export interface GitCommit {
  hash: string
  short: string
  author: string
  when: string
  subject: string
}

export interface GhItem {
  number: number
  title: string
  url: string
  author: string
  updated: string
  head?: string
  base?: string
  draft: boolean
  labels: string[]
}

export interface CliStatus {
  installed: boolean
  version?: string
  loggedIn?: boolean
  detail?: string
}

/** Pushed from main to the renderer. */
export type MainEvent =
  | { type: 'project'; project: ProjectInfo | null }
  | { type: 'sessions'; sessions: SessionMeta[]; active: string | null }
  | { type: 'chat-reset'; chats: Record<string, ChatMessage[]> }
  | { type: 'chat-upsert'; message: ChatMessage }
  | { type: 'status'; agentId: string; status: AgentStatus; activity?: string; temp?: { model: string; effort: Effort; difficulty: string } }
  | { type: 'talk'; agentId: string }
  | { type: 'bus'; event: BusEvent }
  | { type: 'channels'; channels: Channel[] }
  | { type: 'bus-reset'; events: BusEvent[] }
  | { type: 'inbox'; items: InboxItem[] }
  | { type: 'media'; items: MediaItem[] }
  | { type: 'council'; critics: CouncilCritic[] }
  | { type: 'settings'; settings: AppSettings }
  | { type: 'usage'; total: Usage }
  | { type: 'toast'; level: 'info' | 'error'; text: string }

export const MASTERMIND_ID = 'mastermind'
