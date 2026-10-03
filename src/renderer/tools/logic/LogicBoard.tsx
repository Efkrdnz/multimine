import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Hammer, Maximize, Pencil, Plus, Redo2, RefreshCw, Sparkles, Undo2 } from 'lucide-react'
import type { PluginInfo } from '@shared/types'
import {
  addNode,
  boardFolder,
  connect,
  copyFragment,
  disconnect,
  duplicate,
  KIND_HELP,
  KIND_LABEL,
  newBoard,
  NODE_W,
  parseBoard,
  parseCodeMap,
  pasteFragment,
  removeNodes,
  slug,
  validate,
  type Board,
  type CodeMap,
  type CodeRef,
  type Fragment,
  type Issue,
  type Link
} from '@shared/logic/model'
import { spec } from '@shared/logic/spec'
import { boardDiff, changeCount, changedIds, changeSpec } from '@shared/logic/diff'
import { BOARD_ROOT, boardDir, buildTask, updateTask, viaMastermind } from '@shared/logic/brief'
import { TARGET_IDS, TARGETS, type PaletteItem, type TargetId } from '@shared/logic/targets'
import { useStore } from '../../state/store'
import { errText, usePluginApi, type PluginCall } from '../pluginApi'
import { Canvas, KIND_COLOR, paletteFor, type View } from './Canvas'

type Member = { id: string; name: string; role: string }
type Entry = { name: string; path: string; dir: boolean }

const MAP_POLL_MS = 5000
const MAP_POLL_FOR = 45 * 60_000

