import { describe, expect, it } from 'vitest'
import { MOCK_DEFAULTS, newChat, parseChat } from '@shared/chat'
import { slugify } from '@shared/ids'
import { clampEffort } from '@shared/effort'
import { effortOptions } from '../../src/main/providers/aiSdk'
import { codexArgs, codexEvents, codexPrompt, winQuote } from '../../src/main/providers/codexCli'
import { friendlyClaudeError } from '../../src/main/providers/claudeCli'
import { hardStop, readOnlyCommand } from '../../src/main/providers/guard'
import { findMediaUrls, kindOf } from '../../src/main/media/capture'
import { buildSystemPrompt, VERIFY_RULES } from '../../src/main/chat/prompts'
import { Inbox, formatAnswers } from '../../src/main/chat/inbox'

describe('chat files', () => {
  it('round-trip every field through JSON', () => {
    const c = newChat('c1', MOCK_DEFAULTS, { name: 'HUD work', mcp: ['meshy'], fallback: [{ provider: 'codex-cli', model: 'gpt-5.6', effort: 'high' }] })
    expect(parseChat('c1', JSON.parse(JSON.stringify(c)))).toEqual(c)
  })

  it('falls back to defaults for junk instead of throwing', () => {
    const c = parseChat('x', { provider: 'nonsense', effort: 11, name: '   ', mcp: [1, 'ok'] })
    expect(c.provider).toBe('mock')
    expect(c.effort).toBe('medium')
    expect(c.name).toBe('New chat')
    expect(c.mcp).toEqual(['ok'])
    expect(parseChat('y', null).id).toBe('y')
  })

  it('slugs names into file-safe ids', () => {
    expect(slugify('Context Handler!')).toBe('context-handler')
    expect(slugify('???', 'server')).toBe('server')
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
  const agent = newChat('designer', MOCK_DEFAULTS, { provider: 'codex-cli', model: 'gpt-6-astra', effort: 'max', permissions: 'read', autoApprove: true })

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
    expect(hardStop('git -C ../other push --force')).toBe('git push')
    expect(hardStop('rm -r -f build')).toBe('recursive delete')
    expect(hardStop('rm --recursive build')).toBe('recursive delete')
    expect(hardStop('find . -name "*.class" -delete')).toBe('recursive delete')
    expect(hardStop('git branch --delete --force old')).toBeTruthy()
    expect(hardStop('rm notes.txt')).toBeNull()
  })

  it('lets a read-only agent look but not touch', () => {
    expect(readOnlyCommand('git log --oneline -5')).toBe(true)
    expect(readOnlyCommand('ls src | head')).toBe(true)
    expect(readOnlyCommand('cat a > b')).toBe(false)
    expect(readOnlyCommand('npm install')).toBe(false)
    expect(readOnlyCommand('grep -rn "a|b" src 2>/dev/null | head -20')).toBe(true)
    expect(readOnlyCommand("find . -name '*.ts' -type f")).toBe(true)
    expect(readOnlyCommand('git status && git diff --stat')).toBe(true)
    expect(readOnlyCommand('git branch -a')).toBe(true)
  })

  it('does not take a command for a look because of how it starts', () => {
    for (const cmd of [
      'echo $(rm -rf ~)',
      'echo `rm -rf ~`',
      'ls; rm -rf src',
      'ls && rm -rf src',
      'ls & rm -rf src',
      'cat a\nrm b',
      'find . -delete',
      'find . -exec rm {} \\;',
      'find . -execdir sh -c x ;',
      'rg --pre ./evil foo',
      'git diff --output=src/main.ts',
      'git -c core.pager=evil log',
      'git branch new-branch',
      'git checkout main',
      'tree -o out.txt',
      'echo hi > file',
      'echo hi >> file',
      'GIT_EXTERNAL_DIFF=evil git diff',
      './ls',
      'cat "unclosed',
      'sort -o out in'
    ])
      expect(readOnlyCommand(cmd), cmd).toBe(false)
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
  const chat = newChat('c1', MOCK_DEFAULTS)

  it('injects multimine.md and the Multimine tools, and nothing about a team', () => {
    const s = buildSystemPrompt({ agent: chat, projectDir: '/p', multimineMd: '# House rules' })
    expect(s).toContain('# House rules')
    expect(s).toContain('`ask_user`')
    expect(s).toContain('`show_media`')
    expect(s).not.toMatch(/Mastermind|message_agent|report`|team/)
  })

  it('tells a chat that can write how to verify its work, and a read-only one nothing of the kind', () => {
    expect(buildSystemPrompt({ agent: chat, projectDir: '/p', multimineMd: '' })).toContain(VERIFY_RULES)
    expect(buildSystemPrompt({ agent: { ...chat, permissions: 'read' }, projectDir: '/p', multimineMd: '' })).not.toContain(VERIFY_RULES)
  })
})

describe('inbox', () => {
  it('blocks the asker until answered, and records the answer', async () => {
    let seen = 0
    const inbox = new Inbox(() => seen++)
    const q = [{ question: 'Colour?', options: [{ label: 'Red' }, { label: 'Blue' }] }]
    const pending = inbox.ask('designer', 'Colour?', q)
    expect(inbox.pending()).toHaveLength(1)
    inbox.answer(inbox.pending()[0].id, { 'Colour?': 'Blue' })
    const item = await pending
    expect(item.answers).toEqual({ 'Colour?': 'Blue' })
    expect(formatAnswers(item)).toContain('Blue')
    expect(seen).toBe(2)
  })

  it('refuses pending approvals when cancelled', async () => {
    const inbox = new Inbox(() => undefined)
    const p = inbox.approval('c1', 'Plan', 'x')
    inbox.cancelAll('closed')
    expect((await p).approved).toBe(false)
    expect(inbox.pending()).toHaveLength(0)
  })
})
