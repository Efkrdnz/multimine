import { Lightbulb } from 'lucide-react'
import { useStore } from '../state/store'
import { openTool } from '../tools/openTool'

/** Ideas a chat saved to the Idea Book, in the chat: how many, their titles, and the way to review them. */
export function IdeaCardView({ card }: { card: { count: number; titles: string[] } }) {
  const plugin = useStore((s) => s.plugins.find((p) => p.manifest.id === 'idea-book'))
  return (
    <div className="my-3 rounded-xl border border-amber-300/25 bg-gradient-to-br from-amber-400/[0.07] to-transparent px-3 py-2.5" data-testid="idea-card">
      <div className="flex items-center gap-2">
        <Lightbulb size={14} className="text-amber-300" />
        <span className="text-[12.5px] font-semibold text-indigo-50">
          {card.count} idea{card.count === 1 ? '' : 's'} saved to the Idea Book
        </span>
        <span className="text-[11px] text-indigo-300/60">to review</span>
        <span className="flex-1" />
        <button className="btn !py-0.5 text-[11px]" disabled={!plugin} onClick={() => plugin && openTool(plugin)} data-testid="idea-card-open">
          Review
        </button>
      </div>
      <ul className="mt-1.5 space-y-0.5 pl-6 text-[12px] text-indigo-200/80">
        {card.titles.map((t) => (
          <li key={t} className="list-disc">
            {t}
          </li>
        ))}
        {card.count > card.titles.length && <li className="list-none text-indigo-300/50">and {card.count - card.titles.length} more</li>}
      </ul>
    </div>
  )
}
