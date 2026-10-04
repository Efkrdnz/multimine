import { Link2, Sheet } from 'lucide-react'
import type { TableCard } from '@shared/types'
import { useStore } from '../state/store'
import { openTool } from '../tools/openTool'

/** A table a chat saved, in the chat: what it holds, how much is linked to the code, its first rows. */
export function TableCardView({ card }: { card: TableCard }) {
  const plugin = useStore((s) => s.plugins.find((p) => p.manifest.id === 'tables'))
  const show = () => {
    if (!plugin) return
    const s = useStore.getState()
    s.set({ tableRequest: { id: card.id, n: (s.tableRequest?.n ?? 0) + 1 } })
    openTool(plugin)
  }
  return (
    <div className="my-3 overflow-hidden rounded-xl border border-violet-400/25 bg-violet-950/20" data-testid="table-card">
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <Sheet size={14} className="text-violet-300" />
        <span className="font-semibold text-indigo-50">{card.name}</span>
        <span className="text-[11px] text-indigo-300/60">
          {card.rows} rows · {card.columns} columns
        </span>
        <span className={`flex items-center gap-1 text-[11px] ${card.verified < card.links ? 'text-amber-300' : 'text-emerald-300/80'}`} title={card.broken.length ? `Not linked:\n${card.broken.join('\n')}` : undefined}>
          <Link2 size={11} /> {card.verified} of {card.links} linked to code
        </span>
        <div className="flex-1" />
        <button className="btn !py-0.5 text-[11px]" onClick={show} data-testid="table-card-open">
          Open in Tables
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[11.5px]">
          <thead>
            <tr>
              {card.preview.columns.map((c) => (
                <th key={c.key} className="px-3 py-1 text-left font-semibold text-indigo-300/80">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {card.preview.rows.map((r, i) => (
              <tr key={i} className="border-t border-white/5">
                {card.preview.columns.map((c) => (
                  <td key={c.key} className="px-3 py-1 text-indigo-100">
                    {r[c.key] || <span className="text-indigo-300/30">-</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {card.rows > card.preview.rows.length && <div className="px-3 pb-2 pt-1 text-[10.5px] text-indigo-300/50">and {card.rows - card.preview.rows.length} more in the Tables tool</div>}
      </div>
    </div>
  )
}
