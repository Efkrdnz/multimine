import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import type { IdeEntry, IdeHit } from '@shared/types'
import { SKIP, insideProject, walk } from '../orchestrator/workspace'

const MAX_OPEN = 3_000_000

const rel = (root: string, full: string) => relative(root, full).split(sep).join('/')

/** Hidden from the navigator as well as from search: build output, VCS, and Multimine's own logs. */
export function hidden(name: string, relPath: string): boolean {
  if (SKIP.has(name)) return true
  return relPath === '.multimine/sessions' || relPath === '.multimine/media'
}

/** One level of the tree, folders first. The navigator loads deeper levels as they are opened. */
export async function list(root: string, dir = ''): Promise<IdeEntry[]> {
  const full = insideProject(root, dir || '.')
  const entries = await readdir(full, { withFileTypes: true }).catch(() => [])
  return entries
    .map((e) => ({ name: e.name, path: rel(root, join(full, e.name)), dir: e.isDirectory() }))
    .filter((e) => !hidden(e.name, e.path))
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.dir ? -1 : 1))
}

/**
 * Fuzzy file-name match: every character of the query appears in order. Contiguous runs, a match
 * at the start of the file name, and shorter paths score higher. Returns null when it does not match.
 */
export function fuzzyScore(query: string, path: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, '')
  if (!q) return 0
  const p = path.toLowerCase()
  const name = p.slice(p.lastIndexOf('/') + 1)
  let score = 0
  let at = -1
  let run = 0
  for (const ch of q) {
    const i = p.indexOf(ch, at + 1)
    if (i < 0) return null
    run = i === at + 1 ? run + 1 : 0
    score += 1 + run * 2
    at = i
  }
  if (name.includes(q)) score += 20 + (name.startsWith(q) ? 15 : 0)
  return score - p.length * 0.02
}

export class ProjectFiles {
  private cache: string[] | null = null

  constructor(private readonly root: string) {}

  /** Forget the file list (the watcher calls this when files come and go). */
  invalidate(): void {
    this.cache = null
  }

  async files(): Promise<string[]> {
    if (this.cache) return this.cache
    const out: string[] = []
    await walk(this.root, this.root, 40, out, 60_000)
    this.cache = out.filter((f) => !f.endsWith('/') && !f.startsWith('.multimine/sessions/') && !f.startsWith('.multimine/media/'))
    return this.cache
  }

  async findFiles(query: string, limit = 80): Promise<IdeHit[]> {
    const scored: { path: string; score: number }[] = []
    for (const f of await this.files()) {
      const s = fuzzyScore(query, f)
      if (s !== null) scored.push({ path: f, score: s })
    }
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => ({ path: x.path }))
  }

  /** Text search inside files: literal, case-insensitive, at most `limit` hits. */
  async grep(query: string, limit = 300): Promise<IdeHit[]> {
    const q = query.toLowerCase()
    if (!q) return []
    const hits: IdeHit[] = []
    for (const f of await this.files()) {
      const full = join(this.root, f)
      try {
        if ((await stat(full)).size > 1_500_000) continue
        const text = await readFile(full, 'utf8')
        if (text.includes('\u0000') || !text.toLowerCase().includes(q)) continue
        const lines = text.split('\n')
        for (let i = 0; i < lines.length && hits.length < limit; i++)
          if (lines[i].toLowerCase().includes(q)) hits.push({ path: f, line: i + 1, text: lines[i].trim().slice(0, 200) })
      } catch {
        // unreadable
      }
      if (hits.length >= limit) break
    }
    return hits
  }

  async read(path: string): Promise<{ text: string; binary: boolean; tooBig: boolean }> {
    const full = insideProject(this.root, path)
    const size = (await stat(full)).size
    if (size > MAX_OPEN) return { text: '', binary: false, tooBig: true }
    const buf = await readFile(full)
    const binary = buf.subarray(0, 8000).includes(0)
    return { text: binary ? '' : buf.toString('utf8'), binary, tooBig: false }
  }

  async write(path: string, text: string): Promise<void> {
    const full = insideProject(this.root, path)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, text, 'utf8')
  }
}
