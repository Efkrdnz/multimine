import type { Crash } from './run/crash'
import type { MessageModes } from './modes'
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
  /** Every turn starts in plan mode: it plans and asks the user to approve before it changes anything. */
  planMode: boolean
  /** Coop: it works with the user as a partner, asking them about everything that shapes the result. */
  coop: boolean
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
  /** A slash command the user typed (`/table ...`, `/plugin ...`): the text stays as typed, the turn gets the command's prompt. */
  command?: 'table' | 'plugin' | 'idea'
  /** Said to Tuesday on a phone call, or on Telegram. */
  via?: 'phone' | 'telegram'
  /** `/plan`, `/coop` (or a tool asking for them): this message's own modes, over the chat's. */
  modes?: MessageModes
  /** A table a chat saved, shown as a card in the chat. */
  table?: TableCard
  /** Ideas a chat saved to the Idea Book for the user to review, shown as a card. */
  ideas?: { count: number; titles: string[] }
  /** The files this reply's turn changed, with the snapshots to diff or undo them. */
  changes?: TurnChanges
  /** Images the user attached to this message. */
  attachments?: Attachment[]
}

/** An image attached to a message, saved in the project's `.multimine/media/attachments/`. */
export interface Attachment {
  /** Relative to the project. */
  path: string
  mime: string
  /** The file's own name, or what a pasted image was called. */
  name: string
  bytes: number
  w?: number
  h?: number
}

/** An image the window sends with a message, before it is saved. */
export interface ImageUpload {
  name: string
  mime: string
  /** Base64, no data: prefix. */
  data: string
  w?: number
  h?: number
}

/** A file one turn changed. */
export interface FileChange {
  path: string
  status: 'A' | 'M' | 'D'
  add: number
  del: number
  binary?: boolean
}

/** What one turn did to the project: snapshots of the files before and after it, in Multimine's own history. */
export interface TurnChanges {
  before: string
  after: string
  files: FileChange[]
  /** Files changed beyond the ones listed. */
  more?: number
  /** Other chats that were working at the same time: their edits may be in here too. */
  overlapped?: string[]
  /** When the user undid it. */
  undone?: number
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
  /** Pushing, publishing, destroying history: only the user can allow it, never Tuesday on their behalf. */
  hardStop?: boolean
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
  /** The project tabs open when Multimine last closed, and the one on screen. */
  openProjects?: string[]
  activeProject?: string
  claudePath?: string
  codexPath?: string
  tuesday: TuesdaySettings
  phone: PhoneSettings
  telegram: TelegramSettings
}

/**
 * Talking to Tuesday on Telegram, through the user's own bot. The bot token is kept with the API
 * keys (encrypted); the PIN for hard stops is the phone's.
 */
export interface TelegramSettings {
  enabled: boolean
  /** The user's own Telegram chat with the bot, once paired: nobody else is answered. */
  ownerChatId?: number
  ownerName?: string
  /** When a chat waits on the user: message them when away from the computer, always, or never. */
  notify: 'away' | 'always' | 'off'
  awayMinutes: number
  /** Messages arrive silently at night (local time). */
  quietHours: { enabled: boolean; from: string; to: string }
  /** Answer a voice note with a voice note (with an OpenAI key). */
  voiceReplies: boolean
}

/** Where the Telegram connection stands. */
export interface TelegramState {
  status: 'off' | 'starting' | 'ready' | 'error'
  detail?: string
  /** The bot's @username. */
  bot?: string
  /** Who it is paired with. */
  paired?: string
  /** The code to send the bot to pair, while it is not paired. */
  pairCode?: string
  secrets: { token: boolean; pin: boolean }
  /** What turns voice notes into text (the key it uses), if anything. */
  voice: 'groq' | 'openai' | 'google' | null
}

/**
 * Talking to Tuesday on the phone, through a Twilio number. The auth token and the PIN are kept
 * with the API keys (encrypted), not here.
 */
export interface PhoneSettings {
  enabled: boolean
  /** The Twilio account (AC...). */
  accountSid: string
  /** The Twilio number calls come in on and go out from (+15551234567). */
  twilioNumber: string
  /** The user's own phone: the only one that may call in, and the one Tuesday calls. */
  myNumber: string
  /** For speech recognition: 'en-US', 'en-GB', 'tr-TR'... */
  language: string
  /** A Twilio voice ('Polly.Joanna-Neural'); empty for Twilio's default in that language. */
  voice: string
  /** Call when a chat waits on the user and the computer has been idle for `awayMinutes`. */
  callWhenAway: boolean
  awayMinutes: number
  /** No calls at night (local time). */
  quietHours: { enabled: boolean; from: string; to: string }
  /** A public address the user runs themselves; empty: a free Cloudflare tunnel. */
  publicUrl: string
}

