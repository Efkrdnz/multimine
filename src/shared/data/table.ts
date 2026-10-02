/**
 * A game data file as a table: JSON (an array of objects, an object of objects keyed by id, or an
 * object holding one such array) or CSV/TSV. Parsing remembers the file's shape and formatting so a
 * save writes the same layout back - same indentation, key order, line endings, final newline - and a
 * row nobody touched comes out exactly as it went in, so the diff is only what was changed.
 */

export type ColType = 'int' | 'number' | 'bool' | 'enum' | 'string' | 'json'

export interface Column {
  name: string
  type: ColType
  /** The values an enum column takes, in first-seen order. */
  values?: string[]
}

export interface Row {
  /** A stable id for the editor (not written to the file). */
  rid: number
  /** For a keyed object: the row's key. */
  key?: string
  /** The row's fields, in its own key order. CSV fields are strings. */
  value: Record<string, unknown>
  /** The row's original text, kept while it is untouched (for JSON, the object; for CSV, the line). */
  raw?: string
  /** JSON: where the row sat in the file it was read from. */
  span?: { keyStart?: number; valueStart: number; valueEnd: number; key?: string }
}

export type Shape =
  | { kind: 'array' }
  | { kind: 'keyed' }
  | { kind: 'wrapped'; prop: string; root: Record<string, unknown> }
  | { kind: 'csv'; delimiter: ',' | '\t'; header: string[]; headerRaw: string }

export interface Format {
  indent: string
  eol: '\n' | '\r\n'
  finalNewline: boolean
  /** Arrays of plain values written on one line (`["a", "b"]`), as formatters like Prettier leave them. */
  inlineArrays: boolean
  /** What separates the items of such an array. */
  inlineSep: string
}

export interface Table {
  path: string
  shape: Shape
  format: Format
  columns: Column[]
  rows: Row[]
  /** JSON: the text read, the container the rows live in, and the rows it held in order. */
  source?: { text: string; open: number; close: number; rids: number[]; childIndent: string; closeIndent: string }
}

/** The synthetic column a keyed object's keys are shown in. */
export const KEY_COLUMN = '(key)'

const SKIP_DIRS = new Set(['node_modules', '.git', 'build', 'dist', 'out', 'Library', 'Temp', 'Logs', 'obj', 'bin', '.godot', '.import', '.gradle', 'run', 'Binaries', 'Intermediate', 'Saved', 'DerivedDataCache', '.idea', '.vscode', '.multimine', 'coverage', 'test-results', 'target'])
const SKIP_FILES = new Set(['package.json', 'package-lock.json', 'tsconfig.json', 'jsconfig.json', 'composer.json', 'manifest.json', 'pack.mcmeta', 'components.json', '.eslintrc.json', 'turbo.json', 'vercel.json', 'deno.json'])

export const skipDir = (name: string): boolean => SKIP_DIRS.has(name) || name.startsWith('.')

/** Whether a file is worth offering as data (by its name; its content decides later). */
export function isDataFile(name: string): boolean {
  const n = name.toLowerCase()
  if (SKIP_FILES.has(n) || n.startsWith('tsconfig.') || n.endsWith('.lock.json')) return false
  return n.endsWith('.json') || n.endsWith('.csv') || n.endsWith('.tsv')
}

function detectFormat(text: string): Format {
  const eol: Format['eol'] = text.includes('\r\n') ? '\r\n' : '\n'
  const m = /\n([ \t]+)\S/.exec(text)
  const inline = /\[[^[\]{}\r\n]+\]/.exec(text)
  return { indent: m ? (m[1].startsWith('\t') ? '\t' : m[1]) : '  ', eol, finalNewline: /\n$/.test(text), inlineArrays: !!inline, inlineSep: inline && !/,\s/.test(inline[0]) && inline[0].includes(',') ? ',' : ', ' }
}

// ---- a scanner just good enough to find where each row sits in the text ----

