import { useState } from 'react'
import { BookOpen, Save } from 'lucide-react'
import { api, useStore } from '../state/store'
import { Drawer } from './Drawer'

/** multimine.md: the project's instructions, given to every chat like CLAUDE.md or AGENTS.md. */
export function InstructionsPanel() {
  const project = useStore((s) => s.project)!
  const [md, setMd] = useState(project.multimineMd)
  return (
    <Drawer title="Project instructions" icon={<BookOpen size={17} className="text-cyan-300" />} width="w-[640px]">
      <div className="flex h-full flex-col gap-2">
        <p className="text-xs text-indigo-200/70">
          <span className="font-mono">multimine.md</span> at the project root is given to every chat, whichever provider runs it - like CLAUDE.md or AGENTS.md. Fill in "How to verify" with your project's exact commands.
        </p>
        <textarea className="field scroll-thin min-h-[50vh] flex-1 font-mono text-xs" value={md} onChange={(e) => setMd(e.target.value)} spellCheck={false} data-testid="instructions-text" />
        <button className="btn btn-primary self-end" disabled={md === project.multimineMd} onClick={() => void api().saveMultimineMd(md).then(() => useStore.getState().toast('info', 'multimine.md saved'))}>
          <Save size={14} /> Save
        </button>
      </div>
    </Drawer>
  )
}
