import { useCallback, useEffect, useState } from 'react'
import { ArrowDownToLine, ArrowUpFromLine, ExternalLink, GitBranch, GitCommitHorizontal, GitPullRequest, KeyRound, Minus, Plus, RefreshCw, CircleDot } from 'lucide-react'
import type { GhItem, GitCommit, GitFile, GitStatus } from '@shared/types'
import { api, useStore } from '../state/store'
import { Drawer } from './Drawer'

type Tab = 'changes' | 'history' | 'github'

const LETTER: Record<string, string> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', U: 'conflict', '?': 'new' }

function letterOf(f: GitFile): string {
  return f.untracked ? '?' : f.staged ? f.index : f.worktree
}

function letterColor(l: string): string {
  return l === 'D' ? 'text-red-300' : l === '?' || l === 'A' ? 'text-emerald-300' : l === 'U' ? 'text-orange-300' : 'text-amber-200'
}

/** A unified diff, coloured by line. */
function Diff({ text }: { text: string }) {
  return (
    <pre className="scroll-thin max-h-[42vh] overflow-auto rounded-lg border border-white/10 bg-black/40 p-2 font-mono text-[11px] leading-[1.45] select-text">
      {text.split('\n').map((l, i) => (
        <div
          key={i}
          className={
            l.startsWith('+') && !l.startsWith('+++')
              ? 'bg-emerald-500/10 text-emerald-200'
              : l.startsWith('-') && !l.startsWith('---')
                ? 'bg-red-500/10 text-red-200'
                : l.startsWith('@@')
                  ? 'text-cyan-300'
                  : 'text-slate-300'
          }
        >
          {l || ' '}
        </div>
      ))}
    </pre>
  )
}

