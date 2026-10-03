import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A project's CLAUDE.md is loaded by Claude Code into every model call of every agent, sub-agent and
 * helper. A small one is worth that; a large one (a game mod's can run to 170 KB, over 40k tokens)
 * is most of what a long task spends. A large one is therefore not preloaded: the agent is given
 * its outline with line numbers and reads the sections it needs.
 */

/** At or under this, CLAUDE.md loads as usual. */
export const INLINE_LIMIT = 12_000
const MAX_OUTLINE = 80

export interface Section {
  level: number
  title: string
  /** 1-based first and last line. */
  start: number
  end: number
}

export interface ProjectDoc {
  /** Files Claude Code must not preload (each in native and forward-slash form, for the glob matcher). */
  excludes: string[]
  /** What the agent is told instead. Empty when nothing was excluded. */
  note: string
}

/** The headings of a markdown file with the lines each section spans, skipping fenced code. */
export function outline(text: string): Section[] {
  const lines = text.split(/\r?\n/)
  const found: Section[] = []
  let fence = false
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    if (fence) return
    const m = /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line)
    if (m) found.push({ level: m[1].length, title: m[2], start: i + 1, end: lines.length })
  })
  // a section runs to the next heading at its own level or above
  for (let i = 0; i < found.length; i++) {
    const next = found.slice(i + 1).find((s) => s.level <= found[i].level)
    if (next) found[i].end = next.start - 1
  }
  if (found.length <= MAX_OUTLINE) return found
  // too many: keep the shallowest levels that fit
  for (let depth = 3; depth >= 1; depth--) {
    const kept = found.filter((s) => s.level <= depth)
    if (kept.length <= MAX_OUTLINE) return kept
  }
  return found.slice(0, MAX_OUTLINE)
}

/** The note an agent gets in place of a large instructions file. */
export function noteFor(file: string, text: string): string {
  const kb = Math.round(Buffer.byteLength(text) / 1024)
  const sections = outline(text)
  const list = sections.length
    ? sections.map((s) => `${'  '.repeat(Math.max(0, s.level - 1))}- ${s.title} (lines ${s.start}-${s.end})`).join('\n')
    : `(no headings; ${text.split(/\r?\n/).length} lines)`
  return (
    `# Project instructions (${file}, ${kb} KB, not preloaded)\n` +
    `The project's ${file} holds its conventions, commands and how each system works. It is too large to send with every request, so it is not loaded. ` +
    `Before you work in an area, Read the section for it (Read with offset and limit, using the line numbers below) or Grep the file. ` +
    `Never Read the whole file. Its sections:\n${list}`
  )
}

const CANDIDATES = ['CLAUDE.md', '.claude/CLAUDE.md']

/** What to keep out of the preload for a project, and what to say instead. */
export function projectInstructions(dir: string): ProjectDoc {
  const excludes: string[] = []
  const notes: string[] = []
  for (const rel of CANDIDATES) {
    const full = join(dir, rel)
    try {
      if (!existsSync(full) || statSync(full).size <= INLINE_LIMIT) continue
      const text = readFileSync(full, 'utf8')
      excludes.push(full)
      if (full.includes('\\')) excludes.push(full.replace(/\\/g, '/'))
      notes.push(noteFor(rel, text))
    } catch {
      // unreadable: leave it to Claude Code
    }
  }
  return { excludes, note: notes.join('\n\n') }
}
