import { clampEffort } from './effort'
import type { AgentSpec, Effort, EconomySettings, ProviderKind } from './types'

export const DIFFICULTIES = ['light', 'standard', 'heavy'] as const
export type Difficulty = (typeof DIFFICULTIES)[number]

/** A model and effort an agent runs one task on instead of its own; it reverts when the task ends. */
export interface TempModel {
  model: string
  effort: Effort
  difficulty: Difficulty
}

const ORDER: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const EFFORT_CAP: Record<Exclude<Difficulty, 'heavy'>, Effort> = { light: 'low', standard: 'medium' }

/** What each provider steps down to. Editable in Settings -> Economy; a blank keeps the agent's own model. */
export const DEFAULT_TIERS: Partial<Record<ProviderKind, { light?: string; standard?: string }>> = {
  'claude-cli': { light: 'claude-haiku-4-5-20251001', standard: 'claude-sonnet-5-5' },
  anthropic: { light: 'claude-haiku-4-5-20251001', standard: 'claude-sonnet-5-5' },
  google: { light: 'gemini-2.5-flash', standard: 'gemini-2.5-flash' },
  'codex-cli': {},
  openai: {}
}

/**
 * The cheaper model and effort for a message rated `difficulty` (Quick asks for `light`), or null
 * when the chat should run as configured. It only ever steps down: a heavy message, or a tier that
 * is not cheaper than what the chat already uses, changes nothing.
 */
export function downshift(agent: Pick<AgentSpec, 'provider' | 'model' | 'effort'>, difficulty: Difficulty | undefined, eco: Pick<EconomySettings, 'tiers'>): TempModel | null {
  if (!difficulty || difficulty === 'heavy') return null
  const tier = eco.tiers[agent.provider] ?? {}
  const model = (difficulty === 'light' ? tier.light || tier.standard : tier.standard) || agent.model
  const cap = EFFORT_CAP[difficulty]
  const effort = clampEffort(agent.provider, ORDER.indexOf(agent.effort) > ORDER.indexOf(cap) ? cap : agent.effort)
  if (model === agent.model && effort === agent.effort) return null
  return { model, effort, difficulty }
}

export const CONCISE_RULES = `## Economy mode
Tokens are being saved. Be brief: no preamble, no restating the task, no summaries of what you are
about to do. Answer in the fewest words that are complete; use bullet points over prose. Read only
the files you need, and the parts of them you need. When you finish: what changed, where, and
anything left undone - nothing else.`

/** What the light tier is asked when economy rates a message before it runs. */
export const RATE_SYSTEM = `Rate how hard a coding request is. Answer with one word only:
light - routine, mechanical work: renames, moving values, small edits, lookups, short questions
standard - ordinary features and fixes
heavy - design, tricky debugging, wide refactors, or anything you are unsure about`

/** The rating in a light-tier answer; anything unclear counts as heavy, so nothing runs cheaper by mistake. */
export function parseRating(answer: string): Difficulty {
  const word = /\b(light|standard|heavy)\b/i.exec(answer)?.[1]?.toLowerCase()
  return (DIFFICULTIES as readonly string[]).includes(word ?? '') ? (word as Difficulty) : 'heavy'
}
