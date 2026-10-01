import { useEffect, useState } from 'react'
import { Sparkles, Users } from 'lucide-react'
import { DEFAULT_CATALOG, PROVIDER_LABEL } from '@shared/catalog'
import { clampEffort } from '@shared/effort'
import { ROLE_LABEL, roleTemplate } from '@shared/templates'
import { PROVIDERS, type AgentSpec, type ProviderKind, type Role } from '@shared/types'
import { api, useStore } from '../state/store'
import { OrbAvatar } from './OrbAvatar'

const SUGGESTED: Role[] = ['planner', 'implementer', 'designer', 'brainstormer', 'context-handler']

/** Shown while a project has only its Mastermind: one click for a starting team, each member editable later. */
export function TeamWizard({ onDone }: { onDone: () => void }) {
  const settings = useStore((s) => s.settings)
  const [rows, setRows] = useState(() => SUGGESTED.map((r) => ({ on: true, spec: roleTemplate(r, '') })))
  const [busy, setBusy] = useState(false)
  const [clis, setClis] = useState<{ claude: boolean; codex: boolean } | null>(null)

  useEffect(() => {
    void api()
      .detectClis()
      .then((r) => setClis({ claude: r.claude.installed, codex: r.codex.installed }))
  }, [])

  const setProvider = (i: number | 'all', provider: ProviderKind) =>
    setRows((rs) =>
      rs.map((r, j) => {
        if (i !== 'all' && i !== j) return r
        const list = settings?.catalog[provider] ?? DEFAULT_CATALOG[provider]
        const keep = list.some((m) => m.id === r.spec.model)
        return { ...r, spec: { ...r.spec, provider, model: keep ? r.spec.model : (list[0]?.id ?? ''), effort: clampEffort(provider, r.spec.effort), planMode: provider === 'claude-cli' && r.spec.planMode } }
      })
    )

  const create = async () => {
    setBusy(true)
    try {
      for (const r of rows.filter((x) => x.on)) await api().saveAgent(r.spec as AgentSpec, true)
      useStore.getState().set({ openChats: [], focused: null })
      onDone()
    } catch (e) {
      useStore.getState().toast('error', String((e as Error).message ?? e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/30">
      <div className="glass rise w-[760px] max-w-[94vw] rounded-2xl p-6" data-testid="team-wizard">
        <div className="flex items-center gap-2 font-display text-xl font-bold">
          <Users size={20} className="text-violet-300" /> Assemble your team
        </div>
        <p className="mt-1 text-sm text-indigo-200/80">
          Mastermind is ready. Start with the suggested specialists - each is a markdown brief in <code className="font-mono text-xs">.multimine/agents/</code> you can rewrite, and you can always add more.
          {clis && !clis.claude && ' Claude Code was not found on this machine, so Claude-subscription agents will need it installed and logged in.'}
        </p>
        <div className="mt-4 flex items-center gap-2 text-xs">
          <span className="text-indigo-300">Set every provider to</span>
          <select className="field !w-auto !py-1 text-xs" defaultValue="" onChange={(e) => e.target.value && setProvider('all', e.target.value as ProviderKind)} data-testid="wizard-all-provider">
            <option value="">(keep suggestions)</option>
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_LABEL[p]}
              </option>
            ))}
          </select>
        </div>
        <div className="mt-3 space-y-1.5">
          {rows.map((r, i) => (
            <div key={r.spec.role} className={`flex items-center gap-3 rounded-xl border px-3 py-2 ${r.on ? 'border-white/15 bg-black/25' : 'border-white/5 opacity-50'}`}>
              <input type="checkbox" checked={r.on} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} />
              <OrbAvatar color={r.spec.color} size={26} />
              <div className="w-36">
                <div className="text-sm font-semibold">{r.spec.name}</div>
                <div className="text-[10px] text-indigo-300/70">
                  {ROLE_LABEL[r.spec.role]} · {r.spec.permissions}
                  {r.spec.gated ? ' · gated' : ''}
                </div>
              </div>
              <select className="field !w-56 !py-1 text-xs" value={r.spec.provider} onChange={(e) => setProvider(i, e.target.value as ProviderKind)}>
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {PROVIDER_LABEL[p]}
                  </option>
                ))}
              </select>
              <input className="field flex-1 !py-1 font-mono text-xs" value={r.spec.model} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, spec: { ...x.spec, model: e.target.value } } : x)))} />
              <span className="w-12 text-right font-mono text-[11px] text-indigo-300">{r.spec.effort}</span>
            </div>
          ))}
        </div>
        <div className="mt-5 flex items-center gap-2">
          <button className="btn btn-ghost" onClick={onDone}>
            Skip, I'll build my own
          </button>
          <div className="flex-1" />
          <button className="btn btn-primary !px-5" disabled={busy || !rows.some((r) => r.on)} onClick={create} data-testid="wizard-create">
            <Sparkles size={14} /> {busy ? 'Creating...' : `Create ${rows.filter((r) => r.on).length} agents`}
          </button>
        </div>
      </div>
    </div>
  )
}
