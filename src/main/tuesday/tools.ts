import { basename } from 'node:path'
import { z } from 'zod'
import type { AgentSpec, ChatMessage, InboxItem, MainEvent } from '@shared/types'
import { SHORT_PROVIDER } from '@shared/catalog'
import type { ToolDef, ToolOutput } from '../providers/types'
import type { Workspace } from '../app'
import { suggestCommand } from '../run/runner'
import type { Table } from '@shared/tables/model'

/** What Tuesday's tools reach: the open projects, and the window. */
export interface TuesdayHost {
  /** The open projects, in tab order. */
  spaces(): Workspace[]
  current(): Workspace | null
  /** Brings a project on screen and, in it, a chat or a tool. */
  show(dir: string, target: { chatId?: string; tool?: string }): Promise<void>
  /** The tools (built in and installed) of a project, by id and name. */
  toolList(dir: string): Promise<{ id: string; name: string }[]>
  /** An event from a project, as if that project sent it (the window hears it when it is on screen). */
  notify(ws: Workspace, e: MainEvent): void
  /** Sends things to the user's Telegram, once it is paired: a table, the latest screenshots. */
  share?: {
    ready(): boolean
    table(ws: Workspace, t: Table): Promise<string>
    shots(o: { chat?: string; project?: string; limit?: number }): Promise<string>
  }
  /** On a phone call or Telegram: a hard stop the user wants allowed waits for their PIN there. */
  remote?: { armHardStop(itemId: string, title: string, approve: boolean): boolean }
}

const text = (t: string, isError = false): ToolOutput => ({ text: t, isError })
const clipTo = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
const nameOf = (ws: Workspace) => basename(ws.dir)

/** A project by its name or folder; the one on screen when none is named. */
export function findProject(host: TuesdayHost, ref?: string): Workspace {
  const all = host.spaces()
  if (!all.length) throw new Error('No project is open.')
  if (!ref?.trim()) return host.current() ?? all[0]
  const r = norm(ref)
  const hits = all.filter((ws) => ws.dir === ref || norm(nameOf(ws)) === r)
  const loose = hits.length ? hits : all.filter((ws) => norm(nameOf(ws)).includes(r))
  if (loose.length === 1) return loose[0]
  if (!loose.length) throw new Error(`No open project "${ref}". Open: ${all.map(nameOf).join(', ')}.`)
  throw new Error(`"${ref}" matches several projects: ${loose.map((w) => w.dir).join('; ')}. Give the folder.`)
}

/** A chat by its id or name, in a named project or any open one (the one on screen first). */
export function findChat(host: TuesdayHost, ref: string, project?: string): { ws: Workspace; chat: AgentSpec } {
  const cur = host.current()
  const spaces = project?.trim() ? [findProject(host, project)] : [...(cur ? [cur] : []), ...host.spaces().filter((w) => w !== cur)]
  if (!spaces.length) throw new Error('No project is open.')
  for (const ws of spaces) {
    const chat = ws.project.get(ref)
    if (chat) return { ws, chat }
  }
  const all = spaces.flatMap((ws) => ws.project.list().map((chat) => ({ ws, chat })))
  const r = norm(ref)
  const exact = all.filter((x) => norm(x.chat.name) === r)
  const hits = exact.length ? exact : all.filter((x) => norm(x.chat.name).includes(r))
  if (hits.length === 1) return hits[0]
  const list = (xs: typeof all) => xs.map((x) => `"${x.chat.name}" (${x.chat.id}, ${nameOf(x.ws)})`).join('; ')
  if (!hits.length) throw new Error(`No chat "${ref}". Chats: ${list(all.slice(0, 30)) || 'none'}.`)
  throw new Error(`"${ref}" matches several chats: ${list(hits)}. Say which, by id.`)
}

/** Everything waiting on the user in the open projects, by id. */
function findWaiting(host: TuesdayHost, id: string): { ws: Workspace; item: InboxItem } {
  for (const ws of host.spaces()) {
    const item = ws.engine.inbox.get(id)
    if (item) return { ws, item }
  }
  throw new Error(`Nothing is waiting with id ${id}. Call waiting for the current list.`)
}

