import type { CouncilConfig, CouncilCritic } from '@shared/types'

export type Severity = 'high' | 'medium' | 'low'

export interface Objection {
  issue: string
  severity: Severity
  fix?: string
}

export interface CriticVerdict {
  lens: string
  objections: Objection[]
  approve: boolean
  wouldApproveIf: string
  /** Round 2: what this critic answered to the others. */
  rebuttals: string[]
  /** The critic did not return a usable verdict. */
  malformed?: boolean
}

export const MIN_OBJECTIONS = 3

export function criticSystem(lens: string): string {
  return `You are a critic on a review council, judging a plan through one lens: ${lens}.
Your job is to find what is wrong, missing, risky or over-built - not to agree. A plan that looks
fine to you has problems you have not found yet; look harder. Praise is worthless here.
Rules:
- Give at least ${MIN_OBJECTIONS} concrete objections, each tied to a specific part of the plan.
- Rate each one high (it would fail or do damage), medium (it costs real rework) or low.
- "approve" may be true only if none of your objections is high.
- Say exactly what would make you approve.
Answer with one JSON object and nothing else:
{"objections":[{"issue":"...","severity":"high|medium|low","fix":"..."}],"approve":false,"wouldApproveIf":"...","rebuttals":[]}`
}

export function roundOnePrompt(plan: string, focus?: string): string {
  return `${focus ? `Focus: ${focus}\n\n` : ''}# Plan under review\n\n${plan}`
}

export function roundTwoPrompt(plan: string, own: CriticVerdict, others: CriticVerdict[]): string {
  const theirs = others
    .map((v) => `### ${v.lens}\n${v.objections.map((o) => `- [${o.severity}] ${o.issue}`).join('\n') || '- (none)'}`)
    .join('\n\n')
  return `# Plan under review\n\n${plan}\n\n# Your first verdict\n${JSON.stringify(own)}\n\n# The other critics said\n${theirs}\n\n` +
    `Round two. For at least one of the other critics' objections, either rebut it with a reason or escalate it ` +
    `(it is worse than they said). Put those in "rebuttals". Then give your final verdict: you may change severities ` +
    `or your approval, but only for a reason you state. Same JSON shape as before.`
}

function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const candidates = [fenced?.[1], text]
  for (const c of candidates) {
    if (!c) continue
    const start = c.indexOf('{')
    const end = c.lastIndexOf('}')
    if (start < 0 || end <= start) continue
    try {
      return JSON.parse(c.slice(start, end + 1))
    } catch {
      // try the next candidate
    }
  }
  return null
}

/** Reads a critic's answer. A critic that does not follow the format is recorded as such, not trusted. */
export function parseVerdict(lens: string, text: string): CriticVerdict {
  const raw = extractJson(text) as any
  if (!raw || !Array.isArray(raw.objections)) {
    return {
      lens,
      objections: [{ issue: 'The critic returned no structured verdict, so its review cannot be counted.', severity: 'medium' }],
      approve: false,
      wouldApproveIf: '',
      rebuttals: [],
      malformed: true
    }
  }
  const sev = (s: unknown): Severity => (s === 'high' || s === 'medium' || s === 'low' ? s : 'medium')
  return {
    lens,
    objections: raw.objections
      .filter((o: any) => o && typeof o.issue === 'string')
      .map((o: any) => ({ issue: o.issue, severity: sev(o.severity), fix: typeof o.fix === 'string' ? o.fix : undefined })),
    approve: raw.approve === true,
    wouldApproveIf: typeof raw.wouldApproveIf === 'string' ? raw.wouldApproveIf : '',
    rebuttals: Array.isArray(raw.rebuttals) ? raw.rebuttals.filter((r: unknown): r is string => typeof r === 'string') : []
  }
}

/**
 * Whether a critic's approval counts. Approval is not taken at face value: it needs no high
 * objection standing, and a critic that found fewer than MIN_OBJECTIONS did not do the job.
 */
export function counts(v: CriticVerdict): boolean {
  return v.approve && !v.malformed && v.objections.length >= MIN_OBJECTIONS && !v.objections.some((o) => o.severity === 'high')
}

export interface CouncilResult {
  verdicts: CriticVerdict[]
  approvals: number
  /** Majority of counted approvals. */
  passed: boolean
  report: string
}

export function councilReport(verdicts: CriticVerdict[]): CouncilResult {
  const approvals = verdicts.filter(counts).length
  const passed = approvals * 2 > verdicts.length
  const rows = verdicts.map((v) => {
    const high = v.objections.filter((o) => o.severity === 'high').length
    const verdict = counts(v) ? 'approve' : v.malformed ? 'no verdict' : v.approve ? 'approve (not counted)' : 'reject'
    return `| ${v.lens.split(':')[0]} | ${verdict} | ${high} | ${v.objections.length} |`
  })
  const details = verdicts
    .map((v) => {
      const obs = v.objections.map((o) => `- **${o.severity}** ${o.issue}${o.fix ? `\n  - fix: ${o.fix}` : ''}`).join('\n')
      const reb = v.rebuttals.length ? `\n\n_Round two:_\n${v.rebuttals.map((r) => `- ${r}`).join('\n')}` : ''
      const ifs = v.wouldApproveIf ? `\n\n_Would approve if:_ ${v.wouldApproveIf}` : ''
      return `### ${v.lens}\n${obs || '- (no objections)'}${reb}${ifs}`
    })
    .join('\n\n')
  const report =
    `## Council verdict: ${passed ? 'PASSES' : 'DOES NOT PASS'} (${approvals}/${verdicts.length} counted approvals)\n\n` +
    `| Critic | Verdict | High | Objections |\n|---|---|---|---|\n${rows.join('\n')}\n\n${details}`
  return { verdicts, approvals, passed, report }
}

export interface CouncilRunner {
  /** One completion with no tools, on the council's configured provider. */
  complete(system: string, prompt: string, criticId: string): Promise<string>
  progress(critics: CouncilCritic[]): void
}

export async function runCouncil(plan: string, config: CouncilConfig, runner: CouncilRunner, focus?: string): Promise<CouncilResult> {
  const lenses = Array.from({ length: Math.max(1, config.size) }, (_, i) => config.lenses[i % config.lenses.length] ?? `Critic ${i + 1}`)
  const critics: CouncilCritic[] = lenses.map((lens, i) => ({ id: `critic-${i + 1}`, lens, status: 'thinking' }))
  runner.progress(critics)
  const mark = (i: number, status: CouncilCritic['status']) => {
    critics[i] = { ...critics[i], status }
    runner.progress([...critics])
  }
  // round one is blind: every critic sees only the plan
  let verdicts = await Promise.all(
    lenses.map(async (lens, i) => {
      try {
        return parseVerdict(lens, await runner.complete(criticSystem(lens), roundOnePrompt(plan, focus), critics[i].id))
      } catch (e) {
        mark(i, 'error')
        return parseVerdict(lens, `error: ${(e as Error).message}`)
      }
    })
  )
  if (config.rounds === 2 && verdicts.length > 1) {
    critics.forEach((_, i) => mark(i, 'thinking'))
    verdicts = await Promise.all(
      verdicts.map(async (own, i) => {
        const others = verdicts.filter((_, j) => j !== i)
        try {
          const next = parseVerdict(own.lens, await runner.complete(criticSystem(own.lens), roundTwoPrompt(plan, own, others), critics[i].id))
          return next.malformed ? own : next
        } catch {
          return own
        }
      })
    )
  }
  critics.forEach((c, i) => mark(i, c.status === 'error' ? 'error' : 'done'))
  return councilReport(verdicts)
}
