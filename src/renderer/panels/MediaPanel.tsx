import { useState } from 'react'
import { ExternalLink, Image } from 'lucide-react'
import type { MediaItem } from '@shared/types'
import { EMPTY_LIST, api, useStore } from '../state/store'
import { Drawer } from './Drawer'
import { MediaView } from './MediaView'

export function MediaPanel() {
  const media = useStore((s) => s.media)
  const agents = useStore((s) => s.project?.agents ?? EMPTY_LIST)
  const [big, setBig] = useState<MediaItem | null>(null)
  const [kind, setKind] = useState<'all' | MediaItem['kind']>('all')
  const list = media.filter((m) => kind === 'all' || m.kind === kind).slice().reverse()
  return (
    <Drawer title="Media gallery" icon={<Image size={17} className="text-cyan-300" />} width="w-[620px]">
      <div className="mb-3 flex gap-1 text-xs">
        {(['all', 'image', 'video', 'model', 'audio'] as const).map((k) => (
          <button key={k} className={`rounded-md px-2.5 py-1 font-semibold capitalize ${kind === k ? 'bg-violet-500/30 text-white' : 'text-indigo-300 hover:bg-white/5'}`} onClick={() => setKind(k)}>
            {k}
          </button>
        ))}
      </div>
      {list.length === 0 && (
        <div className="mt-8 text-center text-sm text-indigo-300/60">
          Images, videos, audio and 3D models agents generate land here. Connect generation MCP servers (Higgsfield, Meshy, WaveSpeed...) in Settings and assign them to an agent.
        </div>
      )}
      {big ? (
        <div className="space-y-3">
          <button className="btn" onClick={() => setBig(null)}>
            Back to gallery
          </button>
          <MediaView item={big} />
          <div className="text-xs text-indigo-200/80">{big.title ?? big.source}</div>
          <button className="btn" onClick={() => void api().openPath(big.path)}>
            <ExternalLink size={13} /> Open file
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {list.map((m) => {
            const a = agents.find((x) => x.id === m.agentId)
            return (
              <div key={m.id} className="cursor-pointer rounded-xl border border-white/10 bg-black/25 p-2 hover:border-violet-400/40" onClick={() => setBig(m)}>
                <MediaView item={m} compact />
                <div className="mt-1.5 flex items-center gap-1 text-[10px] text-indigo-300/80">
                  <span className="text-indigo-200">{a?.name ?? m.agentId.replace(/^plugin:/, '')}</span> · {m.kind} · <span className="truncate">{m.title ?? m.source}</span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Drawer>
  )
}
