import { describe, expect, it } from 'vitest'
import { counts, parseVerdict, runCouncil, councilReport } from '../../src/main/orchestrator/council'

const verdict = (approve: boolean, severities: string[]) =>
  JSON.stringify({ objections: severities.map((s, i) => ({ issue: `issue ${i}`, severity: s })), approve, wouldApproveIf: 'tests', rebuttals: [] })

describe('council', () => {
  it('parses fenced or bare JSON and refuses to trust a malformed answer', () => {
    expect(parseVerdict('L', '```json\n' + verdict(true, ['low', 'low', 'medium']) + '\n```').objections).toHaveLength(3)
    const bad = parseVerdict('L', 'Looks great to me!')
    expect(bad.malformed).toBe(true)
    expect(counts(bad)).toBe(false)
  })

  it('does not count an approval with a high objection or too few objections', () => {
    expect(counts(parseVerdict('L', verdict(true, ['high', 'low', 'low'])))).toBe(false)
    expect(counts(parseVerdict('L', verdict(true, ['low'])))).toBe(false)
    expect(counts(parseVerdict('L', verdict(true, ['low', 'medium', 'low'])))).toBe(true)
  })

  it('passes only on a majority of counted approvals', () => {
    const v = [parseVerdict('A', verdict(true, ['low', 'low', 'low'])), parseVerdict('B', verdict(true, ['high', 'low', 'low'])), parseVerdict('C', verdict(false, ['low', 'low', 'low']))]
    const r = councilReport(v)
    expect(r.approvals).toBe(1)
    expect(r.passed).toBe(false)
    expect(r.report).toContain('approve (not counted)')
  })

  it('runs a blind round then a cross-examination round that sees the others', async () => {
    const prompts: string[] = []
    const progress: string[] = []
    const result = await runCouncil(
      'PLAN',
      { size: 3, provider: 'mock', model: 'mock', effort: 'low', lenses: ['Skeptic', 'Scope', 'UX'], rounds: 2 },
      {
        complete: async (_s, prompt) => {
          prompts.push(prompt)
          return prompt.includes('Round two') ? JSON.stringify({ objections: [{ issue: 'x', severity: 'low' }, { issue: 'y', severity: 'low' }, { issue: 'z', severity: 'low' }], approve: true, wouldApproveIf: '', rebuttals: ['rebut'] }) : verdict(false, ['high', 'low', 'low'])
        },
        progress: (c) => progress.push(c.map((x) => x.status).join(','))
      }
    )
    expect(prompts).toHaveLength(6)
    expect(prompts.slice(0, 3).every((p) => !p.includes('other critics'))).toBe(true)
    expect(prompts.slice(3).every((p) => p.includes('The other critics said'))).toBe(true)
    expect(result.passed).toBe(true)
    expect(result.verdicts[0].rebuttals).toEqual(['rebut'])
    expect(progress.at(-1)).toBe('done,done,done')
  })
})
