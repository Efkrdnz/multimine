import type { PluginInfo } from '@shared/types'
import { useStore } from '../state/store'

/** Opens a tool's window beside the sidebar; a plugin still waiting for consent asks first. */
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
