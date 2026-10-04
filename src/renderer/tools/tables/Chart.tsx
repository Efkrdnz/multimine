import { useMemo, useState } from 'react'
import { SERIES, cellText, enumColor, type Table } from '@shared/tables/model'

const W = 720
const H = 260
const PAD = { l: 44, r: 16, t: 12, b: 46 }

const fmt = (n: number) => (Math.abs(n) >= 1000 ? `${Math.round(n / 100) / 10}k` : Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100))

/** Round steps for an axis: 4-6 ticks at 1, 2 or 5 times a power of ten. */
function ticks(lo: number, hi: number): number[] {
  if (lo === hi) return [lo]
  const raw = (hi - lo) / 5
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
  const out: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.round(v * 1e9) / 1e9)
  return out
}

/**
 * Numeric columns across the rows, one line each, on one shared axis. Columns of very different
 * sizes compare as a share of their own largest value instead of on a second axis.
 */
function LineChart({ table, keys, relative }: { table: Table; keys: string[]; relative: boolean }) {
  const [hover, setHover] = useState<number | null>(null)
  const name = table.columns[0]?.key
  const rows = table.rows
  const series = keys.map((k, i) => {
    const col = table.columns.find((c) => c.key === k)!
    const raw = rows.map((r) => (typeof r.cells[k] === 'number' ? (r.cells[k] as number) : null))
    const max = Math.max(...raw.map((v) => Math.abs(v ?? 0)), 0) || 1
    return { key: k, label: col.label, color: SERIES[i % SERIES.length], raw, values: raw.map((v) => (v === null ? null : relative ? (v / max) * 100 : v)) }
  })
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null))
  if (!rows.length || !all.length) return <div className="p-6 text-center text-xs text-indigo-300/60">No numbers to draw yet.</div>
  const lo = Math.min(0, ...all)
  const hi = Math.max(...all)
  const yt = ticks(lo, hi === lo ? lo + 1 : hi)
  const y0 = Math.min(lo, yt[0])
  const y1 = Math.max(hi, yt[yt.length - 1])
  const x = (i: number) => PAD.l + (rows.length === 1 ? (W - PAD.l - PAD.r) / 2 : (i / (rows.length - 1)) * (W - PAD.l - PAD.r))
  const y = (v: number) => PAD.t + (1 - (v - y0) / (y1 - y0 || 1)) * (H - PAD.t - PAD.b)
  const step = Math.max(1, Math.ceil(rows.length / 12))
  return (
    <div className="relative max-w-[780px]">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" onMouseLeave={() => setHover(null)} data-testid="tb-line-chart">
        {yt.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke={t === 0 ? 'rgb(165 180 252 / 0.35)' : 'rgb(165 180 252 / 0.08)'} />
            <text x={PAD.l - 6} y={y(t) + 3} textAnchor="end" className="fill-indigo-300/60 text-[10px]">
              {fmt(t)}
              {relative ? '%' : ''}
            </text>
          </g>
        ))}
        {rows.map((r, i) =>
          i % step === 0 ? (
            <text key={r.id} x={x(i)} y={H - PAD.b + 14} textAnchor="end" transform={`rotate(-30 ${x(i)} ${H - PAD.b + 14})`} className="fill-indigo-300/60 text-[10px]">
              {cellText(r.cells[name]).slice(0, 14)}
            </text>
          ) : null
        )}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} stroke="rgb(165 180 252 / 0.35)" strokeDasharray="3 3" />}
        {series.map((s) => {
          const pts = s.values.map((v, i) => (v === null ? null : [x(i), y(v)] as const))
          const d = pts.reduce((acc, p, i) => (p ? `${acc}${acc && pts[i - 1] ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}` : acc), '')
          return (
            <g key={s.key}>
              <path d={d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {pts.map((p, i) => (p ? <circle key={i} cx={p[0]} cy={p[1]} r={hover === i ? 5 : 4} fill={s.color} stroke="#0b0d1f" strokeWidth={2} /> : null))}
            </g>
          )
        })}
        {/* hit targets wider than the marks: one band per row */}
        {rows.map((r, i) => (
          <rect key={r.id} x={x(i) - (W - PAD.l - PAD.r) / Math.max(1, rows.length - 1) / 2} y={PAD.t} width={(W - PAD.l - PAD.r) / Math.max(1, rows.length - 1)} height={H - PAD.t - PAD.b} fill="transparent" onMouseEnter={() => setHover(i)} />
        ))}
      </svg>
      {hover !== null && (
        <div className="pointer-events-none absolute top-2 rounded-lg border border-white/10 bg-[#0b0d1f]/95 px-2.5 py-1.5 text-[11px] shadow-xl" style={{ left: `${Math.min(78, (x(hover) / W) * 100 + 2)}%` }} data-testid="tb-chart-tip">
          <div className="mb-0.5 font-semibold text-indigo-50">{cellText(rows[hover].cells[name])}</div>
          {series.map((s) => (
            <div key={s.key} className="flex items-center gap-1.5 text-indigo-200">
              <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
              {s.label}: <span className="font-mono text-indigo-50">{s.raw[hover] === null ? '-' : fmt(s.raw[hover]!)}</span>
            </div>
          ))}
        </div>
      )}
      {series.length > 1 && (
        <div className="mt-1 flex flex-wrap gap-3 px-2 text-[11px] text-indigo-200">
          {series.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5">
              <span className="h-0.5 w-4 rounded" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/** Shares of a whole: rows counted (or a number summed) by the value of one column. Past eight slices, the rest is "Other". */
function PieChart({ table, by, sum }: { table: Table; by: string; sum: string }) {
  const [hover, setHover] = useState<string | null>(null)
  const col = table.columns.find((c) => c.key === by)
  const slices = useMemo(() => {
    const totals = new Map<string, number>()
    for (const r of table.rows) {
      const k = cellText(r.cells[by]) || '(empty)'
      const v = sum ? (typeof r.cells[sum] === 'number' ? Math.abs(r.cells[sum] as number) : 0) : 1
      totals.set(k, (totals.get(k) ?? 0) + v)
    }
    let list = [...totals.entries()].sort((a, b) => b[1] - a[1])
    if (list.length > 8) list = [...list.slice(0, 7), ['Other', list.slice(7).reduce((n, [, v]) => n + v, 0)]]
    // "Other" and rows with no value are neutral: they are not an entity of their own
    return list.map(([label, value], i) => ({ label, value, color: label === 'Other' || label === '(empty)' ? '#6b7280' : col?.type === 'enum' ? enumColor(col, label) : SERIES[i % SERIES.length] }))
  }, [table, by, sum, col])
  const total = slices.reduce((n, s) => n + s.value, 0)
  if (!total) return <div className="p-6 text-center text-xs text-indigo-300/60">Nothing to share out yet.</div>
  const R = 92
  const r = 56
  let a = -Math.PI / 2
  const arcs = slices.map((s) => {
    const span = (s.value / total) * Math.PI * 2
    const a0 = a
    a += span
    return { ...s, a0, a1: a }
  })
  const pt = (rad: number, ang: number) => [110 + rad * Math.cos(ang), 110 + rad * Math.sin(ang)]
  return (
    <div className="flex flex-wrap items-center gap-6 px-2" data-testid="tb-pie-chart">
      <svg viewBox="0 0 220 220" className="h-[220px] w-[220px] shrink-0">
        {arcs.map((s) => {
          if (arcs.length === 1) return <circle key={s.label} cx={110} cy={110} r={(R + r) / 2} fill="none" stroke={s.color} strokeWidth={R - r} />
          const [x0, y0] = pt(R, s.a0)
          const [x1, y1] = pt(R, s.a1)
          const [x2, y2] = pt(r, s.a1)
          const [x3, y3] = pt(r, s.a0)
          const big = s.a1 - s.a0 > Math.PI ? 1 : 0
          return (
            <path
              key={s.label}
              d={`M${x0},${y0}A${R},${R} 0 ${big} 1 ${x1},${y1}L${x2},${y2}A${r},${r} 0 ${big} 0 ${x3},${y3}Z`}
              fill={s.color}
              stroke="#0b0d1f"
              strokeWidth={2}
              opacity={hover && hover !== s.label ? 0.45 : 1}
              onMouseEnter={() => setHover(s.label)}
              onMouseLeave={() => setHover(null)}
            />
          )
        })}
        <text x={110} y={106} textAnchor="middle" className="fill-indigo-50 text-[18px] font-semibold">
          {fmt(hover ? (slices.find((s) => s.label === hover)?.value ?? total) : total)}
        </text>
        <text x={110} y={124} textAnchor="middle" className="fill-indigo-300/70 text-[10px]">
          {hover ?? (sum ? `total ${table.columns.find((c) => c.key === sum)?.label ?? ''}` : 'rows')}
        </text>
      </svg>
      <div className="min-w-0 space-y-1 text-[12px]">
        {slices.map((s) => (
          <div key={s.label} className={`flex items-center gap-2 ${hover && hover !== s.label ? 'opacity-50' : ''}`} onMouseEnter={() => setHover(s.label)} onMouseLeave={() => setHover(null)}>
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: s.color }} />
            <span className="truncate text-indigo-50">{s.label}</span>
            <span className="ml-auto pl-4 font-mono text-indigo-200">{fmt(s.value)}</span>
            <span className="w-10 text-right font-mono text-indigo-300/60">{Math.round((s.value / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** The chart panel under a table: a line across the rows, or a pie of one column, on demand. */
export function TableChart({ table }: { table: Table }) {
  const numeric = table.columns.filter((c) => c.type === 'number')
  const groups = table.columns.filter((c) => c.type === 'enum' || c.type === 'bool' || (c.type === 'text' && c.key !== table.columns[0]?.key))
  const [kind, setKind] = useState<'line' | 'pie'>(numeric.length ? 'line' : 'pie')
  const [keys, setKeys] = useState<string[]>(numeric.slice(0, 2).map((c) => c.key))
  const [relative, setRelative] = useState(false)
  const [by, setBy] = useState(groups[0]?.key ?? table.columns[0]?.key ?? '')
  const [sum, setSum] = useState('')
  const shown = keys.filter((k) => numeric.some((c) => c.key === k))
  return (
    <div className="border-t border-white/10 bg-black/20 p-3" data-testid="tb-chart">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px]">
        <div className="flex rounded-md bg-black/40 p-0.5">
          {(['line', 'pie'] as const).map((k) => (
            <button key={k} className={`rounded px-2 py-0.5 capitalize ${kind === k ? 'bg-violet-500/40 text-white' : 'text-indigo-300/80'}`} onClick={() => setKind(k)} data-testid={`tb-chart-${k}`}>
              {k}
            </button>
          ))}
        </div>
        {kind === 'line' ? (
          <>
            {numeric.map((c) => (
              <label key={c.key} className="flex items-center gap-1 text-indigo-200">
                <input type="checkbox" checked={keys.includes(c.key)} onChange={(e) => setKeys(e.target.checked ? [...keys, c.key] : keys.filter((k) => k !== c.key))} data-testid={`tb-chart-col-${c.key}`} />
                {c.label}
              </label>
            ))}
            {shown.length > 1 && (
              <label className="ml-auto flex items-center gap-1 text-indigo-300/80" title="Each line as a share of its own largest value, so columns of different sizes compare on one axis">
                <input type="checkbox" checked={relative} onChange={(e) => setRelative(e.target.checked)} /> % of max
              </label>
            )}
          </>
        ) : (
          <>
            <span className="text-indigo-300/70">Split by</span>
            <select className="field !w-auto !py-0.5 !text-[11px]" value={by} onChange={(e) => setBy(e.target.value)} data-testid="tb-pie-by">
              {table.columns.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
            <span className="text-indigo-300/70">measure</span>
            <select className="field !w-auto !py-0.5 !text-[11px]" value={sum} onChange={(e) => setSum(e.target.value)} data-testid="tb-pie-sum">
              <option value="">Count of rows</option>
              {numeric.map((c) => (
                <option key={c.key} value={c.key}>
                  Sum of {c.label}
                </option>
              ))}
            </select>
          </>
        )}
      </div>
      {kind === 'line' ? <LineChart table={table} keys={shown} relative={relative && shown.length > 1} /> : <PieChart table={table} by={by} sum={sum} />}
    </div>
  )
}
