import { useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { PERMISSION_TEXT } from '@shared/pluginText'
import type { PluginInfo, PluginPermission } from '@shared/types'
import { api, useStore } from '../state/store'
import { Modal } from '../panels/Modal'
import { PluginIcon } from './PluginIcon'
import { openTool } from './openTool'

/** Before a plugin runs (or gains a new permission): what it asks for, in plain words. */
export function ConsentDialog() {
  const consent = useStore((s) => s.consent)
  const plugin = useStore((s) => s.plugins.find((p) => p.manifest.id === consent?.pluginId))
  if (!consent || !plugin) return null
  // keyed, so the ticks start from what this plugin asks for every time the dialog opens
  return <Consent key={plugin.manifest.id} plugin={plugin} thenOpen={consent.thenOpen} />
}

function Consent({ plugin, thenOpen }: { plugin: PluginInfo; thenOpen?: boolean }) {
  const [chosen, setChosen] = useState<Set<PluginPermission>>(() => new Set(plugin.manifest.permissions))
  const close = () => useStore.getState().set({ consent: null })
  const allow = async () => {
    await api().pluginSetEnabled(plugin.manifest.id, true, [...chosen])
    close()
    const fresh = (await api().pluginList()).plugins.find((p) => p.manifest.id === plugin.manifest.id)
    if (fresh && thenOpen) openTool({ ...fresh, pending: [] })
  }
  return (
    <Modal title="Allow this tool?" onClose={close} width="w-[480px]">
      <div className="space-y-4 p-5" data-testid="consent">
        <div className="flex items-center gap-3">
          <PluginIcon plugin={plugin} size={48} />
          <div>
            <div className="font-display text-base font-bold">{plugin.manifest.name}</div>
            <div className="text-xs text-indigo-300/80">
              v{plugin.manifest.version} · {plugin.source === 'project' ? 'from this project folder' : plugin.source === 'user' ? 'installed by you' : 'built in'}
            </div>
          </div>
        </div>
        {plugin.manifest.description && <p className="text-sm text-indigo-100/90">{plugin.manifest.description}</p>}
        {plugin.source === 'project' && (
          <div className="rounded-lg border border-amber-400/30 bg-amber-500/10 p-2 text-xs text-amber-100">This tool came with the project folder, not from you. Only allow it if you trust where the project came from.</div>
        )}
        <div>
          <div className="label">It asks to</div>
          {plugin.manifest.permissions.length === 0 && <div className="text-sm text-indigo-200/80">Nothing beyond showing its own window.</div>}
          {plugin.manifest.permissions.map((p) => (
            <label key={p} className="flex items-center gap-2 py-1 text-sm">
              <input
                type="checkbox"
                checked={chosen.has(p)}
                onChange={(e) => {
                  const next = new Set(chosen)
                  if (e.target.checked) next.add(p)
                  else next.delete(p)
                  setChosen(next)
                }}
              />
              {PERMISSION_TEXT[p]}
            </label>
          ))}
          <div className="mt-2 text-[11px] text-indigo-300/70">It runs walled off from Multimine: no access to your keys, subscriptions or settings. You can revoke any of these later in Manage.</div>
        </div>
        <div className="flex justify-end gap-2">
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => void allow()} data-testid="consent-allow">
            <ShieldCheck size={14} /> Allow and open
          </button>
        </div>
      </div>
    </Modal>
  )
}