export function GitPanel() {
  const toast = useStore((s) => s.toast)
  const busCount = useStore((s) => s.bus.length)
  const keyed = useStore((s) => s.keyed)
  const [tab, setTab] = useState<Tab>('changes')
  const [st, setSt] = useState<GitStatus | null>(null)
  const [branches, setBranches] = useState<{ current: string; local: string[] }>({ current: '', local: [] })
  const [sel, setSel] = useState<GitFile | null>(null)
  const [diff, setDiff] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [log, setLog] = useState<GitCommit[]>([])
  const [shown, setShown] = useState<{ hash: string; text: string } | null>(null)
  const [gh, setGh] = useState<{ repo: string | null; auth: 'token' | 'gh' | null } | null>(null)
  const [pulls, setPulls] = useState<GhItem[] | null>(null)
  const [issues, setIssues] = useState<GhItem[] | null>(null)
  const [ghError, setGhError] = useState('')
  const [token, setToken] = useState('')
  const [pr, setPr] = useState({ title: '', body: '' })

  const refresh = useCallback(async () => {
    try {
      const s = await api().gitStatus()
      setSt(s)
      if (s.isRepo) setBranches(await api().gitBranches())
    } catch (e) {
      toast('error', String((e as Error).message))
    }
  }, [toast])

  // refresh on open, every few seconds, and whenever agents talk (they may have changed files)
  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), 5000)
    return () => clearInterval(t)
  }, [refresh])
  useEffect(() => {
    void refresh()
  }, [busCount, refresh])

  useEffect(() => {
    if (!sel) return setDiff('')
    void api().gitDiff(sel.path, sel.staged, sel.untracked).then(setDiff).catch((e) => setDiff(String(e.message)))
  }, [sel, st])

  useEffect(() => {
    if (tab === 'history') void api().gitLog().then(setLog)
    if (tab === 'github') void loadGithub()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, keyed])

  async function loadGithub() {
    setGhError('')
    try {
      const info = await api().ghInfo()
      setGh(info)
      if (info.repo && info.auth) {
        const [p, i] = await Promise.all([api().ghList('pulls'), api().ghList('issues')])
        setPulls(p)
        setIssues(i)
      }
    } catch (e) {
      setGhError(String((e as Error).message))
    }
  }

  async function act(label: string, fn: () => Promise<unknown>, done?: (r: unknown) => void) {
    setBusy(label)
    try {
      const r = await fn()
      done?.(r)
      await refresh()
    } catch (e) {
      toast('error', `${label}: ${String((e as Error).message).slice(0, 400)}`)
    } finally {
      setBusy(null)
    }
  }

  const staged = st?.files.filter((f) => f.staged) ?? []
  const unstaged = st?.files.filter((f) => !f.staged) ?? []

  const fileRow = (f: GitFile) => {
    const l = letterOf(f)
    const on = sel?.path === f.path && sel.staged === f.staged
    return (
      <div key={`${f.staged}:${f.path}`} className={`group flex items-center gap-2 rounded-md px-2 py-1 text-xs ${on ? 'bg-violet-500/20' : 'hover:bg-white/5'}`}>
        <button className={`w-4 font-mono font-bold ${letterColor(l)}`} title={LETTER[l] ?? l}>
          {l === '?' ? 'U' : l}
        </button>
        <button className="flex-1 truncate text-left font-mono" onClick={() => setSel(f)} title={f.path}>
          {f.path}
        </button>
        <button
          className="opacity-0 group-hover:opacity-100"
          title={f.staged ? 'Unstage' : 'Stage'}
          onClick={() => void act(f.staged ? 'Unstage' : 'Stage', () => (f.staged ? api().gitUnstage([f.path]) : api().gitStage([f.path])))}
        >
          {f.staged ? <Minus size={13} /> : <Plus size={13} />}
        </button>
      </div>
    )
  }

  return (
    <Drawer title="Repository" icon={<GitBranch size={17} className="text-orange-300" />} width="w-[760px]">
      {!st ? (
        <div className="text-sm text-indigo-300/70">Reading the repository...</div>
      ) : !st.isRepo ? (
        <div className="mt-8 text-center text-sm text-indigo-200/80">
          This project folder is not a git repository yet.
          <div className="mt-4">
            <button className="btn btn-primary" onClick={() => void act('git init', () => api().gitInit())}>
              Initialise git here
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <select
              className="field !w-auto !py-1 font-mono text-xs"
              value={branches.current}
              onChange={(e) => {
                const v = e.target.value
                if (v === '__new') {
                  const name = prompt('New branch name')
                  if (name) void act('Create branch', () => api().gitCheckout(name.trim(), true))
                } else void act('Switch branch', () => api().gitCheckout(v, false))
              }}
              data-testid="git-branch"
            >
              {branches.local.map((b) => (
                <option key={b}>{b}</option>
              ))}
              {!branches.local.includes(branches.current) && <option>{branches.current || st.branch}</option>}
              <option value="__new">+ New branch...</option>
            </select>
            <span className="font-mono text-[11px] text-indigo-300/80">
              {st.upstream ? `${st.upstream} · ↑${st.ahead} ↓${st.behind}` : 'no upstream'}
            </span>
            <div className="flex-1" />
            <button className="btn !py-1 text-xs" disabled={!!busy} onClick={() => void act('Pull', () => api().gitPull(), (r) => toast('info', String(r)))}>
              <ArrowDownToLine size={13} /> Pull
            </button>
            <button className="btn !py-1 text-xs" disabled={!!busy || !st.remote} onClick={() => confirm(`Push ${st.branch} to origin?`) && void act('Push', () => api().gitPush(), (r) => toast('info', String(r).slice(0, 300)))}>
              <ArrowUpFromLine size={13} /> Push
            </button>
            <button className="btn btn-ghost !p-1.5" onClick={() => void refresh()} title="Refresh">
              <RefreshCw size={14} className={busy ? 'animate-spin' : ''} />
            </button>
          </div>

          <div className="mb-4 flex gap-1 rounded-lg bg-black/30 p-1 text-xs">
            {(['changes', 'history', 'github'] as Tab[]).map((t) => (
              <button key={t} className={`flex-1 rounded-md py-1.5 font-semibold capitalize ${tab === t ? 'bg-violet-500/30 text-white' : 'text-indigo-300'}`} onClick={() => setTab(t)}>
                {t === 'changes' ? `Changes (${st.files.length})` : t === 'github' ? 'GitHub' : 'History'}
              </button>
            ))}
          </div>

          {tab === 'changes' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="mb-1 flex items-center">
                    <span className="label flex-1">Staged ({staged.length})</span>
                    {!!staged.length && (
                      <button className="text-[10px] text-indigo-300 hover:text-white" onClick={() => void act('Unstage', () => api().gitUnstage(staged.map((f) => f.path)))}>
                        unstage all
                      </button>
                    )}
                  </div>
                  <div className="scroll-thin max-h-48 overflow-y-auto rounded-lg border border-white/10 bg-black/20 p-1">{staged.length ? staged.map(fileRow) : <div className="p-2 text-[11px] text-indigo-300/50">Nothing staged</div>}</div>
                </div>
                <div>
                  <div className="mb-1 flex items-center">
                    <span className="label flex-1">Changes ({unstaged.length})</span>
                    {!!unstaged.length && (
                      <button className="text-[10px] text-indigo-300 hover:text-white" onClick={() => void act('Stage', () => api().gitStage(unstaged.map((f) => f.path)))} data-testid="git-stage-all">
                        stage all
                      </button>
                    )}
                  </div>
                  <div className="scroll-thin max-h-48 overflow-y-auto rounded-lg border border-white/10 bg-black/20 p-1">{unstaged.length ? unstaged.map(fileRow) : <div className="p-2 text-[11px] text-indigo-300/50">Working tree clean</div>}</div>
                </div>
              </div>
              <div className="flex gap-2">
                <input className="field font-mono text-xs" placeholder="Commit message" value={msg} onChange={(e) => setMsg(e.target.value)} data-testid="git-message" />
                <button
                  className="btn btn-primary shrink-0"
                  disabled={!staged.length || !msg.trim() || !!busy}
                  onClick={() => void act('Commit', () => api().gitCommit(msg), () => (setMsg(''), toast('info', 'Committed')))}
                  data-testid="git-commit"
                >
                  <GitCommitHorizontal size={14} /> Commit {staged.length ? `(${staged.length})` : ''}
                </button>
              </div>
              {sel && (
                <div>
                  <div className="mb-1 font-mono text-[11px] text-indigo-200">
                    {sel.path} {sel.staged ? '(staged)' : ''}
                  </div>
                  <Diff text={diff} />
                </div>
              )}
            </div>
          )}

          {tab === 'history' && (
            <div className="space-y-1">
              {shown && (
                <div className="mb-3">
                  <button className="btn mb-2 !py-1 text-xs" onClick={() => setShown(null)}>
                    Back to history
                  </button>
                  <Diff text={shown.text} />
                </div>
              )}
              {!shown &&
                log.map((c) => (
                  <button key={c.hash} className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-xs hover:bg-white/5" onClick={() => void api().gitShow(c.hash).then((text) => setShown({ hash: c.hash, text }))}>
                    <span className="font-mono text-amber-200">{c.short}</span>
                    <span className="flex-1 truncate">{c.subject}</span>
                    <span className="shrink-0 text-indigo-300/70">{c.author}</span>
                    <span className="w-24 shrink-0 text-right text-indigo-300/50">{c.when}</span>
                  </button>
                ))}
              {!shown && !log.length && <div className="text-sm text-indigo-300/60">No commits yet.</div>}
            </div>
          )}

          {tab === 'github' && (
            <div className="space-y-4">
              {!gh ? (
                <div className="text-sm text-indigo-300/70">Checking GitHub...</div>
              ) : !gh.repo ? (
                <div className="text-sm text-indigo-200/80">No GitHub remote. Add one as <code className="font-mono">origin</code> (e.g. <code className="font-mono">git remote add origin https://github.com/you/repo.git</code>).</div>
              ) : (
                <>
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-mono font-semibold">{gh.repo}</span>
                    <button className="btn btn-ghost !p-1" onClick={() => window.open(`https://github.com/${gh.repo}`)}>
                      <ExternalLink size={13} />
                    </button>
                    <span className="flex-1" />
                    <span className="text-[11px] text-indigo-300/70">{gh.auth === 'token' ? 'using your token' : gh.auth === 'gh' ? 'using the gh CLI login' : 'not signed in'}</span>
                    <button className="btn btn-ghost !p-1" onClick={() => void loadGithub()}>
                      <RefreshCw size={13} />
                    </button>
                  </div>
                  {!gh.auth && (
                    <div className="rounded-lg border border-amber-300/30 bg-amber-500/5 p-3 text-xs">
                      Sign in to see pull requests and issues: run <code className="font-mono">gh auth login</code>, or paste a GitHub token (repo scope). It is stored encrypted like your API keys.
                      <div className="mt-2 flex gap-2">
                        <input className="field font-mono text-xs" type="password" placeholder="ghp_... or github_pat_..." value={token} onChange={(e) => setToken(e.target.value)} />
                        <button className="btn" disabled={!token} onClick={() => void api().setKey('github', token).then((k) => (setToken(''), useStore.getState().set({ keyed: k })))}>
                          <KeyRound size={13} /> Save
                        </button>
                      </div>
                    </div>
                  )}
                  {ghError && <div className="rounded-lg border border-red-400/30 bg-red-950/30 p-2 text-xs text-red-100">{ghError}</div>}
                  {gh.auth && (
                    <>
                      <section>
                        <div className="label">New pull request from {st.branch}</div>
                        <input className="field mb-2 text-xs" placeholder="Title" value={pr.title} onChange={(e) => setPr({ ...pr, title: e.target.value })} />
                        <textarea className="field mb-2 min-h-16 text-xs" placeholder="Description" value={pr.body} onChange={(e) => setPr({ ...pr, body: e.target.value })} />
                        <button
                          className="btn btn-primary"
                          disabled={!pr.title.trim() || !!busy}
                          onClick={() =>
                            void act('Create PR', () => api().ghCreatePr(pr.title, pr.body), (r) => {
                              setPr({ title: '', body: '' })
                              window.open((r as GhItem).url)
                              void loadGithub()
                            })
                          }
                        >
                          <GitPullRequest size={13} /> Create pull request
                        </button>
                        <span className="ml-2 text-[11px] text-indigo-300/60">Push the branch first.</span>
                      </section>
                      {[
                        ['Open pull requests', pulls, GitPullRequest] as const,
                        ['Open issues', issues, CircleDot] as const
                      ].map(([title, list, Icon]) => (
                        <section key={title}>
                          <div className="label">
                            {title} {list ? `(${list.length})` : ''}
                          </div>
                          {list?.length === 0 && <div className="text-xs text-indigo-300/50">None.</div>}
                          {list?.map((i) => (
                            <button key={i.number} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-white/5" onClick={() => window.open(i.url)}>
                              <Icon size={13} className="shrink-0 text-emerald-300" />
                              <span className="text-indigo-300/70">#{i.number}</span>
                              <span className="flex-1 truncate">{i.title}</span>
                              {i.head && <span className="shrink-0 font-mono text-[10px] text-indigo-300/60">{i.head} → {i.base}</span>}
                              <span className="shrink-0 text-indigo-300/60">{i.author}</span>
                            </button>
                          ))}
                        </section>
                      ))}
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}
    </Drawer>
  )
}
