import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BarChart3, Check, Code2, FileCode2, Hammer, Link2, Plus, RefreshCw, Sparkles, Trash2, Unlink, X } from 'lucide-react'
import type { PluginInfo } from '@shared/types'
import {
  COLUMN_TYPES,
  TABLE_ROOT,
  addColumn,
  addRow,
  cellFromInput,
  cellText,
  emptyTable,
  enumColor,
  parseTable,
  removeColumn,
  removeRow,
  setCell,
  tableJson,
  tablePath,
  updateColumn,
  type ColumnType,
  type Table,
  type TableColumn
} from '@shared/tables/model'
import { linkedFiles, planChanges, readFromCode, type Change, type LinkState } from '@shared/tables/links'
import { changeTablePrompt, implementPrompt } from '@shared/tables/prompt'
import { useStore } from '../../state/store'
import { errText, usePluginApi, type PluginCall } from '../pluginApi'
import { ChatTarget, chatLabel, useChats, type ChatChoice, type Sent } from '../ChatTarget'
import { TableChart } from './Chart'

const TYPE_LABEL: Record<ColumnType, string> = { text: 'Text', number: 'Number', enum: 'Choice', bool: 'Yes / no' }

async function listTables(call: PluginCall): Promise<Table[]> {
  const entries = await call<{ name: string; dir: boolean }[]>('files.list', TABLE_ROOT).catch(() => [])
  const out: Table[] = []
  for (const e of entries.filter((x) => !x.dir && x.name.endsWith('.json'))) {
    try {
      out.push(parseTable(JSON.parse(await call<string>('files.read', `${TABLE_ROOT}/${e.name}`)), e.name.slice(0, -5)).table)
    } catch {
      // not a table: skipped
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Tables: the project's numbers in one place, each cell linked where it can be to the spot in the
 * code that holds it. Editing a linked cell rewrites that literal after you review the change, and
 * the file is read back to verify it; the code is the truth whenever the two disagree. A chat makes
 * a table from a description (`/table ...`); any table can be given to every chat as context.
 */
export function Tables({ plugin }: { plugin: PluginInfo }) {
  const call = usePluginApi(plugin.manifest.id)
  const toast = useStore((s) => s.toast)
  const chats = useChats(call)
  const [tables, setTables] = useState<Table[] | null>(null)
  const [table, setTable] = useState<Table | null>(null)
  // linked cells edited here and not yet written to the code: `row.key`
  const [edits, setEdits] = useState<Set<string>>(new Set())
  const [states, setStates] = useState<Record<string, LinkState>>({})
  const [chart, setChart] = useState(false)
  const [panel, setPanel] = useState<'ask' | 'column' | null>(null)
  const [review, setReview] = useState<{ changes: Change[]; texts: Record<string, string>; missing: string[] } | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const editsRef = useRef(edits)
  editsRef.current = edits

  const persist = useCallback(
    (t: Table, now = false) => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      const write = () => void call('files.write', tablePath(t.id), tableJson(t)).catch((e) => toast('error', `Could not save the table: ${errText(e)}`))
      if (now) write()
      else saveTimer.current = setTimeout(write, 300)
      setTables((ts) => (ts ? [...ts.filter((x) => x.id !== t.id), t].sort((a, b) => a.name.localeCompare(b.name)) : ts))
    },
    [call, toast]
  )

  const change = useCallback((t: Table) => {
    setTable(t)
    persist(t)
  }, [persist])

  /** Reads every linked value from its file: the code is the truth, unsaved edits aside. */
  const fromCode = useCallback(
    async (t: Table, keep: Set<string>, quiet = false) => {
      const files: Record<string, string> = {}
      for (const f of linkedFiles(t)) {
        const text = await call<string>('files.read', f).catch(() => null)
        if (text !== null) files[f] = text
      }
      const back = readFromCode(t, files, keep)
      setStates(back.states)
      setTable(back.table)
      if (back.changed.length || JSON.stringify(back.table.rows) !== JSON.stringify(t.rows)) persist(back.table, true)
      if (back.changed.length && !quiet) toast('info', `${back.changed.length} value${back.changed.length === 1 ? '' : 's'} updated from the code`)
      return back
    },
    [call, persist, toast]
  )

  const open = useCallback(
    async (t: Table) => {
      setEdits(new Set())
      setReview(null)
      setTable(t)
      void call('storage.set', 'last', t.id)
      await fromCode(t, new Set(), true)
    },
    [call, fromCode]
  )

  const reload = useCallback(
    async (pick?: string) => {
      const list = await listTables(call)
      setTables(list)
      const last = pick ?? (await call<string | null>('storage.get', 'last').catch(() => null))
      const t = list.find((x) => x.id === last) ?? list[0]
      if (t) await open(t)
      else setTable(null)
    },
    [call, open]
  )

  useEffect(() => {
    void reload()
  }, [reload])

  // a chat saved a table, or a table card in a chat asked for one
  const changed = useStore((s) => s.tablesChanged)
  const request = useStore((s) => s.tableRequest)
  useEffect(() => {
    if (changed && !editsRef.current.size) void reload(changed.id)
  }, [changed]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (request) void reload(request.id)
  }, [request]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => void (saveTimer.current && clearTimeout(saveTimer.current)), [])

  const create = () => {
    const name = window.prompt('Name the new table', 'Spells')
    if (!name?.trim()) return
    let t = emptyTable(name)
    for (let n = 2; tables?.some((x) => x.id === t.id); n++) t = { ...t, id: `${emptyTable(name).id}-${n}` }
    persist(t, true)
    void open(t)
  }

  const editCell = (rowId: string, key: string, input: string) => {
    if (!table) return
    const col = table.columns.find((c) => c.key === key)!
    const next = setCell(table, rowId, key, cellFromInput(col, input))
    change(next)
    const row = next.rows.find((r) => r.id === rowId)
    if (row?.links?.[key]) setEdits((s) => new Set(s).add(`${rowId}.${key}`))
  }

  const startReview = async () => {
    if (!table) return
    const files: Record<string, string> = {}
    for (const f of linkedFiles(table)) {
      const text = await call<string>('files.read', f).catch(() => null)
      if (text !== null) files[f] = text
    }
    const plan = planChanges(table, [...edits].map((id) => ({ rowId: id.slice(0, id.lastIndexOf('.')), key: id.slice(id.lastIndexOf('.') + 1) })), files)
    setReview({ changes: plan.changes, texts: plan.texts, missing: plan.missing.map((m) => `${m.rowId}.${m.key}`) })
  }

  /** Writes the reviewed changes, reads the files back, and checks every value took. */
  const apply = async () => {
    if (!table || !review) return
    const files = [...new Set(review.changes.map((c) => c.file))]
    try {
      for (const f of files) await call('files.write', f, review.texts[f])
      const back = await fromCode(table, new Set(), true)
      const wrong = review.changes.filter((c) => back.changed.includes(`${c.rowId}.${c.key}`))
      setEdits(new Set())
      setReview(null)
      if (wrong.length) toast('error', `${wrong.length} value${wrong.length === 1 ? ' did' : 's did'} not take: ${wrong.map((w) => w.label).join(', ')}`)
      else toast('info', `${review.changes.length} value${review.changes.length === 1 ? '' : 's'} written to ${files.length} file${files.length === 1 ? '' : 's'} and verified`)
    } catch (e) {
      toast('error', `Could not write the code: ${errText(e)}`)
    }
  }

  const discard = async () => {
    if (!table) return
    setEdits(new Set())
    setReview(null)
    await fromCode(table, new Set(), true)
  }

  const send = async (to: string, text: string, what: string) => {
    try {
      const sent = await call<Sent>('send', to, text)
      toast('info', `${what} - ${chatLabel(chats, to, sent)} is on it`)
      return true
    } catch (e) {
      toast('error', `Could not send: ${errText(e)}`)
      return false
    }
  }

  if (tables === null) return <div className="p-6 text-sm text-indigo-300/70">Opening tables...</div>

  return (
    <div className="relative flex h-full min-h-0" data-testid="tables">
      <TableList tables={tables} current={table?.id} chats={chats} onOpen={(t) => void open(t)} onCreate={create} onMake={(to, text) => send(to, `/table ${text}`, 'Asked for a table')} />
      {!table ? (
        <div className="flex flex-1 items-center justify-center p-8 text-center text-sm leading-relaxed text-indigo-200/70">
          <div className="max-w-md">
            No tables yet. Describe one on the left and a chat builds it from your code - or type <span className="font-mono text-indigo-100">/table</span> in any chat, or make an empty one and fill it in yourself.
          </div>
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2">
            <input className="field !w-56 !py-1 font-display font-bold" value={table.name} onChange={(e) => change({ ...table, name: e.target.value })} data-testid="tb-name" />
            <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-white/10 px-2 py-1 text-[11px] text-indigo-100" title="Give this table to every chat in the project, so it reads values here instead of searching the code">
              <input type="checkbox" checked={table.context} onChange={(e) => change({ ...table, context: e.target.checked })} data-testid="tb-context" />
              Context for chats
            </label>
            <div className="flex-1" />
            <span className="text-[11px] text-indigo-300/60" data-testid="tb-link-summary">
              {linkSummary(table, states)}
            </span>
            <button className="btn btn-ghost !p-1.5" title="Read every linked value from the code again" onClick={() => void fromCode(table, edits)} data-testid="tb-refresh">
              <RefreshCw size={13} />
            </button>
            <button className={`btn !py-1 ${chart ? '!border-violet-400/60 bg-violet-500/15' : ''}`} onClick={() => setChart(!chart)} data-testid="tb-chart-toggle">
              <BarChart3 size={13} /> Chart
            </button>
            <button className={`btn !py-1 ${panel === 'ask' ? '!border-violet-400/60 bg-violet-500/15' : ''}`} onClick={() => setPanel(panel === 'ask' ? null : 'ask')} title="Have a chat change this table: add columns, find more rows, link what is not linked" data-testid="tb-ask-toggle">
              <Sparkles size={13} /> Change with AI
            </button>
            <button className="btn btn-ghost !p-1.5 text-red-300/80" title="Delete this table (the code is not touched)" onClick={() => window.confirm(`Delete the table "${table.name}"? The code is not touched.`) && void call('files.remove', tablePath(table.id)).then(() => (call('storage.set', 'last', null), reload()))} data-testid="tb-delete">
              <Trash2 size={13} />
            </button>
          </div>
          {panel === 'ask' && <AskPanel chats={chats} onSend={(to, text) => send(to, changeTablePrompt(table, text), `Asked to change "${table.name}"`).then((ok) => ok && setPanel(null))} />}
          {edits.size > 0 && (
            <div className="flex items-center gap-2 border-b border-amber-400/20 bg-amber-500/10 px-3 py-1.5 text-[12px] text-amber-100" data-testid="tb-pending">
              <span className="h-2 w-2 rounded-full bg-amber-400" />
              {edits.size} value{edits.size === 1 ? '' : 's'} changed here, not yet in the code
              <div className="flex-1" />
              <button className="btn !py-0.5 text-[11px]" onClick={() => void discard()}>
                Discard
              </button>
              <button className="btn btn-primary !py-0.5 text-[11px]" onClick={() => void startReview()} data-testid="tb-review">
                <Code2 size={12} /> Review &amp; apply
              </button>
            </div>
          )}
          <div className="scroll-thin min-h-0 flex-1 overflow-auto">
            <Grid table={table} states={states} edits={edits} onEdit={editCell} onChange={change} onColumn={() => setPanel(panel === 'column' ? null : 'column')} columnOpen={panel === 'column'} call={call} chats={chats} onImplement={(id, to) => send(to, implementPrompt(table, [id]), `Asked to build "${cellText(table.rows.find((r) => r.id === id)?.cells[table.columns[0].key] ?? id)}"`)} />
          </div>
          {chart && <TableChart key={table.id} table={table} />}
        </div>
      )}
      {review && table && <Review review={review} onApply={() => void apply()} onClose={() => setReview(null)} />}
    </div>
  )
}

function linkSummary(t: Table, states: Record<string, LinkState>): string {
  const links = t.rows.reduce((n, r) => n + Object.keys(r.links ?? {}).length, 0)
  const missing = Object.values(states).filter((s) => s === 'missing').length
  const ideas = t.rows.filter((r) => r.idea).length
  return [`${t.rows.length} rows`, links ? `${links} values linked to code${missing ? `, ${missing} not found` : ''}` : 'not linked to code', ideas ? `${ideas} idea${ideas === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')
}

function TableList({ tables, current, chats, onOpen, onCreate, onMake }: { tables: Table[]; current?: string; chats: ChatChoice[]; onOpen: (t: Table) => void; onCreate: () => void; onMake: (to: string, text: string) => Promise<boolean> }) {
  const [text, setText] = useState('')
  const [to, setTo] = useState('new')
  return (
    <div className="flex w-[230px] shrink-0 flex-col border-r border-white/10 bg-black/20">
      <div className="flex items-center px-3 pb-1 pt-3">
        <span className="label !mb-0 flex-1">Tables</span>
        <button className="rounded p-0.5 text-indigo-300/70 hover:bg-white/10 hover:text-white" title="A new, empty table to fill in yourself" onClick={onCreate} data-testid="tb-new">
          <Plus size={13} />
        </button>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2">
        {tables.map((t) => (
          <button key={t.id} className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left ${t.id === current ? 'bg-violet-500/20' : 'hover:bg-white/5'}`} onClick={() => onOpen(t)} data-testid={`tb-list-${t.id}`}>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] text-indigo-50">{t.name}</span>
              <span className="block truncate text-[10.5px] text-indigo-300/55">
                {t.rows.length} rows · {t.columns.length} columns
              </span>
            </span>
            {t.context && <span className="shrink-0 rounded bg-cyan-500/20 px-1 text-[9.5px] font-semibold text-cyan-100" title="Given to every chat as context">context</span>}
          </button>
        ))}
        {!tables.length && <div className="px-2 py-3 text-[11px] text-indigo-300/50">None yet.</div>}
      </div>
      <div className="space-y-1.5 border-t border-white/10 p-2">
        <div className="text-[10.5px] font-semibold uppercase tracking-wider text-indigo-300/60">Make one with AI</div>
        <textarea
          className="field min-h-[72px] !text-xs"
          placeholder="Every spell in the mod, with mana usage, cooldown, rank requirement, element (with colours) and base damage (negative heals)"
          value={text}
          onChange={(e) => setText(e.target.value)}
          data-testid="tb-make-text"
        />
        <div className="flex items-center gap-1.5">
          <ChatTarget chats={chats} value={to} onChange={setTo} testId="tb-make-to" className="min-w-0 flex-1" />
          <button className="btn btn-primary shrink-0 !py-1" disabled={!text.trim()} onClick={() => void onMake(to, text.trim()).then((ok) => ok && setText(''))} data-testid="tb-make-send">
            <Sparkles size={12} />
          </button>
        </div>
        <div className="text-[10px] leading-snug text-indigo-300/45">
          Or type <span className="font-mono">/table ...</span> in any chat.
        </div>
      </div>
    </div>
  )
}

