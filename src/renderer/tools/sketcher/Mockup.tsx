import { useMemo, useState } from 'react'
import { drawSketch } from '@shared/sketch/draw'
import { layoutAt, type Sketch } from '@shared/sketch/model'
import { logicalSize, TARGETS, type Screen } from '@shared/sketch/targets'
import { toPng } from './paint'

const THUMB_W = 240

/**
 * The styled mockup, and the same sketch on every screen the target is played or used on, laid out
 * the way that engine resolves anchors - so a HUD that only holds at 1920x1080 shows it here, before
 * anyone has built it.
 */
export function Mockup({ sketch }: { sketch: Sketch }) {
  const t = TARGETS[sketch.target]
  const [pick, setPick] = useState(0)
  const screens = t.screens
  const renders = useMemo(
    () =>
      screens.map((s) => {
        const l = logicalSize(t, s)
        const laid = layoutAt(sketch, l.w, l.h)
        return { s, l, thumb: `data:image/png;base64,${toPng(drawSketch(laid, t.style), l.w, l.h, THUMB_W / l.w)}`, laid }
      }),
    [sketch, t, screens]
  )
  const cur = renders[Math.min(pick, renders.length - 1)]
  const big = useMemo(() => {
    if (!cur) return ''
    // the device's own pixels, capped so a 3440-wide screen stays cheap to draw
    const scale = Math.min(cur.l.scale, 1600 / cur.l.w)
    return `data:image/png;base64,${toPng(drawSketch(cur.laid, t.style), cur.l.w, cur.l.h, scale)}`
  }, [cur, t.style])

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#070816]" data-testid="sk-mockup">
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4">
        <img src={big} alt="Mockup" className="max-h-full max-w-full object-contain shadow-2xl" style={{ imageRendering: t.style === 'minecraft' ? 'pixelated' : 'auto' }} />
        <div className="text-[11px] text-indigo-300/70">{caption(t.uiScale, cur.s, cur.l)}</div>
      </div>
      <div className="scroll-thin flex shrink-0 gap-3 overflow-x-auto border-t border-white/10 p-3" data-testid="sk-sizes">
        {renders.map((r, i) => (
          <button key={r.s.label} onClick={() => setPick(i)} className={`shrink-0 overflow-hidden rounded-lg border text-left transition ${i === pick ? 'border-violet-400/70' : 'border-white/10 hover:border-white/30'}`} data-testid="sk-size">
            <img src={r.thumb} alt={r.s.label} style={{ width: THUMB_W * Math.min(1, 135 / ((THUMB_W * r.l.h) / r.l.w)), imageRendering: t.style === 'minecraft' ? 'pixelated' : 'auto' }} className="block" />
            <div className="flex justify-between gap-2 px-2 py-1 text-[10.5px]">
              <span className="font-semibold text-indigo-100">{r.s.label}</span>
              <span className="font-mono text-indigo-300/70">
                {r.s.w}x{r.s.h}
              </span>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

function caption(mode: string, s: Screen, l: { w: number; h: number; scale: number }): string {
  if (mode === 'minecraft') return `${s.w} x ${s.h} at GUI scale ${l.scale}: ${l.w} x ${l.h} GUI px. Drawn in the vanilla palette from scratch - no game textures or fonts.`
  if (mode === 'fit') return `${s.w} x ${s.h}: the UI scaled by ${l.scale.toFixed(2)} and laid out on ${l.w} x ${l.h}, as the engine's anchors place it. A stand-in look, not the game's art.`
  return `${s.w} x ${s.h}: laid out by the anchors. A quick styled preview; the builder follows the project's own look.`
}
