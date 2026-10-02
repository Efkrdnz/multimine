import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, FilePlus, FolderOpen, Grid3x3, Maximize, Redo2, Save, Send, Undo2, ZoomIn, ZoomOut } from 'lucide-react'
import type { PluginInfo } from '@shared/types'
import { sketchBrief, sketchDir, SKETCH_ROOT } from '@shared/sketch/brief'
import { drawSketch, lookOf } from '@shared/sketch/draw'
import {
  add,
  byId,
  copy,
  duplicate,
  exportJson,
  History,
  move,
  newSketch,
  parseSketch,
  paste,
  remove,
  reorder,
  settle,
  slug,
  update,
  type ElementType,
  type Rect,
  type Sketch,
  type SketchElement
} from '@shared/sketch/model'
import { inventoryStamp, PRESET_IDS, PRESETS, type PresetId } from '@shared/sketch/presets'
import { api, useStore } from '../../state/store'
import { fitView, SketchCanvas, type View } from './Canvas'
import { toPng } from './paint'
import { Layers, Palette, Properties } from './Panels'
import { Revisions } from './Revisions'

/**
 * The UI Sketcher. It is built into the app but holds no privileges of its own: every file it writes,
 * every message it sends and every picture it shows goes through the same permission-checked plugin
 * API a third-party tool gets.
 */
export function useSketcherApi(id: string) {
  return useCallback(<T,>(method: string, ...args: unknown[]) => api().pluginCall(id, method, args) as Promise<T>, [id])
}

type Tab = 'design' | 'mockup' | 'revisions'
type Member = { id: string; name: string; role: string }

