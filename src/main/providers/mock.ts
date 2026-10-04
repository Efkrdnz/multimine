import type { AgentEvent, ProviderAdapter, ToolDef, TurnRequest } from './types'

export interface MockStep {
  text?: string
  /** args may be computed from the outputs of the earlier tool calls in this turn. */
  tool?: { name: string; args: Record<string, unknown> | ((outputs: string[]) => Record<string, unknown>) }
  /** A provider event as it is, for tests of what the engine does with one (a sub-agent's step, a heartbeat). */
  event?: AgentEvent
}

/** A script decides what a mock agent does with a prompt. Tests inject one; the app uses the default. */
export type MockScript = (req: TurnRequest) => MockStep[] | Promise<MockStep[]>

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * The default mock: a friendly offline stand-in. A line `/tool <name> <json>` in the prompt calls
 * that tool for real, so the whole bus can be driven without any AI behind it.
 */
export const defaultMockScript: MockScript = (req) => {
  const steps: MockStep[] = []
  for (const line of req.prompt.split('\n')) {
    // `/think ...` and `/say ...` stand in for a model's reasoning and its answer, in order
    const said = /^\s*\/(think|say)\s+(.+)$/.exec(line)
    if (said) {
      steps.push(said[1] === 'think' ? { event: { type: 'thinking', delta: said[2] } } : { text: said[2] })
      continue
    }
    const m = /^\s*\/tool\s+(\S+)\s*(\{.*\})?\s*$/.exec(line)
    if (m) {
      let args: Record<string, unknown> = {}
      try {
        args = m[2] ? JSON.parse(m[2]) : {}
      } catch {
        args = {}
      }
      steps.push({ tool: { name: m[1], args } })
    }
  }
  if (steps.length) return steps
  const first = req.prompt.split('\n').find((l) => l.trim()) ?? ''
  return [
    {
      text:
        `**${req.agent.name}** here (mock provider - no AI attached).\n\n` +
        `You said: _${first.slice(0, 160)}_\n\n` +
        `Give me a real brain in the agent editor: pick a provider (Claude or Codex subscription, or an API key), a model and an effort. ` +
        `Tools I could use right now: ${req.tools.map((t) => `\`${t.name}\``).join(', ') || 'none'}.`
    }
  ]
}

export class MockProvider implements ProviderAdapter {
  constructor(private readonly script: MockScript = defaultMockScript, private readonly delayMs = 12) {}

  async *run(req: TurnRequest): AsyncIterable<AgentEvent> {
    const steps = await this.script(req)
    const outputs: string[] = []
    let n = 0
    for (const step of steps) {
      if (req.signal.aborted) return
      if (step.event) yield step.event
      if (step.tool) {
        const id = `mock-${++n}`
        const def: ToolDef | undefined = req.tools.find((t) => t.name === step.tool!.name)
        const args = typeof step.tool.args === 'function' ? step.tool.args(outputs) : step.tool.args
        yield { type: 'tool-start', id, name: step.tool.name, input: args }
        if (!def) {
          outputs.push(`No tool named ${step.tool.name}`)
          yield { type: 'tool-end', id, output: outputs[outputs.length - 1], isError: true }
          continue
        }
        try {
          const out = await def.handler(args)
          outputs.push(out.text)
          yield { type: 'tool-end', id, output: out.text, isError: out.isError }
        } catch (e) {
          outputs.push(String((e as Error).message ?? e))
          yield { type: 'tool-end', id, output: outputs[outputs.length - 1], isError: true }
        }
      }
      if (step.text) {
        // stream it in word-sized pieces so the UI's mouth and typing animation have something to do
        const parts = step.text.match(/\S+\s*|\s+/g) ?? [step.text]
        for (const p of parts) {
          if (req.signal.aborted) return
          yield { type: 'text', delta: p }
          if (this.delayMs) await sleep(this.delayMs)
        }
      }
    }
    yield { type: 'usage', inputTokens: Math.ceil((req.system.length + req.prompt.length) / 4), outputTokens: 40 }
  }
}
