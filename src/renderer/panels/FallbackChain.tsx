import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { DEFAULT_CATALOG, PROVIDER_LABEL } from '@shared/catalog'
import { SUPPORTED_EFFORTS, clampEffort } from '@shared/effort'
import { EFFORTS, PROVIDERS, type FallbackHop, type ProviderKind } from '@shared/types'
import { useStore } from '../state/store'

const PAID = new Set<ProviderKind>(['anthropic', 'openai', 'google', 'groq', 'xai', 'openrouter'])

/** An ordered list of provider/model/effort hops: where an agent goes when its provider is out of usage. */
export function FallbackChain({ value, onChange, testId }: { value: FallbackHop[]; onChange: (v: FallbackHop[]) => void; testId?: string }) {
  const catalog = useStore((s) => s.settings?.catalog)
  const set = (i: number, patch: Partial<FallbackHop>) => onChange(value.map((h, j) => (j === i ? { ...h, ...patch } : h)))
  const move = (i: number, d: number) => {
    const next = [...value]
    const [h] = next.splice(i, 1)
    next.splice(i + d, 0, h)
    onChange(next)
  }
  return (
    <div className="space-y-1.5" data-testid={testId}>
      {value.map((h, i) => {
        const models = catalog?.[h.provider] ?? DEFAULT_CATALOG[h.provider]
        return (
          <div key={i} className="flex items-center gap-1.5">
            <span className="w-5 text-right font-mono text-[11px] text-sky-300">{i + 1}.</span>
            <select
              className="field !w-48 !py-1 text-xs"
              value={h.provider}
              onChange={(e) => {
                const provider = e.target.value as ProviderKind
                const list = catalog?.[provider] ?? DEFAULT_CATALOG[provider]
                set(i, { provider, model: list[0]?.id ?? '', effort: clampEffort(provider, h.effort) })
              }}
            >
              {PROVIDERS.filter((p) => p !== 'mock').map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_LABEL[p]}
                </option>
              ))}
            </select>
            <input className="field flex-1 !py-1 font-mono text-[11px]" list={`fb-models-${i}`} value={h.model} onChange={(e) => set(i, { model: e.target.value })} />
            <datalist id={`fb-models-${i}`}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </datalist>
            <select className="field !w-24 !py-1 text-xs" value={h.effort} onChange={(e) => set(i, { effort: e.target.value as FallbackHop['effort'] })}>
              {EFFORTS.filter((e) => SUPPORTED_EFFORTS[h.provider].includes(e)).map((e) => (
                <option key={e}>{e}</option>
              ))}
            </select>
            {PAID.has(h.provider) ? <span className="rounded bg-amber-400/15 px-1 text-[9px] font-bold text-amber-200" title="Billed per call to your API key">PAID</span> : <span className="w-[30px]" />}
            <button className="btn btn-ghost !p-1" disabled={i === 0} onClick={() => move(i, -1)}>
              <ArrowUp size={12} />
            </button>
            <button className="btn btn-ghost !p-1" disabled={i === value.length - 1} onClick={() => move(i, 1)}>
              <ArrowDown size={12} />
            </button>
            <button className="btn btn-ghost !p-1 text-red-300" onClick={() => onChange(value.filter((_, j) => j !== i))}>
              <Trash2 size={12} />
            </button>
          </div>
        )
      })}
      <button
        className="btn !py-1 text-xs"
        onClick={() => {
          const used = new Set(value.map((h) => h.provider))
          const provider = (['codex-cli', 'claude-cli', 'openai', 'anthropic', 'google'] as ProviderKind[]).find((p) => !used.has(p)) ?? 'openai'
          onChange([...value, { provider, model: (catalog?.[provider] ?? DEFAULT_CATALOG[provider])[0]?.id ?? '', effort: clampEffort(provider, 'high') }])
        }}
        data-testid={testId ? `${testId}-add` : undefined}
      >
        <Plus size={12} /> Add fallback
      </button>
    </div>
  )
}
