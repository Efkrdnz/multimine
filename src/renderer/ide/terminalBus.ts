/**
 * Terminal output arrives on the app-wide event stream; a terminal tab may mount a moment after its
 * first bytes do. Output is held per terminal until its tab attaches, then streamed straight in.
 */
const buffers = new Map<string, string[]>()
const sinks = new Map<string, (data: string) => void>()

export function pushTerminalData(id: string, data: string): void {
  const sink = sinks.get(id)
  if (sink) return sink(data)
  const b = buffers.get(id) ?? []
  b.push(data)
  if (b.length > 2000) b.splice(0, b.length - 2000)
  buffers.set(id, b)
}

export function attachTerminal(id: string, sink: (data: string) => void): () => void {
  sinks.set(id, sink)
  for (const d of buffers.get(id) ?? []) sink(d)
  buffers.delete(id)
  return () => {
    if (sinks.get(id) === sink) sinks.delete(id)
  }
}

export function forgetTerminal(id: string): void {
  sinks.delete(id)
  buffers.delete(id)
}