function AskPanel({ chats, onSend }: { chats: ChatChoice[]; onSend: (to: string, text: string) => void }) {
  const [text, setText] = useState('')
  const [to, setTo] = useState('new')
  return (
    <div className="flex items-start gap-2 border-b border-white/10 bg-black/20 p-2" data-testid="tb-ask">
      <textarea autoFocus className="field min-h-[54px] flex-1 !text-xs" placeholder="e.g. Add a cast time column; find the spells in the nether package too; colour the elements like their particles" value={text} onChange={(e) => setText(e.target.value)} data-testid="tb-ask-text" />
      <div className="flex w-44 shrink-0 flex-col gap-1">
        <ChatTarget chats={chats} value={to} onChange={setTo} testId="tb-ask-to" className="!w-full" />
        <button className="btn btn-primary justify-center !py-1" disabled={!text.trim()} onClick={() => onSend(to, text.trim())} data-testid="tb-ask-send">
          <Sparkles size={12} /> Send
        </button>
      </div>
    </div>
  )
}

function Grid({
  table,
  states,
  edits,
  onEdit,
  onChange,
  onColumn,
  columnOpen,
  call,
  chats,
  onImplement
}: {
  table: Table
  states: Record<string, LinkState>
  edits: Set<string>
  onEdit: (rowId: string, key: string, input: string) => void
  onChange: (t: Table) => void
  onColumn: () => void
  columnOpen: boolean
  call: PluginCall
  chats: ChatChoice[]
  onImplement: (rowId: string, to: string) => Promise<boolean>
}) {
  const [editing, setEditing] = useState<{ row: string; key: string } | null>(null)
  const [colMenu, setColMenu] = useState<string | null>(null)
  const addNew = () => {
    const res = addRow(table, { [table.columns[0].key]: 'New idea' })
    onChange(res.table)
    setEditing({ row: res.id, key: table.columns[0].key })
  }
  return (
    <table className="w-full border-separate border-spacing-0 text-[12.5px]" data-testid="tb-grid">
      <thead className="sticky top-0 z-10 bg-[#0d1024]">
        <tr>
          {table.columns.map((c) => (
            <th key={c.key} className="relative border-b border-white/10 px-2 py-1.5 text-left font-semibold text-indigo-200">
              <button className="flex items-center gap-1 hover:text-white" onClick={() => setColMenu(colMenu === c.key ? null : c.key)} title={c.note ?? `${TYPE_LABEL[c.type]} column - click to change it`} data-testid={`tb-col-${c.key}`}>
                {c.label}
                <span className="text-[9.5px] font-normal text-indigo-300/45">{TYPE_LABEL[c.type]}</span>
              </button>
              {colMenu === c.key && <ColumnMenu table={table} col={c} onChange={onChange} onClose={() => setColMenu(null)} />}
            </th>
          ))}
          <th className="relative w-10 border-b border-white/10 px-1 text-right">
            <button className="rounded p-1 text-indigo-300/70 hover:bg-white/10 hover:text-white" title="Add a column" onClick={onColumn} data-testid="tb-add-col">
              <Plus size={13} />
            </button>
            {columnOpen && <NewColumn table={table} onChange={onChange} onClose={onColumn} />}
          </th>
        </tr>
      </thead>
      <tbody>
        {table.rows.map((r) => (
          <tr key={r.id} className="group" data-testid={`tb-row-${r.id}`}>
            {table.columns.map((c, i) => {
              const id = `${r.id}.${c.key}`
              const link = r.links?.[c.key]
              const state = states[id]
              const edited = edits.has(id)
              const on = editing?.row === r.id && editing.key === c.key
              return (
                <td
                  key={c.key}
                  className={`border-b border-white/5 px-2 py-1 align-middle ${edited ? 'bg-amber-500/15' : state === 'missing' ? 'bg-red-500/10' : ''} ${c.type === 'number' ? 'text-right font-mono' : ''} ${r.idea ? 'italic' : ''}`}
                  onClick={() => !on && setEditing({ row: r.id, key: c.key })}
                  title={link ? `${link.file}:${link.line}${state === 'missing' ? ' - not found in the code any more' : edited ? ' - changed here; Review & apply writes it to the code' : ''}` : r.idea ? 'An idea: not in the code yet' : undefined}
                  data-testid={`tb-cell-${r.id}-${c.key}`}
                >
                  {on ? (
                    <CellInput col={c} value={r.cells[c.key]} onDone={(v) => (setEditing(null), v !== null && onEdit(r.id, c.key, v))} />
                  ) : (
                    <span className={`flex items-center gap-1.5 ${c.type === 'number' ? 'justify-end' : ''}`}>
                      {i === 0 && r.idea && <span className="rounded bg-violet-500/25 px-1 text-[9.5px] font-semibold not-italic text-violet-100">idea</span>}
                      {link && (state === 'missing' ? <Unlink size={10} className="shrink-0 text-red-300" /> : <Link2 size={10} className="shrink-0 text-indigo-300/40" />)}
                      <CellView col={c} value={r.cells[c.key]} />
                    </span>
                  )}
                </td>
              )
            })}
            <td className="whitespace-nowrap border-b border-white/5 px-1 text-right">
              <RowActions table={table} rowId={r.id} call={call} chats={chats} onImplement={onImplement} onRemove={() => onChange(removeRow(table, r.id))} />
            </td>
          </tr>
        ))}
        <tr>
          <td colSpan={table.columns.length + 1} className="px-2 py-1.5">
            <button className="flex items-center gap-1 text-[12px] text-indigo-300/70 hover:text-white" onClick={addNew} title="A row of your own: an idea for a chat to build, and reference values for it" data-testid="tb-add-row">
              <Plus size={12} /> Add a row
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  )
}

