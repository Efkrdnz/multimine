import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, ImageOff, MousePointer2, Send, Square, Type, Undo2 } from 'lucide-react'
import { revisionBrief, sketchDir, uiCreator } from '@shared/sketch/brief'
import type { Sketch } from '@shared/sketch/model'
import { useStore } from '../../state/store'

interface Shot {
  id: string
  path: string
  title?: string
  agentId: string
  ts: number
  kind: string
}

type Line = { x1: number; y1: number; x2: number; y2: number }
type Mark = ({ kind: 'box' } & Line) | ({ kind: 'arrow' } & Line) | { kind: 'text'; x1: number; y1: number; text: string }

const RED = '#ef4444'

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }
const mimeOf = (p: string) => MIME[p.split('.').pop()?.toLowerCase() ?? ''] ?? 'image/png'

/**
 * The real screens the UI Creator brought back, from the gallery: pick one, mark what is wrong on it,
 * say what to change, and the marked-up picture goes back to whoever builds the UI.
 */
export function Revisions({ sketch, call }: { sketch: Sketch; call: <T>(m: string, ...a: unknown[]) => Promise<T> }) {
  const toast = useStore((s) => s.toast)
  const [shots, setShots] = useState<Shot[] | null>(null)
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [open, setOpen] = useState<Shot | null>(null)

  useEffect(() => {
    void call<Shot[]>('media.list')
      .then((all) => {
        // the builder's screenshots first; the sketcher's own mockups after
        const imgs = all.filter((m) => m.kind === 'image').sort((a, b) => Number(a.agentId.startsWith('plugin:')) - Number(b.agentId.startsWith('plugin:')) || b.ts - a.ts)
        setShots(imgs.slice(0, 24))
      })
      .catch((e) => (setShots([]), toast('error', String((e as Error).message ?? e))))
  }, [call, toast])

  useEffect(() => {
    let live = true
    for (const s of shots ?? [])
      if (!thumbs[s.id])
        void call<string>('files.read', s.path, 'base64')
          .then((b) => live && setThumbs((t) => ({ ...t, [s.id]: `data:${mimeOf(s.path)};base64,${b}` })))
          .catch(() => undefined)
    return () => {
      live = false
    }
  }, [shots])

  if (open && thumbs[open.id]) return <Markup sketch={sketch} shot={open} src={thumbs[open.id]} call={call} onBack={() => setOpen(null)} />

  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4" data-testid="sk-revisions">
      <div className="mb-3 text-xs leading-relaxed text-indigo-300/80">
        Screenshots in the gallery. When the UI Creator captures the real screen it lands here: open one, mark what should change and send it back as a revision.
      </div>
      {shots === null && <div className="text-xs text-indigo-300/70">Loading the gallery...</div>}
      {shots?.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-16 text-sm text-indigo-300/70">
          <ImageOff size={28} /> No screenshots yet. Send the sketch to Mastermind and the real screen comes back here.
        </div>
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
        {shots?.map((s) => (
          <button key={s.id} onClick={() => setOpen(s)} className="overflow-hidden rounded-xl border border-white/10 bg-black/30 text-left transition hover:border-violet-400/50" data-testid="sk-shot">
            <div className="flex aspect-video items-center justify-center bg-black/40">{thumbs[s.id] ? <img src={thumbs[s.id]} alt="" className="max-h-full max-w-full object-contain" /> : <div className="text-[10px] text-indigo-300/50">...</div>}</div>
            <div className="truncate px-2 py-1.5 text-[11px] text-indigo-200/90">{s.title || s.path.split(/[\\/]/).pop()}</div>
          </button>
        ))}
      </div>
    </div>
  )
}