/** Where the phone connection stands. */
export interface PhoneState {
  status: 'off' | 'starting' | 'ready' | 'error'
  detail?: string
  /** The public address Twilio reaches Multimine at. */
  url?: string
  /** A call going on now. */
  call: { outbound: boolean; since: number } | null
  /** Which secrets are saved (never the secrets themselves). */
  secrets: { token: boolean; pin: boolean }
}

/**
 * Tuesday: the assistant above every chat and project. It runs on the provider and model chosen
 * here; any left out follow the new-chat defaults.
 */
export interface TuesdaySettings {
  enabled: boolean
  name: string
  provider?: ProviderKind
  model?: string
  effort?: Effort
}

/** Something a chat in any open project (or Tuesday) is waiting on the user for, with where it is. */
export interface WaitingItem {
  item: InboxItem
  /** The project it is in; null when Tuesday itself asks. */
  dir: string | null
  project: string
  chat: string
}

/** A line from Tuesday by the orb: a chat finished, failed or asks something. */
export interface TuesdayNotice {
  id: number
  kind: 'ask' | 'done' | 'error'
  text: string
  dir: string
  chatId: string
  /** What an 'ask' is about: the line goes once it is answered. */
  itemId?: string
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
/** The project's run button: what it starts, and how the last run went. */
export interface RunState {
  status: 'idle' | 'running' | 'exited'
  command: string
  startedAt?: number
  endedAt?: number
  code?: number | null
  signal?: string | null
  /** The user pressed Stop. */
  stopped?: boolean
  /** Errors and crashes found in the output, newest last. */
  problems: Crash[]
}

/** An open project's tab: which one is on screen, and what its chats and run are doing meanwhile. */
export interface ProjectTab {
  dir: string
  name: string
  active: boolean
  /** Chats working right now. */
  busy: number
  /** Questions and permissions waiting for the user. */
  waiting: number
  /** Its run button's game is running. */
  running: boolean
}

/** Where the app's own update stands. */
export interface UpdateState {
  /** unsupported: running from source, or a Mac build (unsigned apps cannot replace themselves there). */
  status: 'unsupported' | 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'ready' | 'error'
  /** The version running now. */
  current: string
  /** The version found or downloaded. */
  version?: string
  percent?: number
  error?: string
  checkedAt?: number
}

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
  | { type: 'reveal'; itemId?: string; agentId?: string; panel?: 'run'; dir?: string }
  /** The app's own update moved on: found, downloading, ready to install. */
  | { type: 'update'; state: UpdateState }
  /** The open projects (tabs) changed: one opened, closed or came on screen, or what one is doing changed. */
  | { type: 'projects'; projects: ProjectTab[] }
  | { type: 'media'; items: MediaItem[] }
  | { type: 'settings'; settings: AppSettings }
  | { type: 'usage'; total: Usage; byAgent?: Record<string, Usage> }
  /** The Claude plan's usage windows; a warning when one has just crossed 90%. */
  | { type: 'plan-limits'; windows: PlanWindow[]; warning?: string }
  /** Open a project file in the IDE window, at a line. */
  | { type: 'ide-open'; path: string; line?: number }
  /** A chat saved ideas to the Idea Book: the tool reloads. */
  | { type: 'ideas-changed' }
  /** A table was saved by a chat: the Tables tool reloads it. */
  | { type: 'tables-changed'; id: string }
  | { type: 'toast'; level: 'info' | 'error'; text: string }
  /** A chat installed (or updated) a tool it made: the window asks the user to allow it, then opens it. */
  | { type: 'plugin-installed'; id: string; chatId: string; update: boolean }
  /** The run button's process started, stopped, or found a problem. */
  | { type: 'run'; state: RunState }
  /** New lines of the running game's output; `reset` starts a new run's log. */
  | { type: 'run-output'; lines: string[]; reset?: boolean }
  /** Tuesday's conversation: one message changed, or all of it. */
  | { type: 'tuesday-upsert'; message: ChatMessage }
  | { type: 'tuesday-reset'; messages: ChatMessage[] }
  | { type: 'tuesday-status'; status: AgentStatus; activity?: string; detail?: string }
  /** Everything waiting on the user, in every open project. */
  | { type: 'tuesday-waiting'; items: WaitingItem[] }
  | { type: 'tuesday-notice'; notice: TuesdayNotice }
  /** Tuesday put something on screen: a chat or a tool of the project now on screen. */
  | { type: 'tuesday-show'; chatId?: string; tool?: string }
  | { type: 'phone'; state: PhoneState }
  | { type: 'telegram'; state: TelegramState }