const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export function Sketcher({ plugin }: { plugin: PluginInfo }) {
  const call = useSketcherApi(plugin.manifest.id)
  const toast = useStore((s) => s.toast)
  const [sketch, setSketch] = useState<Sketch | null>(null)
  const [savedJson, setSavedJson] = useState('')
  const [selection, setSelection] = useState<string[]>([])
  const [tool, setTool] = useState<ElementType | 'inventory' | null>(null)
  const [view, setView] = useState<View | null>(null)
  const [styled, setStyled] = useState(false)
  const [showGrid, setShowGrid] = useState(true)
  const [tab, setTab] = useState<Tab>('design')
  const [menu, setMenu] = useState<'new' | 'open' | 'send' | null>(null)
  const [, bump] = useState(0)
  const history = useRef(new History())
  const clip = useRef<SketchElement[]>([])
  const lastEdit = useRef<{ key: string; t: number } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const canvasBox = useRef<HTMLDivElement>(null)

  // reopen the last sketch, or start a Minecraft one
  useEffect(() => {
    let live = true
    void (async () => {
      let sk: Sketch | null = null
      try {
        const last = await call<string | null>('storage.get', 'last')
        if (last) sk = parseSketch(JSON.parse(await call<string>('files.read', `${SKETCH_ROOT}/${slug(last)}/sketch.json`)))
      } catch {
        sk = null
      }
      if (!live) return
      const start = sk ?? newSketch('Untitled', 'minecraft')
      setSketch(start)
      setSavedJson(sk ? JSON.stringify(sk) : '')
    })()
    return () => {
      live = false
    }
  }, [call])

  const commit = useCallback(
    (next: Sketch, mergeKey?: string) => {
      setSketch((cur) => {
        if (!cur || next === cur) return next
        const now = Date.now()
        const merge = mergeKey && lastEdit.current?.key === mergeKey && now - lastEdit.current.t < 1200
        if (!merge) history.current.push(cur)
        lastEdit.current = mergeKey ? { key: mergeKey, t: now } : null
        return next
      })
      bump((n) => n + 1)
    },
    []
  )

  const undo = () => {
    if (!sketch) return
    const prev = history.current.undo(sketch)
    if (prev) (setSketch(prev), setSelection((s) => s.filter((id) => byId(prev, id))), bump((n) => n + 1))
  }
  const redo = () => {
    if (!sketch) return
    const next = history.current.redo(sketch)
    if (next) (setSketch(next), bump((n) => n + 1))
  }

  const save = useCallback(
    async (sk: Sketch, quiet = false): Promise<string | null> => {
      const dir = sketchDir(sk.name)
      try {
        const p = PRESETS[sk.preset]
        await call('files.write', `${dir}/sketch.json`, exportJson(sk))
        await call('files.write', `${dir}/sketch.png`, toPng(drawSketch(sk, 'wireframe'), sk.canvas.w, sk.canvas.h, p.scale), 'base64')
        await call('files.write', `${dir}/mockup.png`, toPng(drawSketch(sk, p.style), sk.canvas.w, sk.canvas.h, p.scale), 'base64')
        await call('storage.set', 'last', slug(sk.name))
        setSavedJson(JSON.stringify(sk))
        if (!quiet) toast('info', `Saved to ${dir}`)
        return dir
      } catch (e) {
        toast('error', `Could not save the sketch: ${errText(e)}`)
        return null
      }
    },
    [call, toast]
  )

  const sendToMastermind = async (note: string) => {
    if (!sketch) return
    const dir = await save(sketch, true)
    if (!dir) return
    try {
      const team = await call<Member[]>('team.list')
      await call('send', 'mastermind', sketchBrief(sketch, team, note))
      await call('media.show', `${dir}/mockup.png`, `Sketch: ${sketch.name} (mockup)`).catch(() => undefined)
      toast('info', `Sent "${sketch.name}" to Mastermind`)
      setMenu(null)
    } catch (e) {
      toast('error', `Could not send: ${errText(e)}`)
    }
  }

  const drawn = (type: ElementType | 'inventory', r: Rect) => {
    if (!sketch) return
    const p = PRESETS[sketch.preset]
    let next = sketch
    let ids: string[] = []
    if (type === 'inventory') {
      for (const d of inventoryStamp(r.x - 8, r.y - 72)) {
        const res = add(next, d)
        next = res.sketch
        ids.push(res.id)
      }
    } else {
      const size = r.w ? { w: r.w, h: r.h } : p.sizes[type]
      const res = add(next, { type, x: r.x, y: r.y, ...size, ...(type === 'slotgrid' && !r.w ? { cols: p.style === 'minecraft' ? 9 : 4, rows: 3 } : {}) })
      next = res.sketch
      ids = [res.id]
      // a drawn slot grid gets as many whole cells as fit
      if (type === 'slotgrid' && r.w) {
        const cell = p.sizes.slot.w
        next = update(next, res.id, { cols: Math.max(1, Math.round(r.w / cell)), rows: Math.max(1, Math.round(r.h / cell)), w: Math.max(1, Math.round(r.w / cell)) * cell, h: Math.max(1, Math.round(r.h / cell)) * cell })
      }
    }
    commit(next)
    setSelection(ids)
    setTool(null)
    root.current?.focus()
  }

  const key = (e: React.KeyboardEvent) => {
    if (!sketch || tab !== 'design') return
    const t = e.target as HTMLElement
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return
    const mod = e.ctrlKey || e.metaKey
    const k = e.key.toLowerCase()
    const done = () => (e.preventDefault(), e.stopPropagation())
    if (mod && k === 'z') return done(), e.shiftKey ? redo() : undo()
    if (mod && k === 'y') return done(), redo()
    if (mod && k === 's') return done(), void save(sketch)
    if (mod && k === 'a') return done(), setSelection(sketch.elements.filter((x) => !x.parent).map((x) => x.id))
    if (e.key === 'Escape') return done(), tool ? setTool(null) : setSelection([])
    if (!selection.length) {
      if (mod && k === 'v') {
        done()
        const res = paste(sketch, clip.current, PRESETS[sketch.preset].grid * 4)
        if (res.ids.length) (commit(res.sketch), setSelection(res.ids))
      }
      return
    }
    if (e.key === 'Delete' || e.key === 'Backspace') return done(), commit(remove(sketch, selection)), setSelection([])
    if (mod && k === 'd') {
      done()
      const res = duplicate(sketch, selection, PRESETS[sketch.preset].grid * 4)
      return commit(res.sketch), setSelection(res.ids)
    }
    if (mod && k === 'c') return done(), void (clip.current = copy(sketch, selection))
    if (mod && k === 'x') return done(), void (clip.current = copy(sketch, selection)), commit(remove(sketch, selection)), setSelection([])
    if (mod && k === 'v') {
      done()
      const res = paste(sketch, clip.current, PRESETS[sketch.preset].grid * 4)
      return res.ids.length ? (commit(res.sketch), setSelection(res.ids)) : undefined
    }
    if (e.key === ']' || e.key === '[') {
      done()
      let next = sketch
      for (const id of selection) next = reorder(next, id, e.key === ']' ? (mod ? 'top' : 'up') : mod ? 'bottom' : 'down')
      return commit(next)
    }
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
    if (arrows[e.key]) {
      done()
      const step = e.shiftKey ? Math.max(2, PRESETS[sketch.preset].grid * 4) : 1
      const [dx, dy] = arrows[e.key]
      commit(settle(move(sketch, selection, dx * step, dy * step), selection), `nudge:${selection.join()}`)
    }
  }

  const zoomBy = (f: number) => {
    const el = canvasBox.current
    if (!view || !el) return
    const cx = el.clientWidth / 2
    const cy = el.clientHeight / 2
    const z = Math.max(0.05, Math.min(40, view.zoom * f))
    setView({ zoom: z, x: cx - ((cx - view.x) / view.zoom) * z, y: cy - ((cy - view.y) / view.zoom) * z })
  }
  const fit = () => sketch && canvasBox.current && setView(fitView(sketch, canvasBox.current.clientWidth, canvasBox.current.clientHeight))

  const mockup = useMemo(() => {
    if (!sketch || tab !== 'mockup') return ''
    const p = PRESETS[sketch.preset]
    return `data:image/png;base64,${toPng(drawSketch(sketch, p.style), sketch.canvas.w, sketch.canvas.h, p.scale)}`
  }, [sketch, tab])

  if (!sketch) return <div className="p-6 text-sm text-indigo-300/70">Opening the sketcher...</div>
  const preset = PRESETS[sketch.preset]
  const dirty = JSON.stringify(sketch) !== savedJson

  return (
    <div ref={root} tabIndex={0} onKeyDown={key} className="flex h-full flex-col outline-none" data-testid="sketcher">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-white/10 px-3 py-1.5">
        <input
          value={sketch.name}
          onChange={(e) => commit({ ...sketch, name: e.target.value.slice(0, 80) }, 'name')}
          onBlur={(e) => !e.target.value.trim() && commit({ ...sketch, name: 'Untitled' })}
          className="field !w-36 !py-1 !text-xs font-semibold"
          title="Sketch name (also its folder under .multimine/sketches)"
          data-testid="sk-name"
        />
        <span className="rounded-md border border-white/10 px-1.5 py-0.5 text-[10.5px] text-indigo-300/80">{preset.label}</span>
        <div className="relative">
          <button className="btn btn-ghost !px-2 !py-1" title="New sketch" onClick={() => setMenu(menu === 'new' ? null : 'new')} data-testid="sk-new">
            <FilePlus size={14} />
          </button>
          {menu === 'new' && <NewMenu onPick={(name, p) => (setSketch(newSketch(name, p)), history.current.clear(), setSavedJson(''), setSelection([]), setView(null), setMenu(null), bump((n) => n + 1))} onClose={() => setMenu(null)} />}
        </div>
        <div className="relative">
          <button className="btn btn-ghost !px-2 !py-1" title="Open a saved sketch" onClick={() => setMenu(menu === 'open' ? null : 'open')} data-testid="sk-open">
            <FolderOpen size={14} />
          </button>
          {menu === 'open' && (
            <OpenMenu
              call={call}
              onPick={(sk) => (setSketch(sk), setSavedJson(JSON.stringify(sk)), history.current.clear(), setSelection([]), setView(null), setMenu(null), void call('storage.set', 'last', slug(sk.name)))}
              onClose={() => setMenu(null)}
            />
          )}
        </div>
        <div className="mx-1 h-5 w-px bg-white/10" />
        <button className="btn btn-ghost !px-2 !py-1" title="Undo (Ctrl+Z)" disabled={!history.current.canUndo} onClick={undo} data-testid="sk-undo">
          <Undo2 size={14} />
        </button>
        <button className="btn btn-ghost !px-2 !py-1" title="Redo (Ctrl+Shift+Z)" disabled={!history.current.canRedo} onClick={redo}>
          <Redo2 size={14} />
        </button>
        <div className="mx-1 h-5 w-px bg-white/10" />
        <div className="flex rounded-lg border border-white/10 p-0.5 text-[11px]">
          {(['wireframe', 'styled'] as const).map((m) => (
            <button key={m} onClick={() => setStyled(m === 'styled')} className={`rounded-md px-2 py-0.5 ${styled === (m === 'styled') ? 'bg-violet-500/40 text-white' : 'text-indigo-300/80'}`} data-testid={`sk-look-${m}`}>
              {m === 'wireframe' ? 'Wireframe' : preset.style === 'minecraft' ? 'Minecraft' : 'Styled'}
            </button>
          ))}
        </div>
        <button className={`btn btn-ghost !px-2 !py-1 ${showGrid ? 'text-violet-300' : ''}`} title={`Grid (${preset.grid} ${preset.units})`} onClick={() => setShowGrid(!showGrid)}>
          <Grid3x3 size={14} />
        </button>
        <button className="btn btn-ghost !px-1.5 !py-1" title="Zoom out" onClick={() => zoomBy(1 / 1.25)}>
          <ZoomOut size={14} />
        </button>
        <span className="w-10 text-center font-mono text-[10.5px] text-indigo-300/80">{view ? `${Math.round((view.zoom / preset.scale) * 100)}%` : ''}</span>
        <button className="btn btn-ghost !px-1.5 !py-1" title="Zoom in" onClick={() => zoomBy(1.25)}>
          <ZoomIn size={14} />
        </button>
        <button className="btn btn-ghost !px-1.5 !py-1" title="Fit" onClick={fit}>
          <Maximize size={13} />
        </button>
        <div className="flex-1" />
        <div className="flex rounded-lg border border-white/10 p-0.5 text-[11px]">
          {(['design', 'mockup', 'revisions'] as Tab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`rounded-md px-2.5 py-0.5 capitalize ${tab === t ? 'bg-violet-500/40 text-white' : 'text-indigo-300/80'}`} data-testid={`sk-tab-${t}`}>
              {t}
            </button>
          ))}
        </div>
        <button className="btn !py-1" onClick={() => void save(sketch)} title="Save sketch.json, sketch.png and mockup.png (Ctrl+S)" data-testid="sk-save">
          {dirty ? <Save size={13} /> : <Check size={13} />} {dirty ? 'Save' : 'Saved'}
        </button>
        <div className="relative">
          <button className="btn btn-primary !py-1" title="Send to Mastermind to have it built" onClick={() => setMenu(menu === 'send' ? null : 'send')} data-testid="sk-send">
            <Send size={13} /> Send
          </button>
          {menu === 'send' && <SendMenu sketch={sketch} onSend={sendToMastermind} onClose={() => setMenu(null)} />}
        </div>
      </div>

      {tab === 'design' && (
        <div className="flex min-h-0 flex-1">
          <div className="scroll-thin flex w-[208px] shrink-0 flex-col gap-3 overflow-y-auto border-r border-white/10 p-2">
            <div>
              <div className="label">Elements</div>
              <Palette sketch={sketch} tool={tool} setTool={setTool} />
            </div>
            <div className="min-h-0">
              <div className="label">Layers</div>
              <Layers
                sketch={sketch}
                selection={selection}
                onSelect={(ids, additive) => setSelection(additive ? [...new Set([...selection, ...ids])] : ids)}
                onToggle={(id, field) => commit(update(sketch, id, { [field]: !byId(sketch, id)?.[field] }))}
              />
            </div>
          </div>
          <div ref={canvasBox} className="min-w-0 flex-1" onPointerDown={() => root.current?.focus()}>
            <SketchCanvas
              sketch={sketch}
              look={lookOf(sketch, styled)}
              grid={preset.grid}
              showGrid={showGrid}
              selection={selection}
              tool={tool}
              view={view}
              setView={setView}
              onSelect={setSelection}
              onBegin={(before) => (history.current.push(before), (lastEdit.current = null), bump((n) => n + 1))}
              onLive={setSketch}
              onCommitMove={(ids) => setSketch((cur) => (cur ? settle(cur, ids) : cur))}
              onDrawn={drawn}
            />
          </div>
          <div className="scroll-thin w-[236px] shrink-0 overflow-y-auto border-l border-white/10">
            <Properties
              sketch={sketch}
              selection={selection}
              onPatch={(id, patch) => commit(update(sketch, id, patch), `${id}:${Object.keys(patch).join()}`)}
              onSketch={(patch) => commit({ ...sketch, ...patch }, `sketch:${Object.keys(patch).join()}`)}
            />
          </div>
        </div>
      )}

      {tab === 'mockup' && (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-[#070816] p-4" data-testid="sk-mockup">
          <img src={mockup} alt="Mockup" className="max-h-full max-w-full object-contain shadow-2xl" style={{ imageRendering: preset.style === 'minecraft' ? 'pixelated' : 'auto' }} />
          <div className="text-[11px] text-indigo-300/70">
            {preset.style === 'minecraft' ? 'Drawn in the vanilla palette from scratch - no game textures or fonts - at GUI scale 3.' : 'A quick styled preview of the intent; the builder follows the project\'s own look.'}{' '}
            {Math.round(sketch.canvas.w * preset.scale)} x {Math.round(sketch.canvas.h * preset.scale)} px.
          </div>
        </div>
      )}

      {tab === 'revisions' && <Revisions sketch={sketch} call={call} />}
    </div>
  )
}