const WS = /\s/
function skipWs(t: string, i: number): number {
  while (i < t.length && WS.test(t[i])) i++
  return i
}
function endOfString(t: string, i: number): number {
  for (i++; i < t.length; i++) {
    if (t[i] === '\\') i++
    else if (t[i] === '"') return i + 1
  }
  return i
}
function endOfValue(t: string, i: number): number {
  const c = t[i]
  if (c === '"') return endOfString(t, i)
  if (c === '{' || c === '[') {
    let depth = 0
    while (i < t.length) {
      const ch = t[i]
      if (ch === '"') {
        i = endOfString(t, i)
        continue
      }
      if (ch === '{' || ch === '[') depth++
      else if (ch === '}' || ch === ']') {
        depth--
        if (depth === 0) return i + 1
      }
      i++
    }
    return i
  }
  while (i < t.length && !/[\s,\]}]/.test(t[i])) i++
  return i
}
type Entry = { keyStart?: number; key?: string; valueStart: number; valueEnd: number }
/** The entries of the object or array opening at `open`, and where it closes. */
function entries(t: string, open: number): { list: Entry[]; close: number } {
  const obj = t[open] === '{'
  const list: Entry[] = []
  let i = skipWs(t, open + 1)
  if (t[i] === (obj ? '}' : ']')) return { list, close: i }
  while (i < t.length) {
    let keyStart: number | undefined
    let key: string | undefined
    if (obj) {
      keyStart = i
      const ke = endOfString(t, i)
      key = JSON.parse(t.slice(i, ke)) as string
      i = skipWs(t, skipWs(t, ke) + 1)
    }
    const valueEnd = endOfValue(t, i)
    list.push({ keyStart, key, valueStart: i, valueEnd })
    i = skipWs(t, valueEnd)
    if (t[i] !== ',') return { list, close: i }
    i = skipWs(t, i + 1)
  }
  return { list, close: i }
}
/** The whitespace a line starts with, for the line `at` is on. */
function lineIndent(t: string, at: number): string {
  const start = t.lastIndexOf('\n', at - 1) + 1
  return /^[ \t]*/.exec(t.slice(start, at))![0]
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

let ridCounter = 0
const nextRid = () => ++ridCounter

/** Reads a data file into a table, or explains why it is not one. */
export function parseTable(path: string, text: string): { ok: true; table: Table } | { ok: false; reason: string } {
  const format = detectFormat(text)
  const lower = path.toLowerCase()
  if (lower.endsWith('.csv') || lower.endsWith('.tsv')) return parseCsv(path, text, lower.endsWith('.tsv') ? '\t' : ',', format)
  let data: unknown
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (e) {
    return { ok: false, reason: `Not valid JSON: ${(e as Error).message}` }
  }
  let shape: Shape
  let rows: Row[]
  if (Array.isArray(data)) {
    if (!data.length || !data.every(isRecord)) return { ok: false, reason: 'A JSON array, but not of objects' }
    shape = { kind: 'array' }
    rows = data.map((v) => ({ rid: nextRid(), value: { ...(v as Record<string, unknown>) } }))
  } else if (isRecord(data)) {
    const vals = Object.values(data)
    const arrays = Object.entries(data).filter(([, v]) => Array.isArray(v) && v.length > 0 && v.every(isRecord))
    if (vals.length && vals.every(isRecord)) {
      shape = { kind: 'keyed' }
      rows = Object.entries(data).map(([key, v]) => ({ rid: nextRid(), key, value: { ...(v as Record<string, unknown>) } }))
    } else if (arrays.length === 1) {
      const [prop, arr] = arrays[0] as [string, Record<string, unknown>[]]
      shape = { kind: 'wrapped', prop, root: data }
      rows = arr.map((v) => ({ rid: nextRid(), value: { ...v } }))
    } else return { ok: false, reason: arrays.length > 1 ? 'Holds several tables; open one of them as its own file' : 'Not a table of records' }
  } else return { ok: false, reason: 'Not a table of records' }
  // where the rows sit, so untouched ones are written back exactly as they were
  let open = skipWs(text, text.charCodeAt(0) === 0xfeff ? 1 : 0)
  if (shape.kind === 'wrapped') {
    const prop = shape.prop
    const at = entries(text, open).list.find((e) => e.key === prop)
    if (at) open = at.valueStart
  }
  const { list, close } = entries(text, open)
  // a keyed object's rows in the order the file has them (Object.entries puts integer-like keys first)
  if (shape.kind === 'keyed' && new Set(list.map((e) => e.key)).size === list.length && list.length === rows.length) {
    const byKey = new Map(rows.map((r) => [r.key, r]))
    rows = list.map((e) => byKey.get(e.key)!)
  }
  const source = list.length === rows.length ? { text, open, close, rids: rows.map((r) => r.rid), childIndent: list.length ? lineIndent(text, list[0].keyStart ?? list[0].valueStart) : format.indent, closeIndent: lineIndent(text, close) } : undefined
  if (source) rows.forEach((r, i) => ((r.raw = text.slice(list[i].valueStart, list[i].valueEnd)), (r.span = { keyStart: list[i].keyStart, key: list[i].key, valueStart: list[i].valueStart, valueEnd: list[i].valueEnd })))
  return { ok: true, table: { path, shape, format, columns: inferColumns(shape, rows), rows, source } }
}

/** RFC 4180: quoted fields, doubled quotes, line breaks inside quotes. Returns records with their raw text. */
export function splitCsv(text: string, delimiter: string): { fields: string[]; raw: string }[] {
  const out: { fields: string[]; raw: string }[] = []
  let fields: string[] = []
  let field = ''
  let quoted = false
  let start = 0
  let i = 0
  const end = (at: number, next: number) => {
    fields.push(field)
    out.push({ fields, raw: text.slice(start, at) })
    fields = []
    field = ''
    start = next
  }
  while (i < text.length) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') (field += '"'), (i += 2)
        else (quoted = false), i++
      } else (field += ch), i++
    } else if (ch === '"' && field === '') (quoted = true), i++
    else if (ch === delimiter) fields.push(field), (field = ''), i++
    else if (ch === '\r' && text[i + 1] === '\n') end(i, i + 2), (i += 2)
    else if (ch === '\n') end(i, i + 1), i++
    else (field += ch), i++
  }
  if (start < text.length) end(text.length, text.length)
  return out
}

