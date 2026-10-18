/**
 * Terminal output arrives on the app-wide event stream. Each terminal's recent output is kept (the
 * last 200,000 characters), so a tab that mounts later - the code window reopened, or its project
 * back on screen - replays it and carries on from there.
 */
const history = new Map<string, { chunks: string[]; size: number }>()
const sinks = new Map<string, (data: string) => void>()
const KEEP = 200_000

export function pushTerminalData(id: string, data: string): void {
  const h = history.get(id) ?? { chunks: [], size: 0 }
  h.chunks.push(data)
  h.size += data.length
  while (h.size > KEEP && h.chunks.length > 1) h.size -= h.chunks.shift()!.length
  history.set(id, h)
  sinks.get(id)?.(data)
}

export function attachTerminal(id: string, sink: (data: string) => void): () => void {
  sinks.set(id, sink)
  for (const d of history.get(id)?.chunks ?? []) sink(d)
  return () => {
    if (sinks.get(id) === sink) sinks.delete(id)
  }
}

export function forgetTerminal(id: string): void {
  sinks.delete(id)
  history.delete(id)
}
