/**
 * Plan and coop: two ways a chat can work, for one message or (as a chat setting) every message.
 *
 * Plan: it looks, then hands in a plan for the user to approve before it changes anything. Claude
 * has its own plan mode; every other provider gets the same through Multimine: for that message it
 * can only read, it hands the plan in with `present_plan`, and once the user approves, Multimine
 * sends the go-ahead as the next message.
 *
 * Coop: it works as the user's partner and asks them, in rounds, about everything that shapes the
 * result, before and while it works.
 */

export interface MessageModes {
  /** Undefined: whatever the chat is set to. */
  plan?: boolean
  coop?: boolean
}

export interface TurnModes {
  plan: boolean
  coop: boolean
}

/**
 * `/plan` and `/coop` at the start of a message, in any order: the modes, and the message without
 * them. Nothing else is read, so `/table` and the other commands work after them as usual.
 */
export function parseModes(body: string): { modes: MessageModes; text: string } {
  const modes: MessageModes = {}
  let text = body.trimStart()
  for (;;) {
    const m = /^\/(plan|coop)(?=\s|$)\s*/.exec(text)
    if (!m) break
    modes[m[1] as 'plan' | 'coop'] = true
    text = text.slice(m[0].length)
  }
  return text === body.trimStart() ? { modes, text: body } : { modes, text }
}

/**
 * What a turn runs in: the message's own modes over the chat's. The commands (`/table`, `/plugin`,
 * `/idea`) have their own flow: the chat's plan mode does not hold them up, only an explicit `/plan`.
 */
export function turnModes(chat: { planMode: boolean; coop: boolean }, msg: { modes?: MessageModes; command?: string }): TurnModes {
  return { plan: msg.modes?.plan ?? (msg.command ? false : chat.planMode), coop: msg.modes?.coop ?? chat.coop }
}

/** The planning rule for providers without a plan mode of their own. */
export const PLAN_RULES =
  'Plan mode: this message is for planning only. Do not change files or run anything that changes them. Look at what you need (read, search, read-only commands), then call present_plan with the plan in markdown: the goal, the steps, the files you will change, the risks, and how you will check it works. The user approves it or says what to change; when they ask for changes, revise it and call present_plan again. Once it is approved, stop and reply in one line: the go-ahead comes as the next message.'

/** Coop: the chat and the user work on it together, and it asks a lot. */
export const COOP_RULES = `Coop mode: you and the user work on this together, as partners at one desk. Before you decide anything that shapes the result, ask.
- First ask yourself the crucial questions: what is the goal really, who is it for, what would make it fail, what are the trade-offs, what is being assumed. Answer the ones the project can answer yourself (read the code, the notes); bring the user the ones only they can: intent, taste, priorities, constraints, what "done" looks like.
- Ask with ask_user, one to four questions at a time, each with 2-4 concrete options, your recommendation first with the reason in its description. Ask in rounds, not all at once: each round builds on the answers before.
- Between rounds, say briefly what you learned and what is still open.
- Do not assume on matters of scope or taste; small mechanical choices are yours.
- Before a big change, sum up what you agreed and ask to go ahead. Keep asking as the work goes and new forks appear.`

/** The message that follows an approved plan (providers without their own plan mode). */
export function goAheadPrompt(note?: string): string {
  return ['The plan is approved: carry it out now.', note?.trim() ? `The user adds: ${note.trim()}` : ''].filter(Boolean).join('\n\n')
}
