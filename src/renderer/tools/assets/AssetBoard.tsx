import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Check, FileAudio, Image as ImageIcon, Music, Palette, Play, Plus, RotateCcw, Send, Trash2, Wand2, X } from 'lucide-react'
import type { PluginInfo } from '@shared/types'
import {
  addAsset,
  approve,
  ASSET_KINDS,
  BOARD_PATH,
  GENERATORS,
  boardJson,
  emptyBoard,
  IMAGE_KINDS,
  KIND_LABEL,
  matchCandidates,
  modIdFrom,
  parseBoard,
  pixelSize,
  removeAsset,
  requestBrief,
  revisionBrief,
  setStatus,
  suggestPath,
  updateAsset,
  type Asset,
  type AssetKind,
  type AssetStatus,
  type Board,
  type Candidate
} from '@shared/assets/board'
import { detectTarget, TARGETS, type TargetId } from '@shared/sketch/targets'
import { useStore } from '../../state/store'
import { errText, usePluginApi, type PluginCall } from '../pluginApi'
import { ChatTarget, chatLabel, useChats, type Sent } from '../ChatTarget'

const COLUMNS: { title: string; statuses: AssetStatus[]; hint: string }[] = [
  { title: 'Wanted', statuses: ['wanted'], hint: 'What the project needs' },
  { title: 'In progress', statuses: ['requested', 'rejected'], hint: 'With a chat' },
  { title: 'Review', statuses: ['review'], hint: 'Pick one, or send it back' },
  { title: 'Done', statuses: ['approved'], hint: 'In the project' }
]

const POLL_MS = 3000

/**
 * The Asset Board: what art and sound the project needs, sent to a chat to make, reviewed when it
 * comes back, and copied into the project only when approved. Everything goes through the plugin API.
 */
