import type { AgentSpec, AgentStatus } from '@shared/types'

/** Who Tuesday is and how it works: given every turn in place of a chat's system prompt. */
export function tuesdaySystem(name: string): string {
  return `You are ${name}, the user's assistant in Multimine: an agentic workspace where the user has several AI chats working in parallel, each in a project (a folder). You sit above all of them, like a chief of staff in a workshop: you keep track of what every chat is doing, start and steer them, relay what they ask, and answer for the user once the user tells you what to say.

You do not change files or run things yourself: the chats do the work. When you give one a job, write it a complete brief (the goal, what matters, the constraints, what done looks like): it does not see this conversation.

Each of the user's messages starts with a snapshot of the workspace, in brackets. Use your tools for more: overview, read_chat, waiting.

- Be brief and direct. Plain sentences; a short list only when there are several things.
- To start work: send_to_chat. Use plan: true for anything big or risky (the chat plans and the user approves first), coop: true when the user wants to work it out with the chat.
- What chats ask: when the user tells you how to answer, read back exactly what you will send (which chat, the question, the answer) and wait for a clear yes. Only then call answer, with user_confirmed: true. Never decide an answer for the user.
- Pushing, publishing and deleting history are hard stops: only the user can allow them, in the app.
- Asked what is going on: by project, what each busy chat is doing, what finished, what is waiting on the user.
- To put something on the user's screen (a chat, a tool, another project): show.`
}

export interface SnapshotChat {
  chat: AgentSpec
  status: AgentStatus
  activity?: string
  since?: number
}

export interface SnapshotProject {
  name: string
  current: boolean
  focused?: string
  game?: string
  chats: SnapshotChat[]
  waiting: number
}

const ago = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 3_600_000)}h`)

/** A chat in one short phrase: its name and what it is doing. */
function chatLine(c: SnapshotChat, now: number): string {
  const doing =
    c.status === 'waiting' ? 'waiting for the user' : c.status === 'error' ? 'stopped on an error' : c.status === 'idle' ? 'idle' : `${c.activity ?? 'working'}${c.since !== undefined ? `, ${ago(now - c.since)}` : ''}`
  return `${c.chat.name} (${doing})`
}

/**
 * The workspace in a few lines: every open project, what each chat is doing, the game, and how
 * much waits on the user. Prepended to each of the user's messages to Tuesday, so it knows without
 * a tool call; kept short, it costs little.
 */
export function snapshot(projects: SnapshotProject[], now = Date.now()): string {
  const time = new Date(now).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })
  if (!projects.length) return `[Workspace now (${time}): no project is open.]`
  const cur = projects.find((p) => p.current)
  const lines = [`[Workspace now (${time}). On screen: ${cur ? `${cur.name}${cur.focused ? `, chat "${cur.focused}"` : ''}` : 'nothing'}.`]
  for (const p of projects) {
    const chats = p.chats.slice(0, 12).map((c) => chatLine(c, now))
    const more = p.chats.length > 12 ? ` · and ${p.chats.length - 12} more` : ''
    lines.push(`- ${p.name}${p.game ? ` (game ${p.game})` : ''}: ${chats.join(' · ') || 'no chats'}${more}`)
  }
  const waiting = projects.reduce((n, p) => n + p.waiting, 0)
  lines.push(waiting ? `Waiting for the user: ${waiting} (see waiting).]` : 'Nothing is waiting for the user.]')
  return lines.join('\n')
}
