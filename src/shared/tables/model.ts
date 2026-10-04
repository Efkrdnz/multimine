/**
 * Tables: a project's numbers in one place - every spell with its mana, cooldown and damage, say -
 * each cell linked, where it can be, to the spot in the code that holds the value. They live in
 * `.multimine/tables/<id>.json`, committed with the project. A chat makes one from a description
 * (`/table ...`) or the user builds one by hand; editing a linked cell rewrites the code, and the
 * code is the truth whenever the two disagree.
 */

export const TABLE_ROOT = '.multimine/tables'

export const COLUMN_TYPES = ['text', 'number', 'enum', 'bool'] as const
export type ColumnType = (typeof COLUMN_TYPES)[number]

export interface TableColumn {
  key: string
  label: string
  type: ColumnType
  /** enum: the allowed values, in order. */
  values?: string[]
  /** enum: a colour per value (#rrggbb), for its chip and the charts. */
  colors?: Record<string, string>
  /** What the column means, for whoever reads the table (a chat included). */
  note?: string
}

/**
 * Where a cell's value lives in the code: on `line` of `file`, the literal between `before` and
 * `after` (`MANA_COST = ` ... `;`). The line is a hint; the text around the value finds it again
 * when the code moves.
 */
export interface CodeLink {
  file: string
  line: number
  before: string
  after: string
}

export type Cell = string | number | boolean | null

export interface TableRow {
  id: string
  cells: Record<string, Cell>
  /** Column key -> where that value lives in the code. */
  links?: Record<string, CodeLink>
  /** A row the user added that is not in the code yet: reference values for whoever builds it. */
  idea?: boolean
  /** The file that defines the whole row (the spell's class), for "open in code". */
  file?: string
}

export interface Table {
  id: string
  name: string
  /** What the table is about, in a sentence. */
  description?: string
  /** Given to every chat in the project as context. */
  context: boolean
  columns: TableColumn[]
  rows: TableRow[]
  updated: number
}

export const tablePath = (id: string): string => `${TABLE_ROOT}/${id}.json`

/** A slug for an id: lower case, dashes, never empty. */
export function slugId(name: string, fallback = 'table'): string {
  const s = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return s || fallback
}

const COLOR = /^#[0-9a-f]{6}$/i

function cellOf(v: unknown, col: TableColumn | undefined): Cell {
  if (v === null || v === undefined || v === '') return null
  if (!col) return typeof v === 'number' || typeof v === 'boolean' ? v : String(v)
  if (col.type === 'number') {
    const n = typeof v === 'number' ? v : Number(String(v).replace(/[_,\s]/g, ''))
    return Number.isFinite(n) ? n : String(v)
  }
  if (col.type === 'bool') return v === true || v === 'true' || v === 1 || v === 'yes'
  return String(v).slice(0, 2000)
}

function linkOf(raw: unknown): CodeLink | null {
  if (!raw || typeof raw !== 'object') return null
  const l = raw as Record<string, unknown>
  const file = typeof l.file === 'string' ? l.file.replace(/\\/g, '/').replace(/^\.\//, '') : ''
  if (!file || file.includes('..') || file.startsWith('/')) return null
  const before = typeof l.before === 'string' ? l.before : ''
  const after = typeof l.after === 'string' ? l.after : ''
  if (!before.trim()) return null
  return { file, line: Math.max(1, Math.round(Number(l.line) || 1)), before: before.slice(0, 300), after: after.slice(0, 300) }
}

/**
 * Reads a table from anything a chat or a hand-edited file may hold. What cannot be trusted is
 * dropped or repaired rather than failing the whole table; `problems` says what.
 */
export function parseTable(raw: unknown, fallbackId = 'table'): { table: Table; problems: string[] } {
  const problems: string[] = []
  const t = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const name = typeof t.name === 'string' && t.name.trim() ? t.name.trim().slice(0, 80) : 'Untitled table'
  const id = slugId(typeof t.id === 'string' && t.id ? t.id : name, fallbackId)
  const columns: TableColumn[] = []
  for (const c of Array.isArray(t.columns) ? t.columns : []) {
    if (!c || typeof c !== 'object') continue
    const r = c as Record<string, unknown>
    const label = typeof r.label === 'string' && r.label.trim() ? r.label.trim().slice(0, 60) : typeof r.key === 'string' ? r.key : ''
    if (!label) continue
    let key = slugId(typeof r.key === 'string' && r.key ? r.key : label, 'col').replace(/-/g, '_')
    while (columns.some((x) => x.key === key)) key = `${key}_2`
    const type: ColumnType = (COLUMN_TYPES as readonly string[]).includes(r.type as string) ? (r.type as ColumnType) : 'text'
    const col: TableColumn = { key, label, type }
    if (type === 'enum') {
      col.values = Array.isArray(r.values) ? [...new Set(r.values.map((v) => String(v).slice(0, 60)))].slice(0, 50) : []
      if (r.colors && typeof r.colors === 'object')
        col.colors = Object.fromEntries(Object.entries(r.colors as Record<string, unknown>).filter(([, v]) => typeof v === 'string' && COLOR.test(v)) as [string, string][])
    }
    if (typeof r.note === 'string' && r.note.trim()) col.note = r.note.trim().slice(0, 300)
    columns.push(col)
  }
  if (!columns.length) problems.push('it has no columns')
  const rows: TableRow[] = []
  for (const [i, raw] of (Array.isArray(t.rows) ? t.rows : []).slice(0, 1000).entries()) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    // a row may hold its cells under `cells`, or flat beside its id
    const source = r.cells && typeof r.cells === 'object' ? (r.cells as Record<string, unknown>) : r
    const cells: Record<string, Cell> = {}
    for (const col of columns) {
      const v = source[col.key] ?? source[col.label]
      cells[col.key] = cellOf(v, col)
      if (col.type === 'enum' && typeof cells[col.key] === 'string' && !col.values!.includes(cells[col.key] as string)) col.values!.push(cells[col.key] as string)
    }
    const first = columns[0] ? cells[columns[0].key] : null
    let rid = slugId(typeof r.id === 'string' && r.id ? r.id : String(first ?? `row-${i + 1}`), `row-${i + 1}`)
    while (rows.some((x) => x.id === rid)) rid = `${rid}-2`
    const row: TableRow = { id: rid, cells }
    if (r.links && typeof r.links === 'object') {
      const links: Record<string, CodeLink> = {}
      for (const [k, v] of Object.entries(r.links as Record<string, unknown>)) {
        const col = columns.find((c) => c.key === k || c.label === k)
        const link = linkOf(v)
        if (col && link) links[col.key] = link
        else if (col) problems.push(`${rid}.${col.key}: a link needs a file inside the project and the text before the value`)
      }
      if (Object.keys(links).length) row.links = links
    }
    if (r.idea === true) row.idea = true
    if (typeof r.file === 'string' && r.file && !r.file.includes('..')) row.file = r.file.replace(/\\/g, '/')
    rows.push(row)
  }
  return {
    table: {
      id,
      name,
      description: typeof t.description === 'string' && t.description.trim() ? t.description.trim().slice(0, 500) : undefined,
      context: t.context === true,
      columns,
      rows,
      updated: typeof t.updated === 'number' ? t.updated : Date.now()
    },
    problems
  }
}