function CellView({ col, value }: { col: TableColumn; value: unknown }) {
  if (value === null || value === undefined || value === '') return <span className="text-indigo-300/30">-</span>
  if (col.type === 'enum') {
    const c = enumColor(col, String(value))
    return (
      <span className="inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[11px] not-italic text-indigo-50" style={{ background: `${c}33`, boxShadow: `inset 0 0 0 1px ${c}88` }}>
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: c }} />
        {String(value)}
      </span>
    )
  }
  if (col.type === 'bool') return value ? <Check size={13} className="text-emerald-300" /> : <span className="text-indigo-300/40">no</span>
  if (col.type === 'number' && typeof value === 'number' && value < 0) return <span className="text-emerald-300">{cellText(value)}</span>
  return <span className="text-indigo-50">{cellText(value as never)}</span>
}

function CellInput({ col, value, onDone }: { col: TableColumn; value: unknown; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(value === null || value === undefined ? '' : String(value))
  const ref = useRef<HTMLInputElement & HTMLSelectElement>(null)
  useEffect(() => ref.current?.focus(), [])
  if (col.type === 'enum' || col.type === 'bool')
    return (
      <select ref={ref} className="field !py-0.5 !text-xs" value={v} onChange={(e) => onDone(e.target.value)} onBlur={() => onDone(null)} data-testid="tb-cell-input">
        <option value="">-</option>
        {(col.type === 'bool' ? ['true', 'false'] : (col.values ?? [])).map((x) => (
          <option key={x} value={x}>
            {col.type === 'bool' ? (x === 'true' ? 'yes' : 'no') : x}
          </option>
        ))}
      </select>
    )
  return (
    <input
      ref={ref}
      className={`field !py-0.5 !text-xs ${col.type === 'number' ? 'text-right font-mono' : ''}`}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => onDone(v)}
      onKeyDown={(e) => (e.key === 'Enter' ? onDone(v) : e.key === 'Escape' ? onDone(null) : undefined)}
      data-testid="tb-cell-input"
    />
  )
}

