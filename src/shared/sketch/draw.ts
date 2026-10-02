import { drawOrder, TYPE_LABEL, type Sketch, type SketchElement } from './model'
import { TARGETS, type SketchStyle } from './targets'

/**
 * A sketch as a flat list of drawing operations in canvas units. The editor turns them into SVG, the
 * exporter paints them onto a canvas for `sketch.png` and `mockup.png`; one list means the picture an
 * agent is sent is exactly the picture the user drew. Every look is procedural: no game textures or
 * fonts are shipped or copied.
 */
export type Op =
  | { k: 'rect'; el?: string; x: number; y: number; w: number; h: number; fill?: string; stroke?: string; lw?: number; r?: number; dash?: number }
  | { k: 'line'; el?: string; x1: number; y1: number; x2: number; y2: number; color: string; lw: number; dash?: number }
  | { k: 'circle'; el?: string; cx: number; cy: number; r: number; fill?: string; stroke?: string; lw?: number }
  /** A filled sector from `from` to `to`, in turns clockwise from twelve o'clock (a cooldown sweep). */
  | { k: 'pie'; el?: string; cx: number; cy: number; r: number; from: number; to: number; fill: string }
  | { k: 'text'; el?: string; x: number; y: number; text: string; color: string; size: number; align: 'left' | 'center'; bold?: boolean; mono?: boolean; shadow?: string; maxW?: number }
  | { k: 'grad'; x: number; y: number; w: number; h: number; from: string; to: string }

export type Look = 'wireframe' | SketchStyle

export const STYLE_LABEL: Record<SketchStyle, string> = { game: 'Game', minecraft: 'Minecraft', web: 'Styled', desktop: 'Styled' }

export function lookOf(sk: Sketch, styled: boolean): Look {
  return styled ? TARGETS[sk.target].style : 'wireframe'
}

/** How big one "small" thing is on this canvas: 1 on a 240-high Minecraft GUI, 4.5 on a 1080p screen. */
const unitOf = (sk: Sketch) => Math.max(1, Math.min(4.5, sk.canvas.h / 240))

