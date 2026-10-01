import { useEffect, useState } from 'react'
import { BookOpen, RefreshCw, Save } from 'lucide-react'
import { api, useStore } from '../state/store'
import { Drawer } from './Drawer'
import { Markdown } from './MessageView'

export function ContextPanel() {
  const project = useStore((s) => s.project)!
  const bus = useStore((s) => s.bus)
  const [tab, setTab] = useState<'multimine' | 'context'>('multimine')
  const [md, setMd] = useState(project.multimineMd)
  const [files, setFiles] = useState<{ file: string; text: string }[]>([])
  const [sel, setSel] = useState<string | null>(null)
  const handler = project.agents.find((a) => a.role === 'context-handler')
  const contextWrites = bus.filter((b) => b.kind === 'context' && b.to === 'context').length

  const load = () => void api().contextFiles().then((f) => {
    setFiles(f)
    setSel((s) => s ?? f[0]?.file ?? null)
  })
  useEffect(load, [contextWrites])

  return (
    <Drawer title="Project knowledge" icon={<BookOpen size={17} className="text-cyan-300" />} width="w-[640px]">
      <div className="mb-4 flex gap-1 rounded-lg bg-black/30 p-1 text-xs">
        <button className={`flex-1 rounded-md py-1.5 font-semibold ${tab === 'multimine' ? 'bg-violet-500/30 text-white' : 'text-indigo-300'}`} onClick={() => setTab('multimine')}>
          multimine.md
        </button>
        <button className={`flex-1 rounded-md py-1.5 font-semibold ${tab === 'context' ? 'bg-violet-500/30 text-white' : 'text-indigo-300'}`} onClick={() => setTab('context')}>
          Context files ({files.length})
        </button>
      </div>
      {tab === 'multimine' ? (
        <div className="flex h-[calc(100%-3.5rem)] flex-col gap-2">
          <p className="text-xs text-indigo-200/70">Shared guidance injected into every agent's system prompt, like CLAUDE.md or AGENTS.md. Lives at the project root.</p>
          <textarea className="field scroll-thin min-h-[50vh] flex-1 font-mono text-xs" value={md} onChange={(e) => setMd(e.target.value)} spellCheck={false} />
          <button className="btn btn-primary self-end" disabled={md === project.multimineMd} onClick={() => void api().saveMultimineMd(md).then(() => useStore.getState().toast('info', 'multimine.md saved'))}>
            <Save size={14} /> Save
          </button>
        </div>
      ) : (
        <div>
          <div className="mb-3 flex items-center gap-2 text-xs text-indigo-200/70">
            <span className="flex-1">
              {handler ? `Maintained by ${handler.name} in .multimine/context/.` : 'No Context Handler yet. Create one (role: Context Handler) and it will map the project here.'}
            </span>
            <button className="btn !py-1" onClick={load}>
              <RefreshCw size={12} />
            </button>
          </div>
          <div className="mb-3 flex flex-wrap gap-1">
            {files.map((f) => (
              <button key={f.file} className={`rounded-md px-2 py-1 font-mono text-[11px] ${sel === f.file ? 'bg-cyan-500/25 text-cyan-100' : 'bg-black/30 text-indigo-300 hover:bg-white/5'}`} onClick={() => setSel(f.file)}>
                {f.file}
              </button>
            ))}
          </div>
          {sel && <Markdown text={files.find((f) => f.file === sel)?.text ?? ''} />}
        </div>
      )}
    </Drawer>
  )
}
