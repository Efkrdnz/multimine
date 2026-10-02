import { useEffect, useState } from 'react'
import { CheckCircle2, KeyRound, Plug, Plus, RefreshCw, Save, Trash2, XCircle } from 'lucide-react'
import { DEFAULT_CATALOG, PROVIDER_LABEL, needsKey } from '@shared/catalog'
import { slugify } from '@shared/agentFile'
import { EFFORTS, PROVIDERS, type AppSettings, type CliStatus, type McpServerConfig, type ModelEntry, type ProviderKind } from '@shared/types'
import { api, useStore } from '../state/store'
import { Modal } from './Modal'

const TABS = [
  ['general', 'Economy & handoffs'],
  ['providers', 'Providers & keys'],
  ['models', 'Models'],
  ['council', 'Council'],
  ['mcp', 'MCP servers']
] as const
type Tab = (typeof TABS)[number][0]

function CliCard({ name, status, path, onPath }: { name: string; status?: CliStatus; path?: string; onPath: (p: string) => void }) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/25 p-3">
      <div className="flex items-center gap-2 text-sm font-semibold">
        {status === undefined ? <RefreshCw size={14} className="animate-spin" /> : status.installed && status.loggedIn !== false ? <CheckCircle2 size={15} className="text-emerald-300" /> : <XCircle size={15} className="text-amber-300" />}
        {name}
        <span className="font-mono text-[11px] font-normal text-indigo-300/70">{status?.version}</span>
      </div>
      {status?.detail && <div className="mt-1 text-xs text-indigo-200/70">{status.detail}</div>}
      <input className="field mt-2 font-mono text-xs" placeholder="Executable path (optional)" defaultValue={path} onBlur={(e) => onPath(e.target.value)} />
    </div>
  )
}

function Toggle({ on, onChange, title, help, testId }: { on: boolean; onChange: (v: boolean) => void; title: string; help: string; testId?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 bg-black/20 p-3">
      <input type="checkbox" className="mt-1" checked={on} onChange={(e) => onChange(e.target.checked)} data-testid={testId} />
      <span>
        <span className="text-sm font-semibold">{title}</span>
        <span className="block text-xs text-indigo-200/70">{help}</span>
      </span>
    </label>
  )
}

function General({ settings }: { settings: AppSettings }) {
  const eco = settings.economy
  const setEco = (patch: Partial<AppSettings['economy']>) => void api().updateSettings({ economy: { ...eco, ...patch } })
  const tierProviders = PROVIDERS.filter((p) => p !== 'mock')
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <div className="label">Economy mode</div>
        <Toggle
          on={eco.enabled}
          onChange={(v) => setEco({ enabled: v })}
          title="Save tokens"
          help="The master switch. Also on the top bar. What it does is chosen below."
          testId="economy-enabled"
        />
        <div className={`space-y-2 pl-6 ${eco.enabled ? '' : 'pointer-events-none opacity-40'}`}>
          <Toggle on={eco.concise} onChange={(v) => setEco({ concise: v })} title="Short answers" help="Every agent is told to answer and report briefly and to read only what it needs." />
          <Toggle
            on={eco.downshift}
            onChange={(v) => setEco({ downshift: v })}
            title="Cheaper models for easy tasks"
            help="Mastermind rates each handoff light, standard or heavy. Light and standard tasks run on the cheaper model below for that task only; the agent shows it in amber with a ⚡ and goes back to its own model afterwards. Heavy tasks are never downshifted."
          />
          <div className="rounded-xl border border-white/10 bg-black/20 p-3">
            <div className="mb-2 grid grid-cols-[180px_1fr_1fr] gap-2 text-[10px] font-bold uppercase tracking-wider text-indigo-300">
              <span>Provider</span>
              <span>Light task model (effort low)</span>
              <span>Standard task model (effort medium)</span>
            </div>
            {tierProviders.map((p) => {
              const t = eco.tiers[p] ?? {}
              const put = (k: 'light' | 'standard', v: string) => setEco({ tiers: { ...eco.tiers, [p]: { ...t, [k]: v || undefined } } })
              const list = settings.catalog[p] ?? DEFAULT_CATALOG[p]
              return (
                <div key={p} className="mb-1.5 grid grid-cols-[180px_1fr_1fr] items-center gap-2">
                  <span className="text-xs">{PROVIDER_LABEL[p].replace(' API key', '')}</span>
                  {(['light', 'standard'] as const).map((k) => (
                    <input key={k} className="field !py-1 font-mono text-[11px]" list={`tier-${p}`} placeholder="keep agent's model" defaultValue={t[k] ?? ''} onBlur={(e) => put(k, e.target.value.trim())} />
                  ))}
                  <datalist id={`tier-${p}`}>
                    {list.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </datalist>
                </div>
              )
            })}
            <div className="mt-1 text-[11px] text-indigo-300/60">Blank keeps the agent's model and only lowers its effort.</div>
          </div>
        </div>
      </section>
      <section>
        <div className="label">Handoffs</div>
        <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-black/20 p-3 text-sm">
          <span className="flex-1">
            Wait this many minutes for a delegated task before handing the caller its turn back
            <span className="block text-xs text-indigo-200/70">After that the report arrives as a new message, so long jobs (builds, implementations) never time out.</span>
          </span>
          <input
            className="field !w-20 text-center"
            type="number"
            min={1}
            max={50}
            defaultValue={settings.handoffWaitMinutes}
            onBlur={(e) => void api().updateSettings({ handoffWaitMinutes: Math.max(1, Math.min(50, Number(e.target.value) || 10)) })}
          />
        </div>
      </section>
    </div>
  )
}

