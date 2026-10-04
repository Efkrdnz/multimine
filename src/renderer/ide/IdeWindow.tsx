import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { ChevronDown, ChevronRight, Code2, ExternalLink, File, Folder, FolderOpen, Plus, Save, Search, SquareTerminal, X } from 'lucide-react'
import type { IdeEntry, IdeHit, TerminalInfo, TerminalKind } from '@shared/types'
import { SIDE_DOCK, api, onMainEvent, useStore } from '../state/store'
import { languageOf } from './monaco'
import { attachTerminal, forgetTerminal } from './terminalBus'

// ---------------------------------------------------------------- navigator

function TreeNode({ entry, depth, open, onOpen }: { entry: IdeEntry; depth: number; open: (p: string) => void; onOpen: string | null }) {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<IdeEntry[] | null>(null)
  const version = useStore((s) => s.ide) // re-read when the window reopens

  const load = useCallback(() => void api().ideList(entry.path).then(setChildren), [entry.path])
  useEffect(() => {
    if (expanded) load()
  }, [expanded, load, version])
  // folders follow files coming and going
  useEffect(
    () =>
      onMainEvent((e) => {
        if (expanded && e.type === 'file-changed' && e.kind !== 'changed' && e.path.startsWith(`${entry.path}/`) && !e.path.slice(entry.path.length + 1).includes('/')) load()
      }),
    [expanded, entry.path, load]
  )

  const pad = { paddingLeft: 8 + depth * 12 }
  if (!entry.dir)
    return (
      <button className={`flex w-full items-center gap-1.5 truncate py-[3px] pr-2 text-left text-[12px] ${onOpen === entry.path ? 'bg-violet-500/25 text-white' : 'text-indigo-100/90 hover:bg-white/5'}`} style={pad} onClick={() => open(entry.path)} title={entry.path}>
        <File size={12} className="shrink-0 text-indigo-300/70" />
        <span className="truncate">{entry.name}</span>
      </button>
    )
  return (
    <div>
      <button className="flex w-full items-center gap-1 truncate py-[3px] pr-2 text-left text-[12px] text-indigo-100 hover:bg-white/5" style={pad} onClick={() => setExpanded(!expanded)}>
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {expanded ? <FolderOpen size={12} className="shrink-0 text-amber-300/80" /> : <Folder size={12} className="shrink-0 text-amber-300/80" />}
        <span className="truncate">{entry.name}</span>
      </button>
      {expanded && children?.map((c) => <TreeNode key={c.path} entry={c} depth={depth + 1} open={open} onOpen={onOpen} />)}
    </div>
  )
}

