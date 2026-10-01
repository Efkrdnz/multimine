let counter = 0
/** Sortable, collision-safe within a process: time base36 + counter + random. */
export function newId(prefix = ''): string {
  counter = (counter + 1) % 1296
  return prefix + Date.now().toString(36) + counter.toString(36).padStart(2, '0') + Math.random().toString(36).slice(2, 6)
}
