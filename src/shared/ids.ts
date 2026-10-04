let counter = 0
/** Sortable, collision-safe within a process: time base36 + counter + random. */
export function newId(prefix = ''): string {
  counter = (counter + 1) % 1296
  return prefix + Date.now().toString(36) + counter.toString(36).padStart(2, '0') + Math.random().toString(36).slice(2, 6)
}

/** A slug safe for a file name or an id: lower case, dashes, never empty. */
export function slugify(name: string, fallback = 'item'): string {
  const s = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return s || fallback
}