function Navigator({ open, active }: { open: (path: string, line?: number) => void; active: string | null }) {
  const [root, setRoot] = useState<IdeEntry[]>([])
  const [query, setQuery] = useState('')
  const [inFiles, setInFiles] = useState(false)
  const [hits, setHits] = useState<IdeHit[] | null>(null)
  const project = useStore((s) => s.project?.dir)

  const loadRoot = useCallback(() => void api().ideList('').then(setRoot), [])
  useEffect(loadRoot, [loadRoot, project])
  useEffect(() => onMainEvent((e) => e.type === 'file-changed' && e.kind !== 'changed' && !e.path.includes('/') && loadRoot()), [loadRoot])

  useEffect(() => {
    const q = query.trim()
    if (!q) return setHits(null)
    const t = setTimeout(() => void (inFiles ? api().ideGrep(q) : api().ideFind(q)).then(setHits), inFiles ? 250 : 60)
    return () => clearTimeout(t)
  }, [query, inFiles])

  return (
    <div className="flex h-full w-[250px] shrink-0 flex-col border-r border-white/10">
      <div className="p-2">
        <div className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-black/40 px-2 focus-within:border-violet-400/60">
          <Search size={13} className="shrink-0 text-indigo-300/70" />
          <input className="w-full bg-transparent py-1.5 text-xs outline-none" placeholder={inFiles ? 'Search inside files' : 'Find a file'} value={query} onChange={(e) => setQuery(e.target.value)} data-testid="ide-search" />
          {query && (
            <button onClick={() => setQuery('')}>
              <X size={12} />
            </button>
          )}
        </div>
        <label className="mt-1.5 flex items-center gap-1.5 text-[10px] text-indigo-300/80">
          <input type="checkbox" checked={inFiles} onChange={(e) => setInFiles(e.target.checked)} /> search inside files
        </label>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto pb-2">
        {hits
          ? hits.length === 0
            ? <div className="px-3 text-xs text-indigo-300/60">No matches.</div>
            : hits.map((h, i) => (
                <button key={`${h.path}:${h.line ?? i}`} className="block w-full px-3 py-1 text-left hover:bg-white/5" onClick={() => open(h.path, h.line)} data-testid="ide-hit">
                  <div className="truncate text-[12px] text-indigo-100">
                    {h.path.slice(h.path.lastIndexOf('/') + 1)}
                    {h.line ? <span className="text-indigo-300/60">:{h.line}</span> : null}
                  </div>
                  <div className="truncate font-mono text-[10px] text-indigo-300/60">{h.text ?? h.path}</div>
                </button>
              ))
          : root.map((e) => <TreeNode key={e.path} entry={e} depth={0} open={(p) => open(p)} onOpen={active} />)}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- editor

interface Tab {
  path: string
  text: string
  saved: string
  readOnly?: string
  /** The file changed on disk while this tab held unsaved edits. */
  diskChanged?: boolean
}

function EditorPane({ tabs, setTabs, active, setActive, reveal }: { tabs: Tab[]; setTabs: (fn: (t: Tab[]) => Tab[]) => void; active: string | null; setActive: (p: string | null) => void; reveal: { path: string; line: number; n: number } | null }) {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null)
  const tab = tabs.find((t) => t.path === active) ?? null

  const save = useCallback(async () => {
    if (!tab || tab.readOnly) return
    // the editor holds the truth: a save straight after typing must not write the text of a render ago
    const text = editorRef.current?.getModel()?.uri.path.endsWith(tab.path) ? editorRef.current.getValue() : tab.text
    if (text === tab.saved) return
    await api().ideWrite(tab.path, text)
    setTabs((ts) => ts.map((t) => (t.path === tab.path ? { ...t, text, saved: text, diskChanged: false } : t)))
  }, [tab, setTabs])

  // Monaco keeps the key presses it gets, so Ctrl+S inside the editor is one of its own commands;
  // the window listener below covers focus anywhere else in the code window
  const saveRef = useRef(save)
  saveRef.current = save

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && useStore.getState().ide === 'open') {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [save])

  useEffect(() => {
    if (!reveal || reveal.path !== active) return
    const ed = editorRef.current
    const t = setTimeout(() => {
      ed?.revealLineInCenter(reveal.line)
      ed?.setPosition({ lineNumber: reveal.line, column: 1 })
      ed?.focus()
    }, 50)
    return () => clearTimeout(t)
  }, [reveal, active])

  const close = (path: string) => {
    const t = tabs.find((x) => x.path === path)
    if (t && t.text !== t.saved && !confirm(`${path} has unsaved changes. Close anyway?`)) return
    const rest = tabs.filter((x) => x.path !== path)
    setTabs(() => rest)
    if (active === path) setActive(rest.at(-1)?.path ?? null)
  }

  const reload = async () => {
    if (!tab) return
    const r = await api().ideRead(tab.path)
    setTabs((ts) => ts.map((t) => (t.path === tab.path ? { ...t, text: r.text, saved: r.text, diskChanged: false } : t)))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="scroll-thin flex items-center gap-0.5 overflow-x-auto border-b border-white/10 px-1 pt-1">
        {tabs.map((t) => (
          <div key={t.path} className={`flex shrink-0 items-center gap-1.5 rounded-t-md px-2.5 py-1 text-[11px] ${t.path === active ? 'bg-[#080a1c] text-white' : 'text-indigo-300 hover:bg-white/5'}`}>
            <button onClick={() => setActive(t.path)} title={t.path}>
              {t.path.slice(t.path.lastIndexOf('/') + 1)}
            </button>
            {t.text !== t.saved ? <span className="h-1.5 w-1.5 rounded-full bg-amber-300" /> : null}
            <button className="opacity-60 hover:opacity-100" onClick={() => close(t.path)}>
              <X size={11} />
            </button>
          </div>
        ))}
        <div className="flex-1" />
        {tab && (
          <div className="flex shrink-0 items-center gap-1 pb-1 pr-1">
            <button className="btn btn-ghost !px-1.5 !py-0.5 text-[10px]" title="Save (Ctrl+S)" disabled={tab.text === tab.saved} onClick={() => void save()} data-testid="ide-save">
              <Save size={12} />
            </button>
            <button className="btn btn-ghost !px-1.5 !py-0.5 text-[10px]" title="Open in IntelliJ IDEA" onClick={() => void api().ideOpenExternal(tab.path, 'idea')}>
              <ExternalLink size={11} /> IntelliJ
            </button>
            <button className="btn btn-ghost !px-1.5 !py-0.5 text-[10px]" title="Open in VS Code" onClick={() => void api().ideOpenExternal(tab.path, 'code')}>
              <ExternalLink size={11} /> VS Code
            </button>
          </div>
        )}
      </div>
      {tab?.diskChanged && (
        <div className="flex items-center gap-2 bg-amber-500/15 px-3 py-1 text-[11px] text-amber-100">
          This file changed on disk while you were editing it.
          <button className="underline" onClick={() => void reload()}>
            Load theirs
          </button>
          <button className="underline" onClick={() => setTabs((ts) => ts.map((t) => (t.path === tab.path ? { ...t, diskChanged: false } : t)))}>
            Keep mine
          </button>
        </div>
      )}
      <div className="relative min-h-0 flex-1 bg-[#080a1c]">
        {!tab ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-indigo-300/60">
            <Code2 size={28} className="text-violet-300/50" />
            Open a file from the navigator, or find one with the search bar.
          </div>
        ) : tab.readOnly ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-indigo-300/70">{tab.readOnly}</div>
        ) : (
          <Editor
            path={tab.path}
            value={tab.text}
            language={languageOf(tab.path)}
            theme="multimine"
            onMount={(ed, monaco) => {
              editorRef.current = ed
              ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveRef.current())
            }}
            onChange={(v) => setTabs((ts) => ts.map((t) => (t.path === tab.path ? { ...t, text: v ?? '' } : t)))}
            options={{ fontSize: 13, fontFamily: 'JetBrains Mono, ui-monospace, monospace', minimap: { enabled: true, scale: 1 }, scrollBeyondLastLine: false, smoothScrolling: true, automaticLayout: true, tabSize: 4 }}
          />
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- terminal

function TerminalView({ info, visible }: { info: TerminalInfo; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const fit = useRef<FitAddon | null>(null)

  useEffect(() => {
    const term = new Terminal({
      fontFamily: 'JetBrains Mono, ui-monospace, monospace',
      fontSize: 12.5,
      cursorBlink: true,
      allowProposedApi: true,
      theme: { background: '#05060f', foreground: '#e5e7ff', cursor: '#c084fc', selectionBackground: '#3b2f7a', black: '#1e2040', brightBlack: '#4b5080', magenta: '#c084fc', cyan: '#67e8f9', green: '#86efac', yellow: '#fcd34d', blue: '#93c5fd', red: '#fca5a5' }
    })
    const f = new FitAddon()
    fit.current = f
    term.loadAddon(f)
    term.open(host.current!)
    const detach = attachTerminal(info.id, (d) => term.write(d))
    const input = term.onData((d) => void api().terminalWrite(info.id, d))
    const resize = term.onResize(({ cols, rows }) => void api().terminalResize(info.id, cols, rows))
    const ro = new ResizeObserver(() => {
      if (host.current && host.current.offsetWidth > 0) {
        try {
          f.fit()
        } catch {
          // not laid out yet
        }
      }
    })
    ro.observe(host.current!)
    return () => {
      ro.disconnect()
      input.dispose()
      resize.dispose()
      detach()
      term.dispose()
    }
  }, [info.id])

  useEffect(() => {
    if (visible) setTimeout(() => fit.current?.fit(), 30)
  }, [visible])

  return (
    <div className={`absolute inset-0 ${visible ? '' : 'invisible'}`}>
      <div ref={host} className="h-full w-full px-2 pt-1" data-testid={`terminal-${info.kind}`} />
    </div>
  )
}

function TerminalPane() {
  const [terms, setTerms] = useState<TerminalInfo[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const ide = useStore((s) => s.ide)

  useEffect(() => {
    void api()
      .terminalAvailable()
      .then((r) => setUnavailable(r.ok ? null : (r.error ?? 'The terminal is unavailable.')))
  }, [])
  useEffect(
    () =>
      onMainEvent((e) => {
        if (e.type !== 'terminal-exit') return
        forgetTerminal(e.id)
        setTerms((ts) => {
          const rest = ts.filter((t) => t.id !== e.id)
          setActive((a) => (a === e.id ? (rest.at(-1)?.id ?? null) : a))
          return rest
        })
      }),
    []
  )

  const open = async (kind: TerminalKind) => {
    try {
      const info = await api().terminalOpen(kind, 100, 24)
      setTerms((ts) => [...ts, info])
      setActive(info.id)
    } catch (e) {
      useStore.getState().toast('error', String((e as Error).message))
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-0.5 border-y border-white/10 bg-black/30 px-1">
        {terms.map((t) => (
          <div key={t.id} className={`flex items-center gap-1.5 px-2 py-1 text-[11px] ${t.id === active ? 'text-white' : 'text-indigo-300 hover:text-white'}`}>
            <button className="flex items-center gap-1" onClick={() => setActive(t.id)}>
              <SquareTerminal size={11} className={t.kind === 'claude' ? 'text-amber-300' : t.kind === 'codex' ? 'text-emerald-300' : ''} />
              {t.title}
            </button>
            <button className="opacity-60 hover:opacity-100" onClick={() => void api().terminalClose(t.id)}>
              <X size={10} />
            </button>
          </div>
        ))}
        <div className="flex-1" />
        <button className="btn btn-ghost !px-1.5 !py-0.5 text-[10px]" onClick={() => void open('shell')} disabled={!!unavailable} data-testid="term-new">
          <Plus size={11} /> Terminal
        </button>
        <button className="btn btn-ghost !px-1.5 !py-0.5 text-[10px] text-amber-200" onClick={() => void open('claude')} disabled={!!unavailable} title="A terminal running Claude Code in the project folder">
          <Plus size={11} /> Claude Code
        </button>
        <button className="btn btn-ghost !px-1.5 !py-0.5 text-[10px] text-emerald-200" onClick={() => void open('codex')} disabled={!!unavailable} title="A terminal running Codex in the project folder">
          <Plus size={11} /> Codex
        </button>
      </div>
      <div className="relative min-h-0 flex-1 bg-[#05060f]">
        {unavailable ? (
          <div className="p-4 text-xs text-amber-200">{unavailable}</div>
        ) : terms.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-indigo-300/60">
            <button className="underline" onClick={() => void open('shell')}>
              Open a terminal
            </button>
            &nbsp;in the project folder.
          </div>
        ) : (
          terms.map((t) => <TerminalView key={t.id} info={t} visible={t.id === active && ide === 'open'} />)
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- window

export function IdeWindow() {
  const ide = useStore((s) => s.ide)
  const [tabs, setTabsState] = useState<Tab[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [reveal, setReveal] = useState<{ path: string; line: number; n: number } | null>(null)
  const [width, setWidth] = useState(() => Math.min(1100, Math.round(window.innerWidth * 0.62)))
  const [termH, setTermH] = useState(260)
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const setTabs = useCallback((fn: (t: Tab[]) => Tab[]) => setTabsState((t) => fn(t)), [])

  const open = useCallback(async (path: string, line?: number) => {
    if (!tabsRef.current.some((t) => t.path === path)) {
      const r = await api().ideRead(path)
      const readOnly = r.tooBig ? 'This file is too large to open here. Use IntelliJ or VS Code.' : r.binary ? 'This is a binary file.' : undefined
      setTabsState((ts) => (ts.some((t) => t.path === path) ? ts : [...ts, { path, text: r.text, saved: r.text, readOnly }]))
    }
    setActive(path)
    if (line) setReveal({ path, line, n: Date.now() })
  }, [])

  // a tool asked for a file at a line (a Logic Board box's code link)
  const request = useStore((s) => s.ideRequest)
  useEffect(() => {
    if (request) void open(request.path, request.line)
  }, [request, open])

  // an open file changed on disk (an agent, another editor): follow it, unless it holds unsaved edits
  useEffect(
    () =>
      onMainEvent((e) => {
        if (e.type !== 'file-changed') return
        const t = tabsRef.current.find((x) => x.path === e.path)
        if (!t || t.readOnly) return
        if (e.kind === 'deleted') return setTabsState((ts) => ts.map((x) => (x.path === e.path ? { ...x, diskChanged: true } : x)))
        void api()
          .ideRead(e.path)
          .then((r) => {
            if (r.text === t.saved) return
            setTabsState((ts) => ts.map((x) => (x.path !== e.path ? x : x.text === x.saved ? { ...x, text: r.text, saved: r.text } : { ...x, diskChanged: true })))
          })
      }),
    []
  )

  const drag = (kind: 'width' | 'height') => (e: React.MouseEvent) => {
    e.preventDefault()
    const sx = e.clientX
    const sy = e.clientY
    const w0 = width
    const h0 = termH
    const move = (ev: MouseEvent) => {
      // docked on the right, so dragging the left edge leftwards widens it
      if (kind === 'width') setWidth(Math.max(560, Math.min(window.innerWidth - 300, w0 - (ev.clientX - sx))))
      else setTermH(Math.max(90, Math.min(window.innerHeight - 260, h0 - (ev.clientY - sy))))
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const dirty = useMemo(() => tabs.filter((t) => t.text !== t.saved).length, [tabs])

  return (
    <div data-left-drawer={ide === 'open' ? '' : undefined} className={`glass rise absolute bottom-3 ${SIDE_DOCK} top-16 z-20 flex max-w-[calc(100vw-300px)] flex-col overflow-hidden rounded-2xl ${ide === 'open' ? '' : 'hidden'}`} style={{ width }} data-testid="ide">
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <Code2 size={16} className="text-violet-300" />
        <div className="font-display text-sm font-bold">Code</div>
        {dirty > 0 && <span className="text-[10px] text-amber-300">{dirty} unsaved</span>}
        <div className="flex-1" />
        <button className="btn btn-ghost !p-1" onClick={() => useStore.getState().set({ ide: 'hidden' })} title="Hide (terminals keep running)">
          <X size={15} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        <Navigator open={(p, l) => void open(p, l)} active={active} />
        <div className="flex min-w-0 flex-1 flex-col">
          <EditorPane tabs={tabs} setTabs={setTabs} active={active} setActive={setActive} reveal={reveal} />
          <div className="h-1 cursor-row-resize bg-white/5 hover:bg-violet-400/40" onMouseDown={drag('height')} />
          <div style={{ height: termH }} className="shrink-0">
            <TerminalPane />
          </div>
        </div>
      </div>
      <div className="absolute bottom-0 left-0 top-0 w-1 cursor-col-resize hover:bg-violet-400/40" onMouseDown={drag('width')} />
    </div>
  )
}
