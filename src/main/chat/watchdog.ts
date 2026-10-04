import type { WatchdogSettings } from '@shared/types'
import { duration, shortCommand } from '@shared/activity'

/**
 * Watches one turn's tool calls for the patterns that mean an agent is going round in circles:
 * launching the same app again and again with nothing changed in between, repeating one call,
 * cycling through the same few calls, or simply running far longer than a task should. It decides
 * nothing by itself: a trip is handed to the user, who says continue, stop, or what to do instead.
 * Pure, so the rules can be tested on exact sequences.
 */

export const DEFAULT_WATCHDOG: WatchdogSettings = {
  enabled: true,
  launchRepeats: 3,
  exactRepeats: 5,
  cycleRepeats: 3,
  budgetMinutes: 20,
  usageBudget: 3,
  quietMinutes: 5,
  launchPatterns: [
    'runClient',
    'runServer',
    'runGameTest',
    'npm (run )?(dev|start)',
    'pnpm (run )?(dev|start)',
    'yarn (dev|start)',
    'vite( |$)',
    'godot',
    'Unity(\\.exe)?( |$)',
    'UnrealEditor',
    'UE4Editor',
    'playwright test',
    'electron \\.'
  ]
}

/** Polling a background command or a todo list repeats by nature; it is never a loop by itself. */
const IGNORED = /^(BashOutput|TaskOutput|KillShell|KillBash|TodoWrite|TodoRead|mcp__multimine__.*|report|message_agent|list_agents|read_context|show_media|ask_user)$/
const EDITS = /^(Write|Edit|MultiEdit|NotebookEdit|write_file|edit_file|edit|apply_patch)$/

/**
 * What one model call costs, in tokens weighed the way they are priced: context read back from the
 * cache a tenth, context written to it a quarter more, output five times. A long agentic turn is
 * mostly cache reads of the same context, which is why its size matters on every call.
 */
export interface CallUsage {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
}

export function weighted(u: CallUsage): number {
  return u.input + u.cacheWrite * 1.25 + u.cacheRead * 0.1 + u.output * 5
}

const millions = (n: number) => (n >= 10_000_000 ? `${Math.round(n / 1e6)}M` : `${(n / 1e6).toFixed(1)}M`)

export interface Trip {
  kind: 'launch' | 'repeat' | 'cycle' | 'budget' | 'usage'
  /** One line for a balloon: what it keeps doing. */
  title: string
  /** A fuller account for the inbox. */
  detail: string
  /** What "continue" forgives. */
  key: string
}

const commandOf = (input: unknown): string | null => {
  const i = input as Record<string, unknown> | null
  const c = i && typeof i === 'object' ? (i.command ?? i.cmd) : null
  return typeof c === 'string' ? c : Array.isArray(c) ? c.join(' ') : null
}

/** The call exactly, for spotting a repeat. */
export function exactSignature(name: string, input: unknown): string {
  const cmd = commandOf(input)
  return `${name}:${cmd !== null ? cmd.trim().replace(/\s+/g, ' ') : JSON.stringify(input ?? null)}`
}

/**
 * What a launch is, whatever its flags: the program and its first word that is not a flag.
 * `./gradlew runClient -PautoScreenshot=120` and `.\gradlew.bat runClient -PquickPlay=...` are both
 * `gradlew runClient`.
 */
export function launchSignature(cmd: string): string {
  const words = shortCommand(cmd)
    .replace(/^(npx|bunx|pnpm exec|cmd \/c|powershell( -Command)?)\s+/i, '')
    .split(' ')
    .filter((w) => w && !w.startsWith('-') && !/^[A-Z_]+=/.test(w))
  const prog = (words[0] ?? '').replace(/^.*[\\/]/, '').replace(/\.(bat|cmd|exe|sh)$/i, '')
  return [prog, words[1] ?? ''].filter(Boolean).join(' ')
}

export class Watchdog {
  private readonly started: number
  private budgetMs: number
  private budgetTripped = false
  /** Weighted tokens this turn may spend before it asks; 0 is no limit. */
  private usageBudget: number
  private spent = 0
  private read = 0
  private calls = 0
  /** launch signature -> launches since the last edit, and in the whole turn */
  private launches = new Map<string, { sinceEdit: number; total: number; first: number }>()
  private exact = new Map<string, number>()
  private recent: string[] = []
  private readonly patterns: RegExp[]

  constructor(
    private readonly cfg: WatchdogSettings,
    now: number,
    budgetMinutes = cfg.budgetMinutes
  ) {
    this.started = now
    this.budgetMs = budgetMinutes * 60_000
    this.usageBudget = Math.max(0, cfg.usageBudget ?? 0) * 1_000_000
    this.patterns = cfg.launchPatterns.flatMap((p) => {
      try {
        return [new RegExp(p, 'i')]
      } catch {
        return []
      }
    })
  }

  /** One model call finished: what it cost counts toward the turn's usage budget. */
  spend(u: CallUsage): void {
    this.spent += weighted(u)
    this.read += u.input + u.cacheRead + u.cacheWrite
    this.calls++
  }

  get usage(): { spent: number; calls: number } {
    return { spent: this.spent, calls: this.calls }
  }

  isLaunch(cmd: string): boolean {
    return this.patterns.some((p) => p.test(cmd))
  }

