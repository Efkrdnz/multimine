import { drawOrder, TYPE_LABEL, type Sketch, type SketchElement } from './model'
import { PRESETS, type SketchStyle } from './presets'

/**
 * A sketch as a flat list of drawing operations in canvas units. The editor turns them into SVG, the
 * exporter paints them onto a canvas for `sketch.png` and `mockup.png`; one list means the picture an
 * agent is sent is exactly the picture the user drew. Every look is procedural: no game textures or
 * fonts are shipped or copied.
 */
export type Op =
  | { k: 'rect'; el?: string; x: number; y: number; w: number; h: number; fill?: string; stroke?: string; lw?: number; r?: number; dash?: number }
  | { k: 'line'; el?: string; x1: number; y1: number; x2: number; y2: number; color: string; lw: number; dash?: number }
  | { k: 'text'; el?: string; x: number; y: number; text: string; color: string; size: number; align: 'left' | 'center'; bold?: boolean; mono?: boolean; shadow?: string; maxW?: number }
  | { k: 'grad'; x: number; y: number; w: number; h: number; from: string; to: string }

export type Look = 'wireframe' | SketchStyle

export function lookOf(sk: Sketch, styled: boolean): Look {
  return styled ? PRESETS[sk.preset].style : 'wireframe'
}

export function drawSketch(sk: Sketch, look: Look): Op[] {
  const ops: Op[] = []
  background(ops, sk, look)
  for (const e of drawOrder(sk)) {
    if (e.hidden || hiddenByParent(sk, e)) continue
    if (look === 'wireframe') wire(ops, e)
    else if (look === 'minecraft') minecraft(ops, e)
    else flat(ops, e, look)
  }
  return ops
}

function hiddenByParent(sk: Sketch, e: SketchElement): boolean {
  for (let p = e.parent; p; ) {
    const pe = sk.elements.find((x) => x.id === p)
    if (!pe) return false
    if (pe.hidden) return true
    p = pe.parent
  }
  return false
}

function background(ops: Op[], sk: Sketch, look: Look) {
  const { w, h } = sk.canvas
  if (look === 'wireframe') ops.push({ k: 'rect', x: 0, y: 0, w, h, fill: '#fbfbfd' })
  // the dimmed world vanilla draws behind a container screen
  else if (look === 'minecraft') ops.push({ k: 'grad', x: 0, y: 0, w, h, from: '#2a2f45', to: '#11131c' }, { k: 'rect', x: 0, y: 0, w, h, fill: 'rgba(16,16,16,0.55)' })
  else if (look === 'web') ops.push({ k: 'rect', x: 0, y: 0, w, h, fill: '#f4f5f9' })
  else ops.push({ k: 'rect', x: 0, y: 0, w, h, fill: '#e9ebf0' })
}

/** Slot grid cells: the grid's size divided evenly, so a resized grid keeps its counts. */
export function cells(e: SketchElement): { x: number; y: number; w: number; h: number }[] {
  const cols = Math.max(1, e.cols ?? 1)
  const rows = Math.max(1, e.rows ?? 1)
  const cw = e.w / cols
  const ch = e.h / rows
  const out = []
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.push({ x: e.x + c * cw, y: e.y + r * ch, w: cw, h: ch })
  return out
}

// ---- wireframe: what the editor shows by default and what sketch.png is ----

const WIRE = '#475569'
const WIRE_FILL: Partial<Record<SketchElement['type'], string>> = {
  window: '#ffffff',
  panel: '#f1f5f9',
  button: '#e0e7ff',
  textfield: '#ffffff',
  slot: '#e2e8f0',
  image: '#f1f5f9',
  list: '#ffffff',
  tooltip: '#1e293b'
}

