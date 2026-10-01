import { describe, expect, it } from 'vitest'
import { parseAgentFile, serializeAgentFile, slugify } from '@shared/agentFile'
import { clampEffort } from '@shared/effort'
import { roleTemplate } from '@shared/templates'
import { effortOptions } from '../../src/main/providers/aiSdk'
import { codexArgs, codexEvents, codexPrompt, winQuote } from '../../src/main/providers/codexCli'
import { friendlyClaudeError, readOnlyCommand } from '../../src/main/providers/claudeCli'
import { hardStop } from '../../src/main/providers/guard'
import { findMediaUrls, kindOf } from '../../src/main/media/capture'
import { buildSystemPrompt, CONTEXT_PROTOCOL } from '../../src/main/orchestrator/prompts'
import { Inbox, formatAnswers, recommendedAnswers } from '../../src/main/orchestrator/inbox'

describe('agent files', () => {
  it('round-trip every field through markdown with frontmatter', () => {
    const a = { ...roleTemplate('implementer', 'impl'), name: 'Forge Hand', mcp: ['meshy'], purpose: '# Hi\n\nDo things.\n' }
    const back = parseAgentFile('impl', serializeAgentFile(a))
    expect(back).toEqual(a)
  })

  it('falls back to defaults for junk instead of throwing', () => {
    const a = parseAgentFile('x', '---\nprovider: nonsense\neffort: 11\ncolor: red\n---\nbody')
    expect(a.provider).toBe('mock')
    expect(a.effort).toBe('medium')
    expect(a.color).toBe('#7c9cff')
    expect(a.purpose).toBe('body\n')
    expect(parseAgentFile('y', 'no frontmatter at all').name).toBe('y')
  })

  it('slugs names into file-safe ids', () => {
    expect(slugify('Context Handler!')).toBe('context-handler')
    expect(slugify('???')).toBe('agent')
  })

  it('ships a template for every role that parses to that role', () => {
    for (const role of ['mastermind', 'planner', 'implementer', 'designer', 'brainstormer', 'context-handler', 'critic'] as const)
      expect(roleTemplate(role).role).toBe(role)
    expect(roleTemplate('implementer').gated).toBe(true)
    expect(roleTemplate('planner').planMode).toBe(true)
  })
})

describe('effort', () => {
  it('clamps down to the nearest level a provider supports', () => {
    expect(clampEffort('codex-cli', 'max')).toBe('xhigh')
    expect(clampEffort('groq', 'xhigh')).toBe('high')
    expect(clampEffort('compatible', 'low')).toBe('medium')
    expect(clampEffort('claude-cli', 'max')).toBe('max')
  })

  it('maps onto each vendor option', () => {
    const a = effortOptions('anthropic', 'high')
    expect(a.providerOptions!.anthropic.thinking.budgetTokens).toBe(16384)
    expect(a.maxOutputTokens).toBeGreaterThan(16384)
    expect(effortOptions('openai', 'xhigh').providerOptions!.openai.reasoningEffort).toBe('xhigh')
    expect(effortOptions('groq', 'max').providerOptions!.groq.reasoningEffort).toBe('high')
    expect(effortOptions('compatible', 'high')).toEqual({})
  })
})

describe('codex cli', () => {
  const agent = { ...roleTemplate('designer', 'designer'), model: 'gpt-6-astra', effort: 'max' as const }

  it('builds exec arguments with model, effort, sandbox, the bus and resume', () => {
    const args = codexArgs({ agent, cwd: '/p', resumeId: 'T1', busUrl: 'http://127.0.0.1:9/mcp/designer?t=x', externalMcp: [] })
    expect(args.slice(0, 2)).toEqual(['exec', '--json'])
    expect(args).toContain('gpt-6-astra')
    expect(args).toContain('model_reasoning_effort="xhigh"')
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only')
    expect(args).toContain('mcp_servers.multimine.url="http://127.0.0.1:9/mcp/designer?t=x"')
    expect(args.slice(-3)).toEqual(['resume', 'T1', '-'])
  })

  it('passes stdio MCP servers as TOML overrides', () => {
    const args = codexArgs({ agent, cwd: '/p', externalMcp: [{ id: 'meshy', name: 'Meshy', transport: 'stdio', command: 'npx', args: ['-y', 'meshy-mcp'], env: { KEY: 'k' } }] })
    expect(args).toContain('mcp_servers.meshy.args=["-y","meshy-mcp"]')
    expect(args).toContain('mcp_servers.meshy.env={KEY="k"}')
  })

  it('parses the JSONL event stream', () => {
    const lines = [
      '{"type":"thread.started","thread_id":"th_1"}',
      '{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"ls"}}',
      '{"type":"item.completed","item":{"id":"i1","type":"command_execution","aggregated_output":"a\\nb","exit_code":0}}',
      '{"type":"item.completed","item":{"id":"i2","type":"reasoning","text":"thinking"}}',
      '{"type":"item.completed","item":{"id":"i3","type":"agent_message","text":"done"}}',
      '{"type":"item.completed","item":{"id":"i4","type":"file_change","changes":[{"path":"a.java","kind":"update"}]}}',
      '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}',
      'not json'
    ]
    const events = lines.flatMap(codexEvents)
    expect(events.map((e) => e.type)).toEqual(['resume', 'tool-start', 'tool-end', 'thinking', 'text', 'tool-start', 'tool-end', 'usage'])
    expect(events[0]).toEqual({ type: 'resume', id: 'th_1' })
    expect(codexEvents('{"type":"turn.failed","error":{"message":"quota"}}')).toEqual([{ type: 'error', message: 'quota' }])
  })

  it('quotes arguments for the Windows shell', () => {
    expect(winQuote('exec')).toBe('exec')
    expect(winQuote('C:\\My Mods\\magic')).toBe('"C:\\My Mods\\magic"')
    expect(winQuote('model_reasoning_effort="high"')).toBe('"model_reasoning_effort=\\"high\\""')
  })

  it('sends the system prompt only on a fresh thread', () => {
    expect(codexPrompt({ system: 'SYS', history: [], prompt: 'hi' })).toContain('SYS')
    expect(codexPrompt({ system: 'SYS', history: [], prompt: 'hi', resumeId: 't' })).toBe('hi')
  })
})

