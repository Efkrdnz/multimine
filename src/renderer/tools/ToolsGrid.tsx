import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Settings2, X } from 'lucide-react'
import type { PluginInfo } from '@shared/types'
import { api, useStore } from '../state/store'
import { PluginIcon } from './PluginIcon'

/** Opens a tool: asks for consent first if the plugin is off or wants something new. */
export function openTool(p: PluginInfo): void {
  const s = useStore.getState()
  if (!p.enabled || p.pending.length) return s.set({ consent: { pluginId: p.manifest.id, thenOpen: true } })
  s.set({
    openTools: s.openTools.includes(p.manifest.id) ? s.openTools : [...s.openTools, p.manifest.id],
    activeTool: p.manifest.id,
    panel: null,
    ide: s.ide === 'open' ? 'hidden' : s.ide
  })
}

function Tile({ label, children, onClick, wiggle, badge, onBadge, dim, testId, drag }: {
  label: string
  children: React.ReactNode
  onClick: () => void
  wiggle?: boolean
  badge?: boolean
  onBadge?: () => void
  dim?: boolean
  testId?: string
  drag?: React.HTMLAttributes<HTMLDivElement>
}) {
  return (
    <div className="relative flex w-[78px] flex-col items-center gap-1.5" {...drag}>
      <button className={`relative transition-transform active:scale-90 ${wiggle ? 'tile-wiggle' : 'hover:scale-[1.06]'} ${dim ? 'opacity-55' : ''}`} onClick={onClick} data-testid={testId}>
        {children}
        {badge && (
          <span
            className="absolute -left-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-zinc-700 text-white shadow ring-1 ring-black/40"
            onClick={(e) => {
              e.stopPropagation()
              onBadge?.()
            }}
          >
            <X size={11} strokeWidth={3} />
          </span>
        )}
      </button>
      <span className="w-full truncate text-center text-[11px] font-medium text-indigo-50 drop-shadow">{label}</span>
    </div>
  )
}

/**
 * The Tools grid: one rail button opens a home screen of tools. Edit mode (the button, or a long
 * press) wiggles the tiles: drag to reorder, the badge removes a plugin.
 */
export function ToolsGrid({ onClose }: { onClose: () => void }) {
  const plugins = useStore((s) => s.plugins)
  const order = useStore((s) => s.settings?.toolOrder)
  const [edit, setEdit] = useState(false)
  const [dragging, setDragging] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const press = useRef<ReturnType<typeof setTimeout> | null>(null)

  const sorted = useMemo(() => {
    const rank = (id: string) => {
      const i = (order ?? []).indexOf(id)
      return i < 0 ? 1000 : i
    }
    return [...plugins].sort((a, b) => (a.source === 'builtin' ? -1 : 0) - (b.source === 'builtin' ? -1 : 0) || rank(a.manifest.id) - rank(b.manifest.id))
  }, [plugins, order])

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && (edit ? setEdit(false) : onClose())
    const click = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('[data-testid="tools"]') && onClose()
    window.addEventListener('keydown', key)
    window.addEventListener('mousedown', click)
    return () => {
      window.removeEventListener('keydown', key)
      window.removeEventListener('mousedown', click)
    }
  }, [edit, onClose])

  const reorder = (from: string, to: string) => {
    const ids = sorted.map((p) => p.manifest.id)
    const a = ids.indexOf(from)
    const b = ids.indexOf(to)
    if (a < 0 || b < 0 || a === b) return
    ids.splice(b, 0, ids.splice(a, 1)[0])
    void api().updateSettings({ toolOrder: ids })
  }

  return (
    <div
      ref={box}
      className="tools-pop glass absolute bottom-0 left-[56px] z-30 w-[384px] origin-bottom-left rounded-[28px] p-5"
      onMouseDown={() => (press.current = setTimeout(() => setEdit(true), 650))}
      onMouseUp={() => press.current && clearTimeout(press.current)}
      onMouseLeave={() => press.current && clearTimeout(press.current)}
      data-testid="tools-grid"
    >
      <div className="mb-4 flex items-center">
        <div className="flex-1 font-display text-sm font-bold tracking-wide">Tools</div>
        <button className={`rounded-full px-3 py-0.5 text-xs font-semibold ${edit ? 'bg-violet-500 text-white' : 'bg-white/10 text-indigo-100 hover:bg-white/15'}`} onClick={() => setEdit(!edit)} data-testid="tools-edit">
          {edit ? 'Done' : 'Edit'}
        </button>
      </div>
      <div className="grid grid-cols-4 gap-x-2 gap-y-4">
        {sorted.map((p) => (
          <Tile
            key={p.manifest.id}
            label={p.manifest.name}
            dim={!p.enabled}
            wiggle={edit}
            badge={edit && p.source !== 'builtin'}
            onBadge={() => confirm(`Remove ${p.manifest.name}?`) && void api().pluginRemove(p.manifest.id)}
            onClick={() => {
              if (edit) return
              onClose()
              openTool(p)
            }}
            testId={`tool-${p.manifest.id}`}
            drag={
              edit
                ? {
                    draggable: true,
                    onDragStart: () => setDragging(p.manifest.id),
                    onDragOver: (e) => e.preventDefault(),
                    onDrop: () => dragging && reorder(dragging, p.manifest.id),
                    onDragEnd: () => setDragging(null)
                  }
                : undefined
            }
          >
            <PluginIcon plugin={p} />
          </Tile>
        ))}
        <Tile
          label="Install"
          onClick={() => {
            void api()
              .pluginPickAndInstall()
              .then((m) => m && useStore.getState().set({ consent: { pluginId: m.id, thenOpen: true } }))
              .catch((e) => useStore.getState().toast('error', String(e.message ?? e)))
          }}
          testId="tool-install"
        >
          <div className="flex h-[58px] w-[58px] items-center justify-center rounded-[15px] border-2 border-dashed border-white/25 text-indigo-100 hover:border-white/50">
            <Plus size={26} />
          </div>
        </Tile>
        <Tile
          label="Manage"
          onClick={() => {
            onClose()
            useStore.getState().set({ modal: { kind: 'plugins' } })
          }}
          testId="tool-manage"
        >
          <div className="flex h-[58px] w-[58px] items-center justify-center rounded-[15px] bg-gradient-to-br from-zinc-500 to-zinc-700 text-white shadow-[0_8px_22px_-6px_rgba(0,0,0,0.75)]">
            <Settings2 size={28} />
          </div>
        </Tile>
      </div>
      {edit && <div className="mt-4 text-center text-[11px] text-indigo-200/70">Drag tiles to reorder. Built-in tools cannot be removed.</div>}
    </div>
  )
}