export const tableJson = (t: Table): string => `${JSON.stringify(t, null, 2)}\n`

/** A new, empty table with a name column. */
export function emptyTable(name: string): Table {
  return { id: slugId(name), name: name.trim() || 'Untitled table', context: false, columns: [{ key: 'name', label: 'Name', type: 'text' }], rows: [], updated: Date.now() }
}

export function addRow(t: Table, cells: Record<string, Cell> = {}, idea = true): { table: Table; id: string } {
  const label = String(cells[t.columns[0]?.key] ?? 'new')
  let id = slugId(label, 'row')
  for (let n = 2; t.rows.some((r) => r.id === id); n++) id = `${slugId(label, 'row')}-${n}`
  const row: TableRow = { id, cells: Object.fromEntries(t.columns.map((c) => [c.key, cells[c.key] ?? null])), ...(idea ? { idea: true } : {}) }
  return { table: { ...t, rows: [...t.rows, row], updated: Date.now() }, id }
}

export function removeRow(t: Table, id: string): Table {
  return { ...t, rows: t.rows.filter((r) => r.id !== id), updated: Date.now() }
}

export function addColumn(t: Table, label: string, type: ColumnType): { table: Table; key: string } {
  let key = slugId(label, 'col').replace(/-/g, '_')
  for (let n = 2; t.columns.some((c) => c.key === key); n++) key = `${slugId(label, 'col').replace(/-/g, '_')}_${n}`
  const col: TableColumn = { key, label: label.trim() || key, type, ...(type === 'enum' ? { values: [] } : {}) }
  return { table: { ...t, columns: [...t.columns, col], rows: t.rows.map((r) => ({ ...r, cells: { ...r.cells, [key]: null } })), updated: Date.now() }, key }
}

export function removeColumn(t: Table, key: string): Table {
  return {
    ...t,
    columns: t.columns.filter((c) => c.key !== key),
    rows: t.rows.map((r) => {
      const { [key]: _gone, ...cells } = r.cells
      const links = r.links ? Object.fromEntries(Object.entries(r.links).filter(([k]) => k !== key)) : undefined
      return { ...r, cells, links: links && Object.keys(links).length ? links : undefined }
    }),
    updated: Date.now()
  }
}

export function updateColumn(t: Table, key: string, patch: Partial<Omit<TableColumn, 'key'>>): Table {
  return { ...t, columns: t.columns.map((c) => (c.key === key ? { ...c, ...patch } : c)), updated: Date.now() }
}

/** A typed value from what the user typed into a cell. */
export function cellFromInput(col: TableColumn, input: string): Cell {
  return cellOf(input.trim(), col)
}

export function setCell(t: Table, rowId: string, key: string, value: Cell): Table {
  const col = t.columns.find((c) => c.key === key)
  let columns = t.columns
  // a new enum value joins the column's list
  if (col?.type === 'enum' && typeof value === 'string' && value && !col.values?.includes(value)) columns = t.columns.map((c) => (c.key === key ? { ...c, values: [...(c.values ?? []), value] } : c))
  return { ...t, columns, rows: t.rows.map((r) => (r.id === rowId ? { ...r, cells: { ...r.cells, [key]: value } } : r)), updated: Date.now() }
}

export function cellText(v: Cell): string {
  if (v === null) return ''
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 10000) / 10000)
  return String(v)
}

/**
 * The categorical palette for the app's dark surface, in a fixed order (validated: CVD-separated
 * neighbours, all at least 3:1 against the surface). A ninth series is never a new hue.
 */
export const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767']
const PALETTE = SERIES

/** A colour for an enum value: its own, or the palette's by the value's position in the column. */
export function enumColor(col: TableColumn, value: string): string {
  return col.colors?.[value] ?? PALETTE[Math.max(0, col.values?.indexOf(value) ?? 0) % PALETTE.length]
}