function parseCsv(path: string, text: string, delimiter: ',' | '\t', format: Format): { ok: true; table: Table } | { ok: false; reason: string } {
  const recs = splitCsv(text, delimiter)
  if (recs.length < 1 || !recs[0].fields.some((f) => f.trim())) return { ok: false, reason: 'An empty file' }
  const header = recs[0].fields
  if (new Set(header).size !== header.length) return { ok: false, reason: 'Two columns share a name' }
  const rows: Row[] = recs.slice(1).map((r) => ({ rid: nextRid(), raw: r.raw, value: Object.fromEntries(header.map((h, i) => [h, r.fields[i] ?? ''])) }))
  const shape: Shape = { kind: 'csv', delimiter, header, headerRaw: recs[0].raw }
  return { ok: true, table: { path, shape, format, columns: inferColumns(shape, rows), rows } }
}

const INT = /^-?\d+$/
const NUM = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

/** A column's type, from every value it holds. */
export function inferType(values: unknown[], fromCsv: boolean): { type: ColType; values?: string[] } {
  const present = values.filter((v) => v !== null && v !== undefined && v !== '')
  if (!present.length) return { type: 'string' }
  if (fromCsv) {
    const s = present.map(String)
    if (s.every((v) => INT.test(v))) return { type: 'int' }
    if (s.every((v) => NUM.test(v))) return { type: 'number' }
    if (s.every((v) => v === 'true' || v === 'false')) return { type: 'bool' }
    return enumOrString(s, values.length)
  }
  if (present.every((v) => typeof v === 'boolean')) return { type: 'bool' }
  if (present.every((v) => typeof v === 'number' && Number.isInteger(v))) return { type: 'int' }
  if (present.every((v) => typeof v === 'number')) return { type: 'number' }
  if (present.every((v) => typeof v === 'string')) return enumOrString(present as string[], values.length)
  return { type: 'json' }
}

function enumOrString(s: string[], total: number): { type: ColType; values?: string[] } {
  const distinct = [...new Set(s)]
  // a handful of short values repeated across many rows is a set of choices (rarity, element, type)
  if (total >= 4 && distinct.length <= 12 && distinct.length < s.length && distinct.every((v) => v.length <= 24)) return { type: 'enum', values: distinct }
  return { type: 'string' }
}

export function inferColumns(shape: Shape, rows: readonly Row[]): Column[] {
  const names: string[] = shape.kind === 'csv' ? [...shape.header] : []
  if (shape.kind !== 'csv') for (const r of rows) for (const k of Object.keys(r.value)) if (!names.includes(k)) names.push(k)
  const cols = names.map((name) => ({ name, ...inferType(rows.map((r) => r.value[name]), shape.kind === 'csv') }))
  return shape.kind === 'keyed' ? [{ name: KEY_COLUMN, type: 'string' }, ...cols] : cols
}

// ---- editing ----

export function cellValue(t: Table, r: Row, col: string): unknown {
  return col === KEY_COLUMN ? r.key : r.value[col]
}