function Popover({ children, onClose, align = 'left' }: { children: React.ReactNode; onClose: () => void; align?: 'left' | 'right' }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose])
  return (
    <>
      <div className="fixed inset-0 z-40" onPointerDown={onClose} />
      <div className={`glass tools-pop absolute top-full z-50 mt-1.5 rounded-xl p-3 ${align === 'right' ? 'right-0' : 'left-0'}`} onKeyDown={(e) => e.stopPropagation()}>
        {children}
      </div>
    </>
  )
}

function NewMenu({ onPick, onClose }: { onPick: (name: string, p: PresetId) => void; onClose: () => void }) {
  const [name, setName] = useState('Untitled')
  return (
    <Popover onClose={onClose}>
      <div className="w-64 space-y-2" data-testid="sk-new-menu">
        <div className="label">New sketch</div>
        <input autoFocus className="field !py-1 !text-xs" value={name} onChange={(e) => setName(e.target.value.slice(0, 80))} />
        <div className="grid gap-1">
          {PRESET_IDS.map((id) => (
            <button key={id} className="flex items-center justify-between rounded-lg border border-white/10 px-2.5 py-1.5 text-left text-xs hover:border-violet-400/40 hover:bg-white/5" onClick={() => onPick(name.trim() || 'Untitled', id)} data-testid={`sk-preset-${id}`}>
              <span className="font-semibold">{PRESETS[id].label}</span>
              <span className="font-mono text-[10px] text-indigo-300/70">
                {PRESETS[id].canvas.w}x{PRESETS[id].canvas.h}
              </span>
            </button>
          ))}
        </div>
      </div>
    </Popover>
  )
}