function Markup({ sketch, shot, src, call, onBack }: { sketch: Sketch; shot: Shot; src: string; call: <T>(m: string, ...a: unknown[]) => Promise<T>; onBack: () => void }) {
  const toast = useStore((s) => s.toast)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [marks, setMarks] = useState<Mark[]>([])
  const [tool, setTool] = useState<'box' | 'arrow' | 'text' | null>('box')
  const [draft, setDraft] = useState<Mark | null>(null)
  const [notes, setNotes] = useState('')
  const [markText, setMarkText] = useState('Fix this')
  const [busy, setBusy] = useState(false)
  const svg = useRef<SVGSVGElement>(null)

  useEffect(() => {
    const img = new Image()
    img.onload = () => setSize({ w: img.naturalWidth, h: img.naturalHeight })
    img.src = src
  }, [src])

  const lw = size ? Math.max(3, size.w / 320) : 3
  const at = (e: React.PointerEvent) => {
    const r = svg.current!.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * size!.w, y: ((e.clientY - r.top) / r.height) * size!.h }
  }
  const down = (e: React.PointerEvent) => {
    if (!tool || !size) return
    const p = at(e)
    if (tool === 'text') {
      if (markText.trim()) setMarks([...marks, { kind: 'text', x1: p.x, y1: p.y, text: markText.trim().slice(0, 200) }])
      return
    }
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    setDraft(tool === 'box' ? { kind: 'box', x1: p.x, y1: p.y, x2: p.x, y2: p.y } : { kind: 'arrow', x1: p.x, y1: p.y, x2: p.x, y2: p.y })
  }
  const move = (e: React.PointerEvent) => draft && draft.kind !== 'text' && setDraft({ ...draft, ...{ x2: at(e).x, y2: at(e).y } })
  const up = () => {
    if (draft && draft.kind !== 'text' && Math.hypot(draft.x2 - draft.x1, draft.y2 - draft.y1) > lw * 2) setMarks([...marks, draft])
    setDraft(null)
  }

  const send = async () => {
    if (!size) return
    setBusy(true)
    try {
      // the screenshot with the marks burnt in, so whoever reads it sees exactly this
      const c = document.createElement('canvas')
      c.width = size.w
      c.height = size.h
      const ctx = c.getContext('2d')!
      const img = new Image()
      await new Promise<void>((res, rej) => ((img.onload = () => res()), (img.onerror = () => rej(new Error('could not read the screenshot'))), (img.src = src)))
      ctx.drawImage(img, 0, 0)
      for (const m of marks) drawMark(ctx, m, lw)
      const dir = sketchDir(sketch.name)
      const existing = await call<{ name: string }[]>('files.list', dir).catch(() => [])
      const n = existing.filter((f) => /^revision-\d+\.png$/.test(f.name)).length + 1
      const path = `${dir}/revision-${n}.png`
      await call('files.write', path, c.toDataURL('image/png').split(',')[1], 'base64')
      const team = await call<{ id: string; name: string; role: string }[]>('team.list')
      const to = uiCreator(team)
      await call('send', to?.id ?? 'mastermind', revisionBrief(sketch, path, notes))
      toast('info', `Revision ${n} sent to ${to?.name ?? 'Mastermind'}`)
      onBack()
    } catch (e) {
      toast('error', `Could not send the revision: ${String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`)
    } finally {
      setBusy(false)
    }
  }

  const all = draft ? [...marks, draft] : marks
  return (
    <div className="flex min-h-0 flex-1" data-testid="sk-markup">
      <div className="flex min-w-0 flex-1 items-center justify-center bg-[#070816] p-4">
        {size && (
          <div className="relative max-h-full max-w-full" style={{ aspectRatio: `${size.w} / ${size.h}`, height: '100%' }}>
            <img src={src} alt="" className="absolute inset-0 h-full w-full object-contain" draggable={false} />
            <svg ref={svg} data-testid="sk-markup-svg" viewBox={`0 0 ${size.w} ${size.h}`} className="absolute inset-0 h-full w-full" style={{ cursor: tool ? 'crosshair' : 'default' }} onPointerDown={down} onPointerMove={move} onPointerUp={up}>
              <defs>
                <marker id="rv-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill={RED} />
                </marker>
              </defs>
              {all.map((m, i) =>
                m.kind === 'box' ? (
                  <rect key={i} x={Math.min(m.x1, m.x2)} y={Math.min(m.y1, m.y2)} width={Math.abs(m.x2 - m.x1)} height={Math.abs(m.y2 - m.y1)} fill="none" stroke={RED} strokeWidth={lw} />
                ) : m.kind === 'arrow' ? (
                  <line key={i} x1={m.x1} y1={m.y1} x2={m.x2} y2={m.y2} stroke={RED} strokeWidth={lw} markerEnd="url(#rv-arrow)" />
                ) : (
                  <text key={i} x={m.x1} y={m.y1} fill={RED} fontSize={lw * 6} fontWeight={700} fontFamily="system-ui, sans-serif" stroke="#000" strokeWidth={lw / 2} paintOrder="stroke">
                    {m.text}
                  </text>
                )
              )}
            </svg>
          </div>
        )}
      </div>
      <div className="flex w-[260px] shrink-0 flex-col gap-3 border-l border-white/10 p-3">
        <div className="truncate text-xs font-semibold">{shot.title || shot.path.split(/[\\/]/).pop()}</div>
        <div className="flex gap-1">
          {(
            [
              [null, MousePointer2, 'Look'],
              ['box', Square, 'Box'],
              ['arrow', ArrowUpRight, 'Arrow'],
              ['text', Type, 'Text']
            ] as const
          ).map(([t, I, label]) => (
            <button key={label} title={label} onClick={() => setTool(t)} className={`btn !px-2 !py-1 ${tool === t ? '!border-violet-400/70 !bg-violet-500/30' : ''}`}>
              <I size={13} />
            </button>
          ))}
          <button className="btn btn-ghost !px-2 !py-1" title="Undo the last mark" disabled={!marks.length} onClick={() => setMarks(marks.slice(0, -1))}>
            <Undo2 size={13} />
          </button>
        </div>
        {tool === 'text' && (
          <div>
            <div className="label">Text to place</div>
            <input className="field !py-1 !text-xs" value={markText} onChange={(e) => setMarkText(e.target.value)} placeholder="Click the screenshot to place it" />
          </div>
        )}
        <div>
          <div className="label">What to change</div>
          <textarea className="field min-h-[120px] !text-xs" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="The arrow should sit between the slots; the title is too low..." data-testid="sk-revision-notes" />
        </div>
        <div className="mt-auto flex gap-2">
          <button className="btn" onClick={onBack}>
            Back
          </button>
          <button className="btn btn-primary flex-1 justify-center" disabled={busy || (!marks.length && !notes.trim())} onClick={() => void send()} data-testid="sk-revision-send">
            <Send size={13} /> {busy ? 'Sending...' : 'Send revision'}
          </button>
        </div>
      </div>
    </div>
  )
}

