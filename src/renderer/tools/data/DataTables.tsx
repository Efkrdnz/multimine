import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowDown, ArrowUp, BarChart3, Bot, Copy, FileJson, FileSpreadsheet, Plus, Redo2, RefreshCw, Save, Search, Send, Trash2, Undo2, X } from 'lucide-react'
import type { PluginInfo } from '@shared/types'
import {
  addRow,
  askBrief,
  cellValue,
  coerce,
  describeDiff,
  diff,
  isDataFile,
  KEY_COLUMN,
  parseTable,
  removeRows,
  rowLabel,
  serialize,
  setCell,
  skipDir,
  stats,
  validate,
  type Column,
  type Row,
  type Table
} from '@shared/data/table'
import { useStore } from '../../state/store'
import { errText, usePluginApi, type PluginCall } from '../pluginApi'
import { ChatTarget, chatLabel, useChats, type Sent } from '../ChatTarget'

const MAX_DEPTH = 6
const MAX_ENTRIES = 2000
const MAX_ROWS_SHOWN = 1000
const POLL_MS = 3000

type Entry = { name: string; path: string; dir: boolean }

/** Every JSON/CSV/TSV file under the project, skipping build output, dependencies and editor folders. */
async function findDataFiles(call: PluginCall): Promise<string[]> {
  const out: string[] = []
  let seen = 0
  let level: string[] = ['']
  for (let depth = 0; depth <= MAX_DEPTH && level.length && seen < MAX_ENTRIES; depth++) {
    const next: string[] = []
    for (const dir of level) {
      const list = await call<Entry[]>('files.list', dir).catch(() => [] as Entry[])
      for (const e of list) {
        if (++seen > MAX_ENTRIES) break
        if (e.dir) {
          if (!skipDir(e.name)) next.push(e.path)
        } else if (isDataFile(e.name)) out.push(e.path)
      }
    }
    level = next
  }
  return out.sort((a, b) => a.localeCompare(b))
}

/**
 * Game Data Tables: the project's JSON and CSV data as a spreadsheet. A save writes the file back in
 * its own layout, touching only what changed; an agent can be asked about any rows and edits the file
 * itself, which reloads here.
 */