function OpenMenu({ call, onPick, onClose }: { call: <T>(m: string, ...a: unknown[]) => Promise<T>; onPick: (sk: Sketch) => void; onClose: () => void }) {
  const [names, setNames] = useState<string[] | null>(null)
  useEffect(() => {
    void call<{ name: string; dir: boolean }[]>('files.list', SKETCH_ROOT)
      .then((l) => setNames(l.filter((e) => e.dir).map((e) => e.name)))
      .catch(() => setNames([]))
  }, [call])
  const open = async (n: string) => {
    try {
      const sk = parseSketch(JSON.parse(await call<string>('files.read', `${SKETCH_ROOT}/${n}/sketch.json`)))
      if (sk) onPick(sk)
    } catch {
      /* a folder without a readable sketch.json is skipped */
    }
  }
  return (
    <Popover onClose={onClose}>
      <div className="w-56 space-y-1" data-testid="sk-open-menu">
        <div className="label">Saved sketches</div>
        {names === null && <div className="text-xs text-indigo-300/70">Loading...</div>}
        {names?.length === 0 && <div className="text-xs text-indigo-300/70">None saved in this project yet.</div>}
        {names?.map((n) => (
          <button key={n} className="block w-full truncate rounded-md px-2 py-1 text-left text-xs hover:bg-white/10" onClick={() => void open(n)}>
            {n}
          </button>
        ))}
      </div>
    </Popover>
  )
}

function SendMenu({ sketch, onSend, onClose }: { sketch: Sketch; onSend: (note: string) => Promise<void>; onClose: () => void }) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Popover onClose={onClose} align="right">
      <div className="w-80 space-y-2" data-testid="sk-send-menu">
        <div className="text-xs leading-relaxed text-indigo-200/90">
          Saves <span className="font-mono text-[11px]">{sketchDir(sketch.name)}/</span> and asks Mastermind to have a UI Creator build it, capture the real screen and show it in the gallery.
        </div>
        <textarea autoFocus className="field min-h-[70px] !text-xs" placeholder="Anything to add? Where it opens from, what it is for..." value={note} onChange={(e) => setNote(e.target.value)} data-testid="sk-send-note" />
        <div className="flex justify-end">
          <button className="btn btn-primary !py-1" disabled={busy} onClick={() => (setBusy(true), void onSend(note).finally(() => setBusy(false)))} data-testid="sk-send-go">
            <Send size={13} /> {busy ? 'Sending...' : 'Send'}
          </button>
        </div>
      </div>
    </Popover>
  )
}