function RowActions({ table, rowId, call, chats, onImplement, onRemove }: { table: Table; rowId: string; call: PluginCall; chats: ChatChoice[]; onImplement: (rowId: string, to: string) => Promise<boolean>; onRemove: () => void }) {
  const row = table.rows.find((r) => r.id === rowId)!
  const [to, setTo] = useState<string | null>(null)
  const where = row.file ? { file: row.file, line: 1 } : Object.values(row.links ?? {})[0]
  return (
    <span className="inline-flex items-center gap-0.5 opacity-0 group-hover:opacity-100 has-[select]:opacity-100">
      {row.idea &&
        (to === null ? (
          <button className="rounded px-1 py-0.5 text-[10.5px] text-violet-200 hover:bg-violet-500/20" title="Have a chat build this with these values, and link it back to the table" onClick={() => setTo('new')} data-testid={`tb-implement-${rowId}`}>
            <Hammer size={11} className="mr-0.5 inline" /> Build it
          </button>
        ) : (
          <>
            <ChatTarget chats={chats} value={to} onChange={setTo} testId={`tb-implement-to-${rowId}`} />
            <button className="btn btn-primary !px-1.5 !py-0.5 text-[10.5px]" onClick={() => void onImplement(rowId, to).then(() => setTo(null))} data-testid={`tb-implement-go-${rowId}`}>
              Send
            </button>
            <button className="rounded p-0.5 text-indigo-300/60 hover:text-white" onClick={() => setTo(null)}>
              <X size={11} />
            </button>
          </>
        ))}
      {where && (
        <button className="rounded p-1 text-indigo-300/60 hover:bg-white/10 hover:text-white" title={`Open ${where.file}`} onClick={() => void call('ide.open', where.file, where.line)}>
          <FileCode2 size={12} />
        </button>
      )}
      <button className="rounded p-1 text-indigo-300/60 hover:bg-white/10 hover:text-red-300" title="Remove this row from the table (the code is not touched)" onClick={onRemove} data-testid={`tb-remove-${rowId}`}>
        <Trash2 size={12} />
      </button>
    </span>
  )
}

