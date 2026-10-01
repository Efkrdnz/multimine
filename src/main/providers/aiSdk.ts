import { jsonSchema, stepCountIs, streamText, tool, type ModelMessage, type ToolSet, type LanguageModel } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createGroq } from '@ai-sdk/groq'
import { createXai } from '@ai-sdk/xai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { z } from 'zod'
import { clampEffort, THINKING_BUDGET } from '@shared/effort'
import type { Effort, ProviderKind } from '@shared/types'
import type { AgentEvent, ProviderAdapter, ToolDef, TurnRequest } from './types'

const MAX_STEPS = 40

export function languageModel(provider: ProviderKind, model: string, apiKey?: string, baseUrl?: string): LanguageModel {
  switch (provider) {
    case 'anthropic':
      return createAnthropic({ apiKey })(model)
    case 'openai':
      return createOpenAI({ apiKey })(model)
    case 'google':
      return createGoogleGenerativeAI({ apiKey })(model)
    case 'groq':
      return createGroq({ apiKey })(model)
    case 'xai':
      return createXai({ apiKey })(model)
    case 'openrouter':
      return createOpenAICompatible({ name: 'openrouter', apiKey, baseURL: baseUrl || 'https://openrouter.ai/api/v1' })(model)
    case 'compatible':
      return createOpenAICompatible({ name: 'compatible', apiKey: apiKey || 'none', baseURL: baseUrl || 'http://localhost:11434/v1' })(model)
    default:
      throw new Error(`${provider} is not an API provider`)
  }
}

/** Effort, expressed the way each vendor takes it. Exported for the effort-mapping tests. */
export function effortOptions(provider: ProviderKind, effort: Effort): { providerOptions?: Record<string, Record<string, any>>; maxOutputTokens?: number } {
  const e = clampEffort(provider, effort)
  switch (provider) {
    case 'anthropic': {
      const budget = THINKING_BUDGET[e]
      return { providerOptions: { anthropic: { thinking: { type: 'enabled', budgetTokens: budget } } }, maxOutputTokens: budget + 8192 }
    }
    case 'google':
      return { providerOptions: { google: { thinkingConfig: { thinkingBudget: THINKING_BUDGET[e] > 32768 ? 32768 : THINKING_BUDGET[e], includeThoughts: true } } } }
    case 'openai':
      return { providerOptions: { openai: { reasoningEffort: e, reasoningSummary: 'auto' } } }
    case 'groq':
      return { providerOptions: { groq: { reasoningEffort: e } } }
    case 'xai':
      return { providerOptions: { xai: { reasoningEffort: e } } }
    case 'openrouter':
      return { providerOptions: { openrouter: { reasoning: { effort: e } } } }
    default:
      return {}
  }
}

export function toAiTools(defs: ToolDef[]): ToolSet {
  const set: ToolSet = {}
  for (const d of defs) {
    set[d.name] = tool({
      description: d.description,
      inputSchema: d.jsonSchema ? jsonSchema(d.jsonSchema as any) : z.object(d.shape),
      execute: async (args: unknown) => {
        const out = await d.handler((args ?? {}) as Record<string, unknown>)
        return out.isError ? `ERROR: ${out.text}` : out.text
      }
    } as any)
  }
  return set
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

/** Every API-key provider: one streaming, tool-calling loop through the Vercel AI SDK. */
export class AiSdkProvider implements ProviderAdapter {
  async *run(req: TurnRequest): AsyncIterable<AgentEvent> {
    const { agent } = req
    let model: LanguageModel
    try {
      model = languageModel(agent.provider, agent.model, req.apiKey, req.baseUrl)
    } catch (e) {
      yield { type: 'error', message: (e as Error).message }
      return
    }
    const messages: ModelMessage[] = [...req.history.map((h) => ({ role: h.role, content: h.text }) as ModelMessage), { role: 'user', content: req.prompt }]
    const tools = toAiTools(req.tools)
    const { providerOptions, maxOutputTokens } = effortOptions(agent.provider, agent.effort)
    const result = streamText({
      model,
      system: req.system,
      messages,
      tools: Object.keys(tools).length ? tools : undefined,
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: req.signal,
      providerOptions,
      maxOutputTokens
    })
    try {
      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-delta':
            yield { type: 'text', delta: part.text }
            break
          case 'reasoning-delta':
            yield { type: 'thinking', delta: part.text }
            break
          case 'tool-call':
            yield { type: 'tool-start', id: part.toolCallId, name: part.toolName, input: part.input }
            break
          case 'tool-result':
            yield { type: 'tool-end', id: part.toolCallId, output: stringify(part.output) }
            break
          case 'tool-error':
            yield { type: 'tool-end', id: part.toolCallId, output: stringify((part as any).error?.message ?? part.error), isError: true }
            break
          case 'finish':
            yield { type: 'usage', inputTokens: part.totalUsage.inputTokens ?? 0, outputTokens: part.totalUsage.outputTokens ?? 0 }
            break
          case 'error':
            yield { type: 'error', message: stringify((part.error as any)?.message ?? part.error) }
            break
        }
      }
    } catch (e) {
      if (!req.signal.aborted) yield { type: 'error', message: (e as Error).message ?? String(e) }
    }
  }
}

/** The vendor's live model list, for "Refresh models" in Settings. */
export async function listVendorModels(provider: ProviderKind, apiKey?: string, baseUrl?: string): Promise<{ id: string; label: string }[]> {
  const get = async (url: string, headers: Record<string, string>) => {
    const res = await fetch(url, { headers })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    return (await res.json()) as any
  }
  switch (provider) {
    case 'anthropic': {
      const j = await get('https://api.anthropic.com/v1/models?limit=100', { 'x-api-key': apiKey ?? '', 'anthropic-version': '2023-06-01' })
      return j.data.map((m: any) => ({ id: m.id, label: m.display_name ?? m.id }))
    }
    case 'openai':
    case 'xai':
    case 'groq':
    case 'openrouter':
    case 'compatible': {
      const base =
        provider === 'openai'
          ? 'https://api.openai.com/v1'
          : provider === 'xai'
            ? 'https://api.x.ai/v1'
            : provider === 'groq'
              ? 'https://api.groq.com/openai/v1'
              : baseUrl || ''
      const j = await get(`${base}/models`, apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      return (j.data ?? []).map((m: any) => ({ id: m.id, label: m.name ?? m.id })).sort((a: any, b: any) => a.id.localeCompare(b.id))
    }
    case 'google': {
      const j = await get(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(apiKey ?? '')}`, {})
      return (j.models ?? [])
        .filter((m: any) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
        .map((m: any) => ({ id: String(m.name).replace(/^models\//, ''), label: m.displayName ?? m.name }))
    }
    default:
      throw new Error(`${provider} has no model list endpoint`)
  }
}