async function listBoards(call: PluginCall): Promise<{ folder: string; name: string }[]> {
  const dirs = await call<Entry[]>('files.list', BOARD_ROOT).catch(() => [] as Entry[])
  const out: { folder: string; name: string }[] = []
  for (const d of dirs.filter((e) => e.dir)) {
    const text = await call<string>('files.read', `${BOARD_ROOT}/${d.name}/board.json`).catch(() => null)
    const b = text ? parseBoard(text) : null
    if (b) out.push({ folder: d.name, name: b.name })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** The example from the idea itself: on cast, sneak to shoot, otherwise explode. */
export function exampleBoard(): Board {
  let b: Board = { ...newBoard('Sneak Shot', 'minecraft'), folder: 'sneak-shot' }
  const add = (kind: Parameters<typeof addNode>[1], x: number, y: number, title: string, text: string) => {
    const r = addNode(b, kind, x, y, title, text)
    b = r.board
    return r.id
  }
  const e = add('event', 40, 160, 'On cast', 'the player presses the skill key')
  const c = add('condition', 340, 160, 'If sneaking', 'the caster is sneaking')
  const shoot = add('action', 650, 40, 'Shoot', 'spawn a projectile at the hand and shoot it where they look, speed 2, no gravity. On hit it deals {damage}')
  const boom = add('action', 650, 280, 'Explode', 'explode on the spot: radius 3, deals {damage}, no block damage')
  add('value', 340, 380, 'damage', '6 + 2 per tier')
  for (const [from, port, to] of [
    [e, 'then', c],
    [c, 'true', shoot],
    [c, 'false', boom]
  ] as const)
    b = connect(b, from, port, to).board ?? b
  return b
}

/**
 * The Logic Board: a mechanic drawn as boxes in plain words, linked in the order things happen.
 * Build sends the outline to Mastermind (or any agent) as an approved design; the builder writes
 * a code map back, and each box then links to the code that implements it. After an edit, Update
 * sends only what changed.
 */
export function LogicBoard({ plugin }: { plugin: PluginInfo }) {
  const call = usePluginApi(plugin.manifest.id)
  const toast = useStore((s) => s.toast)
  const [boards, setBoards] = useState<{ folder: string; name: string }[] | null>(null)
  const [board, setBoard] = useState<Board | null>(null)
  const [built, setBuilt] = useState<Board | null>(null)
  const [codeMap, setCodeMap] = useState<CodeMap>({})
  const [team, setTeam] = useState<Member[]>([])
  const [to, setTo] = useState('mastermind')
  const [note, setNote] = useState('')
  const [tab, setTab] = useState<'palette' | 'issues' | 'spec'>('palette')
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [selectedLink, setSelectedLink] = useState<Link | null>(null)
  const [view, setView] = useState<View>({ x: 40, y: 40, z: 1 })
  const [sending, setSending] = useState(false)
  const [waitingSince, setWaitingSince] = useState<number | null>(null)
  const history = useRef<{ past: Board[]; future: Board[] }>({ past: [], future: [] })
  const clip = useRef<Fragment | null>(null)
  const savedText = useRef('')
  const mapText = useRef('')
  const boardRef = useRef(board)
  boardRef.current = board

  useEffect(() => {
    void call<Member[]>('team.list').then(setTeam).catch(() => undefined)
    void listBoards(call).then(setBoards)
  }, [call])

  const loadMap = useCallback(
    async (b: Board) => {
      const text = await call<string>('files.read', `${boardDir(b)}/map.json`).catch(() => '')
      if (text === mapText.current) return false
      mapText.current = text
      setCodeMap(parseCodeMap(text))
      return !!text
    },
    [call]
  )

  const open = useCallback(
    async (folder: string) => {
      const text = await call<string>('files.read', `${BOARD_ROOT}/${folder}/board.json`).catch(() => null)
      const b = text ? parseBoard(text) : null
      if (!b) return toast('error', `Could not read the board in ${BOARD_ROOT}/${folder}`)
      const withFolder = { ...b, folder }
      savedText.current = JSON.stringify(withFolder, null, 2)
      setBoard(withFolder)
      const builtText = await call<string>('files.read', `${BOARD_ROOT}/${folder}/built.json`).catch(() => null)
      setBuilt(builtText ? parseBoard(builtText) : null)
      mapText.current = ''
      setCodeMap({})
      void loadMap(withFolder)
      history.current = { past: [], future: [] }
      setSelection(new Set())
      setSelectedLink(null)
      setView({ x: 40, y: 40, z: 1 })
      // the whole board in view once the canvas is laid out
      setTimeout(() => fitRef.current(withFolder), 60)
      void call('storage.set', 'last', folder)
    },
    [call, loadMap, toast]
  )

  // reopen the board last worked on
  useEffect(() => {
    if (!boards || board) return
    void call<string | null>('storage.get', 'last').then((last) => {
      const pick = boards.find((b) => b.folder === last) ?? boards[0]
      if (pick) void open(pick.folder)
    })
  }, [boards, board, call, open])

  // every change is saved shortly after, with the outline beside it for any agent to read
  useEffect(() => {
    if (!board) return
    const text = JSON.stringify(board, null, 2)
    if (text === savedText.current) return
    const t = setTimeout(() => {
      savedText.current = text
      const dir = boardDir(board)
      void Promise.all([call('files.write', `${dir}/board.json`, text), call('files.write', `${dir}/spec.md`, `${spec(board)}\n`)]).catch((e) => toast('error', `Could not save the board: ${errText(e)}`))
    }, 400)
    return () => clearTimeout(t)
  }, [board, call, toast])

  // after a build, look for the code map until it comes (and whenever the window comes back to the front)
  useEffect(() => {
    if (!board) return
    const focus = () => void loadMap(board)
    window.addEventListener('focus', focus)
    let timer: ReturnType<typeof setInterval> | undefined
    if (waitingSince) {
      timer = setInterval(() => {
        if (Date.now() - waitingSince > MAP_POLL_FOR) return setWaitingSince(null)
        void loadMap(board).then((got) => got && (setWaitingSince(null), toast('info', 'The code map arrived: each box now links to its code.')))
      }, MAP_POLL_MS)
    }
    return () => (window.removeEventListener('focus', focus), clearInterval(timer))
  }, [board, waitingSince, loadMap, toast])

  const change = useCallback((next: Board) => {
    const cur = boardRef.current
    if (!cur || next === cur) return
    history.current.past.push(cur)
    if (history.current.past.length > 300) history.current.past.shift()
    history.current.future = []
    setBoard(next)
  }, [])
  const preview = useCallback((next: Board) => setBoard(next), [])
  const settle = useCallback((before: Board) => {
    history.current.past.push(before)
    history.current.future = []
  }, [])
  const undo = () => {
    const prev = history.current.past.pop()
    if (prev && board) (history.current.future.push(board), setBoard(prev))
  }
  const redo = () => {
    const next = history.current.future.pop()
    if (next && board) (history.current.past.push(board), setBoard(next))
  }

  const issues = useMemo(() => (board ? validate(board) : []), [board])
  const byNode = useMemo(() => {
    const m = new Map<string, Issue[]>()
    for (const i of issues) if (i.nodeId) m.set(i.nodeId, [...(m.get(i.nodeId) ?? []), i])
    return m
  }, [issues])
  const diff = useMemo(() => (board && built ? boardDiff(built, board) : null), [board, built])
  const changes = diff ? changeCount(diff) : 0
  const changed = useMemo(() => (diff ? changedIds(diff) : new Set<string>()), [diff])
  const builtIds = useMemo(() => (built ? new Set(built.nodes.map((n) => n.id)) : null), [built])
  const outline = useMemo(() => (board ? spec(board) : ''), [board])

  const create = async (example = false) => {
    const name = example ? 'Sneak Shot' : window.prompt('Name the mechanic', 'New mechanic')?.trim()
    if (!name) return
    const taken = new Set((boards ?? []).map((b) => b.folder))
    let folder = slug(name)
    for (let i = 2; taken.has(folder); i++) folder = `${slug(name)}-${i}`
    const b = example ? { ...exampleBoard(), folder } : { ...newBoard(name, board?.target ?? 'minecraft'), folder }
    const text = JSON.stringify(b, null, 2)
    await call('files.write', `${BOARD_ROOT}/${folder}/board.json`, text)
    await call('files.write', `${BOARD_ROOT}/${folder}/spec.md`, `${spec(b)}\n`)
    setBoards(await listBoards(call))
    await open(folder)
  }

  const rename = () => {
    if (!board) return
    const name = window.prompt('Rename the mechanic', board.name)?.trim()
    if (name && name !== board.name) {
      change({ ...board, name })
      setBoards((bs) => bs?.map((x) => (x.folder === boardFolder(board) ? { ...x, name } : x)) ?? bs)
    }
  }

  const addFromPalette = (item: PaletteItem) => {
    if (!board) return
    const host = document.querySelector('[data-testid="lb-canvas"]')?.getBoundingClientRect()
    const cx = ((host?.width ?? 800) / 2 - view.x) / view.z - NODE_W / 2
    const cy = ((host?.height ?? 600) / 2 - view.y) / view.z - 40
    // a new box lands beside the one selected, linked from it when it can be
    const sel = selection.size === 1 ? board.nodes.find((n) => selection.has(n.id)) : undefined
    const r = addNode(board, item.kind, sel ? sel.x + NODE_W + 60 : cx + (board.nodes.length % 5) * 16, sel ? sel.y : cy + (board.nodes.length % 5) * 16, item.title, item.text)
    let next = r.board
    if (sel) {
      const port = board.links.some((l) => l.from === sel.id) ? null : (['then', 'true', 'each'] as const).find((p) => connect(next, sel.id, p, r.id).board)
      if (port) next = connect(next, sel.id, port, r.id).board ?? next
    }
    change(next)
    setSelection(new Set([r.id]))
  }

  const fit = (b = board) => {
    const host = document.querySelector('[data-testid="lb-canvas"]')?.getBoundingClientRect()
    if (!b?.nodes.length || !host) return
    const x0 = Math.min(...b.nodes.map((n) => n.x))
    const y0 = Math.min(...b.nodes.map((n) => n.y))
    const x1 = Math.max(...b.nodes.map((n) => n.x + NODE_W))
    const y1 = Math.max(...b.nodes.map((n) => n.y + 160))
    const z = Math.min(1, Math.max(0.3, Math.min((host.width - 80) / (x1 - x0), (host.height - 80) / (y1 - y0))))
    setView({ z, x: (host.width - (x1 - x0) * z) / 2 - x0 * z, y: (host.height - (y1 - y0) * z) / 2 - y0 * z })
  }
  const fitRef = useRef(fit)
  fitRef.current = fit

  const centre = (id: string) => {
    const n = board?.nodes.find((x) => x.id === id)
    const host = document.querySelector('[data-testid="lb-canvas"]')?.getBoundingClientRect()
    if (!n || !host) return
    setSelection(new Set([id]))
    setView({ ...view, x: host.width / 2 - (n.x + NODE_W / 2) * view.z, y: host.height / 2 - (n.y + 60) * view.z })
  }

  const send = async () => {
    if (!board || sending) return
    const errors = issues.filter((i) => i.level === 'error')
    if (errors.length && !window.confirm(`The board has ${errors.length} problem${errors.length === 1 ? '' : 's'}:\n\n${errors.map((e) => `- ${e.nodeId ? `[${e.nodeId}] ` : ''}${e.text}`).join('\n')}\n\nBuild it anyway?`)) return
    if (built && !changes) return toast('info', 'Nothing has changed since the last build.')
    setSending(true)
    try {
      const task = built && diff ? updateTask(board, changeSpec(diff, built, board), note) : buildTask(board, note)
      const target = team.find((m) => m.id === to)
      const message = to === 'mastermind' ? viaMastermind(task, board, team) : task
      const title = `${built ? 'Update' : 'Build'} "${board.name}"`
      const dir = boardDir(board)
      await call('files.write', `${dir}/board.json`, JSON.stringify(board, null, 2))
      await call('files.write', `${dir}/spec.md`, `${spec(board)}\n`)
      await call('task', to, title, message)
      await call('files.write', `${dir}/built.json`, JSON.stringify(board, null, 2))
      setBuilt(board)
      setNote('')
      mapText.current = (await call<string>('files.read', `${dir}/map.json`).catch(() => '')) || ''
      setWaitingSince(Date.now())
      toast('info', `${title} sent to ${target?.name ?? to}.`)
    } catch (e) {
      toast('error', `Could not send: ${errText(e)}`)
    } finally {
      setSending(false)
    }
  }

  const openCode = (ref: CodeRef) => void call('ide.open', ref.file, ref.line ?? 1).catch((e) => toast('error', errText(e)))

  const onKey = (e: React.KeyboardEvent) => {
    if (!board) return
    const t = e.target as HTMLElement
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return
    const mod = e.ctrlKey || e.metaKey
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selectedLink) (change(disconnect(board, selectedLink)), setSelectedLink(null))
      else if (selection.size) (change(removeNodes(board, [...selection])), setSelection(new Set()))
    } else if (mod && e.key.toLowerCase() === 'z') e.shiftKey ? redo() : undo()
    else if (mod && e.key.toLowerCase() === 'y') redo()
    else if (mod && e.key.toLowerCase() === 'd' && selection.size) {
      e.preventDefault()
      const r = duplicate(board, [...selection])
      change(r.board)
      setSelection(new Set(r.ids))
    } else if (mod && e.key.toLowerCase() === 'c' && selection.size) clip.current = copyFragment(board, [...selection])
    else if (mod && e.key.toLowerCase() === 'v' && clip.current) {
      const r = pasteFragment(board, clip.current, 40, 40)
      change(r.board)
      setSelection(new Set(r.ids))
    } else if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      setSelection(new Set(board.nodes.map((n) => n.id)))
    } else if (e.key === 'Escape') (setSelection(new Set()), setSelectedLink(null))
    else return
    e.preventDefault()
  }

  const recipients = team.filter((m) => !/terminal/i.test(m.role))

  return (
    <div className="flex h-full min-h-0 flex-col outline-none" tabIndex={0} onKeyDown={onKey} data-testid="logic-board">
      <div className="flex items-center gap-1.5 border-b border-white/10 px-3 py-1.5">
        <select
          className="field !w-44 shrink-0 !py-1 !text-xs"
          value={board ? boardFolder(board) : ''}
          onChange={(e) => (e.target.value === '+new' ? void create() : void open(e.target.value))}
          data-testid="lb-boards"
        >
          {!board && <option value="">No board</option>}
          {(boards ?? []).map((b) => (
            <option key={b.folder} value={b.folder}>
              {b.name}
            </option>
          ))}
          <option value="+new">+ New board...</option>
        </select>
        <button className="btn btn-ghost !p-1.5" title="New board" onClick={() => void create()} data-testid="lb-new">
          <Plus size={14} />
        </button>
        {board && (
          <>
            <button className="btn btn-ghost !p-1.5" title="Rename" onClick={rename}>
              <Pencil size={13} />
            </button>
            <select className="field !w-32 shrink-0 !py-1 !text-xs" value={board.target} onChange={(e) => change({ ...board, target: e.target.value as TargetId })} title="What it is built for: changes the palette and the unit of time" data-testid="lb-target">
              {TARGET_IDS.map((t) => (
                <option key={t} value={t}>
                  {TARGETS[t].label}
                </option>
              ))}
            </select>
            <button className="btn btn-ghost !p-1.5" title="Undo (Ctrl+Z)" disabled={!history.current.past.length} onClick={undo}>
              <Undo2 size={14} />
            </button>
            <button className="btn btn-ghost !p-1.5" title="Redo (Ctrl+Y)" disabled={!history.current.future.length} onClick={redo}>
              <Redo2 size={14} />
            </button>
            <button className="btn btn-ghost !p-1.5" title="Fit the board in view" onClick={() => fit()}>
              <Maximize size={13} />
            </button>
            <span className="min-w-0 flex-1 truncate text-right text-[11px] text-indigo-300/70" title={waitingSince ? 'Waiting for the builder to write the code map' : undefined} data-testid="lb-status">
              {built ? (changes ? `${changes} change${changes === 1 ? '' : 's'} since the build` : 'Built - no changes') : 'Not built yet'}
              {waitingSince ? ' · awaiting code map' : ''}
            </span>
            <button className="btn btn-ghost !p-1.5" title="Look for the code map again" onClick={() => void loadMap(board).then((got) => toast('info', got ? 'Code map loaded.' : Object.keys(codeMap).length ? 'The code map has not changed.' : 'No code map yet.'))} data-testid="lb-refresh">
              <RefreshCw size={13} />
            </button>
            <input className="field !w-40 min-w-0 !py-1 !text-xs" placeholder="A note with it (optional)" value={note} onChange={(e) => setNote(e.target.value)} data-testid="lb-note" />
            <label className="flex shrink-0 items-center gap-1 text-[11px] text-indigo-200/80">
              Send to
              <select className="field !w-32 !py-1 !text-xs" value={to} onChange={(e) => setTo(e.target.value)} data-testid="lb-to">
                {(recipients.length ? recipients : [{ id: 'mastermind', name: 'Mastermind', role: 'mastermind' }]).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn btn-primary shrink-0 !py-1" disabled={sending || !board.nodes.length || (!!built && !changes)} onClick={() => void send()} title={to === 'mastermind' ? 'Mastermind hands it to the Implementer as an approved design - no planning round' : 'Sent straight to this agent as its task'} data-testid="lb-build">
              <Hammer size={13} /> {built ? `Update${changes ? ` (${changes})` : ''}` : 'Build'}
            </button>
          </>
        )}
      </div>

      {!board ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-sm text-indigo-200/80">
          <div className="max-w-lg leading-relaxed">
            Design a mechanic as boxes in plain words - <b className="text-red-300">when</b> it starts, <b className="text-amber-300">if</b> something is true, what to <b className="text-sky-300">do</b> - and link them in the order they happen. Build hands it to the team as an approved design, so the agent spends its effort on the code, not on inventing the mechanic.
          </div>
          <div className="flex gap-2">
            <button className="btn btn-primary" onClick={() => void create()} data-testid="lb-first">
              <Plus size={14} /> New board
            </button>
            <button className="btn" onClick={() => void create(true)} data-testid="lb-example">
              <Sparkles size={14} /> Start from an example
            </button>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <Canvas
            board={board}
            issues={byNode}
            built={builtIds}
            changed={changed}
            codeMap={codeMap}
            selection={selection}
            setSelection={setSelection}
            selectedLink={selectedLink}
            setSelectedLink={setSelectedLink}
            view={view}
            setView={setView}
            change={change}
            preview={preview}
            settle={settle}
            openCode={openCode}
            toast={(t) => toast('info', t)}
          />
          <Side board={board} tab={tab} setTab={setTab} issues={issues} outline={outline} changesText={built && diff && changes ? changeSpec(diff, built, board) : ''} onAdd={addFromPalette} onIssue={centre} />
        </div>
      )}
    </div>
  )
}