function NewColumn({ table, onChange, onClose }: { table: Table; onChange: (t: Table) => void; onClose: () => void }) {
  const [label, setLabel] = useState('')
  const [type, setType] = useState<ColumnType>('number')
  const add = () => {
    if (!label.trim()) return
    onChange(addColumn(table, label, type).table)
    onClose()
  }
  return (
    <div className="glass rise absolute right-0 top-full z-20 mt-1 w-60 space-y-2 rounded-xl p-2.5 text-left font-normal" style={{ background: 'rgb(10 12 28 / 0.97)' }} data-testid="tb-new-col">
      <input autoFocus className="field !py-1 !text-xs" placeholder="Column name, e.g. Cast time" value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} data-testid="tb-col-label" />
      <select className="field !py-1 !text-xs" value={type} onChange={(e) => setType(e.target.value as ColumnType)} data-testid="tb-col-type">
        {COLUMN_TYPES.map((t) => (
          <option key={t} value={t}>
            {TYPE_LABEL[t]}
          </option>
        ))}
      </select>
      <button className="btn btn-primary w-full justify-center !py-1" disabled={!label.trim()} onClick={add} data-testid="tb-col-add">
        <Plus size={12} /> Add column
      </button>
    </div>
  )
}

function ColumnMenu({ table, col, onChange, onClose }: { table: Table; col: TableColumn; onChange: (t: Table) => void; onClose: () => void }) {
  const first = table.columns[0]?.key === col.key
  const values = useMemo(() => col.values ?? [], [col.values])
  return (
    <div className="glass rise absolute left-0 top-full z-20 mt-1 w-64 space-y-2 rounded-xl p-2.5 text-left font-normal" style={{ background: 'rgb(10 12 28 / 0.97)' }} onMouseLeave={onClose} data-testid="tb-col-menu">
      <input className="field !py-1 !text-xs" value={col.label} onChange={(e) => onChange(updateColumn(table, col.key, { label: e.target.value }))} />
      <select className="field !py-1 !text-xs" value={col.type} onChange={(e) => onChange(updateColumn(table, col.key, { type: e.target.value as ColumnType, ...(e.target.value === 'enum' && !col.values ? { values: [...new Set(table.rows.map((r) => cellText(r.cells[col.key])).filter(Boolean))] } : {}) }))}>
        {COLUMN_TYPES.map((t) => (
          <option key={t} value={t}>
            {TYPE_LABEL[t]}
          </option>
        ))}
      </select>
      <input className="field !py-1 !text-xs" placeholder="What it means (a chat reads this)" value={col.note ?? ''} onChange={(e) => onChange(updateColumn(table, col.key, { note: e.target.value || undefined }))} />
      {col.type === 'enum' && values.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-indigo-300/60">Colours</div>
          {values.map((v) => (
            <label key={v} className="flex items-center gap-2 text-[11px] text-indigo-100">
              <input type="color" className="h-5 w-7 cursor-pointer rounded border-0 bg-transparent" value={enumColor(col, v)} onChange={(e) => onChange(updateColumn(table, col.key, { colors: { ...(col.colors ?? {}), [v]: e.target.value } }))} />
              {v}
            </label>
          ))}
        </div>
      )}
      {!first && (
        <button className="btn btn-danger w-full justify-center !py-1 text-[11px]" onClick={() => (onChange(removeColumn(table, col.key)), onClose())}>
          <Trash2 size={11} /> Remove column
        </button>
      )}
    </div>
  )
}

