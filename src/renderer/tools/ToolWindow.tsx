import { lazy, Suspense, useCallback, useState } from 'react'
import { Maximize2, Minimize2, X } from 'lucide-react'
import type { PluginInfo } from '@shared/types'
import { useStore } from '../state/store'
import { PluginHost } from './PluginHost'
import { PluginIcon } from './PluginIcon'

const Sketcher = lazy(() => import('./sketcher/Sketcher').then((m) => ({ default: m.Sketcher })))
const AssetBoard = lazy(() => import('./assets/AssetBoard').then((m) => ({ default: m.AssetBoard })))
const LogicBoard = lazy(() => import('./logic/LogicBoard').then((m) => ({ default: m.LogicBoard })))
const DataTables = lazy(() => import('./data/DataTables').then((m) => ({ default: m.DataTables })))

/** Native (built-in) tools render as part of the app; everything they do still goes through the plugin API. */
const NATIVE: Record<string, React.ComponentType<{ plugin: PluginInfo }>> = {
  'ui-sketcher': Sketcher,
  'asset-board': AssetBoard,
  'data-tables': DataTables,
  'logic-board': LogicBoard
}

function ToolFrame({ plugin, active }: { plugin: PluginInfo; active: boolean }) {
  const [title, setTitle] = useState(plugin.manifest.name)
  const [max, setMax] = useState(false)
  const close = useCallback(() => {
    const s = useStore.getState()
    s.set({ openTools: s.openTools.filter((t) => t !== plugin.manifest.id), activeTool: s.activeTool === plugin.manifest.id ? null : s.activeTool })
  }, [plugin.manifest.id])
  const Native = NATIVE[plugin.manifest.id]

  return (
    <div
      data-left-drawer={active ? '' : undefined}
      // a tool takes the whole space beside the sidebar; maximised, the sidebar too
      className={`glass rise absolute bottom-3 z-20 flex flex-col overflow-hidden rounded-2xl ${max ? 'left-3 top-3' : 'left-[276px] top-16'} right-3 ${active ? '' : 'hidden'}`}
      data-testid={`toolwin-${plugin.manifest.id}`}
    >
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <PluginIcon plugin={plugin} size={20} />
        <div className="flex-1 truncate font-display text-sm font-bold">{title}</div>
        <button className="btn btn-ghost !p-1" title={max ? 'Restore' : 'Maximise'} onClick={() => setMax(!max)}>
          {max ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
        <button className="btn btn-ghost !p-1" title="Close" onClick={close}>
          <X size={15} />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {Native ? (
          <Suspense fallback={<div className="p-6 text-sm text-indigo-300/70">Loading {plugin.manifest.name}...</div>}>
            <Native plugin={plugin} />
          </Suspense>
        ) : (
          <PluginHost plugin={plugin} onTitle={setTitle} onClose={close} />
        )}
      </div>
    </div>
  )
}

/** Every tool opened this run stays mounted (keeping its state); only the active one is shown. */
export function ToolWindows() {
  const open = useStore((s) => s.openTools)
  const active = useStore((s) => s.activeTool)
  const plugins = useStore((s) => s.plugins)
  return (
    <>
      {open.map((id) => {
        const p = plugins.find((x) => x.manifest.id === id && x.enabled)
        return p ? <ToolFrame key={id} plugin={p} active={id === active} /> : null
      })}
    </>
  )
}