/**
 * Turns what was typed into a value of the column's type. JSON numbers stay numbers and booleans
 * booleans; CSV stays text. Throws with a sentence when it does not fit.
 */
export function coerce(t: Table, col: Column, input: string | boolean): unknown {
  const csv = t.shape.kind === 'csv'
  if (col.name === KEY_COLUMN) {
    const s = String(input).trim()
    if (!s) throw new Error('A key cannot be empty')
    return s
  }
  switch (col.type) {
    case 'bool': {
      const b = typeof input === 'boolean' ? input : String(input).trim() === 'true'
      return csv ? String(b) : b
    }
    case 'int': {
      const s = String(input).trim()
      if (s === '') return csv ? '' : null
      if (!INT.test(s)) throw new Error(`${col.name} takes whole numbers`)
      return csv ? s : Number(s)
    }
    case 'number': {
      const s = String(input).trim()
      if (s === '') return csv ? '' : null
      if (!NUM.test(s)) throw new Error(`${col.name} takes numbers`)
      return csv ? s : Number(s)
    }
    case 'json': {
      if (csv) return String(input)
      try {
        return JSON.parse(String(input))
      } catch {
        throw new Error(`${col.name} holds JSON, and that is not valid JSON`)
      }
    }
    default:
      return String(input)
  }
}

/** Sets one cell. The row loses its kept text, so it is written fresh. */
export function setCell(t: Table, rid: number, col: string, value: unknown): Table {
  return {
    ...t,
    rows: t.rows.map((r) => {
      if (r.rid !== rid) return r
      // renaming a key leaves the row's own text alone
      if (col === KEY_COLUMN) return { ...r, key: String(value), raw: t.shape.kind === 'csv' ? undefined : r.raw }
      // an existing key keeps its place in the row; a new one goes at the end
      return { ...r, value: { ...r.value, [col]: value }, raw: undefined }
    })
  }
}

/** A new row after `afterRid` (or at the end): a copy of it, or blanks of the right type. */
export function addRow(t: Table, afterRid?: number, copy = false): { table: Table; rid: number } {
  const at = afterRid === undefined ? t.rows.length - 1 : t.rows.findIndex((r) => r.rid === afterRid)
  const src = t.rows[at]
  const csv = t.shape.kind === 'csv'
  const blank = (c: Column): unknown => (csv ? (c.type === 'bool' ? 'false' : '') : c.type === 'int' || c.type === 'number' ? 0 : c.type === 'bool' ? false : c.type === 'json' ? null : c.type === 'enum' ? (c.values?.[0] ?? '') : '')
  const value: Record<string, unknown> = copy && src ? structuredClone(src.value) : Object.fromEntries(t.columns.filter((c) => c.name !== KEY_COLUMN).map((c) => [c.name, blank(c)]))
  const row: Row = { rid: nextRid(), value }
  if (t.shape.kind === 'keyed') {
    const taken = new Set(t.rows.map((r) => r.key))
    const base = copy && src?.key ? `${src.key}_copy` : 'new'
    let key = base
    for (let i = 2; taken.has(key); i++) key = `${base}_${i}`
    row.key = key
  }
  // an id-like field gets a value nobody else has, so the copy is valid at once
  for (const id of ['id', 'Id', 'ID']) {
    if (!(id in value)) continue
    const nums = t.rows.map((r) => Number(r.value[id])).filter(Number.isFinite)
    if (nums.length === t.rows.length) value[id] = csv ? String(Math.max(0, ...nums) + 1) : Math.max(0, ...nums) + 1
    else if (typeof value[id] === 'string') {
      const taken = new Set(t.rows.map((r) => String(r.value[id])))
      let v = `${value[id] || 'new'}_copy`
      for (let i = 2; taken.has(v); i++) v = `${value[id] || 'new'}_copy_${i}`
      value[id] = v
    }
  }
  const rows = [...t.rows]
  rows.splice(at + 1, 0, row)
  return { table: { ...t, rows }, rid: row.rid }
}

export function removeRows(t: Table, rids: ReadonlySet<number>): Table {
  return { ...t, rows: t.rows.filter((r) => !rids.has(r.rid)) }
}

// ---- writing ----

