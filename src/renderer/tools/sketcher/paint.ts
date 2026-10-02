import type { Op } from '@shared/sketch/draw'

const FONT_SANS = 'Inter, "Segoe UI", system-ui, sans-serif'
const FONT_MONO = '"Cascadia Mono", Consolas, "DejaVu Sans Mono", monospace'

export const fontOf = (o: Extract<Op, { k: 'text' }>): string => (o.mono ? FONT_MONO : FONT_SANS)

/** Paints drawing ops onto a 2D canvas at `scale` device pixels per canvas unit. */
export function paint(ctx: CanvasRenderingContext2D, ops: readonly Op[], scale: number): void {
  ctx.save()
  ctx.scale(scale, scale)
  // pixel-art looks stay crisp: whole units land on whole pixels
  ctx.imageSmoothingEnabled = false
  for (const o of ops) {
    if (o.k === 'grad') {
      const g = ctx.createLinearGradient(0, o.y, 0, o.y + o.h)
      g.addColorStop(0, o.from)
      g.addColorStop(1, o.to)
      ctx.fillStyle = g
      ctx.fillRect(o.x, o.y, o.w, o.h)
    } else if (o.k === 'rect') {
      ctx.beginPath()
      if (o.r) ctx.roundRect(o.x, o.y, o.w, o.h, Math.min(o.r, o.w / 2, o.h / 2))
      else ctx.rect(o.x, o.y, o.w, o.h)
      if (o.fill) (ctx.fillStyle = o.fill), ctx.fill()
      if (o.stroke) {
        ctx.setLineDash(o.dash ? [o.dash, o.dash] : [])
        ctx.strokeStyle = o.stroke
        ctx.lineWidth = o.lw ?? 1
        ctx.stroke()
        ctx.setLineDash([])
      }
    } else if (o.k === 'circle') {
      ctx.beginPath()
      ctx.arc(o.cx, o.cy, Math.max(0, o.r), 0, Math.PI * 2)
      if (o.fill) (ctx.fillStyle = o.fill), ctx.fill()
      if (o.stroke) (ctx.strokeStyle = o.stroke), (ctx.lineWidth = o.lw ?? 1), ctx.stroke()
    } else if (o.k === 'pie') {
      ctx.beginPath()
      ctx.moveTo(o.cx, o.cy)
      ctx.arc(o.cx, o.cy, Math.max(0, o.r), o.from * Math.PI * 2 - Math.PI / 2, o.to * Math.PI * 2 - Math.PI / 2)
      ctx.closePath()
      ctx.fillStyle = o.fill
      ctx.fill()
    } else if (o.k === 'line') {
      ctx.beginPath()
      ctx.setLineDash(o.dash ? [o.dash, o.dash] : [])
      ctx.moveTo(o.x1, o.y1)
      ctx.lineTo(o.x2, o.y2)
      ctx.strokeStyle = o.color
      ctx.lineWidth = o.lw
      ctx.stroke()
      ctx.setLineDash([])
    } else {
      ctx.font = `${o.bold ? '700 ' : ''}${o.size}px ${fontOf(o)}`
      ctx.textBaseline = 'top'
      ctx.textAlign = o.align
      const text = o.maxW ? fit(ctx, o.text, o.maxW) : o.text
      if (o.shadow) {
        ctx.fillStyle = o.shadow
        ctx.fillText(text, o.x + o.size / 8, o.y + o.size / 8)
      }
      ctx.fillStyle = o.color
      ctx.fillText(text, o.x, o.y)
    }
  }
  ctx.restore()
}

function fit(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (maxW <= 0) return ''
  if (ctx.measureText(text).width <= maxW) return text
  let s = text
  while (s.length > 1 && ctx.measureText(`${s}...`).width > maxW) s = s.slice(0, -1)
  return `${s}...`
}

/** The ops as a PNG, base64 without the data: prefix (what the plugin API's files.write takes). */
export function toPng(ops: readonly Op[], w: number, h: number, scale: number): string {
  const c = document.createElement('canvas')
  c.width = Math.round(w * scale)
  c.height = Math.round(h * scale)
  paint(c.getContext('2d')!, ops, scale)
  return c.toDataURL('image/png').replace(/^data:image\/png;base64,/, '')
}
