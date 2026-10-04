import { describe, expect, it } from 'vitest'
import { MOCK_DEFAULTS, newChat } from '@shared/chat'
import type { AgentSpec } from '@shared/types'
import { Channel, ClaudeCliProvider } from '../../src/main/providers/claudeCli'
import type { AgentEvent, TurnRequest } from '../../src/main/providers/types'

/** A stand-in Claude Code process: answers each message pushed on its prompt, in one long run. */
function fakeQuery() {
  const made: { options: any; turns: string[]; closed: boolean }[] = []
  let sid = 0
  const q = ({ prompt, options }: { prompt: any; options: any }) => {
    const me = { options, turns: [] as string[], closed: false }
    made.push(me)
    const out = new Channel<any>()
    const session = options.resume ?? `s${++sid}`
    options.abortController?.signal.addEventListener('abort', () => ((me.closed = true), out.end()))
    void (async () => {
      if (typeof prompt === 'string') {
        me.turns.push(prompt)
        out.push({ type: 'system', subtype: 'init', session_id: session })
        out.push({ type: 'result', subtype: 'success', usage: {}, total_cost_usd: 0.01, session_id: session })
        return out.end()
      }
      let first = true
      for await (const m of prompt) {
        me.turns.push(m.message.content)
        if (first) out.push({ type: 'system', subtype: 'init', session_id: session })
        first = false
        // thinking and text as the SDK streams them
        out.push({ type: 'stream_event', event: { type: 'message_start', message: { id: `m${me.turns.length}` } } })
        out.push({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'pondering' } } })
        out.push({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: `re: ${m.message.content}` } } })
        out.push({ type: 'assistant', message: { id: `m${me.turns.length}`, content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 10, output_tokens: 5 } } })
        if (m.message.content === 'use a tool') {
          const verdict = await options.canUseTool('Write', { file_path: 'a.txt' })
          out.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: verdict.behavior }] } })
        }
        out.push({ type: 'result', subtype: 'success', usage: {}, total_cost_usd: 0.01 * me.turns.length, session_id: session })
      }
      out.end()
    })()
    return Object.assign(out, { interrupt: async () => undefined })
  }
  return { q, made }
}

const agent = (patch: Partial<AgentSpec> = {}): AgentSpec => ({ ...newChat('impl', MOCK_DEFAULTS, { created: 1, updated: 1 }), provider: 'claude-cli', model: 'claude-opus-5-5', autoApprove: true, ...patch })

function request(prompt: string, patch: Partial<TurnRequest> = {}): TurnRequest {
  return {
    agent: agent(),
    system: 'sys',
    history: [],
    prompt,
    cwd: process.cwd(),
    tools: [],
    externalMcp: [],
    signal: new AbortController().signal,
    ask: async () => ({}),
    approvePlan: async () => ({ approved: true }),
    approveAction: async () => true,
    poolKey: 'impl|session1',
    ...patch
  }
}

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

const resumeOf = (evs: AgentEvent[]) => evs.find((e): e is Extract<AgentEvent, { type: 'resume' }> => e.type === 'resume')?.id

