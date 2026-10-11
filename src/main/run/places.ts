import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Crash, Frame, Place } from '@shared/run/crash'

/** Folders never searched for a trace's files: dependencies, build output, engine caches. */
const SKIP = new Set(['.git', '.multimine', 'node_modules', '.gradle', 'build', 'run', 'out', 'dist', 'target', 'bin', 'obj', '.godot', 'Library', 'Temp', 'Logs', 'Binaries', 'Intermediate', 'DerivedDataCache', 'Saved', '.idea', '.vs', '__pycache__'])

const posix = (p: string) => p.split(sep).join('/')

/** Every project file named one of `names`, by name (walks at most `limit` entries). */
async function findByName(dir: string, names: Set<string>, limit = 60_000): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>()
  let seen = 0
  const walk = async (rel: string): Promise<void> => {
    if (seen > limit) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(join(dir, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (++seen > limit) return
      const path = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && !e.name.startsWith('.')) await walk(path)
      } else if (names.has(e.name)) found.set(e.name, [...(found.get(e.name) ?? []), path])
    }
  }
  await walk('')
  return found
}

/** The project file a frame points at, or null for library and engine code. */
function locate(dir: string, f: Frame, byName: Map<string, string[]>): string | null {
  let file = f.file
  if (file.startsWith('file://')) {
    try {
      file = fileURLToPath(file)
    } catch {
      return null
    }
  }
  if (isAbsolute(file) || /^[A-Za-z]:[\\/]/.test(file)) {
    const rel = relative(dir, file)
    return rel && !rel.startsWith('..') && !isAbsolute(rel) && existsSync(file) ? posix(rel) : null
  }
  const clean = file.replace(/\\/g, '/').replace(/^\.\//, '')
  if (clean.includes('/') && existsSync(join(dir, clean))) return clean
  const name = clean.split('/').pop()!
  const all = byName.get(name) ?? []
  // a JVM frame names the package: the file whose path ends with it
  if (f.hint) {
    const hit = all.find((p) => p === f.hint || p.endsWith(`/${f.hint}`))
    if (hit) return hit
    return null
  }
  return all.length === 1 ? all[0] : (all.find((p) => p.endsWith(clean)) ?? null)
}

/** A few lines around `line`, numbered, with the line itself marked. */
export async function snippetAt(dir: string, path: string, line: number, before = 5, after = 3): Promise<string | undefined> {
  try {
    const text = await readFile(join(dir, path), 'utf8')
    const all = text.split(/\r?\n/)
    if (line < 1 || line > all.length) return undefined
    const from = Math.max(1, line - before)
    const to = Math.min(all.length, line + after)
    const width = String(to).length
    return all
      .slice(from - 1, to)
      .map((l, i) => `${from + i === line ? '>' : ' '} ${String(from + i).padStart(width)} | ${l.length > 200 ? `${l.slice(0, 200)}...` : l}`)
      .join('\n')
  } catch {
    return undefined
  }
}

/** The frames of a problem that are in the project, innermost first, with the code at the top two. */
export async function placesFor(dir: string, c: Crash): Promise<Place[]> {
  if (!c.frames.length) return []
  const names = new Set(c.frames.map((f) => f.file.replace(/\\/g, '/').split('/').pop()!).filter(Boolean))
  const byName = await findByName(dir, names)
  const places: Place[] = []
  for (const f of c.frames) {
    const path = locate(dir, f, byName)
    if (!path || places.some((p) => p.path === path && p.line === f.line)) continue
    places.push({ path, line: f.line })
    if (places.length >= 6) break
  }
  for (const p of places.slice(0, 2)) p.snippet = await snippetAt(dir, p.path, p.line)
  return places
}