/** What applying the edits does to the code, line by line, before anything is written. */
function Review({ review, onApply, onClose }: { review: { changes: Change[]; missing: string[] }; onApply: () => void; onClose: () => void }) {
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/50 p-6" onClick={onClose}>
      <div className="glass rise flex max-h-full w-[720px] max-w-full flex-col rounded-2xl" style={{ background: 'rgb(10 12 28 / 0.98)' }} onClick={(e) => e.stopPropagation()} data-testid="tb-review-dialog">
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
          <Code2 size={16} className="text-violet-300" />
          <div className="flex-1 font-display text-[15px] font-bold">Write {review.changes.length} value{review.changes.length === 1 ? '' : 's'} to the code</div>
          <button className="btn btn-ghost !p-1" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
        <div className="scroll-thin min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
          {review.changes.map((c) => (
            <div key={`${c.rowId}.${c.key}`} className="rounded-lg border border-white/10 bg-black/30 p-2" data-testid="tb-change">
              <div className="mb-1 flex items-center gap-2 text-[11.5px]">
                <span className="font-semibold text-indigo-50">{c.label}</span>
                <span className="ml-auto font-mono text-[10.5px] text-indigo-300/60">
                  {c.file}:{c.line}
                </span>
              </div>
              <pre className="overflow-x-auto font-mono text-[11px] leading-relaxed">
                <div className="text-red-300/90">- {c.from.trim()}</div>
                <div className="text-emerald-300">+ {c.to.trim()}</div>
              </pre>
            </div>
          ))}
          {!review.changes.length && <div className="text-sm text-indigo-300/70">Nothing to write: the code already has these values.</div>}
          {review.missing.length > 0 && <div className="text-[11.5px] text-amber-200">Not found in the code, left alone: {review.missing.join(', ')}. Refresh, or have a chat fix the links.</div>}
        </div>
        <div className="flex items-center gap-2 border-t border-white/10 px-4 py-3">
          <span className="text-[11px] text-indigo-300/60">Only these literals change. Each file is read back afterwards to check the value took.</span>
          <div className="flex-1" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!review.changes.length} onClick={onApply} data-testid="tb-apply">
            <Check size={14} /> Apply
          </button>
        </div>
      </div>
    </div>
  )
}
