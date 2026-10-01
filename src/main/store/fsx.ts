import { mkdir, readFile, rename, writeFile, appendFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  const text = await readText(path)
  if (text == null) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

const chains = new Map<string, Promise<void>>()
let seq = 0

/**
 * Write through a temp file so a crash never leaves half a file. Writes to one path are serialized
 * (the inbox and session meta are rewritten from several places at once) and each has its own temp.
 */
export function writeAtomic(path: string, text: string): Promise<void> {
  const prev = chains.get(path) ?? Promise.resolve()
  const next = prev.then(async () => {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.${++seq}.tmp`
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, path)
  })
  const settled = next.catch(() => undefined)
  chains.set(path, settled)
  void settled.then(() => {
    if (chains.get(path) === settled) chains.delete(path)
  })
  return next
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeAtomic(path, JSON.stringify(value, null, 2) + '\n')
}

export async function appendLine(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, JSON.stringify(value) + '\n', 'utf8')
}

export async function readLines<T>(path: string): Promise<T[]> {
  const text = await readText(path)
  if (!text) return []
  const out: T[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as T)
    } catch {
      // a torn last line from a crash is skipped, not fatal
    }
  }
  return out
}
