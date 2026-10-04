import { useState } from 'react'
import { Save, Trash2 } from 'lucide-react'
import { DEFAULT_CATALOG, PROVIDER_LABEL, needsKey } from '@shared/catalog'
import { SUPPORTED_EFFORTS, clampEffort } from '@shared/effort'
import { EFFORTS, PERMISSIONS, PROVIDERS, type AgentSpec } from '@shared/types'
import { api, useStore } from '../state/store'
import { Modal } from './Modal'
import { FallbackChain } from './FallbackChain'

const AUTO_HELP: Record<string, string> = {
  'claude-cli': 'Claude Code: on accepts edits and allows commands and tools without asking; off sends every permission prompt to you.',
  'codex-cli': 'Codex: on runs with full access (network, outside the sandbox); off keeps it in the workspace sandbox. Codex cannot ask mid-run, so pushes go through request_permission.',
  api: 'API models: on lets file writes and commands run; off asks you for each one.'
}

const PERM_HELP = { chat: 'Talks only; never touches files.', read: 'Reads the project; cannot change it.', write: 'Reads and edits the project, runs commands.' }

/** Everything about one chat that does not fit in the composer: its name, provider, permissions, MCP servers and fallbacks. */
export function ChatSettings({ agent }: { agent: AgentSpec }) {
  const settings = useStore((s) => s.settings)
  const keyed = useStore((s) => s.keyed)
  const close = () => useStore.getState().set({ modal: null })
  const [a, setA] = useState<AgentSpec>(agent)
  const [saving, setSaving] = useState(false)
  const patch = (p: Partial<AgentSpec>) => setA((x) => ({ ...x, ...p }))
  const models = settings?.catalog[a.provider] ?? DEFAULT_CATALOG[a.provider]

  const pickProvider = (provider: AgentSpec['provider']) => {
    const list = settings?.catalog[provider] ?? DEFAULT_CATALOG[provider]
    const keep = list.some((m) => m.id === a.model)
    patch({ provider, model: keep ? a.model : (list[0]?.id ?? ''), effort: clampEffort(provider, a.effort), planMode: provider === 'claude-cli' ? a.planMode : false })
  }

  const save = async () => {
    if (!a.name.trim()) return useStore.getState().toast('error', 'Give the chat a name.')
    setSaving(true)
    try {
      await api().saveChat({ ...a, name: a.name.trim() })
      close()
    } catch (e) {
      useStore.getState().toast('error', String((e as Error).message ?? e))
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!confirm(`Delete the chat "${a.name}" and everything said in it?`)) return
    await api().deleteChat(a.id)
    close()
  }

  const missingKey = needsKey(a.provider) && !keyed.includes(a.provider)

  return (
    <Modal title={`Chat settings: ${agent.name}`} onClose={close}>
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="scroll-thin min-h-0 overflow-y-auto p-5">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="label">Name</label>
              <input className="field" value={a.name} onChange={(e) => patch({ name: e.target.value })} autoFocus data-testid="agent-name" />
            </div>

            <div className="col-span-2">
              <label className="label">Provider</label>
              <div className="grid grid-cols-5 gap-1.5">
                {PROVIDERS.map((p) => (
                  <button key={p} className={`rounded-lg border px-2 py-1.5 text-[11px] font-semibold leading-tight transition ${a.provider === p ? 'border-violet-400 bg-violet-500/25 text-white' : 'border-white/10 bg-black/20 text-indigo-200 hover:border-white/25'}`} onClick={() => pickProvider(p)} title={PROVIDER_LABEL[p]}>
                    {PROVIDER_LABEL[p].replace(' API key', '').replace(' subscription', ' sub')}
                  </button>
                ))}
              </div>
              {missingKey && (
                <div className="mt-1.5 text-xs text-amber-300">
                  No {PROVIDER_LABEL[a.provider]} saved.{' '}
                  <button className="underline" onClick={() => useStore.getState().set({ modal: { kind: 'settings', tab: 'providers' } })}>
                    Add it in Settings
                  </button>
                </div>
              )}
              {(a.provider === 'claude-cli' || a.provider === 'codex-cli') && <div className="mt-1.5 text-xs text-indigo-300/70">Runs on your logged-in {a.provider === 'claude-cli' ? 'Claude Code' : 'Codex'} subscription, with its own file tools, in the project folder.</div>}
            </div>

            <div>
              <label className="label">Model</label>
              <input className="field font-mono" list="models" value={a.model} onChange={(e) => patch({ model: e.target.value })} data-testid="agent-model" />
              <datalist id="models">
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </datalist>
              <div className="mt-1 flex flex-wrap gap-1">
                {models.slice(0, 6).map((m) => (
                  <button key={m.id} className={`rounded px-1.5 py-0.5 text-[10px] ${a.model === m.id ? 'bg-violet-500/30 text-white' : 'bg-white/5 text-indigo-300 hover:bg-white/10'}`} onClick={() => patch({ model: m.id })}>
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="label">Effort</label>
              <div className="flex gap-1">
                {EFFORTS.map((e) => {
                  const ok = SUPPORTED_EFFORTS[a.provider].includes(e)
                  return (
                    <button key={e} disabled={!ok} className={`flex-1 rounded-lg border py-1.5 text-xs font-semibold ${a.effort === e ? 'border-violet-400 bg-violet-500/25 text-white' : 'border-white/10 bg-black/20 text-indigo-200'} disabled:opacity-25`} onClick={() => patch({ effort: e })}>
                      {e}
                    </button>
                  )
                })}
              </div>
            </div>

            <div>
              <label className="label">Permissions</label>
              <div className="flex gap-1">
                {PERMISSIONS.map((p) => (
                  <button key={p} className={`flex-1 rounded-lg border py-1.5 text-xs font-semibold ${a.permissions === p ? 'border-violet-400 bg-violet-500/25 text-white' : 'border-white/10 bg-black/20 text-indigo-200'}`} onClick={() => patch({ permissions: p })}>
                    {p}
                  </button>
                ))}
              </div>
              <div className="mt-1 text-[11px] text-indigo-300/70">{PERM_HELP[a.permissions]}</div>
            </div>
            <div className="space-y-2 pt-5">
              <label className="flex items-start gap-2 text-sm" title={AUTO_HELP[a.provider] ?? AUTO_HELP.api}>
                <input type="checkbox" className="mt-1" checked={a.autoApprove} onChange={(e) => patch({ autoApprove: e.target.checked })} data-testid="agent-auto-approve" />
                <span>
                  Auto-approve permissions
                  <span className="block text-[11px] text-indigo-300/70">{a.autoApprove ? 'Never stops to ask; pushing and destructive commands still ask.' : 'Each command, edit or tool use pops up for you to allow.'}</span>
                </span>
              </label>
              <label className={`flex items-center gap-2 text-sm ${a.provider !== 'claude-cli' ? 'opacity-40' : ''}`}>
                <input type="checkbox" disabled={a.provider !== 'claude-cli'} checked={a.planMode} onChange={(e) => patch({ planMode: e.target.checked })} /> Plan mode (Claude): plans and asks before acting
              </label>
            </div>

            <div className="col-span-2 rounded-xl border border-sky-400/20 bg-sky-500/5 p-3">
                <label className="label !text-sky-200">Fallback when out of usage</label>
                <div className="mb-2 text-[11px] text-indigo-200/70">
                  If {a.provider === 'mock' ? 'its provider' : 'this provider'} runs out of usage or its login stops working, this chat continues on the next one, mid-task, with a brief of what is already done.
                  {!a.fallback.length && ' With none set here, the default chain from Settings is used.'}
                </div>
                <FallbackChain value={a.fallback} onChange={(fallback) => patch({ fallback })} testId="agent-fallback" />
                <label className="mt-2 flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={a.fallbackPaidOk} onChange={(e) => patch({ fallbackPaidOk: e.target.checked })} /> Switch to paid API keys without asking
                </label>
              </div>

            {!!settings?.mcpServers.length && (
              <div className="col-span-2">
                <label className="label">MCP servers <span className="normal-case text-indigo-300/60">(their tools are this chat's to use)</span></label>
                <div className="flex flex-wrap gap-1.5">
                  {settings.mcpServers.map((s) => {
                    const on = a.mcp.includes(s.id)
                    return (
                      <button key={s.id} className={`rounded-lg border px-2.5 py-1 text-xs ${on ? 'border-cyan-400 bg-cyan-500/20 text-cyan-50' : 'border-white/10 bg-black/20 text-indigo-200'}`} onClick={() => patch({ mcp: on ? a.mcp.filter((x) => x !== s.id) : [...a.mcp, s.id] })}>
                        {s.name}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 border-t border-white/10 px-5 py-3">
        <button className="btn btn-danger" onClick={remove} data-testid="chat-delete">
          <Trash2 size={14} /> Delete chat
        </button>
        <div className="flex-1" />
        <button className="btn" onClick={close}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={save} disabled={saving} data-testid="agent-save">
          <Save size={14} /> Save
        </button>
      </div>
    </Modal>
  )
}