describe('warm Claude sessions', () => {
  it('serves follow-ups on one live process, with thinking shown and asked for', async () => {
    const f = fakeQuery()
    const p = new ClaudeCliProvider({ query: f.q as any })
    const first = await collect(p.run(request('hello')))
    expect(resumeOf(first)).toBe('s1')
    expect(first.filter((e) => e.type === 'thinking')).toEqual([{ type: 'thinking', delta: 'pondering' }])
    expect(first.filter((e) => e.type === 'text')).toEqual([{ type: 'text', delta: 're: hello' }])
    expect(first.find((e) => e.type === 'usage')).toMatchObject({ costUsd: 0.01, calls: 1 })
    const second = await collect(p.run(request('and again', { resumeId: 's1' })))
    expect(second.filter((e) => e.type === 'text')).toEqual([{ type: 'text', delta: 're: and again' }])
    // the session's running total is 0.02: this turn added 0.01
    expect((second.find((e) => e.type === 'usage') as any).costUsd).toBeCloseTo(0.01)
    expect(f.made).toHaveLength(1)
    expect(f.made[0].turns).toEqual(['hello', 'and again'])
    expect(f.made[0].options.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(f.made[0].options.settings.showThinkingSummaries).toBe(true)
    expect(p.warm).toBe(1)
    p.release()
    expect(p.warm).toBe(0)
    expect(f.made[0].closed).toBe(true)
  })

  it('reopens with resume when the agent changes, and starts fresh for a new task', async () => {
    const f = fakeQuery()
    const p = new ClaudeCliProvider({ query: f.q as any })
    await collect(p.run(request('one')))
    await collect(p.run(request('two', { resumeId: 's1', agent: agent({ effort: 'low' }) })))
    expect(f.made).toHaveLength(2)
    expect(f.made[0].closed).toBe(true)
    expect(f.made[1].options.resume).toBe('s1')
    expect(f.made[1].options.effort).toBe('low')
    // a delegated task asks for no session: the warm one is let go and a new one starts
    const fresh = await collect(p.run(request('new task', { agent: agent({ effort: 'low' }) })))
    expect(f.made).toHaveLength(3)
    expect(f.made[2].options.resume).toBeUndefined()
    expect(resumeOf(fresh)).toBe('s2')
    p.release()
  })

  it('asks the handlers of the turn in progress, not the one that opened the process', async () => {
    const f = fakeQuery()
    const p = new ClaudeCliProvider({ query: f.q as any })
    const asked: string[] = []
    const ask = (who: string) => async () => (asked.push(who), who === 'second')
    await collect(p.run(request('hi', { approveAction: ask('first'), agent: agent({ autoApprove: false }) })))
    const evs = await collect(p.run(request('use a tool', { resumeId: 's1', approveAction: ask('second'), agent: agent({ autoApprove: false }) })))
    expect(asked).toEqual(['second'])
    expect(evs).toContainEqual({ type: 'tool-end', id: 't1', output: 'allow', isError: false })
    expect(f.made).toHaveLength(1)
    p.release()
  })

  it('a stopped turn stops the process; the next one resumes in a new process', async () => {
    const f = fakeQuery()
    const p = new ClaudeCliProvider({ query: f.q as any })
    await collect(p.run(request('one')))
    const ctl = new AbortController()
    ctl.abort()
    await collect(p.run(request('stop me', { resumeId: 's1', signal: ctl.signal })))
    expect(f.made[0].closed).toBe(true)
    expect(p.warm).toBe(0)
    await collect(p.run(request('three', { resumeId: 's1' })))
    expect(f.made).toHaveLength(2)
    expect(f.made[1].options.resume).toBe('s1')
    p.release()
  })

  it('lets an idle process go, and helpers never keep one', async () => {
    const f = fakeQuery()
    const p = new ClaudeCliProvider({ query: f.q as any, idleMs: 30 })
    await collect(p.run(request('one')))
    expect(p.warm).toBe(1)
    await new Promise((r) => setTimeout(r, 60))
    expect(p.warm).toBe(0)
    expect(f.made[0].closed).toBe(true)
    // no pool key: a one-shot process with the prompt as a string
    const once = await collect(p.run(request('council', { poolKey: undefined })))
    expect(resumeOf(once)).toBe('s2')
    expect(p.warm).toBe(0)
    expect(f.made[1].turns).toEqual(['council'])
  })

  it('does not ask a model without adaptive thinking for it', async () => {
    const f = fakeQuery()
    const p = new ClaudeCliProvider({ query: f.q as any })
    await collect(p.run(request('hi', { poolKey: undefined, agent: agent({ model: 'claude-haiku-4-5-20251001' }) })))
    expect(f.made[0].options.thinking).toBeUndefined()
  })
})
