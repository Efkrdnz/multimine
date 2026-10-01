import { useState } from 'react'
import { Save, Trash2 } from 'lucide-react'
import { DEFAULT_CATALOG, PROVIDER_LABEL, needsKey } from '@shared/catalog'
import { SUPPORTED_EFFORTS, clampEffort } from '@shared/effort'
import { CREATABLE_ROLES, ROLE_LABEL, roleTemplate } from '@shared/templates'
import { EFFORTS, MASTERMIND_ID, PERMISSIONS, PROVIDERS, type AgentSpec, type Role } from '@shared/types'
import { api, useStore } from '../state/store'
import { Modal } from './Modal'
import { OrbAvatar } from './OrbAvatar'

const SWATCHES = ['#c084fc', '#60a5fa', '#34d399', '#f472b6', '#fbbf24', '#22d3ee', '#f87171', '#a3e635', '#fb923c', '#e879f9', '#38bdf8', '#facc15']

const PERM_HELP = { chat: 'Talks only; never touches files.', read: 'Reads the project; cannot change it.', write: 'Reads and edits the project, runs commands.' }

export function AgentEditor({ agent, isNew }: { agent: AgentSpec; isNew: boolean }) {
  const settings = useStore((s) => s.settings)
  const keyed = useStore((s) => s.keyed)
  const close = () => useStore.getState().set({ modal: null })
  const [a, setA] = useState<AgentSpec>(agent)
  const [saving, setSaving] = useState(false)
  const isMm = a.id === MASTERMIND_ID
  const patch = (p: Partial<AgentSpec>) => setA((x) => ({ ...x, ...p }))
  const models = settings?.catalog[a.provider] ?? DEFAULT_CATALOG[a.provider]

  const pickRole = (role: Role) => {
    if (!isNew) return patch({ role })
    const t = roleTemplate(role, '')
    setA({ ...t, name: a.name || (role === 'custom' ? '' : t.name) })
  }

  const pickProvider = (provider: AgentSpec['provider']) => {
    const list = settings?.catalog[provider] ?? DEFAULT_CATALOG[provider]
    const keep = list.some((m) => m.id === a.model)
    patch({ provider, model: keep ? a.model : (list[0]?.id ?? ''), effort: clampEffort(provider, a.effort), planMode: provider === 'claude-cli' ? a.planMode : false })
  }

  const save = async () => {
    if (!a.name.trim()) return useStore.getState().toast('error', 'Give the agent a name.')
    setSaving(true)
    try {
      const saved = await api().saveAgent({ ...a, name: a.name.trim() }, isNew)
      close()
      if (isNew) useStore.getState().openChat(saved.id)
    } catch (e) {
      useStore.getState().toast('error', String((e as Error).message ?? e))
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!confirm(`Delete ${a.name}? Its agent file is removed; chats stay in their sessions.`)) return
    await api().deleteAgent(a.id)
    useStore.getState().closeChat(a.id)
    close()
  }

  const missingKey = needsKey(a.provider) && !keyed.includes(a.provider)

  return (
    <Modal title={isNew ? 'Create agent' : `Edit ${agent.name}`} onClose={close}>
      <div className="grid min-h-0 flex-1 grid-cols-[220px_1fr] gap-0 overflow-hidden">
        <div className="flex flex-col items-center gap-3 border-r border-white/10 p-5">
          <OrbAvatar color={a.color} size={130} brain={isMm} status="idle" />
          <div className="text-center font-display text-lg font-bold">{a.name || 'Unnamed'}</div>
          <div className="text-center text-xs text-indigo-300">{ROLE_LABEL[a.role]}</div>
          {!isMm && (
            <div className="mt-2 grid grid-cols-6 gap-1.5">
              {SWATCHES.map((c) => (
                <button key={c} className={`h-6 w-6 rounded-full border-2 ${a.color === c ? 'border-white' : 'border-transparent'}`} style={{ background: c }} onClick={() => patch({ color: c })} />
              ))}
            </div>
          )}
          {!isMm && <input className="field mt-1 text-center font-mono text-xs" value={a.color} onChange={(e) => /^#[0-9a-f]{0,6}$/i.test(e.target.value) && patch({ color: e.target.value })} />}
        </div>

        <div className="scroll-thin min-h-0 overflow-y-auto p-5">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Name</label>
              <input className="field" value={a.name} onChange={(e) => patch({ name: e.target.value })} placeholder="e.g. Context Keeper" autoFocus data-testid="agent-name" />
            </div>
            <div>
              <label className="label">Role {isNew && <span className="normal-case text-indigo-300/60">(fills a starting template)</span>}</label>
              <select className="field" value={a.role} disabled={isMm} onChange={(e) => pickRole(e.target.value as Role)} data-testid="agent-role">
                {(isMm ? ['mastermind' as Role] : CREATABLE_ROLES).map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
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
              {!isMm && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={a.gated} onChange={(e) => patch({ gated: e.target.checked })} /> Gated: needs an approved plan before work
                </label>
              )}
              <label className={`flex items-center gap-2 text-sm ${a.provider !== 'claude-cli' ? 'opacity-40' : ''}`}>
                <input type="checkbox" disabled={a.provider !== 'claude-cli'} checked={a.planMode} onChange={(e) => patch({ planMode: e.target.checked })} /> Plan mode (Claude): plans and asks before acting
              </label>
            </div>

            {!!settings?.mcpServers.length && (
              <div className="col-span-2">
                <label className="label">MCP tools</label>
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

            <div className="col-span-2">
              <label className="label">Purpose <span className="normal-case text-indigo-300/60">(saved as .multimine/agents/{a.id || '<name>'}.md - its system brief)</span></label>
              <textarea className="field scroll-thin min-h-64 font-mono text-xs leading-relaxed" value={a.purpose} onChange={(e) => patch({ purpose: e.target.value })} spellCheck={false} />
            </div>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 border-t border-white/10 px-5 py-3">
        {!isNew && !isMm && (
          <button className="btn btn-danger" onClick={remove}>
            <Trash2 size={14} /> Delete
          </button>
        )}
        <div className="flex-1" />
        <button className="btn" onClick={close}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={save} disabled={saving} data-testid="agent-save">
          <Save size={14} /> {isNew ? 'Create' : 'Save'}
        </button>
      </div>
    </Modal>
  )
}