/** A value in the file's own style, its nested lines starting at `base`. */
function fmt(v: unknown, f: Format, base: string): string {
  if (v === undefined) return 'null'
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  const inner = base + f.indent
  if (Array.isArray(v)) {
    if (!v.length) return '[]'
    if (f.inlineArrays && v.every((x) => x === null || typeof x !== 'object')) return `[${v.map((x) => JSON.stringify(x)).join(f.inlineSep)}]`
    return `[\n${v.map((x) => inner + fmt(x, f, inner)).join(',\n')}\n${base}]`
  }
  const keys = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined)
  if (!keys.length) return '{}'
  return `{\n${keys.map(([k, x]) => `${inner}${JSON.stringify(k)}: ${fmt(x, f, inner)}`).join(',\n')}\n${base}}`
}

const sameOrder = (a: readonly number[], b: readonly Row[]) => a.length === b.length && b.every((r, i) => r.rid === a[i])

/**
 * The file's text for this table, in the layout it was read in. A JSON file is patched rather than
 * rewritten: untouched rows keep their exact text, edited ones are written in the file's own style,
 * and everything around the rows (a wrapper's other fields, comments-free spacing) is left as it was.
 */
export function serialize(t: Table): string {
  const { eol, finalNewline } = t.format
  const nl = (s: string) => (eol === '\r\n' ? s.replace(/\r?\n/g, '\r\n') : s)
  if (t.shape.kind === 'csv') {
    const { delimiter, header, headerRaw } = t.shape
    const quote = (s: string) => (s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r') || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s)
    const text = [headerRaw, ...t.rows.map((r) => r.raw ?? header.map((h) => quote(String(r.value[h] ?? ''))).join(delimiter))].join(eol)
    return finalNewline && !text.endsWith(eol) ? text + eol : text
  }
  const src = t.source
  const keyed = t.shape.kind === 'keyed'
  if (src && sameOrder(src.rids, t.rows)) {
    // the same rows in the same order: splice in only the ones that changed
    let out = src.text
    for (const r of [...t.rows].reverse()) {
      if (r.raw !== undefined && (!keyed || r.key === r.span?.key)) continue
      const sp = r.span!
      const text = r.raw ?? nl(fmt(r.value, t.format, lineIndent(src.text, sp.keyStart ?? sp.valueStart)))
      out = out.slice(0, sp.valueStart) + text + out.slice(sp.valueEnd)
      if (keyed && r.key !== sp.key && sp.keyStart !== undefined) out = out.slice(0, sp.keyStart) + JSON.stringify(r.key) + out.slice(endOfString(src.text, sp.keyStart))
    }
    return out
  }
  // rows added, removed or moved: rebuild the container, keeping each untouched row's text
  const child = src?.childIndent ?? t.format.indent
  const closing = src?.closeIndent ?? ''
  const [o, c] = keyed ? ['{', '}'] : ['[', ']']
  const body = t.rows.map((r) => `${child}${keyed ? `${JSON.stringify(r.key)}: ` : ''}${r.raw ?? fmt(r.value, t.format, child)}`).join(',\n')
  const container = nl(t.rows.length ? `${o}\n${body}\n${closing}${c}` : `${o}${c}`)
  if (src) return src.text.slice(0, src.open) + container + src.text.slice(src.close + 1)
  const whole = t.shape.kind === 'wrapped' ? nl(fmt({ ...t.shape.root, [t.shape.prop]: t.rows.map((r) => r.value) }, t.format, '')) : container
  return finalNewline ? whole + eol : whole
}

// ---- checking ----

export interface Problem {
  rid: number
  col: string
  message: string
}

const ID_COLUMNS = ['id', 'Id', 'ID', 'key', 'name']

/** The column that names a row: the keys of a keyed object, else the first id-like column. */
export function idColumn(t: Table): string | null {
  if (t.shape.kind === 'keyed') return KEY_COLUMN
  return ID_COLUMNS.find((c) => t.columns.some((x) => x.name === c)) ?? null
}

/** Values that do not fit their column, and ids used twice. */
export function validate(t: Table): Problem[] {
  const out: Problem[] = []
  const csv = t.shape.kind === 'csv'
  for (const r of t.rows) {
    for (const c of t.columns) {
      if (c.name === KEY_COLUMN) continue
      const v = r.value[c.name]
      if (v === undefined || v === null || v === '') continue
      const s = String(v)
      const bad =
        (c.type === 'int' && (csv ? !INT.test(s) : typeof v !== 'number' || !Number.isInteger(v))) ||
        (c.type === 'number' && (csv ? !NUM.test(s) : typeof v !== 'number')) ||
        (c.type === 'bool' && (csv ? s !== 'true' && s !== 'false' : typeof v !== 'boolean'))
      if (bad) out.push({ rid: r.rid, col: c.name, message: `${c.name} should be ${c.type === 'int' ? 'a whole number' : c.type === 'bool' ? 'true or false' : 'a number'}` })
    }
  }
  const id = idColumn(t)
  if (id && id !== 'name') {
    const seen = new Map<string, number>()
    for (const r of t.rows) {
      const v = String(cellValue(t, r, id) ?? '')
      if (!v) out.push({ rid: r.rid, col: id, message: 'An empty id' })
      else if (seen.has(v)) out.push({ rid: r.rid, col: id, message: `The id ${v} is used twice` })
      else seen.set(v, r.rid)
    }
  }
  return out
}

/** A row's name for people: its id, else its name, else its place. */
export function rowLabel(t: Table, r: Row): string {
  for (const c of [idColumn(t), 'name', 'Name', 'title']) {
    if (!c) continue
    const v = cellValue(t, r, c)
    if (v !== undefined && v !== null && v !== '') return String(v)
  }
  return `row ${t.rows.indexOf(r) + 1}`
}

export interface Change {
  row: string
  col: string
  from: unknown
  to: unknown
}

/** What changed between two versions of a table: cells, rows added, rows removed. */
export function diff(before: Table, after: Table): { cells: Change[]; added: string[]; removed: string[] } {
  const prev = new Map(before.rows.map((r) => [r.rid, r]))
  const next = new Set(after.rows.map((r) => r.rid))
  const cells: Change[] = []
  const added: string[] = []
  for (const r of after.rows) {
    const p = prev.get(r.rid)
    if (!p) {
      added.push(rowLabel(after, r))
      continue
    }
    for (const c of after.columns) {
      const a = cellValue(before, p, c.name)
      const b = cellValue(after, r, c.name)
      if (JSON.stringify(a) !== JSON.stringify(b)) cells.push({ row: rowLabel(after, r), col: c.name, from: a, to: b })
    }
  }
  const removed = before.rows.filter((r) => !next.has(r.rid)).map((r) => rowLabel(before, r))
  return { cells, added, removed }
}

export function describeDiff(d: ReturnType<typeof diff>, max = 30): string {
  const fmt = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v))
  const lines = d.cells.slice(0, max).map((c) => `- ${c.row}.${c.col}: ${fmt(c.from)} -> ${fmt(c.to)}`)
  if (d.cells.length > max) lines.push(`- ... and ${d.cells.length - max} more cells`)
  if (d.added.length) lines.push(`- added: ${d.added.join(', ')}`)
  if (d.removed.length) lines.push(`- removed: ${d.removed.join(', ')}`)
  return lines.join('\n') || 'No changes.'
}