function doing(ws: Workspace, chat: AgentSpec): string {
  const a = ws.engine.activityOf(chat.id)
  if (a.status === 'waiting') return 'waiting for the user'
  if (a.status === 'error') return 'stopped on an error'
  if (a.status === 'idle') return 'idle'
  return [a.activity ?? 'working', a.detail ? clipTo(a.detail, 80) : ''].filter(Boolean).join(': ')
}

const lastReply = (msgs: ChatMessage[] = []) => [...msgs].reverse().find((m) => m.role === 'assistant' && !m.streaming && (m.text.trim() || m.error))

/** One message, as Tuesday reads it. */
function messageText(m: ChatMessage, chat: AgentSpec): string {
  const when = new Date(m.ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (m.role === 'system') return `--- note ${when}: ${m.text}`
  if (m.role === 'user') {
    const from = m.from === 'user' ? 'the user' : m.from.replace(/^tool:/, '')
    return `--- ${from} ${when}${m.modes?.plan ? ' [plan]' : ''}${m.modes?.coop ? ' [coop]' : ''}\n${clipTo(m.text, 1200)}`
  }
  const tools = m.tools ?? []
  const counts = new Map<string, number>()
  for (const t of tools) counts.set(t.name.replace(/^mcp__\w+__/, ''), (counts.get(t.name.replace(/^mcp__\w+__/, '')) ?? 0) + 1)
  const extra = [
    tools.length ? `ran ${tools.length} tool${tools.length === 1 ? '' : 's'}: ${[...counts].map(([n, c]) => (c > 1 ? `${n} x${c}` : n)).join(', ')}` : '',
    m.changes ? `changed ${m.changes.files.length + (m.changes.more ?? 0)} files${m.changes.undone ? ' (undone)' : ''}` : '',
    m.streaming ? 'still writing' : '',
    m.error ? `error: ${clipTo(m.error, 200)}` : ''
  ].filter(Boolean)
  return `--- ${chat.name} ${when}${extra.length ? ` [${extra.join('; ')}]` : ''}\n${clipTo(m.text.trim(), 1500) || '(no text)'}`
}

/** A waiting item, with what it needs as an answer. */
function waitingText(ws: Workspace, item: InboxItem): string {
  const chat = ws.project.get(item.askedBy)?.name ?? item.askedBy
  const where = `${nameOf(ws)} / ${chat}`
  if (item.kind === 'question') {
    const qs = (item.questions ?? []).map((q, i) => `  ${i + 1}. ${q.question}${q.multiSelect ? ' (one or more)' : ''}\n     options: ${q.options.map((o) => `${o.label}${o.description ? ` (${clipTo(o.description, 120)})` : ''}`).join(' | ')}`)
    return `[${item.id}] ${where} asks:\n${qs.join('\n')}`
  }
  const kind = item.hardStop ? 'HARD STOP, only the user can allow it in the app' : item.watchdog ? 'paused by the loop guard: approve to let it continue, or deny with a note telling it what to do instead' : item.permission ? 'permission' : 'approval'
  return `[${item.id}] ${where} - ${kind}: ${item.title}\n${clipTo((item.planMd ?? '').trim(), 1500)}`
}

/** The tools Tuesday works with: across every open project, on top of nothing else. */
export function tuesdayTools(host: TuesdayHost): ToolDef[] {
  const safe =
    (fn: (a: Record<string, unknown>) => Promise<string> | string) =>
    async (a: Record<string, unknown>): Promise<ToolOutput> => {
      try {
        return text(await fn(a))
      } catch (e) {
        return text((e as Error).message ?? String(e), true)
      }
    }
  const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v))

  const sharing: ToolDef[] = host.share?.ready()
    ? [
        {
          name: 'share_table',
          description: "Send one of a project's tables to the user's Telegram: a picture of it and every row as a CSV. For when they ask to see a table on their phone.",
          shape: { table: z.string().describe('The table id or name'), project: z.string().optional() },
          handler: safe(async (a) => {
            const ws = findProject(host, str(a.project) || undefined)
            const all = await ws.engine.tables.list()
            const r = norm(str(a.table))
            const t = all.find((x) => x.id === str(a.table) || norm(x.name) === r) ?? all.find((x) => norm(x.name).includes(r))
            if (!t) throw new Error(`No table "${a.table}" in ${nameOf(ws)}. Tables: ${all.map((x) => x.name).join(', ') || 'none'}.`)
            return host.share!.table(ws, t)
          })
        },
        {
          name: 'share_screenshots',
          description: "Send the user's Telegram the latest screenshots chats took or looked at while working (and pictures in their galleries), newest first.",
          shape: {
            chat: z.string().optional().describe('Only this chat (name or id)'),
            project: z.string().optional(),
            count: z.number().optional().describe('How many, 1-10 (default 3)')
          },
          handler: safe((a) => host.share!.shots({ chat: str(a.chat) || undefined, project: str(a.project) || undefined, limit: Math.min(10, Math.max(1, Number(a.count) || 3)) }))
        }
      ]
    : []

  return [
    ...sharing,
    {
      name: 'overview',
      description: 'Every open project in detail: each chat with its id, model, what it is doing and the start of its last reply; the game; what waits on the user.',
      shape: {},
      handler: safe(() => {
        const cur = host.current()
        const spaces = host.spaces()
        if (!spaces.length) return 'No project is open.'
        return spaces
          .map((ws) => {
            const run = ws.runner.state
            const game = run.status === 'running' ? `game running (${run.command})` : run.status === 'exited' ? `game exited${run.code != null ? ` with code ${run.code}` : ''}${run.problems.length ? `, ${run.problems.length} problems` : ''}` : ''
            const chats = ws.project.list().map((c) => {
              const last = lastReply(ws.engine.chats[c.id])
              const said = last ? `\n    last reply: ${clipTo((last.error ? `error: ${last.error}` : last.text).replace(/\s+/g, ' ').trim(), 200)}` : ''
              return `- "${c.name}" [${c.id}] ${SHORT_PROVIDER[c.provider]} ${c.model} - ${doing(ws, c)}${ws === cur && ws.activeChat === c.id ? ' (on screen)' : ''}${said}`
            })
            const waiting = ws.engine.inbox.pending().length
            return [`## ${nameOf(ws)}${ws === cur ? ' (on screen)' : ''} - ${ws.dir}${game ? ` - ${game}` : ''}`, ...chats, waiting ? `Waiting for the user: ${waiting}` : ''].filter(Boolean).join('\n')
          })
          .join('\n\n')
      })
    },
    {
      name: 'read_chat',
      description: "A chat's latest messages: what it was asked, what it said, the tools it ran and the files it changed.",
      shape: {
        chat: z.string().describe('The chat id, or its name'),
        project: z.string().optional().describe('The project, when the name is not enough'),
        last: z.number().optional().describe('How many messages, 1-20 (default 8)')
      },
      handler: safe((a) => {
        const { ws, chat } = findChat(host, str(a.chat), str(a.project) || undefined)
        const n = Math.min(20, Math.max(1, Number(a.last) || 8))
        const msgs = (ws.engine.chats[chat.id] ?? []).filter((m) => m.role !== 'system' || m.ideas || m.table || m.fresh).slice(-n)
        return [`"${chat.name}" [${chat.id}] in ${nameOf(ws)} - ${SHORT_PROVIDER[chat.provider]} ${chat.model} - ${doing(ws, chat)}`, ...msgs.map((m) => messageText(m, chat))].join('\n') || 'No messages yet.'
      })
    },
    {
      name: 'send_to_chat',
      description:
        "Give a chat a job or a follow-up. It shows in the chat as from you, and runs on that chat's provider with its permissions. chat 'new' starts a chat (named after the message's first line) in the project.",
      shape: {
        chat: z.string().describe("The chat id or name, or 'new'"),
        message: z.string().describe('A complete brief: the chat does not see your conversation with the user'),
        project: z.string().optional().describe('The project (default: the one on screen)'),
        plan: z.boolean().optional().describe('It plans first and the user approves the plan before it changes anything'),
        coop: z.boolean().optional().describe('It works it out with the user, asking them questions as it goes')
      },
      handler: safe(async (a) => {
        const message = str(a.message).trim()
        if (!message) throw new Error('The message is empty.')
        const modes = { ...(a.plan === true ? { plan: true } : {}), ...(a.coop === true ? { coop: true } : {}) }
        const isNew = norm(str(a.chat)) === 'new'
        const target = isNew ? { ws: findProject(host, str(a.project) || undefined), chat: null } : findChat(host, str(a.chat), str(a.project) || undefined)
        const busy = target.chat ? target.ws.engine.busy(target.chat.id) : false
        const id = await target.ws.engine.fromTool('Tuesday', target.chat?.id ?? 'new', message, target.ws.activeChat ?? undefined, Object.keys(modes).length ? { modes } : {})
        const name = target.ws.project.get(id)?.name ?? id
        const how = [modes.plan ? 'plan first' : '', modes.coop ? 'in coop' : ''].filter(Boolean).join(', ')
        return `Sent to "${name}" [${id}] in ${nameOf(target.ws)}${how ? ` (${how})` : ''}. ${busy ? 'It is busy: it starts on this after its current turn.' : 'It is working on it now.'}`
      })
    },
    {
      name: 'stop_chat',
      description: "Stop a chat's current turn.",
      shape: { chat: z.string(), project: z.string().optional() },
      handler: safe((a) => {
        const { ws, chat } = findChat(host, str(a.chat), str(a.project) || undefined)
        if (!ws.engine.busy(chat.id)) return `"${chat.name}" is not working on anything.`
        ws.engine.stop(chat.id)
        return `Stopped "${chat.name}".`
      })
    },
    {
      name: 'waiting',
      description: 'What the chats are waiting on the user for, in every open project: questions (with their options), plans to approve, permissions. Each has an id for answer.',
      shape: {},
      handler: safe(() => {
        const all = host.spaces().flatMap((ws) => ws.engine.inbox.pending().map((item) => waitingText(ws, item)))
        return all.length ? all.join('\n\n') : 'Nothing is waiting for the user.'
      })
    },
    {
      name: 'answer',
      description:
        "Answer something a chat is waiting on, for the user. Only after you read the answer back to the user and they said yes: set user_confirmed true. A question takes answers (question text, or its number, -> the chosen option's label or the user's own words); a plan, permission or loop-guard pause takes approve. Hard stops cannot be answered here.",
      shape: {
        id: z.string().describe('The id from waiting'),
        answers: z.record(z.string(), z.string()).optional(),
        approve: z.boolean().optional(),
        note: z.string().optional().describe("The user's words to pass on: feedback on a plan, what to do instead"),
        user_confirmed: z.boolean().describe('The user heard this answer read back and said yes')
      },
      handler: safe((a) => {
        if (a.user_confirmed !== true) throw new Error('Not sent. Read the answer back to the user (the chat, the question, the answer) and wait for their yes first.')
        const { ws, item } = findWaiting(host, str(a.id))
        if (item.status !== 'pending') throw new Error('That was already answered.')
        const chat = ws.project.get(item.askedBy)?.name ?? item.askedBy
        const note = str(a.note).trim() || undefined
        if (item.kind === 'question') {
          const given = (a.answers ?? {}) as Record<string, string>
          const values = Object.values(given)
          const qs = item.questions ?? []
          const out: Record<string, string> = {}
          const missing: string[] = []
          qs.forEach((q, i) => {
            const v = given[q.question] ?? (q.header ? given[q.header] : undefined) ?? given[String(i + 1)] ?? (qs.length === 1 && values.length === 1 ? values[0] : undefined)
            if (v == null || !String(v).trim()) missing.push(`${i + 1}. ${q.question}`)
            else out[q.question] = String(v).trim()
          })
          if (missing.length) throw new Error(`Not sent: no answer for ${missing.join('; ')}.`)
          ws.engine.inbox.answer(item.id, out, note)
          return `Answered "${chat}": ${Object.entries(out).map(([q, v]) => `${q} -> ${v}`).join('; ')}.`
        }
        if (typeof a.approve !== 'boolean') throw new Error('Say approve: true or false.')
        if (item.hardStop) {
          // on the phone or Telegram the user's PIN allows it (keypad, or a message deleted at once); never Tuesday's word
          if (a.approve && host.remote?.armHardStop(item.id, item.title, true)) return `"${item.title}" needs the user's PIN: tell them you'll take it next (on a call they type it on the keypad; on Telegram they send it, and it never reaches you). Nothing is allowed until they do.`
          if (a.approve) throw new Error(`"${item.title}" is a hard stop: only the user can allow it, with Allow in the app (or their PIN on a phone call or Telegram).`)
        }
        ws.engine.inbox.decide(item.id, a.approve, note)
        if (item.watchdog) return a.approve ? `"${chat}" continues.` : note ? `"${chat}" was told: ${note}` : `"${chat}" was stopped.`
        return `${a.approve ? 'Approved' : 'Turned down'} for "${chat}": ${item.title}${note ? ` (with: ${note})` : ''}.`
      })
    },
    {
      name: 'run_game',
      description: "A project's run button: start the game (or app) with its saved command, stop it, or see how the run went and the problems it found.",
      shape: { action: z.enum(['start', 'stop', 'status']), project: z.string().optional() },
      handler: safe(async (a) => {
        const ws = findProject(host, str(a.project) || undefined)
        const r = ws.runner
        if (a.action === 'start') {
          const cmd = (await r.config())?.command || (await suggestCommand(ws.dir)) || ''
          if (!cmd) throw new Error(`${nameOf(ws)} has no run command yet: the user sets it with Run in the app.`)
          await r.start(cmd)
          return `Started ${nameOf(ws)}: ${cmd}`
        }
        if (a.action === 'stop') {
          if (r.state.status !== 'running') return `${nameOf(ws)} is not running.`
          await r.stop()
          return `Stopped ${nameOf(ws)}.`
        }
        const s = r.state
        const head = s.status === 'running' ? `Running: ${s.command}` : s.status === 'exited' ? `Exited${s.code != null ? ` with code ${s.code}` : ''}${s.stopped ? ' (stopped)' : ''}: ${s.command}` : 'Not run yet.'
        const problems = s.problems.slice(-5).map((p) => `- ${p.title}${p.cause ? ` (caused by ${p.cause})` : ''}`)
        return [head, problems.length ? `Problems (${s.problems.length}):\n${problems.join('\n')}` : ''].filter(Boolean).join('\n')
      })
    },
    {
      name: 'show',
      description: "Put something on the user's screen: a project (its tab), a chat, or a tool (UI Sketcher, Tables, Idea Book...).",
      shape: { project: z.string().optional(), chat: z.string().optional(), tool: z.string().optional().describe('A tool name or id') },
      handler: safe(async (a) => {
        const found = a.chat ? findChat(host, str(a.chat), str(a.project) || undefined) : null
        const ws = found?.ws ?? findProject(host, str(a.project) || undefined)
        let tool: { id: string; name: string } | undefined
        if (a.tool) {
          const tools = await host.toolList(ws.dir)
          const r = norm(str(a.tool))
          tool = tools.find((t) => t.id === str(a.tool) || norm(t.name) === r) ?? tools.find((t) => norm(t.name).includes(r))
          if (!tool) throw new Error(`No tool "${a.tool}". Tools: ${tools.map((t) => t.name).join(', ')}.`)
        }
        await host.show(ws.dir, { chatId: found?.chat.id, tool: tool?.id })
        return `On screen: ${[nameOf(ws), found ? `chat "${found.chat.name}"` : '', tool ? tool.name : ''].filter(Boolean).join(', ')}.`
      })
    },
    {
      name: 'ideas',
      description: "A project's Idea Book: list its ideas, or add one the user gave you.",
      shape: {
        action: z.enum(['list', 'add']),
        project: z.string().optional(),
        title: z.string().optional().describe('For add: under 70 characters'),
        details: z.string().optional()
      },
      handler: safe(async (a) => {
        const ws = findProject(host, str(a.project) || undefined)
        if (a.action === 'add') {
          const title = str(a.title).trim()
          if (!title) throw new Error('Give the idea a title.')
          const r = await ws.engine.ideas.propose([{ title, details: str(a.details) || undefined }], 'Tuesday', undefined, 'open')
          if (!r.saved.length) return `"${title}" is already in the Idea Book.`
          host.notify(ws, { type: 'ideas-changed' })
          return `Added "${title}" to the Idea Book of ${nameOf(ws)}.`
        }
        const book = await ws.engine.ideas.read()
        const rows = book.ideas.filter((i) => i.status !== 'done').slice(0, 40)
        if (!rows.length) return `The Idea Book of ${nameOf(ws)} has no open ideas.`
        return rows.map((i) => `- ${i.title}${i.status === 'proposed' ? ' (proposed, to review)' : ''}${i.details ? `: ${clipTo(i.details, 160)}` : ''}`).join('\n')
      })
    }
  ]
}