function drawMark(ctx: CanvasRenderingContext2D, m: Mark, lw: number) {
  ctx.strokeStyle = RED
  ctx.fillStyle = RED
  ctx.lineWidth = lw
  if (m.kind === 'box') return ctx.strokeRect(Math.min(m.x1, m.x2), Math.min(m.y1, m.y2), Math.abs(m.x2 - m.x1), Math.abs(m.y2 - m.y1))
  if (m.kind === 'arrow') {
    const a = Math.atan2(m.y2 - m.y1, m.x2 - m.x1)
    const head = lw * 4
    ctx.beginPath()
    ctx.moveTo(m.x1, m.y1)
    ctx.lineTo(m.x2 - Math.cos(a) * head * 0.6, m.y2 - Math.sin(a) * head * 0.6)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(m.x2, m.y2)
    ctx.lineTo(m.x2 - Math.cos(a - 0.45) * head, m.y2 - Math.sin(a - 0.45) * head)
    ctx.lineTo(m.x2 - Math.cos(a + 0.45) * head, m.y2 - Math.sin(a + 0.45) * head)
    ctx.closePath()
    ctx.fill()
    return
  }
  ctx.font = `700 ${lw * 6}px system-ui, sans-serif`
  ctx.lineWidth = lw / 2
  ctx.strokeStyle = '#000'
  ctx.strokeText(m.text, m.x1, m.y1)
  ctx.fillText(m.text, m.x1, m.y1)
}
