import type { z } from 'zod'
import type { AgentSpec, McpServerConfig, Question } from '@shared/types'

/** What a tool returns: text for the model, plus any media it produced. */
export interface ToolOutput {
  text: string
  isError?: boolean
}

/**
 * One tool, written once and handed to every provider: as an AI SDK tool for API agents and as an
 * MCP tool on the local bus server for CLI agents.
 */
export interface ToolDef {
  name: string
  description: string
  shape: z.ZodRawShape
  /** Raw JSON schema instead of a zod shape (external MCP tools proxied to API agents). */
  jsonSchema?: Record<string, unknown>
  handler: (args: Record<string, unknown>) => Promise<ToolOutput>
}

export interface HistoryItem {
  role: 'user' | 'assistant'
  text: string
}

export interface TurnRequest {
  agent: AgentSpec
  system: string
  history: HistoryItem[]
  prompt: string
  cwd: string
  /** Provider session to continue (Claude session_id / Codex thread id). */
  resumeId?: string
  /** In-process tools (API and mock agents). */
  tools: ToolDef[]
  /** URL of this agent's endpoint on the local Multimine MCP bus (CLI agents). */
  busUrl?: string
  /** External MCP servers assigned to this agent (CLI agents get them as config). */
  externalMcp: McpServerConfig[]
  apiKey?: string
  baseUrl?: string
  executable?: string
  signal: AbortSignal
  /** Called when a CLI's own question tool fires (Claude plan mode's AskUserQuestion). */
  ask: (questions: Question[]) => Promise<Record<string, string>>
  /** Called when a CLI wants to leave plan mode with a plan; resolve true to let it proceed. */
  approvePlan: (planMd: string) => Promise<{ approved: boolean; note?: string }>
  /**
   * Asks the user to allow one action; resolves true to allow. `always` marks the actions that
   * ask even with auto-approve on (pushing, publishing, destroying history).
   */
  approveAction: (title: string, detail: string, always?: boolean) => Promise<boolean>
}

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool-start'; id: string; name: string; input: unknown }
  | { type: 'tool-end'; id: string; output: string; isError?: boolean }
  | { type: 'resume'; id: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd?: number }
  | { type: 'error'; message: string }
  /** The provider's own word on how close its user is to a usage limit (Claude subscriptions). */
  | { type: 'limit'; state: 'ok' | 'near' | 'exhausted'; resetsAt?: number; detail?: string }

export interface ProviderAdapter {
  run(req: TurnRequest): AsyncIterable<AgentEvent>
}