function wire(ops: Op[], e: SketchElement) {
  const el = e.id
  const small = Math.max(6, Math.min(12, e.h * 0.55))
  const fill = WIRE_FILL[e.type]
  switch (e.type) {
    case 'group':
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: e.h, stroke: '#94a3b8', lw: 1, dash: 3 })
      ops.push({ k: 'text', el, x: e.x + 2, y: e.y + 2, text: e.name, color: '#64748b', size: 6, align: 'left' })
      return
    case 'label':
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: e.h, stroke: '#cbd5e1', lw: 0.5, dash: 2 })
      ops.push({ k: 'text', el, x: e.x + 1, y: e.y + (e.h - small) / 2, text: e.text || e.name, color: '#0f172a', size: small, align: 'left', maxW: e.w - 2 })
      return
    case 'slotgrid':
      for (const c of cells(e)) ops.push({ k: 'rect', el, x: c.x + 0.5, y: c.y + 0.5, w: c.w - 1, h: c.h - 1, fill: WIRE_FILL.slot, stroke: WIRE, lw: 0.75 })
      return
    case 'image':
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: e.h, fill, stroke: WIRE, lw: 1 })
      ops.push({ k: 'line', el, x1: e.x, y1: e.y, x2: e.x + e.w, y2: e.y + e.h, color: '#94a3b8', lw: 0.75 })
      ops.push({ k: 'line', el, x1: e.x + e.w, y1: e.y, x2: e.x, y2: e.y + e.h, color: '#94a3b8', lw: 0.75 })
      return
    case 'slider': {
      const v = e.value ?? 0.5
      ops.push({ k: 'rect', el, x: e.x, y: e.y + e.h / 2 - 1, w: e.w, h: 2, fill: '#94a3b8' })
      const kw = Math.max(4, Math.min(e.h, 10))
      ops.push({ k: 'rect', el, x: e.x + (e.w - kw) * v, y: e.y, w: kw, h: e.h, fill: '#e0e7ff', stroke: WIRE, lw: 1, r: 1 })
      return
    }
    case 'progress': {
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: e.h, fill: '#ffffff', stroke: WIRE, lw: 1 })
      ops.push({ k: 'rect', el, x: e.x + 1, y: e.y + 1, w: Math.max(0, (e.w - 2) * (e.value ?? 0.5)), h: e.h - 2, fill: '#a5b4fc' })
      return
    }
    case 'checkbox': {
      const s = Math.min(e.h, 12)
      ops.push({ k: 'rect', el, x: e.x, y: e.y + (e.h - s) / 2, w: s, h: s, fill: '#ffffff', stroke: WIRE, lw: 1 })
      if (e.states.includes('selected')) ops.push({ k: 'line', el, x1: e.x + 2, y1: e.y + e.h / 2, x2: e.x + s - 2, y2: e.y + (e.h - s) / 2 + 2, color: WIRE, lw: 1.5 })
      ops.push({ k: 'text', el, x: e.x + s + 3, y: e.y + (e.h - small) / 2, text: e.text ?? '', color: '#0f172a', size: Math.min(small, 9), align: 'left', maxW: e.w - s - 3 })
      return
    }
    case 'list': {
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: e.h, fill, stroke: WIRE, lw: 1 })
      const row = Math.max(10, Math.min(24, e.h / 5))
      for (let y = e.y + row; y < e.y + e.h - 1; y += row) ops.push({ k: 'line', el, x1: e.x + 2, y1: y, x2: e.x + e.w - 2, y2: y, color: '#e2e8f0', lw: 0.75 })
      return
    }
    default: {
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: e.h, fill, stroke: WIRE, lw: e.type === 'window' ? 1.5 : 1, r: e.type === 'button' || e.type === 'tooltip' ? 2 : 0 })
      const color = e.type === 'tooltip' ? '#f8fafc' : '#0f172a'
      if (e.type === 'window') {
        if (e.text) ops.push({ k: 'text', el, x: e.x + 4, y: e.y + 3, text: e.text, color: '#334155', size: 7, align: 'left', bold: true, maxW: e.w - 8 })
      }
      else if (e.type === 'textfield') ops.push({ k: 'text', el, x: e.x + 3, y: e.y + (e.h - small) / 2, text: e.text || 'text...', color: e.text ? '#0f172a' : '#94a3b8', size: Math.min(small, 9), align: 'left', maxW: e.w - 6 })
      else if (e.text !== undefined) ops.push({ k: 'text', el, x: e.x + e.w / 2, y: e.y + (e.h - small) / 2, text: e.text, color, size: Math.min(small, 9), align: 'center', maxW: e.w - 4 })
      else if (e.type === 'panel' || e.type === 'slot') {
        if (e.w > 24 && e.h > 10) ops.push({ k: 'text', el, x: e.x + 2, y: e.y + 2, text: e.type === 'slot' ? '' : e.name, color: '#94a3b8', size: 6, align: 'left' })
      }
    }
  }
}

// ---- Minecraft: bevelled grey, inset slots, the vanilla palette; drawn, not copied ----

