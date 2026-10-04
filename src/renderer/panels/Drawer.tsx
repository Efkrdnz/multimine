import { X } from 'lucide-react'
import { SIDE_DOCK, useLayout, useStore } from '../state/store'

export function Drawer({ title, icon, children, width = 'w-[460px]' }: { title: string; icon: React.ReactNode; children: React.ReactNode; width?: string }) {
  const layout = useLayout()
  return (
    <div data-left-drawer className={`glass rise absolute bottom-3 ${SIDE_DOCK[layout]} top-16 z-20 flex ${width} max-w-[calc(100vw-300px)] flex-col rounded-2xl`}>
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
        {icon}
        <div className="flex-1 font-display text-[15px] font-bold">{title}</div>
        <button className="btn btn-ghost !p-1" onClick={() => useStore.getState().set({ panel: null })}>
          <X size={16} />
        </button>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4 select-text">{children}</div>
    </div>
  )
}
