import type { PluginInfo } from '@shared/types'

export function Sketcher({ plugin }: { plugin: PluginInfo }) {
  return <div className="p-6 text-sm text-indigo-300/70">{plugin.manifest.name}</div>
}