function Side(p: { board: Board; tab: 'palette' | 'issues' | 'spec'; setTab: (t: 'palette' | 'issues' | 'spec') => void; issues: Issue[]; outline: string; changesText: string; onAdd: (i: PaletteItem) => void; onIssue: (id: string) => void }) {
  const errors = p.issues.filter((i) => i.level === 'error').length
  const items = paletteFor(p.board)
  const blank = items.slice(0, 7)
  const ready = items.slice(7)
  const tabs: ['palette' | 'issues' | 'spec', string][] = [
    ['palette', 'Boxes'],
    ['issues', `Issues${p.issues.length ? ` (${p.issues.length})` : ''}`],
    ['spec', 'What the agent reads']
  ]
  return (
    <div className="flex w-[300px] shrink-0 flex-col border-l border-white/10">
      <div className="flex border-b border-white/10 text-[11px]">
        {tabs.map(([id, label]) => (
          <button key={id} className={`flex-1 px-2 py-1.5 ${p.tab === id ? 'border-b-2 border-violet-400 text-white' : 'text-indigo-300/70 hover:text-indigo-100'} ${id === 'issues' && errors ? '!text-red-300' : ''}`} onClick={() => p.setTab(id)} data-testid={`lb-tab-${id}`}>
            {label}
          </button>
        ))}
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-2">
        {p.tab === 'palette' && (
          <>
            <div className="mb-1 text-[10px] uppercase tracking-wider text-indigo-300/50">Blank</div>
            <div className="grid grid-cols-2 gap-1">
              {blank.map((i) => (
                <button key={i.kind} className="rounded-lg border border-white/10 px-2 py-1.5 text-left hover:bg-white/5" title={KIND_HELP[i.kind]} onClick={() => p.onAdd(i)} data-testid={`lb-add-${i.kind}`}>
                  <span className="flex items-center gap-1.5 text-xs text-indigo-50">
                    <span className="h-2 w-2 rounded-full" style={{ background: KIND_COLOR[i.kind] }} />
                    {KIND_LABEL[i.kind]}
                  </span>
                  <span className="block truncate text-[10px] text-indigo-300/60">{KIND_HELP[i.kind]}</span>
                </button>
              ))}
            </div>
            <div className="mb-1 mt-3 text-[10px] uppercase tracking-wider text-indigo-300/50">Ready-made for {TARGETS[p.board.target].label}</div>
            {ready.map((i, k) => (
              <button key={k} className="mb-0.5 flex w-full items-start gap-2 rounded-md px-2 py-1 text-left hover:bg-white/5" onClick={() => p.onAdd(i)} title={i.text} data-testid={`lb-ready-${i.title}`}>
                <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: KIND_COLOR[i.kind] }} />
                <span className="min-w-0">
                  <span className="block text-xs text-indigo-50">{i.title}</span>
                  {i.text && <span className="block truncate text-[10px] text-indigo-300/60">{i.text}</span>}
                </span>
              </button>
            ))}
            <div className="mt-3 rounded-lg bg-white/5 p-2 text-[10.5px] leading-relaxed text-indigo-200/70">
              Select a box and click here to add the next one already linked. Drag from a box's right edge to link it; drop on empty space to pick what comes next. Double-click the board to add anywhere. Right-drag or Alt-drag pans, the wheel zooms. Write <span className="font-mono text-emerald-300">{'{name}'}</span> to use a Value.
            </div>
          </>
        )}
        {p.tab === 'issues' &&
          (p.issues.length ? (
            p.issues.map((i, k) => (
              <button key={k} className="mb-1 flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-white/5" onClick={() => i.nodeId && p.onIssue(i.nodeId)} data-testid="lb-issue">
                <AlertTriangle size={12} className={`mt-0.5 shrink-0 ${i.level === 'error' ? 'text-red-400' : 'text-amber-300'}`} />
                <span>
                  {i.nodeId && <span className="mr-1 font-mono text-[10px] text-indigo-300/70">{i.nodeId}</span>}
                  <span className="text-indigo-50">{i.text}</span>
                </span>
              </button>
            ))
          ) : (
            <div className="p-2 text-xs text-emerald-200/80">Nothing to fix: every box is linked, said, and its values exist.</div>
          ))}
        {p.tab === 'spec' && (
          <>
            {p.changesText && (
              <>
                <div className="mb-1 text-[10px] uppercase tracking-wider text-amber-300/70">An update sends only this</div>
                <pre className="mb-3 whitespace-pre-wrap rounded-lg bg-amber-500/10 p-2 font-mono text-[10.5px] leading-relaxed text-amber-50" data-testid="lb-changes">
                  {p.changesText}
                </pre>
              </>
            )}
            <div className="mb-1 text-[10px] uppercase tracking-wider text-indigo-300/50">The design, as the agent reads it</div>
            <pre className="whitespace-pre-wrap rounded-lg bg-black/30 p-2 font-mono text-[10.5px] leading-relaxed text-indigo-50" data-testid="lb-spec">
              {p.outline}
            </pre>
          </>
        )}
      </div>
    </div>
  )
}
