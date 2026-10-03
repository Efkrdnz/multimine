import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { INLINE_LIMIT, noteFor, outline, projectInstructions } from '../../src/main/providers/projectDoc'

it('an outline gives each heading the lines its section spans, ignoring code fences', () => {
  const md = ['# Title', 'intro', '## A', 'a', '```', '# not a heading', '```', '### A1', 'x', '## B', 'b'].join('\n')
  expect(outline(md)).toEqual([
    { level: 1, title: 'Title', start: 1, end: 11 },
    { level: 2, title: 'A', start: 3, end: 9 },
    { level: 3, title: 'A1', start: 8, end: 9 },
    { level: 2, title: 'B', start: 10, end: 11 }
  ])
})

it('a long outline keeps the shallow levels', () => {
  const md = Array.from({ length: 50 }, (_, i) => `## S${i}\n### Sub${i}a\n### Sub${i}b\ntext`).join('\n')
  const o = outline(md)
  expect(o.length).toBe(50)
  expect(o.every((s) => s.level === 2)).toBe(true)
  expect(noteFor('CLAUDE.md', md)).toContain('- S0 (lines 1-4)')
})

it('a small CLAUDE.md loads as usual, a large one is excluded and outlined', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mm-doc-'))
  try {
    expect(projectInstructions(dir)).toEqual({ excludes: [], note: '' })
    await writeFile(join(dir, 'CLAUDE.md'), '# Small\nfine')
    expect(projectInstructions(dir).excludes).toEqual([])
    await writeFile(join(dir, 'CLAUDE.md'), `# Big\n## Commands\n${'x'.repeat(INLINE_LIMIT)}\n## Architecture\ny`)
    const doc = projectInstructions(dir)
    expect(doc.excludes).toEqual([join(dir, 'CLAUDE.md')])
    expect(doc.note).toContain('not preloaded')
    expect(doc.note).toContain('  - Architecture (lines 4-5)')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