describe('claude errors', () => {
  it('turns an expired login into what to do about it', () => {
    const m = friendlyClaudeError('Claude Code returned an error result: Failed to authenticate: OAuth session expired and could not be refreshed')
    expect(m).toContain('/login')
    expect(m).toContain('Retry')
    expect(friendlyClaudeError('usage limit reached')).toContain('usage limit')
    expect(friendlyClaudeError('something else')).toBe('something else')
  })
})

describe('guards', () => {
  it('stops pushes and destructive commands for the user', () => {
    expect(hardStop('git push origin main')).toBe('git push')
    expect(hardStop('rm -rf build')).toBe('recursive delete')
    expect(hardStop('git reset --hard HEAD~1')).toBeTruthy()
    expect(hardStop('./gradlew build')).toBeNull()
  })

  it('lets a read-only agent look but not touch', () => {
    expect(readOnlyCommand('git log --oneline -5')).toBe(true)
    expect(readOnlyCommand('ls src | head')).toBe(true)
    expect(readOnlyCommand('cat a > b')).toBe(false)
    expect(readOnlyCommand('npm install')).toBe(false)
  })
})

describe('media', () => {
  it('finds media links and classifies them', () => {
    const text = 'see https://cdn.x.com/a/img.PNG?sig=1 and https://x.com/model.glb, not https://x.com/page'
    expect(findMediaUrls(text)).toEqual(['https://cdn.x.com/a/img.PNG?sig=1', 'https://x.com/model.glb'])
    expect(kindOf('clip.mp4')).toBe('video')
    expect(kindOf('a.glb')).toBe('model')
    expect(kindOf('a.txt')).toBeNull()
  })
})

describe('prompts', () => {
  const agents = [roleTemplate('mastermind', 'mastermind'), roleTemplate('designer', 'designer')]
  const base = { agents, projectDir: '/p', multimineMd: '# House rules', automation: false }

  it('injects multimine.md, the roster and the coordination tools', () => {
    const s = buildSystemPrompt({ ...base, agent: agents[1], hasContextHandler: false })
    expect(s).toContain('# House rules')
    expect(s).toContain('`designer`')
    expect(s).toContain('`report`')
    expect(s).not.toContain('Context protocol')
    expect(s).not.toContain('request_approval')
  })

  it('adds the context protocol once a context handler exists, and mastermind tools for mastermind', () => {
    expect(buildSystemPrompt({ ...base, agent: agents[1], hasContextHandler: true })).toContain(CONTEXT_PROTOCOL)
    const mm = buildSystemPrompt({ ...base, agent: agents[0], hasContextHandler: false, automation: true })
    expect(mm).toContain('request_approval')
    expect(mm).toContain('Automation mode is ON')
  })
})

describe('inbox', () => {
  it('blocks the asker until answered, and records the answer', async () => {
    let seen = 0
    const inbox = new Inbox([], () => seen++)
    const q = [{ question: 'Colour?', options: [{ label: 'Red' }, { label: 'Blue' }] }]
    const pending = inbox.ask('designer', 'Colour?', q)
    expect(inbox.pending()).toHaveLength(1)
    inbox.answer(inbox.pending()[0].id, { 'Colour?': 'Blue' })
    const item = await pending
    expect(item.answers).toEqual({ 'Colour?': 'Blue' })
    expect(formatAnswers(item)).toContain('Blue')
    expect(seen).toBe(2)
    expect(recommendedAnswers(q)).toEqual({ 'Colour?': 'Red' })
  })

  it('refuses pending approvals when cancelled and expires stale ones on load', async () => {
    const inbox = new Inbox([], () => undefined)
    const p = inbox.approval('mastermind', 'Plan', 'x')
    inbox.cancelAll('switched')
    expect((await p).approved).toBe(false)
    const reloaded = new Inbox([{ id: 'a', ts: 1, kind: 'approval', askedBy: 'm', title: 't', status: 'pending' }], () => undefined)
    expect(reloaded.pending()).toHaveLength(0)
  })
})