export function AssetBoard({ plugin }: { plugin: PluginInfo }) {
  const call = usePluginApi(plugin.manifest.id)
  const toast = useStore((s) => s.toast)
  const chats = useChats(call)
  // requests go to one chat: a new one the first time, then the same one, so it keeps the style in mind
  const [to, setToState] = useState('new')
  const setTo = useCallback(
    (t: string) => {
      setToState(t)
      void call('storage.set', 'sendTo', t).catch(() => undefined)
    },
    [call]
  )
  useEffect(() => {
    void call<string | null>('storage.get', 'sendTo').then((t) => t && setToState(t)).catch(() => undefined)
  }, [call])
  const [board, setBoard] = useState<Board | null>(null)
  const [engine, setEngine] = useState<TargetId | null>(null)
  const [modId, setModId] = useState<string | undefined>()
  const [openId, setOpenId] = useState<string | null>(null)
  const [styleOpen, setStyleOpen] = useState(false)
  const boardRef = useRef<Board | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let live = true
    void (async () => {
      let b = emptyBoard()
      try {
        b = parseBoard(JSON.parse(await call<string>('files.read', BOARD_PATH)))
      } catch {
        /* no board yet */
      }
      try {
        const root = await call<{ name: string; dir: boolean }[]>('files.list', '')
        const names = root.map((e) => (e.dir ? `${e.name}/` : e.name))
        const read = (n: string) => call<string>('files.read', n).catch(() => null)
        const t = await detectTarget(names, read)
        if (live) setEngine(t)
        if (t === 'minecraft') setModId(modIdFrom((await read('gradle.properties')) ?? '') ?? undefined)
      } catch {
        /* an engine is only a hint */
      }
      if (!live) return
      boardRef.current = b
      setBoard(b)
    })()
    return () => {
      live = false
    }
  }, [call])

  /** Every change is written to board.json shortly after, so the board is part of the project. */
  const commit = useCallback(
    (next: Board) => {
      boardRef.current = next
      setBoard(next)
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => void call('files.write', BOARD_PATH, boardJson(next)).catch((e) => toast('error', `Could not save the asset board: ${errText(e)}`)), 250)
    },
    [call, toast]
  )

  // a chat's results arrive in the gallery titled asset:<id>
  useEffect(() => {
    if (!board) return
    const tick = async () => {
      const b = boardRef.current
      if (!b || !b.assets.some((a) => a.status === 'requested' || a.status === 'rejected' || a.status === 'review')) return
      try {
        const media = await call<{ id: string; path: string; kind: string; ts: number; title?: string }[]>('media.list')
        const got = matchCandidates(boardRef.current!, media)
        if (got.arrived.length) {
          commit(got.board)
          toast('info', `New candidates for ${got.arrived.map((id) => got.board.assets.find((a) => a.id === id)?.name ?? id).join(', ')}`)
        }
      } catch {
        /* the gallery is unreadable without media:read; the board says so on request */
      }
    }
    const t = setInterval(() => void tick(), POLL_MS)
    void tick()
    return () => clearInterval(t)
  }, [board === null, call, commit, toast]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => void (saveTimer.current && clearTimeout(saveTimer.current)), [])

  if (!board) return <div className="p-6 text-sm text-indigo-300/70">Opening the asset board...</div>
  const open = openId ? board.assets.find((a) => a.id === openId) : undefined
  const engineName = engine ? TARGETS[engine].engine : null
  const target = chats.find((c) => c.id === to)
  // a chat picked for the work that has no generator switched on cannot make anything
  const noGenerator = !!target && !target.mcp.some((m) => GENERATORS.includes(m))

  return (
    <div className="flex h-full min-h-0" data-testid="asset-board">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
          <div className="text-xs text-indigo-300/80">
            {board.assets.length} assets{engineName ? ` · ${engineName} project` : ''} · <span className="font-mono text-[11px]">{BOARD_PATH}</span>
          </div>
          <div className="flex-1" />
          {noGenerator && <span className="text-[11px] text-amber-300" title="Switch Meshy, WaveSpeed or Higgsfield on for it in its chat settings, or in Settings -> MCP servers">That chat has no image or 3D generator on</span>}
          <span className="text-[11px] text-indigo-300/70">Requests go to</span>
          <ChatTarget chats={chats} value={to} onChange={setTo} testId="ab-send-to" />
          <button className={`btn !py-1 ${styleOpen ? '!border-violet-400/60' : ''}`} onClick={() => setStyleOpen(!styleOpen)} data-testid="ab-style">
            <Palette size={13} /> Style guide
          </button>
        </div>
        {styleOpen && <StyleGuide board={board} onChange={commit} />}
        <div className="scroll-thin grid min-h-0 flex-1 grid-cols-4 gap-2 overflow-y-auto p-3">
          {COLUMNS.map((col, i) => {
            const items = board.assets.filter((a) => col.statuses.includes(a.status))
            return (
              <div key={col.title} className="flex min-h-0 flex-col rounded-xl border border-white/5 bg-white/[0.02] p-2" data-testid={`ab-col-${col.title.toLowerCase().replace(' ', '-')}`}>
                <div className="mb-2 flex items-baseline gap-2 px-1">
                  <div className="whitespace-nowrap font-display text-sm font-bold">{col.title}</div>
                  <div className="text-[11px] text-indigo-300/60">{items.length || ''}</div>
                  <div className="ml-auto truncate text-[10px] text-indigo-300/50">{col.hint}</div>
                </div>
                {i === 0 && (
                  <AddAsset
                    onAdd={(name, kind) => {
                      const res = addAsset(board, name, kind, engine, modId)
                      commit(res.board)
                      setOpenId(res.id)
                    }}
                  />
                )}
                <div className="space-y-1.5">
                  {items.map((a) => (
                    <AssetCard key={a.id} asset={a} call={call} active={a.id === openId} onClick={() => setOpenId(a.id === openId ? null : a.id)} />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>
      {open && (
        <Detail
          key={open.id}
          asset={open}
          board={board}
          engine={engine}
          modId={modId}
          call={call}
          commit={commit}
          onClose={() => setOpenId(null)}
          request={async (a, revision) => {
            try {
              const brief = revision !== undefined ? revisionBrief(a, revision) : requestBrief(a, boardRef.current!, engineName)
              const dest = to === 'new' || chats.some((c) => c.id === to) ? to : 'new'
              // a new chat starts with the generators the user has set up switched on
              const sent = await call<Sent>('send', dest, brief, { mcp: GENERATORS })
              if (dest !== sent.chatId) setTo(sent.chatId)
              let next = boardRef.current!
              if (revision !== undefined) next = setStatus(next, a.id, 'rejected', revision)
              else next = setStatus(next, a.id, 'requested')
              commit(next)
              toast('info', `${revision !== undefined ? 'Sent back' : 'Requested'} "${a.name}" - ${chatLabel(chats, dest, sent)} is on it`)
            } catch (e) {
              toast('error', `Could not send the request: ${errText(e)}`)
            }
          }}
        />
      )}
    </div>
  )
}

function AddAsset({ onAdd }: { onAdd: (name: string, kind: AssetKind) => void }) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState<AssetKind>('sprite')
  const add = () => {
    if (!name.trim()) return
    onAdd(name.trim().slice(0, 80), kind)
    setName('')
  }
  return (
    <div className="mb-2 grid grid-cols-[1fr_auto] gap-1">
      <input className="field col-span-2 !py-1 !text-xs" placeholder="New asset, e.g. Fire Slime" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} data-testid="ab-new-name" />
      <select className="field !px-1 !py-1 !text-xs" value={kind} onChange={(e) => setKind(e.target.value as AssetKind)} data-testid="ab-new-kind">
        {ASSET_KINDS.map((k) => (
          <option key={k} value={k}>
            {KIND_LABEL[k]}
          </option>
        ))}
      </select>
      <button className="btn !px-2 !py-1" title="Add" onClick={add} data-testid="ab-add">
        <Plus size={13} />
      </button>
    </div>
  )
}

const KIND_ICON: Partial<Record<AssetKind, typeof Box>> = { model: Box, sound: FileAudio, music: Music }

/** A data URL for a media file, read through the plugin API (cached for the session). */
const dataCache = new Map<string, Promise<string>>()
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', ogg: 'audio/ogg', mp3: 'audio/mpeg', wav: 'audio/wav' }
function dataUrl(call: PluginCall, path: string): Promise<string> {
  let p = dataCache.get(path)
  if (!p) {
    const ext = path.split('.').pop()?.toLowerCase() ?? ''
    p = call<string>('files.read', path, 'base64').then((b) => `data:${MIME[ext] ?? 'application/octet-stream'};base64,${b}`)
    p.catch(() => dataCache.delete(path))
    dataCache.set(path, p)
  }
  return p
}

function useDataUrl(call: PluginCall, c: Candidate | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    setUrl(null)
    if (!c || c.kind !== 'image') return
    let live = true
    void dataUrl(call, c.path)
      .then((u) => live && setUrl(u))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [call, c?.path, c?.kind]) // eslint-disable-line react-hooks/exhaustive-deps
  return url
}

function Thumb({ call, c, kind, size }: { call: PluginCall; c?: Candidate; kind: AssetKind; size: number }) {
  const url = useDataUrl(call, c)
  const I = KIND_ICON[kind] ?? ImageIcon
  return (
    <div className="flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-white/10 bg-[repeating-conic-gradient(#1e1b4b_0_25%,#141433_0_50%)] bg-[length:12px_12px]" style={{ width: size, height: size }}>
      {url ? <img src={url} alt="" className="max-h-full max-w-full object-contain" style={{ imageRendering: 'pixelated' }} /> : <I size={size * 0.4} className="text-indigo-300/60" />}
    </div>
  )
}

function AssetCard({ asset: a, call, active, onClick }: { asset: Asset; call: PluginCall; active: boolean; onClick: () => void }) {
  const shown = a.candidates.find((c) => c.mediaId === a.chosen) ?? a.candidates.at(-1)
  return (
    <button onClick={onClick} className={`flex w-full items-center gap-2 rounded-lg border p-1.5 text-left transition ${active ? 'border-violet-400/70 bg-violet-500/15' : 'border-white/10 bg-black/20 hover:border-white/25'}`} data-testid={`ab-card-${a.id}`}>
      <Thumb call={call} c={shown} kind={a.kind} size={40} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-semibold">{a.name}</div>
        <div className="truncate text-[10.5px] text-indigo-300/70">
          {KIND_LABEL[a.kind]} · {a.spec.size}
        </div>
      </div>
      {a.status === 'rejected' && <span className="rounded bg-amber-500/20 px-1 text-[9.5px] font-bold uppercase text-amber-200">revision</span>}
      {a.status === 'requested' && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" title="waiting for the chat making it" />}
      {a.status === 'review' && <span className="rounded bg-violet-500/30 px-1 text-[10px] font-bold text-violet-100">{a.candidates.length}</span>}
    </button>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="label">{label}</div>
      {children}
    </div>
  )
}

function Detail({
  asset: a,
  board,
  engine,
  modId,
  call,
  commit,
  onClose,
  request
}: {
  asset: Asset
  board: Board
  engine: TargetId | null
  modId?: string
  call: PluginCall
  commit: (b: Board) => void
  onClose: () => void
  request: (a: Asset, revision?: string) => Promise<void>
}) {
  const toast = useStore((s) => s.toast)
  const [picked, setPick] = useState<string | undefined>()
  // until one is picked, the newest (candidates can arrive while this is open)
  const pick = picked ?? a.chosen ?? a.candidates.at(-1)?.mediaId
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const px = pixelSize(a.spec)
  const [fit, setFit] = useState(true)
  const set = (patch: Partial<Asset>) => commit(updateAsset(board, a.id, patch))
  const candidate = a.candidates.find((c) => c.mediaId === pick)
  const pixelArt = useMemo(() => !!px && (px.w <= 64 || /pixel/i.test(board.style.text)), [px, board.style.text])

  const doApprove = async () => {
    if (!candidate) return
    setBusy(true)
    try {
      let b64 = await call<string>('files.read', candidate.path, 'base64')
      const image = IMAGE_KINDS.has(a.kind) && candidate.kind === 'image'
      let target = a.targetPath
      if (image) b64 = await reencode(`data:${MIME[candidate.path.split('.').pop()?.toLowerCase() ?? 'png'] ?? 'image/png'};base64,${b64}`, fit ? px : null, !pixelArt)
      else {
        // not an image: keep its bytes, and its own extension if the target guessed another
        const ext = candidate.path.split('.').pop()
        if (ext && !target.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) target = target.replace(/\.[^./]+$/, '') + `.${ext}`
      }
      await call('files.write', target, b64, 'base64')
      commit(approve(updateAsset(board, a.id, { targetPath: target }), a.id, candidate.mediaId))
      toast('info', `"${a.name}" is in the project at ${target}`)
    } catch (e) {
      toast('error', `Could not approve: ${errText(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="scroll-thin flex w-[340px] shrink-0 flex-col gap-3 overflow-y-auto overflow-x-hidden border-l border-white/10 p-3" data-testid="ab-detail">
      <div className="flex items-center gap-2">
        <input className="field !py-1 font-semibold !text-sm" value={a.name} onChange={(e) => set({ name: e.target.value.slice(0, 80) })} />
        <button className="btn btn-ghost !p-1" title="Close details" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <div className="flex items-center gap-2 text-[11px] text-indigo-300/80">
        <span className="font-mono">asset:{a.id}</span>
        <span className="rounded-full border border-white/10 px-2 py-0.5 capitalize">{a.status === 'rejected' ? 'sent back' : a.status}</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Kind">
          <select
            className="field !py-1 !text-xs"
            value={a.kind}
            onChange={(e) => {
              const kind = e.target.value as AssetKind
              // a path still at its old suggestion follows the kind
              const auto = a.targetPath === suggestPath(engine, a.kind, a.name, modId)
              set({ kind, ...(auto ? { targetPath: suggestPath(engine, kind, a.name, modId) } : {}) })
            }}
          >
            {ASSET_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Size">
          <input className="field !py-1 !text-xs" value={a.spec.size} onChange={(e) => set({ spec: { ...a.spec, size: e.target.value.slice(0, 80) } })} data-testid="ab-size" />
        </Field>
      </div>
      <Field label="Format">
        <input className="field !py-1 !text-xs" value={a.spec.format} onChange={(e) => set({ spec: { ...a.spec, format: e.target.value.slice(0, 120) } })} />
      </Field>
      <Field label="What it is">
        <textarea className="field min-h-[70px] !text-xs" value={a.spec.notes} onChange={(e) => set({ spec: { ...a.spec, notes: e.target.value.slice(0, 4000) } })} placeholder="What it shows, where it is used, the mood, references..." data-testid="ab-notes" />
      </Field>
      <Field label="Goes to">
        <div className="flex gap-1">
          <input className="field !py-1 font-mono !text-[11px]" value={a.targetPath} onChange={(e) => set({ targetPath: e.target.value.replace(/\.\.+/g, '.').slice(0, 300) })} data-testid="ab-path" />
          <button className="btn !px-2 !py-1" title="Suggest a path for this project" onClick={() => set({ targetPath: suggestPath(engine, a.kind, a.name, modId) })}>
            <Wand2 size={13} />
          </button>
        </div>
      </Field>

      {a.status === 'review' && (
        <div className="space-y-2 rounded-xl border border-violet-400/30 bg-violet-500/10 p-2">
          <div className="label">Candidates</div>
          <div className="grid grid-cols-3 gap-1.5">
            {a.candidates.map((c) => (
              <button key={c.mediaId} onClick={() => setPick(c.mediaId)} className={`rounded-lg border-2 p-0.5 ${pick === c.mediaId ? 'border-violet-400' : 'border-transparent'}`} title={c.title} data-testid="ab-candidate">
                <Thumb call={call} c={c} kind={a.kind} size={92} />
              </button>
            ))}
          </div>
          {candidate && candidate.kind === 'audio' && <AudioPreview call={call} c={candidate} />}
          {candidate && candidate.kind === 'model' && <div className="text-[11px] text-indigo-300/70">3D models preview in the gallery (Media on the rail).</div>}
          {px && IMAGE_KINDS.has(a.kind) && (
            <label className="flex items-center gap-2 text-[11px] text-indigo-200">
              <input type="checkbox" checked={fit} onChange={(e) => setFit(e.target.checked)} />
              Resize to {px.w}x{px.h} {pixelArt ? '(pixel art: nearest neighbour)' : ''}
            </label>
          )}
          <button className="btn btn-primary w-full justify-center !py-1.5" disabled={!candidate || busy} onClick={() => void doApprove()} data-testid="ab-approve">
            <Check size={13} /> {busy ? 'Copying...' : 'Approve and copy into the project'}
          </button>
          <textarea className="field min-h-[54px] !text-xs" placeholder="Not right? Say what to change..." value={note} onChange={(e) => setNote(e.target.value)} data-testid="ab-reject-note" />
          <button className="btn w-full justify-center !py-1" disabled={!note.trim()} onClick={() => void request(a, note).then(() => setNote(''))} data-testid="ab-reject">
            <RotateCcw size={13} /> Send back with this note
          </button>
        </div>
      )}

      {a.status !== 'review' && (
        <button className="btn btn-primary justify-center !py-1.5" onClick={() => void request(a)} data-testid="ab-request">
          <Send size={13} /> {a.status === 'wanted' ? 'Request it' : 'Request again'}
        </button>
      )}
      {a.status === 'requested' && <div className="text-[11px] leading-snug text-indigo-300/70">Waiting for results in the gallery titled <span className="font-mono">asset:{a.id}</span>. They appear here as they arrive.</div>}
      {a.status === 'approved' && <div className="break-all text-[11px] text-emerald-300/90">In the project at <span className="font-mono">{a.targetPath}</span>.</div>}

      <div className="mt-auto space-y-1 border-t border-white/10 pt-2">
        <div className="label">History</div>
        {a.history
          .slice()
          .reverse()
          .slice(0, 8)
          .map((h, i) => (
            <div key={i} className="flex gap-2 text-[10.5px] text-indigo-300/70">
              <span className="font-mono">{new Date(h.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
              <span className="capitalize">{h.status === 'rejected' ? 'sent back' : h.status}</span>
              {h.note && <span className="truncate italic">"{h.note}"</span>}
            </div>
          ))}
        <button className="btn btn-danger mt-2 !py-1" onClick={() => (commit(removeAsset(board, a.id)), onClose())}>
          <Trash2 size={13} /> Remove from the board
        </button>
      </div>
    </div>
  )
}

function AudioPreview({ call, c }: { call: PluginCall; c: Candidate }) {
  const [url, setUrl] = useState<string | null>(null)
  return url ? (
    <audio src={url} controls autoPlay className="w-full" />
  ) : (
    <button className="btn !py-1" onClick={() => void dataUrl(call, c.path).then(setUrl)}>
      <Play size={13} /> Listen
    </button>
  )
}

/** An image as PNG base64, optionally resized to the spec (nearest neighbour for pixel art). */
async function reencode(src: string, size: { w: number; h: number } | null, smooth: boolean): Promise<string> {
  const img = new Image()
  await new Promise<void>((res, rej) => ((img.onload = () => res()), (img.onerror = () => rej(new Error('not a readable image'))), (img.src = src)))
  const c = document.createElement('canvas')
  c.width = size?.w ?? img.naturalWidth
  c.height = size?.h ?? img.naturalHeight
  const ctx = c.getContext('2d')!
  ctx.imageSmoothingEnabled = smooth
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, 0, 0, c.width, c.height)
  return c.toDataURL('image/png').split(',')[1]
}

function StyleGuide({ board, onChange }: { board: Board; onChange: (b: Board) => void }) {
  const [colour, setColour] = useState('#f5c451')
  const s = board.style
  return (
    <div className="flex gap-4 border-b border-white/10 bg-black/20 p-3" data-testid="ab-style-panel">
      <div className="flex-1">
        <div className="label">Style guide (sent with every request)</div>
        <textarea className="field min-h-[60px] !text-xs" value={s.text} onChange={(e) => onChange({ ...board, style: { ...s, text: e.target.value.slice(0, 5000) } })} placeholder="e.g. hand-painted, warm light, thick dark outlines; 16x16 pixel art in the vanilla palette..." data-testid="ab-style-text" />
      </div>
      <div className="w-56">
        <div className="label">Palette</div>
        <div className="flex flex-wrap items-center gap-1.5">
          {s.palette.map((c) => (
            <button key={c} title={`${c} (click to remove)`} className="h-6 w-6 rounded-md border border-white/20" style={{ background: c }} onClick={() => onChange({ ...board, style: { ...s, palette: s.palette.filter((x) => x !== c) } })} />
          ))}
          <input type="color" value={colour} onChange={(e) => setColour(e.target.value)} className="h-6 w-8 cursor-pointer rounded bg-transparent" />
          <button className="btn !px-1.5 !py-0.5" disabled={s.palette.length >= 16 || s.palette.includes(colour)} onClick={() => onChange({ ...board, style: { ...s, palette: [...s.palette, colour] } })}>
            <Plus size={12} />
          </button>
        </div>
      </div>
    </div>
  )
}
