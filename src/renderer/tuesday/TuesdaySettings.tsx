import { DEFAULT_CATALOG, PROVIDER_LABEL } from '@shared/catalog'
import { SUPPORTED_EFFORTS, clampEffort } from '@shared/effort'
import { PROVIDERS, type AppSettings, type ProviderKind, type TuesdaySettings as Settings } from '@shared/types'
import { api } from '../state/store'
import { PhoneSettings } from './PhoneSettings'
import { TelegramSettings } from './TelegramSettings'

/** Settings -> Tuesday: its name, and the provider and model it runs on. */
export function TuesdaySettings({ settings }: { settings: AppSettings }) {
  const t = settings.tuesday
  const d = settings.chatDefaults
  const set = (patch: Partial<Settings>) => void api().updateSettings({ tuesday: { ...t, ...patch } })
  const provider = t.provider ?? d.provider
  const models = settings.catalog[provider] ?? DEFAULT_CATALOG[provider]
  return (
    <div className="space-y-5" data-testid="tuesday-settings-tab">
      <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 bg-black/20 p-3">
        <input type="checkbox" className="mt-1" checked={t.enabled} onChange={(e) => set({ enabled: e.target.checked })} data-testid="tuesday-enabled" />
        <span>
          <span className="text-sm font-semibold">{t.name || 'Tuesday'}, in the corner</span>
          <span className="block text-xs text-indigo-200/70">
            The assistant above every chat in every open project: it knows what each chat is doing, starts and steers them, tells you when one finishes or asks something, and answers for you once you have said what to answer. It never changes files itself.
          </span>
        </span>
      </label>

      <section>
        <div className="label">Name</div>
        <input className="field max-w-xs" defaultValue={t.name} key={t.name} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== t.name && set({ name: e.target.value.trim().slice(0, 30) })} data-testid="tuesday-name" />
      </section>

      <section>
        <div className="label">Runs on</div>
        <div className="grid grid-cols-3 gap-2 rounded-xl border border-white/10 bg-black/20 p-3">
          <div>
            <label className="label">Provider</label>
            <select
              className="field !py-1 text-xs"
              value={t.provider ?? ''}
              onChange={(e) => {
                const p = (e.target.value || undefined) as ProviderKind | undefined
                if (!p) return set({ provider: undefined, model: undefined, effort: undefined })
                const list = settings.catalog[p] ?? DEFAULT_CATALOG[p]
                set({ provider: p, model: list[0]?.id ?? '', effort: clampEffort(p, t.effort ?? d.effort) })
              }}
              data-testid="tuesday-provider"
            >
              <option value="">Same as new chats ({PROVIDER_LABEL[d.provider]})</option>
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_LABEL[p]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Model</label>
            <input
              className="field !py-1 font-mono text-xs"
              list="tuesday-models"
              disabled={!t.provider}
              defaultValue={t.provider ? (t.model ?? '') : d.model}
              key={`${provider}${t.model ?? ''}`}
              onBlur={(e) => t.provider && e.target.value.trim() && e.target.value.trim() !== t.model && set({ model: e.target.value.trim() })}
              data-testid="tuesday-model"
            />
            <datalist id="tuesday-models">
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </datalist>
          </div>
          <div>
            <label className="label">Effort</label>
            <select className="field !py-1 text-xs" disabled={!t.provider} value={t.effort ?? d.effort} onChange={(e) => set({ effort: e.target.value as Settings['effort'] })}>
              {SUPPORTED_EFFORTS[provider].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </div>
          <div className="col-span-3 text-[11px] text-indigo-300/60">
            A quick model is plenty: {t.name || 'Tuesday'} mostly reads the workspace and passes messages on, and the chats do the heavy work on their own models. Changing the provider starts a new conversation with it.
          </div>
        </div>
      </section>

      <TelegramSettings settings={settings} />
      <PhoneSettings settings={settings} />
    </div>
  )
}