function Providers({ settings }: { settings: AppSettings }) {
  const keyed = useStore((s) => s.keyed)
  const [clis, setClis] = useState<{ claude: CliStatus; codex: CliStatus } | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const detect = () => {
    setClis(null)
    void api().detectClis().then(setClis)
  }
  useEffect(detect, [])
  const saveKey = async (p: string, key: string | null) => {
    const k = await api().setKey(p, key)
    useStore.getState().set({ keyed: k })
    setDrafts((d) => ({ ...d, [p]: '' }))
  }
  const keyProviders = PROVIDERS.filter((p) => needsKey(p) || p === 'compatible')
  return (
    <div className="space-y-6">
      <section>
        <div className="mb-2 flex items-center">
          <div className="label flex-1">Subscriptions (through the official CLIs)</div>
          <button className="btn !py-1 text-xs" onClick={detect}>
            <RefreshCw size={12} /> Detect
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <CliCard name="Claude Code (Claude subscription)" status={clis?.claude} path={settings.claudePath} onPath={(p) => void api().updateSettings({ claudePath: p || undefined })} />
          <CliCard name="Codex CLI (ChatGPT subscription)" status={clis?.codex} path={settings.codexPath} onPath={(p) => void api().updateSettings({ codexPath: p || undefined })} />
        </div>
      </section>
      <section>
        <div className="label">API keys (encrypted on this machine, never written to the project)</div>
        <div className="space-y-2">
          {keyProviders.map((p) => (
            <div key={p} className="flex items-center gap-2">
              <div className="w-56 text-sm">
                {PROVIDER_LABEL[p]}
                {keyed.includes(p) && <span className="ml-2 rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] text-emerald-200">saved</span>}
              </div>
              <input className="field flex-1 font-mono text-xs" type="password" placeholder={keyed.includes(p) ? '•••••••• (replace)' : p === 'compatible' ? 'optional' : 'paste key'} value={drafts[p] ?? ''} onChange={(e) => setDrafts({ ...drafts, [p]: e.target.value })} />
              <button className="btn" disabled={!drafts[p]} onClick={() => void saveKey(p, drafts[p])}>
                <KeyRound size={13} /> Save
              </button>
              {keyed.includes(p) && (
                <button className="btn btn-danger !px-2" onClick={() => void saveKey(p, null)}>
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      </section>
      <section>
        <div className="label">Base URLs</div>
        {(['openrouter', 'compatible'] as ProviderKind[]).map((p) => (
          <div key={p} className="mb-2 flex items-center gap-2">
            <div className="w-56 text-sm">{PROVIDER_LABEL[p].replace(' API key', '')}</div>
            <input className="field flex-1 font-mono text-xs" defaultValue={settings.baseUrls[p]} onBlur={(e) => void api().updateSettings({ baseUrls: { ...settings.baseUrls, [p]: e.target.value } })} />
          </div>
        ))}
      </section>
    </div>
  )
}

function Models({ settings }: { settings: AppSettings }) {
  const [p, setP] = useState<ProviderKind>('claude-cli')
  const [id, setId] = useState('')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const list: ModelEntry[] = settings.catalog[p] ?? DEFAULT_CATALOG[p]
  const write = (next: ModelEntry[]) => void api().updateSettings({ catalog: { ...settings.catalog, [p]: next } })
  const refresh = async () => {
    setBusy(true)
    try {
      const got = await api().refreshModels(p)
      useStore.getState().toast('info', `${got.length} models from ${PROVIDER_LABEL[p]}`)
    } catch (e) {
      useStore.getState().toast('error', `Could not list models: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="grid grid-cols-[200px_1fr] gap-4">
      <div className="space-y-1">
        {PROVIDERS.map((x) => (
          <button key={x} className={`block w-full rounded-lg px-3 py-1.5 text-left text-xs ${p === x ? 'bg-violet-500/25 text-white' : 'text-indigo-200 hover:bg-white/5'}`} onClick={() => setP(x)}>
            {PROVIDER_LABEL[x]}
          </button>
        ))}
      </div>
      <div>
        <div className="mb-3 flex items-center gap-2">
          <div className="flex-1 text-xs text-indigo-200/70">The quick picks in the agent editor. Any id can still be typed there.</div>
          {!['claude-cli', 'codex-cli', 'mock'].includes(p) && (
            <button className="btn" onClick={refresh} disabled={busy}>
              <RefreshCw size={13} className={busy ? 'animate-spin' : ''} /> Refresh from vendor
            </button>
          )}
          <button className="btn" onClick={() => write(DEFAULT_CATALOG[p])}>
            Reset
          </button>
        </div>
        <div className="scroll-thin max-h-[42vh] space-y-1 overflow-y-auto">
          {list.map((m) => (
            <div key={m.id} className="flex items-center gap-2 rounded-lg bg-black/25 px-3 py-1.5 text-sm">
              <span className="w-48 truncate">{m.label}</span>
              <span className="flex-1 truncate font-mono text-xs text-indigo-300/80">{m.id}</span>
              <button className="text-red-300/70 hover:text-red-300" onClick={() => write(list.filter((x) => x.id !== m.id))}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <input className="field font-mono text-xs" placeholder="model id" value={id} onChange={(e) => setId(e.target.value)} />
          <input className="field text-xs" placeholder="label" value={label} onChange={(e) => setLabel(e.target.value)} />
          <button className="btn" disabled={!id.trim()} onClick={() => {
            write([...list.filter((x) => x.id !== id.trim()), { id: id.trim(), label: label.trim() || id.trim() }])
            setId('')
            setLabel('')
          }}>
            <Plus size={13} /> Add
          </button>
        </div>
      </div>
    </div>
  )
}

function Council({ settings }: { settings: AppSettings }) {
  const [c, setC] = useState(settings.council)
  const models = settings.catalog[c.provider] ?? DEFAULT_CATALOG[c.provider]
  return (
    <div className="space-y-4">
      <p className="text-xs text-indigo-200/70">
        When Mastermind runs a council, this many critics review a plan on a cheap model. Round one is blind; in round two each sees the others and must rebut or escalate. An approval only counts with three or more objections and none of them high, so agreeing is never free.
      </p>
      <div className="grid grid-cols-4 gap-3">
        <div>
          <label className="label">Critics</label>
          <input className="field" type="number" min={1} max={7} value={c.size} onChange={(e) => setC({ ...c, size: Math.max(1, Math.min(7, Number(e.target.value))) })} />
        </div>
        <div>
          <label className="label">Rounds</label>
          <select className="field" value={c.rounds} onChange={(e) => setC({ ...c, rounds: Number(e.target.value) as 1 | 2 })}>
            <option value={1}>1 (blind only)</option>
            <option value={2}>2 (cross-examine)</option>
          </select>
        </div>
        <div>
          <label className="label">Provider</label>
          <select className="field" value={c.provider} onChange={(e) => {
            const provider = e.target.value as ProviderKind
            setC({ ...c, provider, model: (settings.catalog[provider] ?? DEFAULT_CATALOG[provider])[0]?.id ?? '' })
          }}>
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_LABEL[p]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Effort</label>
          <select className="field" value={c.effort} onChange={(e) => setC({ ...c, effort: e.target.value as typeof c.effort })}>
            {EFFORTS.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </div>
        <div className="col-span-4">
          <label className="label">Model</label>
          <input className="field font-mono" list="council-models" value={c.model} onChange={(e) => setC({ ...c, model: e.target.value })} />
          <datalist id="council-models">
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </datalist>
        </div>
      </div>
      <div>
        <label className="label">Perspectives (one critic each, cycled)</label>
        {c.lenses.map((l, i) => (
          <div key={i} className="mb-1.5 flex gap-2">
            <input className="field text-xs" value={l} onChange={(e) => setC({ ...c, lenses: c.lenses.map((x, j) => (j === i ? e.target.value : x)) })} />
            <button className="btn btn-danger !px-2" onClick={() => setC({ ...c, lenses: c.lenses.filter((_, j) => j !== i) })} disabled={c.lenses.length <= 1}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        <button className="btn mt-1" onClick={() => setC({ ...c, lenses: [...c.lenses, 'New perspective: what it looks for'] })}>
          <Plus size={13} /> Add perspective
        </button>
      </div>
      <button className="btn btn-primary" onClick={() => void api().updateSettings({ council: c }).then(() => useStore.getState().toast('info', 'Council saved'))}>
        <Save size={14} /> Save council
      </button>
    </div>
  )
}

const BLANK: McpServerConfig = { id: '', name: '', transport: 'http', url: '', headers: {}, command: '', args: [], env: {} }

/**
 * Starters for the generation services. Meshy and WaveSpeed publish MCP servers (npm and PyPI);
 * paste your key into the env. Higgsfield has no published server here, so it is name-only.
 */
const PRESETS: { name: string; hint: string; cfg: Partial<McpServerConfig> }[] = [
  {
    name: 'Meshy',
    hint: '3D models (text/image to 3D). Needs Node. Key from meshy.ai/settings/api.',
    cfg: { id: 'meshy', transport: 'stdio', command: 'npx', args: ['-y', '@meshy-ai/meshy-mcp-server'], env: { MESHY_API_KEY: '' } }
  },
  {
    name: 'WaveSpeed',
    hint: 'Images and video. Needs uv (pip install uv) or pip install wavespeed-mcp. Key from wavespeed.ai.',
    cfg: { id: 'wavespeed', transport: 'stdio', command: 'uvx', args: ['wavespeed-mcp'], env: { WAVESPEED_API_KEY: '' } }
  },
  { name: 'Higgsfield', hint: 'Image & video. Paste the MCP URL or command from your Higgsfield account.', cfg: { id: 'higgsfield' } }
]

function kv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}
const unkv = (r?: Record<string, string>) => Object.entries(r ?? {}).map(([k, v]) => `${k}=${v}`).join('\n')

/** Which agents may use a server, toggled straight from its card. */
function AgentChips({ server }: { server: string }) {
  const agents = useStore((s) => s.project?.agents)
  if (!agents) return null
  return (
    <div className="flex max-w-[320px] flex-wrap justify-end gap-1">
      {agents.map((a) => {
        const on = a.mcp.includes(server)
        return (
          <button
            key={a.id}
            className={`rounded-full border px-2 py-0.5 text-[10px] ${on ? 'border-cyan-400 bg-cyan-500/20 text-cyan-50' : 'border-white/10 text-indigo-300/70 hover:border-white/25'}`}
            title={on ? `${a.name} can use this server` : `Let ${a.name} use this server`}
            onClick={() => void api().saveAgent({ ...a, mcp: on ? a.mcp.filter((x) => x !== server) : [...a.mcp, server] }, false)}
          >
            {a.name}
          </button>
        )
      })}
    </div>
  )
}

function Mcp({ settings }: { settings: AppSettings }) {
  const [edit, setEdit] = useState<McpServerConfig | null>(null)
  const [test, setTest] = useState<{ ok: boolean; tools: string[]; error?: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const save = async () => {
    if (!edit) return
    const id = edit.id || slugify(edit.name)
    const cfg = { ...edit, id }
    await api().updateSettings({ mcpServers: [...settings.mcpServers.filter((s) => s.id !== id), cfg] })
    setEdit(null)
    setTest(null)
  }
  const run = async () => {
    if (!edit) return
    setTesting(true)
    setTest(await api().testMcp({ ...edit, id: edit.id || slugify(edit.name) }))
    setTesting(false)
  }
  if (edit)
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Name</label>
            <input className="field" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
          </div>
          <div>
            <label className="label">Transport</label>
            <select className="field" value={edit.transport} onChange={(e) => setEdit({ ...edit, transport: e.target.value as McpServerConfig['transport'] })}>
              <option value="http">HTTP (streamable)</option>
              <option value="stdio">stdio (local command)</option>
            </select>
          </div>
        </div>
        {edit.transport === 'http' ? (
          <>
            <div>
              <label className="label">URL</label>
              <input className="field font-mono text-xs" value={edit.url} onChange={(e) => setEdit({ ...edit, url: e.target.value })} placeholder="https://.../mcp" />
            </div>
            <div>
              <label className="label">Headers (KEY=value per line)</label>
              <textarea className="field min-h-16 font-mono text-xs" defaultValue={unkv(edit.headers)} onBlur={(e) => setEdit({ ...edit, headers: kv(e.target.value) })} placeholder="Authorization=Bearer ..." />
            </div>
          </>
        ) : (
          <>
            <div className="grid grid-cols-[1fr_2fr] gap-3">
              <div>
                <label className="label">Command</label>
                <input className="field font-mono text-xs" value={edit.command} onChange={(e) => setEdit({ ...edit, command: e.target.value })} placeholder="npx" />
              </div>
              <div>
                <label className="label">Arguments (space separated)</label>
                <input className="field font-mono text-xs" defaultValue={(edit.args ?? []).join(' ')} onBlur={(e) => setEdit({ ...edit, args: e.target.value.split(/\s+/).filter(Boolean) })} />
              </div>
            </div>
            <div>
              <label className="label">Environment (KEY=value per line)</label>
              <textarea className="field min-h-16 font-mono text-xs" defaultValue={unkv(edit.env)} onBlur={(e) => setEdit({ ...edit, env: kv(e.target.value) })} />
            </div>
          </>
        )}
        {test && (
          <div className={`rounded-lg border p-3 text-xs ${test.ok ? 'border-emerald-400/30 bg-emerald-950/30' : 'border-red-400/30 bg-red-950/30'}`}>
            {test.ok ? `Connected. ${test.tools.length} tools: ${test.tools.join(', ')}` : `Failed: ${test.error}`}
          </div>
        )}
        <div className="flex gap-2">
          <button className="btn" onClick={() => setEdit(null)}>
            Cancel
          </button>
          <div className="flex-1" />
          <button className="btn" onClick={run} disabled={testing || !edit.name}>
            <Plug size={13} /> {testing ? 'Testing...' : 'Test connection'}
          </button>
          <button className="btn btn-primary" onClick={save} disabled={!edit.name}>
            <Save size={13} /> Save server
          </button>
        </div>
      </div>
    )
  return (
    <div className="space-y-4">
      <p className="text-xs text-indigo-200/70">
        Connect any MCP server - image, video and 3D generators like Higgsfield, Meshy or WaveSpeed, or anything else - then tick it on an agent in the agent editor. Claude and Codex agents get the server directly; API agents get its tools through Multimine. Generated media is saved and previewed in the gallery.
      </p>
      <div className="space-y-2">
        {settings.mcpServers.map((s) => (
          <div key={s.id} className="flex items-center gap-3 rounded-xl border border-white/10 bg-black/25 px-3 py-2">
            <Plug size={15} className="text-cyan-300" />
            <div className="flex-1">
              <div className="text-sm font-semibold">{s.name}</div>
              <div className="font-mono text-[11px] text-indigo-300/70">{s.transport === 'http' ? s.url : `${s.command} ${(s.args ?? []).join(' ')}`}</div>
            </div>
            <AgentChips server={s.id} />
            <button className="btn !py-1" onClick={() => setEdit(s)}>
              Edit
            </button>
            <button className="btn btn-danger !px-2 !py-1" onClick={() => void api().updateSettings({ mcpServers: settings.mcpServers.filter((x) => x.id !== s.id) })}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary" onClick={() => setEdit({ ...BLANK })}>
          <Plus size={13} /> Add server
        </button>
        {PRESETS.map((p) => (
          <button key={p.name} className="btn" title={p.hint} onClick={() => setEdit({ ...BLANK, ...p.cfg, name: p.name })}>
            <Plus size={13} /> {p.name}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-indigo-300/50">Meshy and WaveSpeed fill in their published servers - add your key under Environment. Higgsfield fills in only the name.</p>
    </div>
  )
}

export function SettingsModal({ initialTab }: { initialTab?: string }) {
  const settings = useStore((s) => s.settings)
  const [tab, setTab] = useState<Tab>((TABS.find((t) => t[0] === initialTab)?.[0] ?? 'general') as Tab)
  if (!settings) return null
  return (
    <Modal title="Settings" onClose={() => useStore.getState().set({ modal: null })}>
      <div className="flex gap-1 border-b border-white/10 px-5 pt-2">
        {TABS.map(([k, label]) => (
          <button key={k} className={`rounded-t-lg px-3 py-2 text-xs font-semibold ${tab === k ? 'bg-white/10 text-white' : 'text-indigo-300 hover:text-white'}`} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      <div className="scroll-thin min-h-[60vh] overflow-y-auto p-5">
        {tab === 'general' && <General settings={settings} />}
        {tab === 'providers' && <Providers settings={settings} />}
        {tab === 'models' && <Models settings={settings} />}
        {tab === 'council' && <Council settings={settings} />}
        {tab === 'mcp' && <Mcp settings={settings} />}
      </div>
    </Modal>
  )
}