export function drawSketch(sk: Sketch, look: Look): Op[] {
  const ops: Op[] = []
  const u = unitOf(sk)
  background(ops, sk, look)
  for (const e of drawOrder(sk)) {
    if (e.hidden || hiddenByParent(sk, e)) continue
    // a modal dims everything drawn before it
    if (e.type === 'modal') ops.push({ k: 'rect', el: e.id, x: 0, y: 0, w: sk.canvas.w, h: sk.canvas.h, fill: look === 'wireframe' ? 'rgba(15,23,42,0.06)' : 'rgba(0,0,0,0.45)' })
    if (look === 'wireframe') wire(ops, e, u)
    else if (look === 'minecraft') minecraft(ops, e)
    else if (look === 'game') game(ops, e)
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
  // a stand-in for the game behind the HUD: sky over ground
  else if (look === 'game') ops.push({ k: 'grad', x: 0, y: 0, w, h: h * 0.62, from: '#3b6b96', to: '#a9c3d6' }, { k: 'grad', x: 0, y: h * 0.62, w, h: h * 0.38, from: '#4d6b3c', to: '#2b3d22' })
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

/** Tabs are written as a comma-separated list in the text. */
export const tabNames = (e: SketchElement): string[] =>
  (e.text ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

/** A dialogue's text is `speaker|line`. */
export function dialogueParts(e: SketchElement): { speaker: string; line: string } {
  const t = e.text ?? ''
  const i = t.indexOf('|')
  return i < 0 ? { speaker: '', line: t } : { speaker: t.slice(0, i).trim(), line: t.slice(i + 1).trim() }
}

/** Splits text into lines that fit `maxW` at `size`, by an average glyph width (good enough for a mockup). */
export function wrap(text: string, maxW: number, size: number, maxLines: number): string[] {
  const per = Math.max(1, Math.floor(maxW / (size * 0.55)))
  const lines: string[] = []
  let cur = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = cur ? `${cur} ${word}` : word
    if (next.length <= per) cur = next
    else {
      if (cur) lines.push(cur)
      cur = word.length > per ? `${word.slice(0, per - 1)}-` : word
    }
    if (lines.length >= maxLines) break
  }
  if (cur && lines.length < maxLines) lines.push(cur)
  return lines.slice(0, maxLines)
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

/** A chevron pointing down, centred on (cx, cy). */
function chevron(ops: Op[], el: string, cx: number, cy: number, s: number, color: string, lw: number) {
  ops.push({ k: 'line', el, x1: cx - s, y1: cy - s / 2, x2: cx, y2: cy + s / 2, color, lw }, { k: 'line', el, x1: cx, y1: cy + s / 2, x2: cx + s, y2: cy - s / 2, color, lw })
}

/** Four arms and a dot, filling the box. */
function cross(ops: Op[], el: string, b: { x: number; y: number; w: number; h: number }, color: string, lw: number, outline?: string) {
  const cx = b.x + b.w / 2
  const cy = b.y + b.h / 2
  const r = Math.min(b.w, b.h) / 2
  const g = r * 0.3
  const arms = [
    [cx, cy - r, cx, cy - g],
    [cx, cy + g, cx, cy + r],
    [cx - r, cy, cx - g, cy],
    [cx + g, cy, cx + r, cy]
  ]
  if (outline) for (const [x1, y1, x2, y2] of arms) ops.push({ k: 'line', el, x1, y1, x2, y2, color: outline, lw: lw * 2.2 })
  for (const [x1, y1, x2, y2] of arms) ops.push({ k: 'line', el, x1, y1, x2, y2, color, lw })
  ops.push({ k: 'circle', el, cx, cy, r: lw * 0.8, fill: color })
}

/** An X closing a window, filling the box. */
function closeX(ops: Op[], el: string, b: { x: number; y: number; w: number; h: number }, color: string, lw: number) {
  ops.push({ k: 'line', el, x1: b.x, y1: b.y, x2: b.x + b.w, y2: b.y + b.h, color, lw }, { k: 'line', el, x1: b.x + b.w, y1: b.y, x2: b.x, y2: b.y + b.h, color, lw })
}

/** A minimap's player arrow pointing up. */
function arrow(ops: Op[], el: string, cx: number, cy: number, s: number, color: string, lw: number) {
  ops.push({ k: 'line', el, x1: cx, y1: cy - s, x2: cx - s * 0.7, y2: cy + s * 0.7, color, lw }, { k: 'line', el, x1: cx, y1: cy - s, x2: cx + s * 0.7, y2: cy + s * 0.7, color, lw })
  ops.push({ k: 'line', el, x1: cx - s * 0.7, y1: cy + s * 0.7, x2: cx, y2: cy + s * 0.3, color, lw }, { k: 'line', el, x1: cx + s * 0.7, y1: cy + s * 0.7, x2: cx, y2: cy + s * 0.3, color, lw })
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
  tooltip: '#1e293b',
  modal: '#ffffff',
  dropdown: '#ffffff',
  icon: '#e2e8f0',
  ability: '#e2e8f0',
  dialogue: '#ffffff',
  toast: '#1e293b',
  minimap: '#e2e8f0'
}

function wire(ops: Op[], e: SketchElement, u: number) {
  const el = e.id
  const lw = Math.max(1, u * 0.45)
  const small = clamp(e.h * 0.5, 6, 9 * u)
  const tiny = 4.5 * u
  const fill = WIRE_FILL[e.type]
  const box = (r = 0) => ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: e.h, fill, stroke: WIRE, lw, r })
  const centred = (s: string, color = '#0f172a') => ops.push({ k: 'text', el, x: e.x + e.w / 2, y: e.y + (e.h - small) / 2, text: s, color, size: small, align: 'center', maxW: e.w - 4 })
  switch (e.type) {
    case 'group':
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: e.h, stroke: '#94a3b8', lw, dash: 3 * u })
      ops.push({ k: 'text', el, x: e.x + 2 * u, y: e.y + 2 * u, text: e.name, color: '#64748b', size: tiny, align: 'left' })
      return
    case 'label':
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: e.h, stroke: '#cbd5e1', lw: lw / 2, dash: 2 * u })
      ops.push({ k: 'text', el, x: e.x + 1, y: e.y + (e.h - small) / 2, text: e.text || e.name, color: '#0f172a', size: small, align: 'left', maxW: e.w - 2 })
      return
    case 'slotgrid':
      for (const c of cells(e)) ops.push({ k: 'rect', el, x: c.x + 0.5, y: c.y + 0.5, w: c.w - 1, h: c.h - 1, fill: WIRE_FILL.slot, stroke: WIRE, lw: lw * 0.75 })
      return
    case 'image':
      box()
      ops.push({ k: 'line', el, x1: e.x, y1: e.y, x2: e.x + e.w, y2: e.y + e.h, color: '#94a3b8', lw: lw * 0.75 })
      ops.push({ k: 'line', el, x1: e.x + e.w, y1: e.y, x2: e.x, y2: e.y + e.h, color: '#94a3b8', lw: lw * 0.75 })
      return
    case 'icon':
      box(2 * u)
      ops.push({ k: 'circle', el, cx: e.x + e.w / 2, cy: e.y + e.h / 2, r: Math.min(e.w, e.h) * 0.25, stroke: WIRE, lw })
      return
    case 'slider': {
      const v = e.value ?? 0.5
      ops.push({ k: 'rect', el, x: e.x, y: e.y + e.h / 2 - lw, w: e.w, h: lw * 2, fill: '#94a3b8' })
      const kw = Math.max(4, Math.min(e.h, 10 * u))
      ops.push({ k: 'rect', el, x: e.x + (e.w - kw) * v, y: e.y, w: kw, h: e.h, fill: '#e0e7ff', stroke: WIRE, lw, r: 1 })
      return
    }
    case 'progress':
    case 'bar': {
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: e.h, fill: '#ffffff', stroke: WIRE, lw })
      ops.push({ k: 'rect', el, x: e.x + lw, y: e.y + lw, w: Math.max(0, (e.w - 2 * lw) * (e.value ?? 0.5)), h: Math.max(0, e.h - 2 * lw), fill: e.type === 'bar' ? `${e.color ?? '#ef4444'}88` : '#a5b4fc' })
      if (e.type === 'bar' && e.text) centred(e.text)
      return
    }
    case 'checkbox': {
      const s = Math.min(e.h, 12 * u)
      ops.push({ k: 'rect', el, x: e.x, y: e.y + (e.h - s) / 2, w: s, h: s, fill: '#ffffff', stroke: WIRE, lw })
      if (e.states.includes('selected')) ops.push({ k: 'line', el, x1: e.x + 2, y1: e.y + e.h / 2, x2: e.x + s - 2, y2: e.y + (e.h - s) / 2 + 2, color: WIRE, lw: lw * 1.5 })
      ops.push({ k: 'text', el, x: e.x + s + 3 * u, y: e.y + (e.h - small) / 2, text: e.text ?? '', color: '#0f172a', size: small, align: 'left', maxW: e.w - s - 3 * u })
      return
    }
    case 'toggle': {
      const sw = Math.min(e.w, e.h * 2)
      const on = (e.value ?? 1) >= 0.5
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: sw, h: e.h, fill: on ? '#c7d2fe' : '#ffffff', stroke: WIRE, lw, r: e.h / 2 })
      ops.push({ k: 'circle', el, cx: on ? e.x + sw - e.h / 2 : e.x + e.h / 2, cy: e.y + e.h / 2, r: e.h * 0.36, fill: '#ffffff', stroke: WIRE, lw })
      if (e.w > e.h * 2.4) ops.push({ k: 'text', el, x: e.x + sw + 3 * u, y: e.y + (e.h - small) / 2, text: e.text ?? '', color: '#0f172a', size: small, align: 'left', maxW: e.w - sw - 3 * u })
      return
    }
    case 'list': {
      box()
      const row = Math.max(10 * u, Math.min(24 * u, e.h / 5))
      for (let y = e.y + row; y < e.y + e.h - 1; y += row) ops.push({ k: 'line', el, x1: e.x + 2, y1: y, x2: e.x + e.w - 2, y2: y, color: '#e2e8f0', lw: lw * 0.75 })
      return
    }
    case 'tabs': {
      const names = tabNames(e)
      const n = Math.max(1, names.length)
      for (let i = 0; i < n; i++) {
        const tx = e.x + (e.w / n) * i
        ops.push({ k: 'rect', el, x: tx, y: e.y, w: e.w / n, h: e.h, fill: i === 0 ? '#e0e7ff' : '#ffffff', stroke: WIRE, lw })
        ops.push({ k: 'text', el, x: tx + e.w / n / 2, y: e.y + (e.h - small) / 2, text: names[i] ?? '', color: '#0f172a', size: small, align: 'center', maxW: e.w / n - 4 })
      }
      return
    }
    case 'dropdown':
      box(2 * u)
      ops.push({ k: 'text', el, x: e.x + 4 * u, y: e.y + (e.h - small) / 2, text: e.text ?? '', color: '#0f172a', size: small, align: 'left', maxW: e.w - e.h - 4 * u })
      chevron(ops, el, e.x + e.w - e.h / 2, e.y + e.h / 2, e.h * 0.15, WIRE, lw)
      return
    case 'modal':
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: e.h, fill, stroke: WIRE, lw: lw * 1.5, r: 3 * u })
      if (e.text) ops.push({ k: 'text', el, x: e.x + 5 * u, y: e.y + 4 * u, text: e.text, color: '#334155', size: 8 * u, align: 'left', bold: true, maxW: e.w - 20 * u })
      closeX(ops, el, { x: e.x + e.w - 10 * u, y: e.y + 4 * u, w: 5 * u, h: 5 * u }, WIRE, lw)
      return
    case 'ability': {
      box(2 * u)
      const cd = e.value ?? 0
      if (cd > 0) ops.push({ k: 'pie', el, cx: e.x + e.w / 2, cy: e.y + e.h / 2, r: Math.min(e.w, e.h) * 0.42, from: 0, to: cd, fill: 'rgba(71,85,105,0.35)' })
      if (e.text) ops.push({ k: 'text', el, x: e.x + e.w - small * 0.6, y: e.y + e.h - small * 1.05, text: e.text, color: '#0f172a', size: small * 0.8, align: 'center', bold: true })
      return
    }
    case 'minimap':
      ops.push({ k: 'circle', el, cx: e.x + e.w / 2, cy: e.y + e.h / 2, r: Math.min(e.w, e.h) / 2, fill, stroke: WIRE, lw })
      arrow(ops, el, e.x + e.w / 2, e.y + e.h / 2, Math.min(e.w, e.h) * 0.08, WIRE, lw)
      ops.push({ k: 'text', el, x: e.x + e.w / 2, y: e.y + 2 * u, text: 'N', color: '#475569', size: tiny, align: 'center', bold: true })
      return
    case 'dialogue': {
      box(2 * u)
      const { speaker, line } = dialogueParts(e)
      const p = e.h - 8 * u
      ops.push({ k: 'rect', el, x: e.x + 4 * u, y: e.y + 4 * u, w: p, h: p, fill: '#e2e8f0', stroke: WIRE, lw })
      const tx = e.x + p + 10 * u
      const fs = clamp(e.h * 0.14, 6, 9 * u)
      if (speaker) ops.push({ k: 'text', el, x: tx, y: e.y + 5 * u, text: speaker, color: '#0f172a', size: fs, align: 'left', bold: true, maxW: e.w - p - 14 * u })
      wrap(line, e.w - p - 14 * u, fs, 3).forEach((l, i) => ops.push({ k: 'text', el, x: tx, y: e.y + 5 * u + fs * (1.5 + i * 1.25), text: l, color: '#334155', size: fs, align: 'left' }))
      return
    }
    case 'crosshair':
      cross(ops, el, e, WIRE, lw)
      return
    case 'joystick':
      ops.push({ k: 'circle', el, cx: e.x + e.w / 2, cy: e.y + e.h / 2, r: Math.min(e.w, e.h) / 2, fill: '#f1f5f9', stroke: WIRE, lw })
      ops.push({ k: 'circle', el, cx: e.x + e.w / 2, cy: e.y + e.h / 2, r: Math.min(e.w, e.h) * 0.2, fill: '#cbd5e1', stroke: WIRE, lw })
      return
    case 'toast':
      box(3 * u)
      ops.push({ k: 'text', el, x: e.x + 5 * u, y: e.y + (e.h - small) / 2, text: e.text ?? '', color: '#f8fafc', size: small, align: 'left', maxW: e.w - 10 * u })
      return
    default: {
      box(e.type === 'button' || e.type === 'tooltip' ? 2 * u : 0)
      const color = e.type === 'tooltip' ? '#f8fafc' : '#0f172a'
      if (e.type === 'window') {
        if (e.text) ops.push({ k: 'text', el, x: e.x + 4 * u, y: e.y + 3 * u, text: e.text, color: '#334155', size: 7 * u, align: 'left', bold: true, maxW: e.w - 8 * u })
      } else if (e.type === 'textfield') ops.push({ k: 'text', el, x: e.x + 3 * u, y: e.y + (e.h - small) / 2, text: e.text || 'text...', color: e.text ? '#0f172a' : '#94a3b8', size: small, align: 'left', maxW: e.w - 6 * u })
      else if (e.text !== undefined) centred(e.text, color)
      else if (e.type === 'panel' && e.w > 24 * u && e.h > 10 * u) ops.push({ k: 'text', el, x: e.x + 2 * u, y: e.y + 2 * u, text: e.name, color: '#94a3b8', size: tiny, align: 'left' })
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

function mcWindow(ops: Op[], el: string, x: number, y: number, w: number, h: number) {
  // a one-pixel black rim with its corners cut, then the raised grey body
  ops.push({ k: 'rect', el, x: x + 1, y, w: w - 2, h, fill: '#000000' }, { k: 'rect', el, x, y: y + 1, w, h: h - 2, fill: '#000000' })
  bevel(ops, el, x + 1, y + 1, w - 2, h - 2, MC.bg, MC.light, MC.dark, 2)
}

function minecraft(ops: Op[], e: SketchElement) {
  const el = e.id
  const disabled = e.states.includes('disabled')
  const t = (x: number, y: number, text: string, color: string, align: 'left' | 'center', shadow?: string, maxW?: number) =>
    ops.push({ k: 'text', el, x, y, text, color, size: 8, align, mono: true, shadow, maxW })
  switch (e.type) {
    case 'window':
      mcWindow(ops, el, e.x, e.y, e.w, e.h)
      return
    case 'modal':
      mcWindow(ops, el, e.x, e.y, e.w, e.h)
      if (e.text) t(e.x + 8, e.y + 6, e.text, MC.text, 'left', undefined, e.w - 16)
      return
    case 'panel':
    case 'slot':
      bevel(ops, el, e.x, e.y, e.w, e.h, MC.slot, MC.slotDark, MC.light, 1)
      return
    case 'group':
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
    case 'toggle':
      // vanilla options are buttons that say what they are set to
      mcButton(ops, el, e.x, e.y, e.w, e.h, disabled)
      t(e.x + e.w / 2, e.y + (e.h - 8) / 2, `${e.text ? `${e.text}: ` : ''}${(e.value ?? 1) >= 0.5 ? 'ON' : 'OFF'}`, '#ffffff', 'center', '#3f3f3f', e.w - 4)
      return
    case 'dropdown':
      mcButton(ops, el, e.x, e.y, e.w, e.h, disabled)
      t(e.x + 5, e.y + (e.h - 8) / 2, e.text ?? '', '#ffffff', 'left', '#3f3f3f', e.w - 16)
      t(e.x + e.w - 7, e.y + (e.h - 8) / 2, 'v', '#ffffff', 'center', '#3f3f3f')
      return
    case 'tabs': {
      const names = tabNames(e)
      const n = Math.max(1, names.length)
      const tw = e.w / n
      names.forEach((name, i) => {
        const sel = i === 0
        ops.push({ k: 'rect', el, x: e.x + i * tw, y: e.y + (sel ? 0 : 2), w: tw - 1, h: e.h - (sel ? 0 : 2), fill: '#000000' })
        bevel(ops, el, e.x + i * tw + 1, e.y + (sel ? 1 : 3), tw - 3, e.h - (sel ? 1 : 4), sel ? MC.bg : '#a0a0a0', MC.light, sel ? MC.bg : MC.dark, sel ? 2 : 1)
        t(e.x + i * tw + tw / 2, e.y + (e.h - 8) / 2 + 1, name, MC.text, 'center', undefined, tw - 4)
      })
      return
    }
    case 'textfield':
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: e.h, fill: '#a0a0a0' }, { k: 'rect', el, x: e.x + 1, y: e.y + 1, w: e.w - 2, h: e.h - 2, fill: '#000000' })
      t(e.x + 4, e.y + (e.h - 8) / 2, `${e.text ?? ''}_`, '#e0e0e0', 'left', '#383838', e.w - 8)
      return
    case 'image':
    case 'icon': {
      const s = Math.max(2, Math.round(Math.min(e.w, e.h) / 4))
      for (let y = 0; y < e.h; y += s)
        for (let x = 0; x < e.w; x += s) ops.push({ k: 'rect', el, x: e.x + x, y: e.y + y, w: Math.min(s, e.w - x), h: Math.min(s, e.h - y), fill: ((x + y) / s) % 2 ? '#7a5c3a' : '#9b7653' })
      return
    }
    case 'list': {
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: e.h, fill: '#000000' })
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: 1, fill: '#5a5a5a' }, { k: 'rect', el, x: e.x, y: e.y + e.h - 1, w: e.w, h: 1, fill: '#5a5a5a' })
      let n = 1
      for (let y = e.y + 3; y + 9 <= e.y + e.h; y += 12) t(e.x + 4, y + 1, `Entry ${n++}`, '#ffffff', 'left', '#3f3f3f', e.w - 8)
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
      bevel(ops, el, e.x, e.y, e.w, e.h, MC.slot, MC.slotDark, MC.light, 1)
      ops.push({ k: 'rect', el, x: e.x + 1, y: e.y + 1, w: Math.max(0, (e.w - 2) * (e.value ?? 0.5)), h: e.h - 2, fill: '#f0f0f0' })
      return
    }
    case 'bar': {
      const color = e.color ?? '#ef4444'
      // a short, wide bar is a row of icons (hearts, food); anything else a flat bar like experience
      if (e.h <= 12 && e.w / e.h >= 5) {
        const s = e.h
        const n = Math.max(1, Math.floor((e.w + 1) / s))
        const full = Math.round(n * (e.value ?? 0.75) * 2) / 2
        for (let i = 0; i < n; i++) {
          const x = e.x + i * s
          ops.push({ k: 'rect', el, x: x + 1, y: e.y + 1, w: s - 2, h: s - 2, fill: '#1a1a1a' })
          if (i < full) ops.push({ k: 'rect', el, x: x + 2, y: e.y + 2, w: (s - 4) * (i + 1 <= full ? 1 : 0.5), h: s - 4, fill: color })
        }
        return
      }
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: e.h, fill: '#000000' })
      ops.push({ k: 'rect', el, x: e.x + 1, y: e.y + 1, w: Math.max(0, (e.w - 2) * (e.value ?? 0.75)), h: e.h - 2, fill: color })
      if (e.text) t(e.x + e.w / 2, e.y - 9, e.text, '#80ff20', 'center', '#000000')
      return
    }
    case 'ability': {
      const cd = e.value ?? 0
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: e.h, fill: 'rgba(0,0,0,0.55)' })
      ops.push({ k: 'rect', el, x: e.x + 0.5, y: e.y + 0.5, w: e.w - 1, h: e.h - 1, stroke: '#a0a0a0', lw: 1 })
      if (cd > 0) ops.push({ k: 'rect', el, x: e.x + 1, y: e.y + 1 + (e.h - 2) * (1 - cd), w: e.w - 2, h: (e.h - 2) * cd, fill: 'rgba(255,255,255,0.35)' })
      if (e.text) t(e.x + e.w - 4, e.y + e.h - 9, e.text, '#ffffff', 'center', '#3f3f3f')
      return
    }
    case 'minimap': {
      bevel(ops, el, e.x, e.y, e.w, e.h, '#3a3a3a', MC.slotDark, MC.light, 1)
      const s = Math.max(2, Math.round(e.w / 12))
      for (let y = 1; y < e.h - 1; y += s)
        for (let x = 1; x < e.w - 1; x += s)
          ops.push({ k: 'rect', el, x: e.x + x, y: e.y + y, w: Math.min(s, e.w - 1 - x), h: Math.min(s, e.h - 1 - y), fill: (x * 7 + y * 13) % 5 === 0 ? '#3f76e4' : (x * 3 + y * 5) % 4 === 0 ? '#5f8a3a' : '#7cb342' })
      ops.push({ k: 'rect', el, x: e.x + e.w / 2 - 1, y: e.y + e.h / 2 - 1, w: 3, h: 3, fill: '#ffffff' })
      return
    }
    case 'dialogue': {
      const { speaker, line } = dialogueParts(e)
      mcWindow(ops, el, e.x, e.y, e.w, e.h)
      if (speaker) t(e.x + 8, e.y + 7, speaker, MC.text, 'left', undefined, e.w - 16)
      wrap(line, e.w - 16, 8, 3).forEach((l, i) => t(e.x + 8, e.y + (speaker ? 19 : 8) + i * 10, l, '#202020', 'left'))
      return
    }
    case 'crosshair':
      cross(ops, el, e, '#ffffff', 1)
      return
    case 'joystick':
      ops.push({ k: 'circle', el, cx: e.x + e.w / 2, cy: e.y + e.h / 2, r: Math.min(e.w, e.h) / 2, fill: 'rgba(0,0,0,0.4)', stroke: '#a0a0a0', lw: 1 })
      ops.push({ k: 'circle', el, cx: e.x + e.w / 2, cy: e.y + e.h / 2, r: Math.min(e.w, e.h) / 5, fill: MC.bg })
      return
    case 'toast': {
      // the advancement toast: a dark frame, the title in yellow and a line in white
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: e.h, fill: '#212121' }, { k: 'rect', el, x: e.x + 1, y: e.y + 1, w: e.w - 2, h: e.h - 2, stroke: '#5a5a5a', lw: 1 })
      bevel(ops, el, e.x + 8, e.y + 8, 16, 16, MC.slot, MC.slotDark, MC.light, 1)
      t(e.x + 30, e.y + 7, e.name !== TYPE_LABEL.toast ? e.name : 'Advancement Made!', '#ffff55', 'left', undefined, e.w - 34)
      t(e.x + 30, e.y + 18, e.text ?? '', '#ffffff', 'left', undefined, e.w - 34)
      return
    }
    case 'tooltip':
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: e.h, fill: 'rgba(16,0,16,0.94)' })
      ops.push({ k: 'rect', el, x: e.x + 1, y: e.y + 1, w: e.w - 2, h: e.h - 2, stroke: '#5000ff', lw: 1 })
      t(e.x + 4, e.y + 4, e.text ?? '', '#ffffff', 'left', '#3f3f3f', e.w - 8)
      return
  }
}

