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

/**
 * One chat: a conversation with one agent, and the settings its turns run on. A project has any
 * number of them, each with its own provider and model; several can run at once.
 */
export interface AgentSpec {
  /** Stable once created: the chat's folder under `.multimine/chats/`. */
  id: string
  name: string
  provider: ProviderKind
  model: string
  effort: Effort
  permissions: Permission
  /** External MCP server ids this chat may use. */
  mcp: string[]
  /** Claude CLI only: start every turn in plan mode. */
  planMode: boolean
  /** Where this chat continues when its provider is out of usage, in order. Empty: the default chain. */
  fallback: FallbackHop[]
  /** Switch onto a pay-per-use API key without asking first. */
  fallbackPaidOk: boolean
  /**
   * Say yes to every permission prompt this chat raises. Pushing, publishing and destroying
   * history still ask. Off: every edit and command asks.
   */
  autoApprove: boolean
  created: number
  updated: number
}

/** What a new chat starts with (Settings -> General). */
export type ChatDefaults = Pick<AgentSpec, 'provider' | 'model' | 'effort' | 'permissions' | 'autoApprove'>

export interface FallbackHop {
  provider: ProviderKind
  model: string
  effort: Effort
}

export type AgentStatus = 'idle' | 'thinking' | 'working' | 'waiting' | 'error'

export interface ToolCallView {
  id: string
  name: string
  input: unknown
  output?: string
  status: 'running' | 'done' | 'error'
  startedAt?: number
  endedAt?: number
  /** The latest sign of life (a heartbeat or a sub-agent step) while it runs. */
  beatAt?: number
  /** A sub-agent's own steps, nested under the call that started it (the latest ones). */
  children?: ToolCallView[]
  /** How many steps the sub-agent has taken in all, including ones no longer kept. */
  childCount?: number
  /** A sub-agent's own word on what it is doing. */
  progress?: string
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

/** One Claude subscription usage window, as last reported. */
export interface PlanWindow {
  /** five_hour, seven_day, seven_day_opus... */
  window: string
  label: string
  /** 0..1 */
  used: number
  /** When it resets, ms since the epoch. */
  resetsAt?: number
  status: 'ok' | 'near' | 'exhausted'
  /** When this reading came in. */
  at: number
}

export interface Usage {
  /** Fresh input: what was not already in the prompt cache. */
  inputTokens: number
  outputTokens: number
  /** Context read back from the cache (cheap, but sent again on every call) and written to it. */
  cacheRead?: number
  cacheWrite?: number
  /** Model calls made. */
  calls?: number
  /** How large the conversation was at the last call: what every next step has to read again. */
  context?: number
  costUsd?: number
}

/** One stretch of a reply: thinking, text, or a tool call (by its id in `tools`). */
export interface Segment {
  kind: 'thinking' | 'text' | 'tool'
  text?: string
  toolId?: string
  /** When it started and, once something else began, when it ended. */
  at: number
  end?: number
}

export interface ChatMessage {
  id: string
  agentId: string
  role: 'user' | 'assistant' | 'system'
  /** 'user', the chat itself (a reply), 'multimine' (a note), or the tool that sent it in: `tool:<name>`. */
  from: string
  text: string
  thinking?: string
  tools?: ToolCallView[]
  /** The reply in the order it happened: thinking, text and tool calls (see shared/segments). */
  segments?: Segment[]
  /** A line in the chat where the agent started a new conversation, with the recap it was given. */
  fresh?: boolean
  recap?: string
  media?: MediaItem[]
  ts: number
  streaming?: boolean
  error?: string
  usage?: Usage
  /** A slash command the user typed (`/table ...`): the text stays as typed, the turn gets the command's prompt. */
  command?: 'table'
  /** A table a chat saved, shown as a card in the chat. */
  table?: TableCard
}

/** A saved table as a chat shows it: what it holds, how much of it is linked, and its first rows. */
export interface TableCard {
  id: string
  name: string
  rows: number
  columns: number
  links: number
  verified: number
  broken: string[]
  preview: { columns: { key: string; label: string }[]; rows: Record<string, string>[] }
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
  /** A quick allow/deny for one action (a command, a push), shown as a balloon over the agent. */
  permission?: boolean
  /** Offers a third answer, "always", remembered for the asking chat (e.g. paid fallbacks). */
  alwaysLabel?: string
  always?: boolean
  /**
   * The watchdog paused this agent: it was repeating itself or ran past its budget. Approve lets it
   * continue, deny with a note tells it what to do instead, deny without one stops the task.
   */
  watchdog?: boolean
}

export interface McpServerConfig {
  id: string
  name: string
  /** Set when a plugin brought this server: it comes and goes with the plugin. */
  pluginId?: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
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
  /** Rate each message with one small call and run easy ones on the light tier (off: only on Quick). */
  autoRate: boolean
  /** Per provider: the model a light and a standard task run on. */
  tiers: Partial<Record<ProviderKind, { light?: string; standard?: string }>>
}

export const PLUGIN_PERMISSIONS = ['team:read', 'agents:message', 'project:read', 'project:write', 'media:read', 'media:write', 'network'] as const
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number]

export const PLUGIN_API_VERSION = 2