export function DataTables({ plugin }: { plugin: PluginInfo }) {
  const call = usePluginApi(plugin.manifest.id)
  const toast = useStore((s) => s.toast)
  const [files, setFiles] = useState<string[] | null>(null)
  const [query, setQuery] = useState('')
  const [path, setPath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [table, setTable] = useState<Table | null>(null)
  const [loaded, setLoaded] = useState<Table | null>(null)
  const [onDisk, setOnDisk] = useState<string | null>(null)
  const lastText = useRef('')
  const history = useRef<{ past: Table[]; future: Table[] }>({ past: [], future: [] })
  const [, bump] = useState(0)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<{ col: string; dir: 1 | -1 } | null>(null)
  const [chart, setChart] = useState(false)
  const [ask, setAsk] = useState(false)

  const refreshFiles = useCallback(() => void findDataFiles(call).then(setFiles), [call])
  useEffect(refreshFiles, [refreshFiles])

  const open = useCallback(
    async (p: string, quiet = false) => {
      try {
        const text = await call<string>('files.read', p)
        const res = parseTable(p, text)
        lastText.current = text
        setOnDisk(null)
        setPath(p)
        if (!res.ok) {
          setError(res.reason)
          setTable(null)
          setLoaded(null)
          return
        }
        setError(null)
        setTable(res.table)
        setLoaded(res.table)
        history.current = { past: [], future: [] }
        setSelected(new Set())
        if (!quiet) setSort(null)
      } catch (e) {
        toast('error', `Could not open ${p}: ${errText(e)}`)
      }
    },
    [call, toast]
  )

  const dirty = !!table && table !== loaded

  const change = (next: Table) => {
    if (!table) return
    history.current.past.push(table)
    if (history.current.past.length > 200) history.current.past.shift()
    history.current.future = []
    setTable(next)
    bump((n) => n + 1)
  }
  const undo = () => {
    const prev = history.current.past.pop()
    if (prev && table) (history.current.future.push(table), setTable(prev), bump((n) => n + 1))
  }
  const redo = () => {
    const next = history.current.future.pop()
    if (next && table) (history.current.past.push(table), setTable(next), bump((n) => n + 1))
  }

  const save = async () => {
    if (!table || !loaded || !path) return
    const text = serialize(table)
    try {
      await call('files.write', path, text)
      const d = diff(loaded, table)
      const n = d.cells.length + d.added.length + d.removed.length
      lastText.current = text
      // read back what was written, so the next save patches against it
      const res = parseTable(path, text)
      if (res.ok) (setTable(res.table), setLoaded(res.table))
      history.current = { past: [], future: [] }
      setSelected(new Set())
      setOnDisk(null)
      toast('info', `Saved ${path}: ${n} change${n === 1 ? '' : 's'}`)
    } catch (e) {
      toast('error', `Could not save: ${errText(e)}`)
    }
  }

  // an agent (or an editor) changing the file: reload if nothing here is unsaved, else ask
  useEffect(() => {
    if (!path) return
    const check = async () => {
      try {
        const text = await call<string>('files.read', path)
        if (text === lastText.current) return
        if (!dirty) {
          await open(path, true)
          toast('info', `${path} changed on disk and was reloaded`)
        } else setOnDisk(text)
      } catch {
        /* gone or unreadable: leave the open copy alone */
      }
    }
    const t = setInterval(() => void check(), POLL_MS)
    window.addEventListener('focus', check)
    return () => (clearInterval(t), window.removeEventListener('focus', check))
  }, [path, dirty, call, open, toast])

  const problems = useMemo(() => {
    const m = new Map<string, string>()
    if (table) for (const p of validate(table)) m.set(`${p.rid}:${p.col}`, p.message)
    return m
  }, [table])

  const view = useMemo(() => {
    if (!table) return []
    const f = filter.trim().toLowerCase()
    let rows = f ? table.rows.filter((r) => table.columns.some((c) => String(fmtCell(cellValue(table, r, c.name))).toLowerCase().includes(f))) : table.rows
    if (sort) {
      const col = table.columns.find((c) => c.name === sort.col)
      const num = col?.type === 'int' || col?.type === 'number'
      rows = [...rows].sort((a, b) => {
        const x = cellValue(table, a, sort.col)
        const y = cellValue(table, b, sort.col)
        return (num ? Number(x) - Number(y) : String(x ?? '').localeCompare(String(y ?? ''), undefined, { numeric: true })) * sort.dir
      })
    }
    return rows
  }, [table, filter, sort])

  const key = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.key.toLowerCase() === 's') (e.preventDefault(), void save())
    else if (mod && e.key.toLowerCase() === 'z') (e.preventDefault(), e.shiftKey ? redo() : undo())
    else if (mod && e.key.toLowerCase() === 'y') (e.preventDefault(), redo())
  }

  const shownFiles = (files ?? []).filter((f) => f.toLowerCase().includes(query.toLowerCase()))

  return (
    <div className="flex h-full min-h-0 outline-none" tabIndex={0} onKeyDown={key} data-testid="data-tables">
      <div className="flex w-[230px] shrink-0 flex-col border-r border-white/10">
        <div className="flex items-center gap-1 p-2">
          <div className="relative flex-1">
            <Search size={12} className="absolute left-2 top-2 text-indigo-300/60" />
            <input className="field !py-1 !pl-6 !text-xs" placeholder="Find a data file" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="dt-search" />
          </div>
          <button className="btn btn-ghost !p-1" title="Look for data files again" onClick={refreshFiles}>
            <RefreshCw size={13} />
          </button>
        </div>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-1 pb-2" data-testid="dt-files">
          {files === null && <div className="p-2 text-xs text-indigo-300/70">Looking for data files...</div>}
          {files?.length === 0 && <div className="p-2 text-xs leading-relaxed text-indigo-300/70">No JSON, CSV or TSV data in this project yet. Godot .tres and Unity .asset files are not supported.</div>}
          {shownFiles.map((f) => {
            const slash = f.lastIndexOf('/')
            const I = f.endsWith('.json') ? FileJson : FileSpreadsheet
            return (
              <button key={f} onClick={() => (dirty && f !== path && !window.confirm(`Discard the unsaved changes to ${path}?`) ? undefined : void open(f))} className={`flex w-full items-start gap-1.5 rounded-md px-2 py-1 text-left ${f === path ? 'bg-violet-500/25 text-white' : 'text-indigo-100/85 hover:bg-white/5'}`} title={f} data-testid={`dt-file-${f}`}>
                <I size={13} className="mt-0.5 shrink-0 text-indigo-300/70" />
                <span className="min-w-0">
                  <span className="block truncate text-xs">{f.slice(slash + 1)}</span>
                  {slash > 0 && <span className="block truncate text-[10px] text-indigo-300/50">{f.slice(0, slash)}</span>}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {!path && <div className="flex flex-1 items-center justify-center text-sm text-indigo-300/70">Pick a data file on the left: items, enemies, loot tables, levels, dialogue...</div>}
        {path && error && (
          <div className="m-4 rounded-xl border border-amber-400/30 bg-amber-500/10 p-3 text-sm text-amber-100">
            <div className="font-semibold">{path} cannot be shown as a table</div>
            <div className="mt-1 text-xs">{error}</div>
          </div>
        )}
        {table && (
          <>
            <div className="flex flex-wrap items-center gap-1.5 border-b border-white/10 px-3 py-1.5">
              <span className="max-w-[260px] truncate font-mono text-xs text-indigo-200" title={table.path}>
                {table.path}
              </span>
              {dirty && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" title="unsaved" />}
              <span className="text-[11px] text-indigo-300/60">
                {table.rows.length} rows · {shapeName(table)}
              </span>
              <div className="flex-1" />
              <div className="relative">
                <Search size={12} className="absolute left-2 top-2 text-indigo-300/60" />
                <input className="field !w-40 !py-1 !pl-6 !text-xs" placeholder="Filter rows" value={filter} onChange={(e) => setFilter(e.target.value)} data-testid="dt-filter" />
              </div>
              <button className="btn btn-ghost !px-2 !py-1" title="Undo (Ctrl+Z)" disabled={!history.current.past.length} onClick={undo}>
                <Undo2 size={14} />
              </button>
              <button className="btn btn-ghost !px-2 !py-1" title="Redo" disabled={!history.current.future.length} onClick={redo}>
                <Redo2 size={14} />
              </button>
              <button className="btn !py-1" title="Add a row" onClick={() => change(addRow(table, selected.size === 1 ? [...selected][0] : undefined).table)} data-testid="dt-add">
                <Plus size={13} /> Row
              </button>
              <button className="btn !py-1" title="Duplicate the selected rows" disabled={!selected.size} onClick={() => change([...selected].reduce((t, rid) => addRow(t, rid, true).table, table))} data-testid="dt-duplicate">
                <Copy size={13} />
              </button>
              <button className="btn !py-1" title="Delete the selected rows" disabled={!selected.size} onClick={() => (change(removeRows(table, selected)), setSelected(new Set()))} data-testid="dt-delete">
                <Trash2 size={13} />
              </button>
              <button className={`btn !py-1 ${chart ? '!border-violet-400/60' : ''}`} title="Chart a column" onClick={() => setChart(!chart)} data-testid="dt-chart-toggle">
                <BarChart3 size={13} />
              </button>
              <button className={`btn !py-1 ${ask ? '!border-violet-400/60' : ''}`} onClick={() => setAsk(!ask)} data-testid="dt-ask-toggle">
                <Bot size={13} /> Ask a chat
              </button>
              <button className="btn btn-primary !py-1" disabled={!dirty} onClick={() => void save()} title="Save (Ctrl+S)" data-testid="dt-save">
                <Save size={13} /> Save
              </button>
            </div>
            {onDisk !== null && (
              <div className="flex items-center gap-2 border-b border-amber-400/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-100">
                <AlertTriangle size={13} /> {table.path} changed on disk while you had unsaved edits.
                <button className="btn !py-0.5" onClick={() => void open(table.path, true)}>
                  Reload theirs
                </button>
                <button className="btn !py-0.5" onClick={() => ((lastText.current = onDisk), setOnDisk(null))}>
                  Keep mine
                </button>
              </div>
            )}
            {ask && <AskPanel call={call} table={table} rows={table.rows.filter((r) => selected.has(r.rid))} onDone={() => setAsk(false)} />}
            <div className="flex min-h-0 flex-1">
              <Grid
                table={table}
                rows={view}
                problems={problems}
                selected={selected}
                setSelected={setSelected}
                sort={sort}
                setSort={setSort}
                onCell={(rid, col, input) => {
                  try {
                    const v = coerce(table, col, input)
                    const row = table.rows.find((r) => r.rid === rid)
                    // leaving a cell as it was is not an edit
                    if (row && JSON.stringify(cellValue(table, row, col.name)) === JSON.stringify(v)) return true
                    change(setCell(table, rid, col.name, v))
                    return true
                  } catch (e) {
                    toast('error', errText(e))
                    return false
                  }
                }}
              />
              {chart && <ChartPanel table={table} rows={view} />}
            </div>
            <div className="flex items-center gap-3 border-t border-white/10 px-3 py-1 text-[10.5px] text-indigo-300/70">
              {problems.size > 0 ? (
                <span className="text-amber-300" data-testid="dt-problems">
                  {problems.size} problem{problems.size === 1 ? '' : 's'}: {[...problems.values()][0]}
                </span>
              ) : (
                <span>No problems</span>
              )}
              {dirty && loaded && <span className="truncate">{describeDiff(diff(loaded, table), 3).split('\n').join('  ')}</span>}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

const shapeName = (t: Table) => (t.shape.kind === 'csv' ? (t.shape.delimiter === '\t' ? 'TSV' : 'CSV') : t.shape.kind === 'keyed' ? 'JSON object by key' : t.shape.kind === 'wrapped' ? `JSON "${t.shape.prop}" list` : 'JSON list')

function fmtCell(v: unknown): string {
  if (v === undefined || v === null) return ''
  return typeof v === 'object' ? JSON.stringify(v) : String(v)
}

const TYPE_TINT: Record<string, string> = { int: 'text-sky-300', number: 'text-sky-300', bool: 'text-emerald-300', enum: 'text-amber-300', string: 'text-indigo-300', json: 'text-pink-300' }

function Grid({
  table,
  rows,
  problems,
  selected,
  setSelected,
  sort,
  setSort,
  onCell
}: {
  table: Table
  rows: Row[]
  problems: Map<string, string>
  selected: Set<number>
  setSelected: (s: Set<number>) => void
  sort: { col: string; dir: 1 | -1 } | null
  setSort: (s: { col: string; dir: 1 | -1 } | null) => void
  onCell: (rid: number, col: Column, input: string | boolean) => boolean
}) {
  const [editing, setEditing] = useState<{ rid: number; col: string } | null>(null)
  const shown = rows.slice(0, MAX_ROWS_SHOWN)
  const numeric = table.columns.filter((c) => c.type === 'int' || c.type === 'number')
  return (
    <div className="scroll-thin min-w-0 flex-1 overflow-auto" data-testid="dt-grid">
      <table className="min-w-full border-separate border-spacing-0 text-xs">
        <thead className="sticky top-0 z-10 bg-[#0e1030]">
          <tr>
            <th className="w-8 border-b border-white/10 px-2 py-1.5">
              <input type="checkbox" checked={!!rows.length && rows.every((r) => selected.has(r.rid))} onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.rid)) : new Set())} />
            </th>
            {table.columns.map((c) => (
              <th
                key={c.name}
                className="cursor-pointer select-none whitespace-nowrap border-b border-l border-white/10 px-2 py-1.5 text-left font-semibold text-indigo-100 hover:bg-white/5"
                onClick={() => setSort(sort?.col !== c.name ? { col: c.name, dir: 1 } : sort.dir === 1 ? { col: c.name, dir: -1 } : null)}
                title={c.values ? `One of: ${c.values.join(', ')}` : undefined}
              >
                <span className="inline-flex items-center gap-1">
                  {c.name === KEY_COLUMN ? 'key' : c.name}
                  <span className={`text-[9.5px] font-normal ${TYPE_TINT[c.type]}`}>{c.type}</span>
                  {sort?.col === c.name && (sort.dir === 1 ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.rid} className={selected.has(r.rid) ? 'bg-violet-500/15' : 'hover:bg-white/[0.03]'} data-testid="dt-row">
              <td className="border-b border-white/5 px-2 text-center">
                <input
                  type="checkbox"
                  checked={selected.has(r.rid)}
                  onChange={(e) => {
                    const next = new Set(selected)
                    if (e.target.checked) next.add(r.rid)
                    else next.delete(r.rid)
                    setSelected(next)
                  }}
                />
              </td>
              {table.columns.map((c) => {
                const v = cellValue(table, r, c.name)
                const problem = problems.get(`${r.rid}:${c.name}`)
                const isEditing = editing?.rid === r.rid && editing.col === c.name
                const csv = table.shape.kind === 'csv'
                return (
                  <td
                    key={c.name}
                    title={problem}
                    className={`max-w-[280px] border-b border-l border-white/5 px-2 py-1 ${problem ? 'bg-red-500/15 text-red-200' : ''} ${c.type === 'int' || c.type === 'number' ? 'text-right font-mono' : ''}`}
                    onClick={() => c.type !== 'bool' && !isEditing && setEditing({ rid: r.rid, col: c.name })}
                    data-testid={`dt-cell-${c.name}`}
                  >
                    {c.type === 'bool' && c.name !== KEY_COLUMN ? (
                      <input type="checkbox" checked={csv ? v === 'true' : v === true} onChange={(e) => onCell(r.rid, c, e.target.checked)} />
                    ) : isEditing ? (
                      <CellEditor col={c} value={v} onDone={(input) => (input === null || onCell(r.rid, c, input)) && setEditing(null)} />
                    ) : (
                      <span className="block truncate">{fmtCell(v) || <span className="text-indigo-300/30">-</span>}</span>
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
        {numeric.length > 0 && (
          <tfoot className="sticky bottom-0 bg-[#0e1030] text-[10px] text-indigo-300/70">
            <tr>
              <td className="border-t border-white/10 px-2 text-center">Σ</td>
              {table.columns.map((c) => {
                const s = c.type === 'int' || c.type === 'number' ? stats(table, c.name) : null
                return (
                  <td key={c.name} className="whitespace-nowrap border-l border-t border-white/10 px-2 py-1 text-right font-mono" data-testid={s ? `dt-stats-${c.name}` : undefined}>
                    {s ? `${round(s.min)}..${round(s.max)} avg ${round(s.mean)}` : ''}
                  </td>
                )
              })}
            </tr>
          </tfoot>
        )}
      </table>
      {rows.length > MAX_ROWS_SHOWN && <div className="p-2 text-xs text-indigo-300/70">Showing the first {MAX_ROWS_SHOWN} of {rows.length} rows; filter to find the rest.</div>}
    </div>
  )
}

const round = (n: number) => (Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 100) / 100)

function CellEditor({ col, value, onDone }: { col: Column; value: unknown; onDone: (input: string | null) => void }) {
  const [text, setText] = useState(fmtCell(value))
  if (col.type === 'enum' && col.values)
    return (
      <select autoFocus className="field !px-1 !py-0.5 !text-xs" value={text} onChange={(e) => onDone(e.target.value)} onBlur={() => onDone(null)} data-testid="dt-editor">
        {[...new Set([...col.values, text])].map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    )
  return (
    <input
      autoFocus
      className="field !px-1 !py-0.5 font-mono !text-xs"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onDone(text)
        if (e.key === 'Escape') onDone(null)
      }}
      onBlur={() => onDone(text)}
      data-testid="dt-editor"
    />
  )
}

function ChartPanel({ table, rows }: { table: Table; rows: Row[] }) {
  const numeric = table.columns.filter((c) => c.type === 'int' || c.type === 'number')
  // a stat rather than an id, when there is one
  const [y, setY] = useState((numeric.find((c) => !/^(id|key)$/i.test(c.name)) ?? numeric[0])?.name ?? '')
  const [x, setX] = useState<string>('')
  if (!numeric.length) return <div className="w-[340px] shrink-0 border-l border-white/10 p-3 text-xs text-indigo-300/70">No numeric columns to chart.</div>
  const W = 320
  const H = 240
  const pad = 28
  const val = (r: Row, c: string) => Number(cellValue(table, r, c))
  const pts = rows.filter((r) => Number.isFinite(val(r, y)) && (!x || Number.isFinite(val(r, x))))
  const ys = pts.map((r) => val(r, y))
  const yMax = Math.max(0, ...ys)
  const yMin = Math.min(0, ...ys)
  const sy = (v: number) => H - pad - ((v - yMin) / (yMax - yMin || 1)) * (H - pad * 1.6)
  const xs = x ? pts.map((r) => val(r, x)) : []
  const xMin = Math.min(...xs)
  const xMax = Math.max(...xs)
  const sx = (v: number) => pad + ((v - xMin) / (xMax - xMin || 1)) * (W - pad * 1.5)
  const bars = pts.slice(0, 60)
  const bw = (W - pad * 1.5) / Math.max(1, bars.length)
  return (
    <div className="w-[340px] shrink-0 space-y-2 border-l border-white/10 p-3" data-testid="dt-chart">
      <div className="flex items-center gap-1.5 text-[11px] text-indigo-200">
        <select className="field !w-auto !px-1 !py-0.5 !text-[11px]" value={y} onChange={(e) => setY(e.target.value)}>
          {numeric.map((c) => (
            <option key={c.name}>{c.name}</option>
          ))}
        </select>
        <span>by</span>
        <select className="field !w-auto !px-1 !py-0.5 !text-[11px]" value={x} onChange={(e) => setX(e.target.value)}>
          <option value="">row</option>
          {numeric
            .filter((c) => c.name !== y)
            .map((c) => (
              <option key={c.name}>{c.name}</option>
            ))}
        </select>
      </div>
      <svg width={W} height={H} className="rounded-lg bg-black/30">
        <line x1={pad} y1={sy(0)} x2={W - 6} y2={sy(0)} stroke="#475569" />
        <text x={4} y={sy(yMax) + 4} fontSize={9} fill="#94a3b8">
          {round(yMax)}
        </text>
        <text x={4} y={sy(yMin) + 4} fontSize={9} fill="#94a3b8">
          {round(yMin)}
        </text>
        {x
          ? pts.map((r) => (
              <circle key={r.rid} cx={sx(val(r, x))} cy={sy(val(r, y))} r={3.5} fill="#a78bfa" fillOpacity={0.85}>
                <title>{`${rowLabel(table, r)}: ${x} ${val(r, x)}, ${y} ${val(r, y)}`}</title>
              </circle>
            ))
          : bars.map((r, i) => {
              const v = val(r, y)
              return (
                <rect key={r.rid} x={pad + i * bw + 1} y={Math.min(sy(v), sy(0))} width={Math.max(1, bw - 2)} height={Math.abs(sy(v) - sy(0))} fill={v >= 0 ? '#8b5cf6' : '#f43f5e'} rx={1.5}>
                  <title>{`${rowLabel(table, r)}: ${v}`}</title>
                </rect>
              )
            })}
      </svg>
      <div className="text-[10.5px] leading-snug text-indigo-300/60">{x ? `${pts.length} rows; hover a point for its row.` : `${y} for ${bars.length} rows in the current order${pts.length > 60 ? ' (first 60)' : ''}; sort or filter the table to change it.`}</div>
    </div>
  )
}

function AskPanel({ call, table, rows, onDone }: { call: PluginCall; table: Table; rows: Row[]; onDone: () => void }) {
  const toast = useStore((s) => s.toast)
  const chats = useChats(call)
  // a question about the data: the chat on screen by default, which usually has the context
  const [to, setTo] = useState('active')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const active = chats.find((c) => c.active)
    if (to === 'active' && active) setTo(active.id)
  }, [chats, to])
  const send = async () => {
    setBusy(true)
    try {
      const dest = to === 'new' || chats.some((c) => c.id === to) ? to : 'active'
      const sent = await call<Sent>('send', dest, askBrief(table, rows, text))
      toast('info', `Asked ${chatLabel(chats, dest, sent)} about ${table.path}`)
      setText('')
      onDone()
    } catch (e) {
      toast('error', `Could not send: ${errText(e)}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex items-start gap-2 border-b border-white/10 bg-black/20 p-2" data-testid="dt-ask">
      <div className="w-44 shrink-0 space-y-1">
        <ChatTarget chats={chats} value={to} onChange={setTo} testId="dt-ask-to" className="!w-full" />
        <div className="text-[10.5px] leading-snug text-indigo-300/70">{rows.length ? `About the ${rows.length} selected row${rows.length === 1 ? '' : 's'}` : 'About the whole table (select rows to narrow it)'}</div>
      </div>
      <textarea
        autoFocus
        className="field min-h-[54px] flex-1 !text-xs"
        placeholder="e.g. Rebalance these weapons so damage per second rises smoothly with rarity."
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && text.trim() && void send()}
        data-testid="dt-ask-text"
      />
      <div className="flex flex-col gap-1">
        <button className="btn btn-primary !py-1" disabled={!text.trim() || busy} onClick={() => void send()} data-testid="dt-ask-send">
          <Send size={13} /> Send
        </button>
        <button className="btn btn-ghost !py-1" onClick={onDone}>
          <X size={13} />
        </button>
      </div>
    </div>
  )
}