// ---- game: a modern HUD, dark glass with a gold accent, sized by each element ----

const G = { glass: 'rgba(10,14,26,0.78)', edge: 'rgba(203,213,225,0.35)', gold: '#f5c451', teal: '#2dd4bf', text: '#f1f5f9', muted: '#94a3b8' }

function game(ops: Op[], e: SketchElement) {
  const el = e.id
  const disabled = e.states.includes('disabled')
  const r = clamp(Math.min(e.w, e.h) * 0.18, 2, 14)
  const lw = clamp(Math.min(e.w, e.h) * 0.04, 1, 3)
  const fs = clamp(e.h * 0.42, 10, 34)
  const text = (x: number, y: number, s: string, color: string, size: number, align: 'left' | 'center', bold?: boolean, maxW?: number) =>
    ops.push({ k: 'text', el, x, y, text: s, color, size, align, bold, maxW, shadow: 'rgba(0,0,0,0.6)' })
  const glass = (fill = G.glass, stroke = G.edge) => ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: e.h, fill, stroke, lw, r })
  switch (e.type) {
    case 'window':
    case 'modal': {
      glass()
      const head = clamp(e.h * 0.12, 28, 64)
      if (e.text) {
        text(e.x + head * 0.5, e.y + head * 0.28, e.text, G.gold, head * 0.42, 'left', true, e.w - head * 1.6)
        ops.push({ k: 'rect', el, x: e.x + head * 0.5, y: e.y + head * 0.95, w: e.w - head, h: Math.max(1, lw * 0.75), fill: 'rgba(245,196,81,0.55)' })
      }
      if (e.type === 'modal') closeX(ops, el, { x: e.x + e.w - head * 0.7, y: e.y + head * 0.32, w: head * 0.3, h: head * 0.3 }, G.muted, lw)
      return
    }
    case 'panel':
      glass()
      return
    case 'group':
      return
    case 'label':
      text(e.x, e.y + (e.h - fs) / 2, e.text || e.name, G.text, fs, 'left', false, e.w)
      return
    case 'button':
      glass(disabled ? 'rgba(51,65,85,0.7)' : 'rgba(30,27,18,0.85)', disabled ? G.muted : G.gold)
      text(e.x + e.w / 2, e.y + (e.h - fs * 0.8) / 2, (e.text ?? '').toUpperCase(), disabled ? G.muted : G.gold, fs * 0.8, 'center', true, e.w - 8)
      return
    case 'textfield':
      glass('rgba(2,6,23,0.75)', e.states.includes('focused') ? G.gold : G.edge)
      text(e.x + e.h * 0.3, e.y + (e.h - fs * 0.8) / 2, e.text || 'Enter text', e.text ? G.text : G.muted, fs * 0.8, 'left', false, e.w - e.h * 0.6)
      return
    case 'slot':
      glass('rgba(2,6,23,0.6)')
      return
    case 'slotgrid':
      for (const c of cells(e)) ops.push({ k: 'rect', el, x: c.x + 2, y: c.y + 2, w: c.w - 4, h: c.h - 4, fill: 'rgba(2,6,23,0.6)', stroke: G.edge, lw, r: clamp(c.w * 0.12, 2, 10) })
      return
    case 'image':
      glass('rgba(51,65,85,0.85)')
      ops.push({ k: 'line', el, x1: e.x + e.w * 0.2, y1: e.y + e.h * 0.75, x2: e.x + e.w * 0.45, y2: e.y + e.h * 0.45, color: G.muted, lw: lw * 1.5 })
      ops.push({ k: 'line', el, x1: e.x + e.w * 0.45, y1: e.y + e.h * 0.45, x2: e.x + e.w * 0.8, y2: e.y + e.h * 0.75, color: G.muted, lw: lw * 1.5 })
      return
    case 'icon':
      ops.push({ k: 'circle', el, cx: e.x + e.w / 2, cy: e.y + e.h / 2, r: Math.min(e.w, e.h) / 2, fill: 'rgba(45,212,191,0.25)', stroke: G.teal, lw })
      ops.push({ k: 'circle', el, cx: e.x + e.w / 2, cy: e.y + e.h / 2, r: Math.min(e.w, e.h) * 0.18, fill: G.teal })
      return
    case 'list': {
      glass()
      const row = clamp(e.h / 6, 28, 72)
      let n = 1
      for (let y = e.y + row * 0.15; y + row <= e.y + e.h; y += row) {
        if (n === 1) ops.push({ k: 'rect', el, x: e.x + lw * 3, y, w: e.w - lw * 6, h: row * 0.9, fill: 'rgba(245,196,81,0.14)', r: r * 0.6 })
        text(e.x + row * 0.4, y + row * 0.22, `Item ${n}`, n === 1 ? G.gold : G.text, row * 0.4, 'left', false, e.w - row)
        n++
      }
      return
    }
    case 'tabs': {
      const names = tabNames(e)
      const n = Math.max(1, names.length)
      const tw = e.w / n
      ops.push({ k: 'rect', el, x: e.x, y: e.y + e.h - lw, w: e.w, h: lw, fill: G.edge })
      names.forEach((name, i) => {
        text(e.x + tw * i + tw / 2, e.y + (e.h - fs * 0.75) / 2, name.toUpperCase(), i === 0 ? G.gold : G.muted, fs * 0.75, 'center', true, tw - 8)
        if (i === 0) ops.push({ k: 'rect', el, x: e.x + tw * 0.15, y: e.y + e.h - lw * 2.5, w: tw * 0.7, h: lw * 2.5, fill: G.gold })
      })
      return
    }
    case 'dropdown':
      glass('rgba(2,6,23,0.75)')
      text(e.x + e.h * 0.3, e.y + (e.h - fs * 0.8) / 2, e.text ?? '', G.text, fs * 0.8, 'left', false, e.w - e.h * 1.3)
      chevron(ops, el, e.x + e.w - e.h / 2, e.y + e.h / 2, e.h * 0.12, G.gold, lw * 1.5)
      return
    case 'slider': {
      const v = e.value ?? 0.5
      const th = clamp(e.h * 0.2, 3, 8)
      ops.push({ k: 'rect', el, x: e.x, y: e.y + (e.h - th) / 2, w: e.w, h: th, fill: 'rgba(2,6,23,0.7)', r: th / 2 })
      ops.push({ k: 'rect', el, x: e.x, y: e.y + (e.h - th) / 2, w: e.w * v, h: th, fill: G.gold, r: th / 2 })
      ops.push({ k: 'circle', el, cx: e.x + e.w * v, cy: e.y + e.h / 2, r: e.h * 0.38, fill: G.text, stroke: G.gold, lw })
      return
    }
    case 'checkbox': {
      const s = Math.min(e.h, e.w)
      const on = e.states.includes('selected')
      ops.push({ k: 'rect', el, x: e.x, y: e.y + (e.h - s) / 2, w: s, h: s, fill: on ? G.gold : 'rgba(2,6,23,0.7)', stroke: on ? G.gold : G.edge, lw, r: s * 0.2 })
      if (on) ops.push({ k: 'line', el, x1: e.x + s * 0.25, y1: e.y + e.h / 2, x2: e.x + s * 0.75, y2: e.y + e.h / 2 - s * 0.2, color: '#1c1917', lw: lw * 1.5 })
      if (e.w > s * 1.5) text(e.x + s * 1.3, e.y + (e.h - fs * 0.8) / 2, e.text ?? '', G.text, fs * 0.8, 'left', false, e.w - s * 1.3)
      return
    }
    case 'toggle': {
      const sw = Math.min(e.w, e.h * 2)
      const on = (e.value ?? 1) >= 0.5
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: sw, h: e.h, fill: on ? 'rgba(45,212,191,0.5)' : 'rgba(2,6,23,0.7)', stroke: on ? G.teal : G.edge, lw, r: e.h / 2 })
      ops.push({ k: 'circle', el, cx: on ? e.x + sw - e.h / 2 : e.x + e.h / 2, cy: e.y + e.h / 2, r: e.h * 0.36, fill: G.text })
      if (e.w > e.h * 2.4) text(e.x + sw + e.h * 0.4, e.y + (e.h - fs * 0.8) / 2, e.text ?? '', G.text, fs * 0.8, 'left', false, e.w - sw - e.h * 0.4)
      return
    }
    case 'progress':
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: e.h, fill: 'rgba(2,6,23,0.7)', r: e.h / 2 })
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w * (e.value ?? 0.5), h: e.h, fill: G.teal, r: e.h / 2 })
      return
    case 'bar': {
      const color = e.color ?? '#ef4444'
      const fillW = Math.max(0, (e.w - 2 * lw) * (e.value ?? 0.75))
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: e.h, fill: 'rgba(2,6,23,0.75)', stroke: 'rgba(0,0,0,0.6)', lw, r: r * 0.6 })
      ops.push({ k: 'rect', el, x: e.x + lw, y: e.y + lw, w: fillW, h: e.h - 2 * lw, fill: color, r: r * 0.5 })
      // the bevel: a lighter band over the top half of the fill
      ops.push({ k: 'rect', el, x: e.x + lw, y: e.y + lw, w: fillW, h: (e.h - 2 * lw) * 0.45, fill: 'rgba(255,255,255,0.22)', r: r * 0.5 })
      if (e.text) text(e.x + e.w / 2, e.y + (e.h - fs * 0.75) / 2, e.text, G.text, fs * 0.75, 'center', true, e.w - 8)
      return
    }
    case 'ability': {
      glass('rgba(10,14,26,0.85)', disabled ? G.edge : G.gold)
      ops.push({ k: 'circle', el, cx: e.x + e.w / 2, cy: e.y + e.h / 2, r: Math.min(e.w, e.h) * 0.22, fill: 'rgba(245,196,81,0.35)' })
      const cd = e.value ?? 0
      if (cd > 0) ops.push({ k: 'pie', el, cx: e.x + e.w / 2, cy: e.y + e.h / 2, r: Math.min(e.w, e.h) * 0.46, from: 0, to: cd, fill: 'rgba(0,0,0,0.55)' })
      if (e.text) {
        const kc = clamp(e.h * 0.32, 10, 30)
        ops.push({ k: 'rect', el, x: e.x + e.w - kc * 0.9, y: e.y + e.h - kc * 0.9, w: kc, h: kc, fill: '#0b0f1a', stroke: G.gold, lw: lw * 0.75, r: kc * 0.2 })
        text(e.x + e.w - kc * 0.4, e.y + e.h - kc * 0.78, e.text, G.gold, kc * 0.62, 'center', true)
      }
      return
    }
    case 'minimap': {
      const cx = e.x + e.w / 2
      const cy = e.y + e.h / 2
      const rr = Math.min(e.w, e.h) / 2
      ops.push({ k: 'circle', el, cx, cy, r: rr, fill: 'rgba(22,48,38,0.85)', stroke: G.gold, lw: lw * 1.5 })
      ops.push({ k: 'circle', el, cx: cx - rr * 0.35, cy: cy + rr * 0.2, r: rr * 0.22, fill: 'rgba(59,130,246,0.55)' })
      ops.push({ k: 'circle', el, cx: cx + rr * 0.4, cy: cy - rr * 0.3, r: rr * 0.08, fill: '#ef4444' })
      arrow(ops, el, cx, cy, rr * 0.12, G.text, lw * 1.2)
      text(cx, e.y + rr * 0.08, 'N', G.gold, rr * 0.16, 'center', true)
      return
    }
    case 'dialogue': {
      const { speaker, line } = dialogueParts(e)
      glass()
      const p = e.h * 0.78
      const pad = (e.h - p) / 2
      ops.push({ k: 'rect', el, x: e.x + pad, y: e.y + pad, w: p, h: p, fill: 'rgba(51,65,85,0.9)', stroke: G.gold, lw, r: r * 0.6 })
      ops.push({ k: 'circle', el, cx: e.x + pad + p / 2, cy: e.y + pad + p * 0.4, r: p * 0.18, fill: G.muted })
      ops.push({ k: 'rect', el, x: e.x + pad + p * 0.22, y: e.y + pad + p * 0.62, w: p * 0.56, h: p * 0.38 - lw, fill: G.muted, r: p * 0.2 })
      const tx = e.x + pad * 2 + p
      const size = clamp(e.h * 0.14, 10, 30)
      if (speaker) text(tx, e.y + pad, speaker, G.gold, size * 1.05, 'left', true, e.w - p - pad * 3)
      wrap(line, e.w - p - pad * 3, size, 3).forEach((l, i) => text(tx, e.y + pad + size * (1.6 + i * 1.35), l, G.text, size, 'left'))
      return
    }
    case 'crosshair':
      cross(ops, el, e, '#ffffff', clamp(e.w * 0.06, 1, 3), 'rgba(0,0,0,0.55)')
      return
    case 'joystick':
      ops.push({ k: 'circle', el, cx: e.x + e.w / 2, cy: e.y + e.h / 2, r: Math.min(e.w, e.h) / 2, fill: 'rgba(255,255,255,0.12)', stroke: 'rgba(255,255,255,0.45)', lw })
      ops.push({ k: 'circle', el, cx: e.x + e.w / 2, cy: e.y + e.h / 2, r: Math.min(e.w, e.h) * 0.2, fill: 'rgba(255,255,255,0.5)' })
      return
    case 'toast':
      glass()
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: lw * 3, h: e.h, fill: G.gold, r: lw })
      text(e.x + e.h * 0.35, e.y + (e.h - fs * 0.75) / 2, e.text ?? '', G.text, fs * 0.75, 'left', true, e.w - e.h * 0.6)
      return
    case 'tooltip':
      glass('rgba(2,6,23,0.92)')
      text(e.x + e.h * 0.2, e.y + (e.h - fs * 0.6) / 2, e.text ?? '', G.text, fs * 0.6, 'left', false, e.w - e.h * 0.4)
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
    case 'window':
    case 'modal': {
      ops.push({ k: 'rect', el, x: e.x + 2, y: e.y + 6, w: e.w, h: e.h, fill: 'rgba(15,23,42,0.08)', r: 12 })
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: e.h, fill: '#ffffff', stroke: '#e5e7eb', lw: 1, r: look === 'web' ? 12 : 8 })
      if (look === 'desktop' && e.type === 'window') {
        ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: 32, fill: '#f3f4f6', r: 8 }, { k: 'rect', el, x: e.x, y: e.y + 31, w: e.w, h: 1, fill: '#e5e7eb' })
        for (const [i, c] of ['#ef4444', '#f59e0b', '#22c55e'].entries()) ops.push({ k: 'circle', el, cx: e.x + 18 + i * 18, cy: e.y + 16, r: 6, fill: c })
        text(e.x + e.w / 2, e.y + 9, e.text || e.name, '#374151', 13, 'center', true, e.w - 120)
      } else if (e.text) text(e.x + 24, e.y + 20, e.text, '#111827', 20, 'left', true, e.w - 72)
      if (e.type === 'modal') closeX(ops, el, { x: e.x + e.w - 34, y: e.y + 22, w: 12, h: 12 }, '#6b7280', 1.5)
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
    case 'dropdown':
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: e.h, fill: '#ffffff', stroke: e.states.includes('focused') ? accent : '#d1d5db', lw: e.states.includes('focused') ? 2 : 1, r: 6 })
      text(e.x + 12, e.y + (e.h - 14) / 2, e.text || 'Type here', e.text ? '#111827' : '#9ca3af', 14, 'left', false, e.w - (e.type === 'dropdown' ? 40 : 24))
      if (e.type === 'dropdown') chevron(ops, el, e.x + e.w - 18, e.y + e.h / 2, 5, '#6b7280', 1.5)
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
    case 'icon':
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: e.h, fill: '#e0e7ff', r: Math.min(e.w, e.h) * 0.25 })
      ops.push({ k: 'circle', el, cx: e.x + e.w / 2, cy: e.y + e.h / 2, r: Math.min(e.w, e.h) * 0.2, fill: accent })
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
    case 'tabs': {
      const names = tabNames(e)
      const n = Math.max(1, names.length)
      const tw = e.w / n
      ops.push({ k: 'rect', el, x: e.x, y: e.y + e.h - 1, w: e.w, h: 1, fill: '#e5e7eb' })
      names.forEach((name, i) => {
        text(e.x + tw * i + tw / 2, e.y + (e.h - 14) / 2, name, i === 0 ? accent : '#6b7280', 14, 'center', i === 0, tw - 8)
        if (i === 0) ops.push({ k: 'rect', el, x: e.x + tw * 0.1, y: e.y + e.h - 2, w: tw * 0.8, h: 2, fill: accent })
      })
      return
    }
    case 'slider': {
      const v = e.value ?? 0.5
      ops.push({ k: 'rect', el, x: e.x, y: e.y + e.h / 2 - 2, w: e.w, h: 4, fill: '#e5e7eb', r: 2 })
      ops.push({ k: 'rect', el, x: e.x, y: e.y + e.h / 2 - 2, w: e.w * v, h: 4, fill: accent, r: 2 })
      ops.push({ k: 'circle', el, cx: e.x + e.w * v, cy: e.y + e.h / 2, r: 9, fill: '#ffffff', stroke: accent, lw: 2 })
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
    case 'toggle': {
      const sw = Math.min(e.w, e.h * 1.8)
      const on = (e.value ?? 1) >= 0.5
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: sw, h: e.h, fill: on ? accent : '#d1d5db', r: e.h / 2 })
      ops.push({ k: 'circle', el, cx: on ? e.x + sw - e.h / 2 : e.x + e.h / 2, cy: e.y + e.h / 2, r: e.h * 0.38, fill: '#ffffff' })
      if (e.w > e.h * 2.4) text(e.x + sw + 10, e.y + (e.h - 14) / 2, e.text ?? '', '#1f2937', 14, 'left', false, e.w - sw - 10)
      return
    }
    case 'progress':
    case 'bar':
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: e.h, fill: '#e5e7eb', r: e.h / 2 })
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w * (e.value ?? 0.5), h: e.h, fill: e.type === 'bar' ? (e.color ?? accent) : accent, r: e.h / 2 })
      return
    case 'ability':
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: e.h, fill: '#ffffff', stroke: '#d1d5db', lw: 1, r: 10 })
      if ((e.value ?? 0) > 0) ops.push({ k: 'pie', el, cx: e.x + e.w / 2, cy: e.y + e.h / 2, r: Math.min(e.w, e.h) * 0.45, from: 0, to: e.value ?? 0, fill: 'rgba(17,24,39,0.25)' })
      if (e.text) text(e.x + e.w - 12, e.y + e.h - 18, e.text, '#374151', 11, 'center', true)
      return
    case 'minimap':
      ops.push({ k: 'circle', el, cx: e.x + e.w / 2, cy: e.y + e.h / 2, r: Math.min(e.w, e.h) / 2, fill: '#e5e7eb', stroke: '#d1d5db', lw: 1 })
      arrow(ops, el, e.x + e.w / 2, e.y + e.h / 2, Math.min(e.w, e.h) * 0.08, accent, 2)
      return
    case 'dialogue': {
      const { speaker, line } = dialogueParts(e)
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: e.h, fill: '#ffffff', stroke: '#e5e7eb', lw: 1, r: 12 })
      ops.push({ k: 'circle', el, cx: e.x + 40, cy: e.y + 40, r: 24, fill: '#e0e7ff' })
      if (speaker) text(e.x + 80, e.y + 18, speaker, '#111827', 15, 'left', true, e.w - 100)
      wrap(line, e.w - 100, 14, 4).forEach((l, i) => text(e.x + 80, e.y + 42 + i * 20, l, '#374151', 14, 'left'))
      return
    }
    case 'crosshair':
      cross(ops, el, e, '#111827', 2)
      return
    case 'joystick':
      ops.push({ k: 'circle', el, cx: e.x + e.w / 2, cy: e.y + e.h / 2, r: Math.min(e.w, e.h) / 2, fill: 'rgba(17,24,39,0.08)', stroke: '#d1d5db', lw: 1 })
      ops.push({ k: 'circle', el, cx: e.x + e.w / 2, cy: e.y + e.h / 2, r: Math.min(e.w, e.h) * 0.2, fill: '#9ca3af' })
      return
    case 'toast':
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: e.h, fill: '#111827', r: 10 })
      text(e.x + 16, e.y + (e.h - 14) / 2, e.text ?? '', '#f9fafb', 14, 'left', false, e.w - 32)
      return
    case 'tooltip':
      ops.push({ k: 'rect', el, x: e.x, y: e.y, w: e.w, h: e.h, fill: '#111827', r: 6 })
      text(e.x + 10, e.y + (e.h - 12) / 2, e.text ?? '', '#f9fafb', 12, 'left', false, e.w - 20)
      return
  }
}

/** The label the layers panel shows when an element has not been named. */
export const displayName = (e: SketchElement): string => (e.name && e.name !== TYPE_LABEL[e.type] ? e.name : e.text ? `${TYPE_LABEL[e.type]} "${e.text.split('|').pop()}"` : TYPE_LABEL[e.type])
