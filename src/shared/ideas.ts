/**
 * The Idea Book: a project's ideas in `.multimine/ideas.json`. The user writes them, or a chat
 * proposes them (`/idea <topic>`, or on its own when side ideas are switched on) and the user keeps
 * or dismisses each one. Any idea can be checked off, or sent to a chat to work on.
 */

export const IDEAS_PATH = '.multimine/ideas.json'

export type IdeaStatus = 'proposed' | 'open' | 'done'

export interface Idea {
  id: string
  title: string
  details?: string
  tags?: string[]
  /** proposed: a chat's, waiting for the user to keep or dismiss it. */
  status: IdeaStatus
  /** Who it came from: 'you', or the chat that proposed it. */
  from: string
  /** The chat that proposed it. */
  chatId?: string
  /** The chat it was last sent to, to work on it. */
  workChatId?: string
  created: number
  doneAt?: number
}

export interface IdeaBook {
  /** Chats save their side ideas here instead of writing them in their replies. */
  sideIdeas: boolean
  ideas: Idea[]
}

export const EMPTY_BOOK: IdeaBook = { sideIdeas: false, ideas: [] }

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/** An idea book read back from disk; anything malformed is dropped rather than failing. */
export function parseBook(raw: unknown): IdeaBook {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const ideas: Idea[] = []
  for (const x of Array.isArray(r.ideas) ? r.ideas : []) {
    if (!x || typeof x !== 'object') continue
    const i = x as Record<string, unknown>
    const title = str(i.title, 200)
    if (!title || typeof i.id !== 'string') continue
    ideas.push({
      id: i.id,
      title,
      ...(str(i.details, 4000) ? { details: str(i.details, 4000) } : {}),
      ...(Array.isArray(i.tags) && i.tags.length ? { tags: i.tags.filter((t): t is string => typeof t === 'string').map((t) => t.trim().toLowerCase().slice(0, 24)).filter(Boolean).slice(0, 6) } : {}),
      status: i.status === 'proposed' || i.status === 'done' ? i.status : 'open',
      from: str(i.from, 80) || 'you',
      ...(typeof i.chatId === 'string' ? { chatId: i.chatId } : {}),
      ...(typeof i.workChatId === 'string' ? { workChatId: i.workChatId } : {}),
      created: typeof i.created === 'number' ? i.created : 0,
      ...(typeof i.doneAt === 'number' ? { doneAt: i.doneAt } : {})
    })
  }
  return { sideIdeas: r.sideIdeas === true, ideas }
}

export const bookJson = (b: IdeaBook) => `${JSON.stringify(b, null, 2)}\n`

/** Two titles that say the same thing: one is not saved twice. */
export const sameIdea = (a: string, b: string) => a.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() === b.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** What every chat is told while side ideas are on (and only then: off, it costs nothing). */
export const SIDE_IDEAS_RULE =
  'Side ideas: when something worth doing beyond the task occurs to you (a feature, a fix, a balance change), save it with save_ideas for the user to review later instead of writing it in your reply. Only ideas worth their time, at most three a turn.'

/** The prompt for `/idea <topic>`: brainstorm, save the ideas for review, reply in a sentence. */
export function ideaCommandPrompt(request: string, existing: string[]): string {
  const topic = request.trim() || 'this project: whatever is most worth doing next'
  return [
    '# Brainstorm ideas',
    '',
    `The user wants ideas about: ${topic}`,
    '',
    'Come up with 5 to 8 ideas that fit this project: specific, different from each other, each something that could be built. Look at the project as much as you need to make them fit (multimine.md, the relevant files), but keep it brief.',
    existing.length ? `Already in the Idea Book (do not repeat): ${existing.slice(0, 60).join('; ')}.` : '',
    'Save them all with one save_ideas call: a short title each (under 70 characters), one to three sentences on what it is and why it fits, and a tag or two (spell, ui, balance...).',
    'Then reply in one sentence: how many you saved and their theme. Do not list them: the user reviews them in the Idea Book.'
  ]
    .filter(Boolean)
    .join('\n')
}

/** How an idea is worked on: built right away, planned for the user to approve first, or worked out together. */
export type WorkHow = 'build' | 'plan' | 'coop'

const WORK_ASK: Record<WorkHow, string> = {
  build: 'Work on this idea from the Idea Book: plan it briefly, then build it. Ask if something about it is unclear.',
  plan: 'Work on this idea from the Idea Book: plan how to build it, for the user to approve.',
  coop: 'Work on this idea from the Idea Book together with the user: work out what it should be with them, then build it.'
}

/** The message that sends an idea to a chat to work on (the plan and coop modes go with it as send options). */
export function workPrompt(idea: Pick<Idea, 'title' | 'details' | 'tags'>, how: WorkHow = 'build'): string {
  return [`# Idea: ${idea.title}`, '', idea.details ?? '', idea.tags?.length ? `Tags: ${idea.tags.join(', ')}` : '', '', WORK_ASK[how]]
    .filter((l, i, all) => l || (all[i - 1] ?? '') !== '')
    .join('\n')
    .trim()
}