export interface PluginManifest {
  id: string
  name: string
  version: string
  api: number
  description: string
  /** A lucide icon name and a two-colour gradient, or an image file in the plugin folder. */
  icon: { glyph: string; gradient: [string, string] } | { file: string }
  /** The page the tool window shows (web plugins). */
  entry?: string
  window: { width: number; height: number }
  permissions: PluginPermission[]
  /** An MCP server that gives agents the plugin's tools. ${PLUGIN_DIR} is replaced with the plugin folder. */
  mcp?: { command: string; args?: string[]; env?: Record<string, string> }
}

export interface PluginInfo {
  manifest: PluginManifest
  source: 'builtin' | 'user' | 'project'
  /** Native plugins ship inside the app and render as part of it (still through the plugin API). */
  native: boolean
  dir: string
  enabled: boolean
  granted: PluginPermission[]
  /** Permissions it asks for that the user has not granted yet. */
  pending: PluginPermission[]
}

export interface PluginSettings {
  enabled: boolean
  granted: PluginPermission[]
}

/** The loop guard: when to pause an agent and ask the user. */
export interface WatchdogSettings {
  enabled: boolean
  /** Launches of the same app with no file changed in between before it asks. */
  launchRepeats: number
  /** Identical calls (with no edit between) before it asks. */
  exactRepeats: number
  /** Times a short cycle of calls may repeat. */
  cycleRepeats: number
  /** Minutes a turn may run before it asks. */
  budgetMinutes: number
  /** Millions of weighted tokens (cache reads a tenth, output five times) a turn may spend before it asks; 0: no limit. */
  usageBudget: number
  /** Minutes of silence before an agent is marked quiet. */
  quietMinutes: number
  /** Regular expressions for commands that launch an app, a game or a server. */
  launchPatterns: string[]
}

/** Desktop notifications when an agent needs the user. */
export interface NotificationSettings {
  enabled: boolean
  /** Also while the Multimine window is in front (off: only when you are elsewhere). */
  whenFocused: boolean
  /** Also when a chat finishes its turn. */
  onFinish: boolean
}

export interface AppSettings {
  /** What a new chat starts with. */
  chatDefaults: ChatDefaults
  /** Set once the user picks the defaults themselves: start-up detection then leaves them alone. */
  chatDefaultsChosen?: boolean
  notifications: NotificationSettings
  watchdog: WatchdogSettings
  plugins: Record<string, PluginSettings>
  /** The fallback chain for agents that have none of their own. */
  defaultFallback: FallbackHop[]
  economy: EconomySettings
  /** Provider -> base URL override (compatible, openrouter, ollama...). */
  baseUrls: Partial<Record<ProviderKind, string>>
  catalog: Partial<Record<ProviderKind, ModelEntry[]>>
  mcpServers: McpServerConfig[]
  recentProjects: string[]
  claudePath?: string
  codexPath?: string
}

export interface ProjectInfo {
  dir: string
  name: string
  multimineMd: string
  /** The project's chats, most recently used first. */
  agents: AgentSpec[]
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

export interface IdeEntry {
  name: string
  /** Relative to the project root, with forward slashes. */
  path: string
  dir: boolean
}

export interface IdeHit {
  path: string
  line?: number
  text?: string
}

export type TerminalKind = 'shell' | 'claude' | 'codex'

export interface TerminalInfo {
  id: string
  kind: TerminalKind
  title: string
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
  | { type: 'chat-reset'; chats: Record<string, ChatMessage[]> }
  | { type: 'chat-upsert'; message: ChatMessage }
  | {
      type: 'status'
      agentId: string
      status: AgentStatus
      activity?: string
      /** What the activity is acting on: the command, the file, the pattern. */
      detail?: string
      /** When the current activity began, for a ticking clock. */
      since?: number
      /** Set when the agent has been silent, or one step has run, for a long time: why. */
      quiet?: string
      /** This turn runs on a cheaper model than the chat's own (Quick, or economy's rating). */
      temp?: { model: string; effort: Effort; difficulty: string }
      fallback?: { provider: ProviderKind; model: string; reason: string }
    }
  | { type: 'provider-health'; health: Record<string, { state: 'near' | 'exhausted'; until: number; reason: string }> }
  | { type: 'terminal-data'; id: string; data: string }
  | { type: 'terminal-exit'; id: string; code: number }
  | { type: 'file-changed'; path: string; kind: 'added' | 'changed' | 'deleted' }
  | { type: 'plugins'; plugins: PluginInfo[]; broken: { dir: string; errors: string[] }[] }
  | { type: 'inbox'; items: InboxItem[] }
  /** A notification was clicked: bring up what it was about. */
  | { type: 'reveal'; itemId?: string; agentId?: string }
  | { type: 'media'; items: MediaItem[] }
  | { type: 'settings'; settings: AppSettings }
  | { type: 'usage'; total: Usage; byAgent?: Record<string, Usage> }
  /** The Claude plan's usage windows; a warning when one has just crossed 90%. */
  | { type: 'plan-limits'; windows: PlanWindow[]; warning?: string }
  /** Open a project file in the IDE window, at a line. */
  | { type: 'ide-open'; path: string; line?: number }
  /** A table was saved by a chat: the Tables tool reloads it. */
  | { type: 'tables-changed'; id: string }
  | { type: 'toast'; level: 'info' | 'error'; text: string }
