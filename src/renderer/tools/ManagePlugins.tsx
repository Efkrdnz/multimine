import { FolderOpen, Trash2 } from 'lucide-react'
import { PERMISSION_TEXT } from '@shared/pluginText'
import { api, useStore } from '../state/store'
import { Modal } from '../panels/Modal'
import { PluginIcon } from './PluginIcon'

export function ManagePlugins() {
  const plugins = useStore((s) => s.plugins)
  const broken = useStore((s) => s.brokenPlugins)
  const close = () => useStore.getState().set({ modal: null })
  return (
    <Modal title="Tools & plugins" onClose={close} width="w-[720px]">
      <div className="scroll-thin max-h-[72vh] space-y-3 overflow-y-auto p-5" data-testid="manage-plugins">
        {plugins.map((p) => (
          <div key={p.manifest.id} className="rounded-xl border border-white/10 bg-black/25 p-3">
            <div className="flex items-center gap-3">
              <PluginIcon plugin={p} size={40} />
              <div className="min-w-0 flex-1">
                <div className="font-semibold">
                  {p.manifest.name} <span className="text-xs font-normal text-indigo-300/70">v{p.manifest.version} · {p.source}</span>
                </div>
                <div className="truncate text-xs text-indigo-200/70">{p.manifest.description}</div>
              </div>
              {p.source !== 'builtin' && (
                <>
                  <label className="flex items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      checked={p.enabled}
                      onChange={(e) => (e.target.checked ? useStore.getState().set({ consent: { pluginId: p.manifest.id, thenOpen: false } }) : void api().pluginSetEnabled(p.manifest.id, false))}
                    />
                    Enabled
                  </label>
                  <button className="btn btn-ghost !p-1.5" title="Open folder" onClick={() => void api().openPath(p.dir)}>
                    <FolderOpen size={14} />
                  </button>
                  {p.source === 'user' && (
                    <button className="btn btn-ghost !p-1.5 text-red-300" title="Uninstall" onClick={() => confirm(`Uninstall ${p.manifest.name}?`) && void api().pluginRemove(p.manifest.id)}>
                      <Trash2 size={14} />
                    </button>
                  )}
                </>
              )}
            </div>
            {p.manifest.permissions.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {p.manifest.permissions.map((perm) => {
                  const on = p.granted.includes(perm)
                  return (
                    <span key={perm} className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${on ? 'border-emerald-400/40 text-emerald-100' : 'border-white/10 text-indigo-300/60 line-through'}`} title={PERMISSION_TEXT[perm]}>
                      {perm}
                      {on && p.source !== 'builtin' && (
                        <button className="ml-0.5 text-red-300 hover:text-red-200" title="Revoke" onClick={() => void api().pluginRevoke(p.manifest.id, perm)} data-testid={`revoke-${p.manifest.id}-${perm}`}>
                          ×
                        </button>
                      )}
                    </span>
                  )
                })}
                {p.manifest.mcp && <span className="rounded-full border border-cyan-400/40 px-2 py-0.5 text-[11px] text-cyan-100">adds agent tools (MCP)</span>}
              </div>
            )}
          </div>
        ))}
        {broken.map((b) => (
          <div key={b.dir} className="rounded-xl border border-red-400/30 bg-red-950/20 p-3 text-xs text-red-100">
            <div className="font-mono">{b.dir}</div>
            {b.errors.join('; ')}
          </div>
        ))}
        <div className="text-[11px] text-indigo-300/60">Writing your own? See docs/plugins.md - a plugin is a folder with plugin.json and a web page.</div>
      </div>
    </Modal>
  )
}