/** Min, max and mean of a numeric column, over the values that are numbers. */
export function stats(t: Table, col: string): { min: number; max: number; mean: number; n: number } | null {
  const nums = t.rows.map((r) => Number(cellValue(t, r, col))).filter((v, i) => Number.isFinite(v) && cellValue(t, t.rows[i], col) !== '' && cellValue(t, t.rows[i], col) !== null)
  if (!nums.length) return null
  const sum = nums.reduce((a, b) => a + b, 0)
  return { min: Math.min(...nums), max: Math.max(...nums), mean: sum / nums.length, n: nums.length }
}

/** The message an agent gets: the file, its columns, the rows in question and what to do. */
export function askBrief(t: Table, rows: readonly Row[], request: string): string {
  const cols = t.columns.map((c) => `${c.name}:${c.type}${c.values ? `(${c.values.join('|')})` : ''}`).join(', ')
  const sample = rows.slice(0, 40).map((r) => (r.key !== undefined ? { [KEY_COLUMN]: r.key, ...r.value } : r.value))
  let json = JSON.stringify(sample)
  if (json.length > 8000) json = `${json.slice(0, 8000)}... (truncated; read the file)`
  return [
    `Data request from Game Data Tables about \`${t.path}\` (${t.rows.length} rows; columns ${cols}).`,
    rows.length ? `The rows in question (${rows.length}${rows.length > 40 ? ', first 40 shown' : ''}): ${json}` : 'It is about the whole table.',
    '',
    `Request: ${request.trim()}`,
    '',
    `Edit \`${t.path}\` directly, keeping its format, key order and indentation, and only the values that need to change. Then report what you changed and why.`
  ].join('\n')
}