const MC = { bg: '#c6c6c6', light: '#ffffff', dark: '#555555', slot: '#8b8b8b', slotDark: '#373737', btn: '#6f6f6f', btnLight: '#a8a8a8', btnDark: '#4a4a4a', text: '#404040' }

/** A raised or inset box: highlight on two sides, shadow on the other two. */
function bevel(ops: Op[], el: string, x: number, y: number, w: number, h: number, fill: string, tl: string, br: string, t: number) {
  ops.push({ k: 'rect', el, x, y, w, h, fill })
  ops.push({ k: 'rect', el, x, y, w, h: t, fill: tl }, { k: 'rect', el, x, y, w: t, h, fill: tl })
  ops.push({ k: 'rect', el, x, y: y + h - t, w, h: t, fill: br }, { k: 'rect', el, x: x + w - t, y, w: t, h, fill: br })
}

function mcButton(ops: Op[], el: string, x: number, y: number, w: number, h: number, disabled: boolean) {
  ops.push({ k: 'rect', el, x, y, w, h, fill: '#000000' })
  bevel(ops, el, x + 1, y + 1, w - 2, h - 2, disabled ? '#2c2c2c' : MC.btn, disabled ? '#2c2c2c' : MC.btnLight, disabled ? '#2c2c2c' : MC.btnDark, 1)
}

function minecraft(ops: Op[], e: SketchElement) {
  const el = e.id
  const disabled = e.states.includes('disabled')
  const t = (x: number, y: number, text: string, color: string, align: 'left' | 'center', shadow?: string, maxW?: number) =>
    ops.push({ k: 'text', el, x, y, text, color, size: 8, align, mono: true, shadow, maxW })
  switch (e.type) {
    case 'window':
      // a one-pixel black rim with its corners cut, then the raised grey body
      ops.push({ k: 'rect', el, x: e.x + 1, y: e.y, w: e.w - 2, h: e.h, fill: '#000000' }, { k: 'rect', el, x: e.x, y: e.y + 1, w: e.w, h: e.h - 2, fill: '#000000' })
      bevel(ops, el, e.x + 1, e.y + 1, e.w - 2, e.h - 2, MC.bg, MC.light, MC.dark, 2)
      return
    case 'panel':
      bevel(ops, el, e.x, e.y, e.w, e.h, MC.slot, MC.slotDark, MC.light, 1)
      return
    case 'group':
      return
    case 'slot':
      bevel(ops, el, e.x, e.y, e.w, e.h, MC.slot, MC.slotDark, MC.light, 1)
      return
    case 'slotgrid':
      for (const c of cells(e)) bevel(ops, el, c.x, c.y, c.w, c.h, MC.slot, MC.slotDark, MC.light, 1)
      return
    case 'label':
      t(e.x, e.y + (e.h - 8) / 2, e.text || e.name, MC.text, 'left', undefined, e.w)
      return
    case 'button':
      mcButton(ops, el, e.x, e.y, e.w, e.h, disabled)
      t(e.x + e.w / 2, e.y + (e.h - 8) / 2, e.text ?? '', disabled ? '#a0a0a0' : '#ffffff', 'center', disabled ? undefined : '#3f3f3f', e.w - 4)
      return
    case 'textfield':
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: e.h, fill: '#a0a0a0' }, { k: 'rect', el, x: e.x + 1, y: e.y + 1, w: e.w - 2, h: e.h - 2, fill: '#000000' })
      t(e.x + 4, e.y + (e.h - 8) / 2, `${e.text ?? ''}_`, '#e0e0e0', 'left', '#383838', e.w - 8)
      return
    case 'image': {
      const s = Math.max(2, Math.round(Math.min(e.w, e.h) / 4))
      for (let y = 0; y < e.h; y += s)
        for (let x = 0; x < e.w; x += s) ops.push({ k: 'rect', el, x: e.x + x, y: e.y + y, w: Math.min(s, e.w - x), h: Math.min(s, e.h - y), fill: ((x + y) / s) % 2 ? '#7a5c3a' : '#9b7653' })
      return
    }
    case 'list': {
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: e.h, fill: '#000000' })
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: 1, fill: '#5a5a5a' }, { k: 'rect', el, x: e.x, y: e.y + e.h - 1, w: e.w, h: 1, fill: '#5a5a5a' })
      const row = 12
      let n = 1
      for (let y = e.y + 3; y + 9 <= e.y + e.h; y += row) t(e.x + 4, y + 1, `Entry ${n++}`, '#ffffff', 'left', '#3f3f3f', e.w - 8)
      return
    }
    case 'slider': {
      const v = e.value ?? 0.5
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: e.h, fill: '#000000' })
      bevel(ops, el, e.x + 1, e.y + 1, e.w - 2, e.h - 2, '#3a3a3a', '#2a2a2a', '#4a4a4a', 1)
      mcButton(ops, el, e.x + (e.w - 8) * v, e.y, 8, e.h, false)
      t(e.x + e.w / 2, e.y + (e.h - 8) / 2, e.text || `${Math.round(v * 100)}%`, '#ffffff', 'center', '#3f3f3f', e.w - 4)
      return
    }
    case 'checkbox': {
      const s = Math.min(e.h, 20)
      mcButton(ops, el, e.x, e.y, s, s, disabled)
      if (e.states.includes('selected')) t(e.x + s / 2, e.y + (s - 8) / 2, 'x', '#ffffff', 'center', '#3f3f3f')
      t(e.x + s + 4, e.y + (e.h - 8) / 2, e.text ?? '', MC.text, 'left', undefined, e.w - s - 4)
      return
    }
    case 'progress': {
      const v = e.value ?? 0.5
      bevel(ops, el, e.x, e.y, e.w, e.h, MC.slot, MC.slotDark, MC.light, 1)
      ops.push({ k: 'rect', el, x: e.x + 1, y: e.y + 1, w: Math.max(0, (e.w - 2) * v), h: e.h - 2, fill: '#f0f0f0' })
      return
    }
    case 'tooltip':
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: e.h, fill: 'rgba(16,0,16,0.94)' })
      ops.push({ k: 'rect', el, x: e.x + 1, y: e.y + 1, w: e.w - 2, h: e.h - 2, stroke: '#5000ff', lw: 1 })
      t(e.x + 4, e.y + 4, e.text ?? '', '#ffffff', 'left', '#3f3f3f', e.w - 8)
      return
  }
}