  /** Records a call about to run. Returns a trip when the user should look before it does. */
  check(name: string, input: unknown, now: number): Trip | null {
    if (!this.cfg.enabled) return null
    if (EDITS.test(name)) {
      // something changed: the next launch is a new experiment, and so is a repeated build
      for (const l of this.launches.values()) l.sinceEdit = 0
      this.exact.clear()
    }
    if (IGNORED.test(name)) return null
    const cmd = commandOf(input)

    if (!this.budgetTripped && now - this.started > this.budgetMs) {
      this.budgetTripped = true
      return {
        kind: 'budget',
        key: 'budget',
        title: `has been on this task for ${duration(now - this.started)}`,
        detail: `This turn has been running for ${duration(now - this.started)}, past its budget of ${duration(this.budgetMs)}. The next step it wants to take: ${name}${cmd ? ` \`${shortCommand(cmd)}\`` : ''}.`
      }
    }

    if (this.usageBudget > 0 && this.spent > this.usageBudget) {
      const budget = this.usageBudget
      // whatever the answer, it asks again only after half the budget more
      this.usageBudget = this.spent + (this.cfg.usageBudget ?? 0) * 500_000
      return {
        kind: 'usage',
        key: 'usage',
        title: `has used a lot of usage on this task: ${this.calls} model calls, ${millions(this.read)} tokens of context`,
        detail: `This turn has made ${this.calls} model calls and read ${millions(this.read)} tokens of context (${millions(this.spent)} weighted, past the budget of ${millions(budget)}). Every call re-reads the whole conversation so far, so a long turn grows costlier with each step. The next step it wants to take: ${name}${cmd ? ` \`${shortCommand(cmd)}\`` : ''}.`
      }
    }

    if (cmd !== null && this.isLaunch(cmd)) {
      const sig = launchSignature(cmd)
      const l = this.launches.get(sig) ?? { sinceEdit: 0, total: 0, first: now }
      l.sinceEdit++
      l.total++
      this.launches.set(sig, l)
      // three launches with nothing changed is a loop; twice that is one even with edits between
      if (l.sinceEdit >= this.cfg.launchRepeats || l.total >= this.cfg.launchRepeats * 2) {
        const nothingNew = l.sinceEdit >= this.cfg.launchRepeats
        return {
          kind: 'launch',
          key: `launch:${sig}`,
          title: `wants to launch \`${sig}\` for the ${ordinal(l.total)} time${nothingNew ? ' with no new edits' : ''}`,
          detail: `It has launched \`${sig}\` ${l.total - 1} times in ${duration(now - l.first)}${nothingNew ? `, ${l.sinceEdit - 1} of them since it last changed a file` : ''}. Next: \`${shortCommand(cmd)}\`. If a launch keeps failing the same way (a missing world or save, no display), tell it what is wrong or to stop and report.`
        }
      }
    }

    const sig = exactSignature(name, input)
    const n = (this.exact.get(sig) ?? 0) + 1
    this.exact.set(sig, n)
    if (n >= this.cfg.exactRepeats) {
      return {
        kind: 'repeat',
        key: `repeat:${sig}`,
        title: `is about to repeat the same ${cmd !== null ? `command \`${shortCommand(cmd).slice(0, 40)}\`` : name} for the ${ordinal(n)} time`,
        detail: `It has made exactly this call ${n - 1} times this turn with no file changed in between: ${cmd !== null ? `\`${shortCommand(cmd)}\`` : `${name} ${JSON.stringify(input).slice(0, 300)}`}.`
      }
    }

    this.recent.push(sig)
    if (this.recent.length > 64) this.recent.shift()
    const cycle = this.cycle()
    if (cycle) {
      this.recent = []
      return {
        kind: 'cycle',
        key: `cycle:${cycle.join('|')}`,
        title: `is going round the same ${cycle.length} steps for the ${ordinal(this.cfg.cycleRepeats)} time`,
        detail: `The last ${cycle.length * this.cfg.cycleRepeats} calls are the same ${cycle.length} steps ${this.cfg.cycleRepeats} times over:\n${cycle.map((s) => `- ${s.replace(/^([^:]+):/, '$1 ').slice(0, 140)}`).join('\n')}`
      }
    }
    return null
  }

  /** The shortest run of 2..8 calls that the latest calls repeat `cycleRepeats` times. */
  private cycle(): string[] | null {
    const r = this.recent
    for (let k = 2; k <= 8; k++) {
      const need = k * this.cfg.cycleRepeats
      if (r.length < need) break
      const tail = r.slice(-need)
      const block = tail.slice(0, k)
      if (new Set(block).size < 2) continue
      if (tail.every((s, i) => s === block[i % k])) return block
    }
    return null
  }

  /** "Let it continue": forgive what tripped, and give a long task more time. */
  forgive(trip: Trip, extraMinutes = 15): void {
    if (trip.kind === 'budget') this.budgetMs += extraMinutes * 60_000
    if (trip.kind === 'budget') this.budgetTripped = false
    if (trip.kind === 'launch') {
      const l = this.launches.get(trip.key.slice('launch:'.length))
      if (l) (l.sinceEdit = 0), (l.total = 0)
    }
    if (trip.kind === 'repeat') this.exact.delete(trip.key.slice('repeat:'.length))
    this.recent = []
  }
}

function ordinal(n: number): string {
  const words = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth']
  return words[n] ?? `${n}th`
}

/** How the user's answer reaches the agent. */
export type WatchVerdict = { ok: true } | { ok: false; reason: string; stop?: boolean }

export function verdictFor(item: { approved?: boolean; note?: string; status?: string }): WatchVerdict {
  if (item.approved) return { ok: true }
  // settled by the app (a session switch, a restart) rather than by the user: stop, say nothing more
  const note = item.status === 'auto' ? '' : item.note?.trim()
  if (note) return { ok: false, reason: `The user paused you here and said: ${note}\nDo what they said before anything else; do not repeat the step that was paused.` }
  return { ok: false, reason: 'The user stopped this task because it was repeating itself. Do not run anything else: report what you did, what keeps failing, and what you need.', stop: true }
}
