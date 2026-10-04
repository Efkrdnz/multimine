import type { Cell, CodeLink, Table } from './model'

/** Where a linked value was found, and what it is there. */
export interface Found {
  /** 1-based line it was found on (it may have moved from the link's hint). */
  line: number
  /** Where on that line the literal starts and ends. */
  start: number
  end: number
  /** The literal as written: `20`, `2.5f`, `"Fire"`. */
  raw: string
  value: Cell
}

export type LinkState = 'ok' | 'moved' | 'missing'

const NUMBER = /^(-?)(\d[\d_]*)(\.\d+)?([eE][+-]?\d+)?([fFdDlL]?)$/

/** The value a literal stands for: a number, a quoted string, a boolean, or the text as it is (an expression). */
export function parseLiteral(raw: string): Cell {
  const s = raw.trim()
  const n = NUMBER.exec(s)
  if (n) return Number(`${n[1]}${n[2].replace(/_/g, '')}${n[3] ?? ''}${n[4] ?? ''}`)
  const q = /^(["'`])([\s\S]*)\1$/.exec(s)
  if (q) return q[2].replace(/\\(["'`\\])/g, '$1')
  if (s === 'true' || s === 'false') return s === 'true'
  return s
}

/**
 * A value written the way the old literal was: a float stays a float (`2.0f`), a suffix stays, a
 * quoted string keeps its quotes. Anything else is written as it reads.
 */
export function formatLiteral(oldRaw: string, value: Cell): string {
  const old = oldRaw.trim()
  if (value === null) return old
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'number') {
    const n = NUMBER.exec(old)
    if (!n) return String(value)
    const suffix = n[5] ?? ''
    const floaty = !!n[3] || /[fFdD]/.test(suffix)
    let body = String(value)
    if (floaty && Number.isInteger(value)) body = `${value}.0`
    return `${body}${suffix}`
  }
  const q = /^(["'`])[\s\S]*\1$/.exec(old)
  if (q) return `${q[1]}${value.replace(/\\/g, '\\\\').replace(new RegExp(q[1], 'g'), `\\${q[1]}`)}${q[1]}`
  return value
}

/** Whether a table's value and the code's mean the same. */
export function sameValue(a: Cell, b: Cell): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))
  return (a ?? '') === (b ?? '')
}

function findOnLine(text: string, link: CodeLink): { start: number; end: number } | null {
  const b = text.indexOf(link.before)
  if (b < 0) return null
  const start = b + link.before.length
  if (!link.after) {
    // nothing after it: the value runs to the end of the line, comment and spaces aside
    const rest = text.slice(start).replace(/\s*(\/\/.*|#.*)?$/, '')
    return rest.trim() ? { start, end: start + rest.length } : null
  }
  const end = text.indexOf(link.after, start)
  if (end < 0 || end === start) return null
  // the value is one literal or a short expression, never half a line of code
  if (end - start > 120) return null
  return { start, end }
}

/**
 * Finds a linked value: on the link's line first, then on the nearest line that has the same text
 * around it (the code moved). Null when no line has it any more.
 */
export function locate(fileText: string, link: CodeLink): Found | null {
  const lines = fileText.split('\n')
  const hint = Math.min(Math.max(link.line - 1, 0), Math.max(lines.length - 1, 0))
  for (let d = 0; d < lines.length; d++) {
    for (const i of d === 0 ? [hint] : [hint - d, hint + d]) {
      if (i < 0 || i >= lines.length) continue
      const at = findOnLine(lines[i].replace(/\r$/, ''), link)
      if (!at) continue
      const raw = lines[i].slice(at.start, at.end)
      return { line: i + 1, start: at.start, end: at.end, raw, value: parseLiteral(raw) }
    }
  }
  return null
}

/** The file with a linked value rewritten, and the line before and after; null when the value is not there. */
export function patch(fileText: string, link: CodeLink, value: Cell): { text: string; line: number; from: string; to: string } | null {
  const found = locate(fileText, link)
  if (!found) return null
  const lines = fileText.split('\n')
  const old = lines[found.line - 1]
  const lead = found.raw.length - found.raw.trimStart().length
  const trail = found.raw.length - found.raw.trimEnd().length
  const next = `${old.slice(0, found.start + lead)}${formatLiteral(found.raw, value)}${old.slice(found.end - trail)}`
  lines[found.line - 1] = next
  return { text: lines.join('\n'), line: found.line, from: old.replace(/\r$/, ''), to: next.replace(/\r$/, '') }
}

/** One value the user changed in a linked cell, ready to write into the code. */
export interface Change {
  rowId: string
  key: string
  label: string
  file: string
  line: number
  from: string
  to: string
  value: Cell
}

/**
 * What writing the edited cells would do to the code: one change per cell, every file's new text,
 * and the cells whose value can no longer be found (they are left alone).
 */
export function planChanges(table: Table, edited: { rowId: string; key: string }[], files: Record<string, string>): { changes: Change[]; texts: Record<string, string>; missing: { rowId: string; key: string }[] } {
  const texts: Record<string, string> = { ...files }
  const changes: Change[] = []
  const missing: { rowId: string; key: string }[] = []
  for (const { rowId, key } of edited) {
    const row = table.rows.find((r) => r.id === rowId)
    const link = row?.links?.[key]
    if (!row || !link || texts[link.file] === undefined) {
      missing.push({ rowId, key })
      continue
    }
    const p = patch(texts[link.file], link, row.cells[key])
    if (!p) {
      missing.push({ rowId, key })
      continue
    }
    if (p.from === p.to) continue
    texts[link.file] = p.text
    const label = `${String(row.cells[table.columns[0]?.key] ?? row.id)} · ${table.columns.find((c) => c.key === key)?.label ?? key}`
    changes.push({ rowId, key, label, file: link.file, line: p.line, from: p.from, to: p.to, value: row.cells[key] })
  }
  return { changes, texts, missing }
}

/**
 * The table as the code has it now: every linked value read from its file, each link's line kept
 * up to date, and the state of every link (`row.key` -> ok, moved or missing). Cells in `keep` (the
 * user's unsaved edits) keep the table's value.
 */
export function readFromCode(table: Table, files: Record<string, string>, keep: Set<string> = new Set()): { table: Table; states: Record<string, LinkState>; changed: string[] } {
  const states: Record<string, LinkState> = {}
  const changed: string[] = []
  const rows = table.rows.map((row) => {
    if (!row.links) return row
    const cells = { ...row.cells }
    const links = { ...row.links }
    for (const [key, link] of Object.entries(row.links)) {
      const id = `${row.id}.${key}`
      const text = files[link.file]
      const found = text === undefined ? null : locate(text, link)
      if (!found) {
        states[id] = 'missing'
        continue
      }
      states[id] = found.line === link.line ? 'ok' : 'moved'
      if (found.line !== link.line) links[key] = { ...link, line: found.line }
      if (!keep.has(id) && !sameValue(cells[key], found.value)) {
        cells[key] = found.value
        changed.push(id)
      }
    }
    return { ...row, cells, links }
  })
  return { table: { ...table, rows }, states, changed }
}

/** Every file a table's links point into. */
export function linkedFiles(table: Table): string[] {
  return [...new Set(table.rows.flatMap((r) => Object.values(r.links ?? {}).map((l) => l.file)))]
}