// ---- web and desktop: flat cards, an accent colour, system type ----

function flat(ops: Op[], e: SketchElement, look: 'web' | 'desktop') {
  const el = e.id
  const accent = look === 'web' ? '#4f46e5' : '#2563eb'
  const disabled = e.states.includes('disabled')
  const text = (x: number, y: number, s: string, color: string, size: number, align: 'left' | 'center', bold?: boolean, maxW?: number) =>
    ops.push({ k: 'text', el, x, y, text: s, color, size, align, bold, maxW })
  switch (e.type) {
    case 'window': {
      ops.push({ k: 'rect', el, x: e.x + 2, y: e.y + 6, w: e.w, h: e.h, fill: 'rgba(15,23,42,0.08)', r: 12 })
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: e.h, fill: '#ffffff', stroke: '#e5e7eb', lw: 1, r: look === 'web' ? 12 : 8 })
      if (look === 'desktop') {
        ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: 32, fill: '#f3f4f6', r: 8 }, { k: 'rect', el, x: e.x, y: e.y + 31, w: e.w, h: 1, fill: '#e5e7eb' })
        for (const [i, c] of ['#ef4444', '#f59e0b', '#22c55e'].entries()) ops.push({ k: 'rect', el, x: e.x + 12 + i * 18, y: e.y + 10, w: 12, h: 12, fill: c, r: 6 })
        text(e.x + e.w / 2, e.y + 9, e.text || e.name, '#374151', 13, 'center', true, e.w - 120)
      } else if (e.text) text(e.x + 24, e.y + 20, e.text, '#111827', 20, 'left', true, e.w - 48)
      return
    }
    case 'panel':
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: e.h, fill: '#ffffff', stroke: '#e5e7eb', lw: 1, r: 8 })
      return
    case 'group':
      return
    case 'label':
      text(e.x, e.y + (e.h - 14) / 2, e.text || e.name, '#1f2937', 14, 'left', false, e.w)
      return
    case 'button':
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: e.h, fill: disabled ? '#c7c9d1' : look === 'web' ? accent : '#ffffff', stroke: look === 'web' ? undefined : '#d1d5db', lw: 1, r: 8 })
      text(e.x + e.w / 2, e.y + (e.h - 14) / 2, e.text ?? '', look === 'web' || disabled ? '#ffffff' : '#111827', 14, 'center', true, e.w - 8)
      return
    case 'textfield':
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: e.h, fill: '#ffffff', stroke: e.states.includes('focused') ? accent : '#d1d5db', lw: e.states.includes('focused') ? 2 : 1, r: 6 })
      text(e.x + 12, e.y + (e.h - 14) / 2, e.text || 'Type here', e.text ? '#111827' : '#9ca3af', 14, 'left', false, e.w - 24)
      return
    case 'slot':
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: e.h, fill: '#f3f4f6', stroke: '#e5e7eb', lw: 1, r: 6 })
      return
    case 'slotgrid':
      for (const c of cells(e)) ops.push({ k: 'rect', el, x: c.x + 2, y: c.y + 2, w: c.w - 4, h: c.h - 4, fill: '#f3f4f6', stroke: '#e5e7eb', lw: 1, r: 6 })
      return
    case 'image':
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: e.h, fill: '#e5e7eb', r: 8 })
      ops.push({ k: 'line', el, x1: e.x + e.w * 0.2, y1: e.y + e.h * 0.75, x2: e.x + e.w * 0.45, y2: e.y + e.h * 0.45, color: '#9ca3af', lw: 2 })
      ops.push({ k: 'line', el, x1: e.x + e.w * 0.45, y1: e.y + e.h * 0.45, x2: e.x + e.w * 0.6, y2: e.y + e.h * 0.62, color: '#9ca3af', lw: 2 })
      ops.push({ k: 'line', el, x1: e.x + e.w * 0.6, y1: e.y + e.h * 0.62, x2: e.x + e.w * 0.8, y2: e.y + e.h * 0.4, color: '#9ca3af', lw: 2 })
      return
    case 'list': {
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: e.h, fill: '#ffffff', stroke: '#e5e7eb', lw: 1, r: 8 })
      const row = 44
      let n = 1
      for (let y = e.y; y + row <= e.y + e.h; y += row) {
        text(e.x + 16, y + 14, `Item ${n++}`, '#374151', 14, 'left', false, e.w - 32)
        if (y + row < e.y + e.h - 1) ops.push({ k: 'line', el, x1: e.x + 12, y1: y + row, x2: e.x + e.w - 12, y2: y + row, color: '#f1f5f9', lw: 1 })
      }
      return
    }
    case 'slider': {
      const v = e.value ?? 0.5
      ops.push({ k: 'rect', el, x: e.x, y: e.y + e.h / 2 - 2, w: e.w, h: 4, fill: '#e5e7eb', r: 2 })
      ops.push({ k: 'rect', el, x: e.x, y: e.y + e.h / 2 - 2, w: e.w * v, h: 4, fill: accent, r: 2 })
      ops.push({ k: 'rect', el, x: e.x + e.w * v - 9, y: e.y + e.h / 2 - 9, w: 18, h: 18, fill: '#ffffff', stroke: accent, lw: 2, r: 9 })
      return
    }
    case 'checkbox': {
      const s = 18
      const on = e.states.includes('selected')
      ops.push({ k: 'rect', el, x: e.x, y: e.y + (e.h - s) / 2, w: s, h: s, fill: on ? accent : '#ffffff', stroke: on ? accent : '#9ca3af', lw: 1.5, r: 4 })
      if (on) ops.push({ k: 'line', el, x1: e.x + 4, y1: e.y + e.h / 2, x2: e.x + s - 4, y2: e.y + e.h / 2 - 4, color: '#ffffff', lw: 2 })
      text(e.x + s + 8, e.y + (e.h - 14) / 2, e.text ?? '', '#1f2937', 14, 'left', false, e.w - s - 8)
      return
    }
    case 'progress':
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: e.h, fill: '#e5e7eb', r: e.h / 2 })
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w * (e.value ?? 0.5), h: e.h, fill: accent, r: e.h / 2 })
      return
    case 'tooltip':
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: e.h, fill: '#111827', r: 6 })
      text(e.x + 10, e.y + (e.h - 12) / 2, e.text ?? '', '#f9fafb', 12, 'left', false, e.w - 20)
      return
  }
}

/** The label the layers panel shows when an element has not been named. */
export const displayName = (e: SketchElement): string => (e.name && e.name !== TYPE_LABEL[e.type] ? e.name : e.text ? `${TYPE_LABEL[e.type]} "${e.text}"` : TYPE_LABEL[e.type])
