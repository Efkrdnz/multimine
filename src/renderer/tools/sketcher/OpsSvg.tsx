import { memo } from 'react'
import type { Op } from '@shared/sketch/draw'
import { fontOf } from './paint'

/** Drawing ops as SVG: the same picture the PNGs get, live in the editor. */
export const OpsSvg = memo(function OpsSvg({ ops }: { ops: readonly Op[] }) {
  return (
    <>
      {ops.map((o, i) => {
        if (o.k === 'grad') {
          const id = `sk-grad-${i}`
          return (
            <g key={i}>
              <defs>
                <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor={o.from} />
                  <stop offset="1" stopColor={o.to} />
                </linearGradient>
              </defs>
              <rect x={o.x} y={o.y} width={o.w} height={o.h} fill={`url(#${id})`} />
            </g>
          )
        }
        if (o.k === 'rect')
          return (
            <rect
              key={i}
              x={o.x}
              y={o.y}
              width={Math.max(0, o.w)}
              height={Math.max(0, o.h)}
              rx={o.r}
              fill={o.fill ?? 'none'}
              stroke={o.stroke}
              strokeWidth={o.stroke ? (o.lw ?? 1) : undefined}
              strokeDasharray={o.dash}
              shapeRendering={o.r ? undefined : 'crispEdges'}
            />
          )
        if (o.k === 'circle') return <circle key={i} cx={o.cx} cy={o.cy} r={Math.max(0, o.r)} fill={o.fill ?? 'none'} stroke={o.stroke} strokeWidth={o.stroke ? (o.lw ?? 1) : undefined} />
        if (o.k === 'pie') return <path key={i} d={piePath(o.cx, o.cy, o.r, o.from, o.to)} fill={o.fill} />
        if (o.k === 'line') return <line key={i} x1={o.x1} y1={o.y1} x2={o.x2} y2={o.y2} stroke={o.color} strokeWidth={o.lw} strokeDasharray={o.dash} />
        const t = (dx: number, color: string) => (
          <text
            x={o.x + dx}
            y={o.y + dx}
            fontSize={o.size}
            fontFamily={fontOf(o)}
            fontWeight={o.bold ? 700 : 400}
            fill={color}
            textAnchor={o.align === 'center' ? 'middle' : 'start'}
            dominantBaseline="text-before-edge"
          >
            {o.text}
          </text>
        )
        const clip = o.maxW ? `sk-clip-${i}` : undefined
        return (
          <g key={i} clipPath={clip ? `url(#${clip})` : undefined}>
            {clip && (
              <defs>
                <clipPath id={clip}>
                  <rect x={o.align === 'center' ? o.x - o.maxW! / 2 : o.x} y={o.y - o.size} width={o.maxW} height={o.size * 3} />
                </clipPath>
              </defs>
            )}
            {o.shadow && t(o.size / 8, o.shadow)}
            {t(0, o.color)}
          </g>
        )
      })}
    </>
  )
})

/** A sector from `from` to `to` turns, clockwise from twelve o'clock. */
function piePath(cx: number, cy: number, r: number, from: number, to: number): string {
  if (to - from >= 0.999) return `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0`
  const at = (t: number) => [cx + r * Math.sin(t * Math.PI * 2), cy - r * Math.cos(t * Math.PI * 2)]
  const [x1, y1] = at(from)
  const [x2, y2] = at(to)
  return `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${to - from > 0.5 ? 1 : 0} 1 ${x2} ${y2} Z`
}
