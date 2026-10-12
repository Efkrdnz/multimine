import { useState } from 'react'
import { Wand2 } from 'lucide-react'
import { api, useStore } from '../state/store'
import { Modal } from '../panels/Modal'
import { PluginIcon } from './PluginIcon'

/** Ideas for a first tool, closer to a game project than a blank page. */
const IDEAS = [
  'A loot table editor for data/loot/*.json, with each drop chance as a bar',
  'A to-do board for this project, kept in the tool',
  'A colour palette maker that saves palette.json',
  'A sound board that plays the .ogg files in assets/sounds',
  'A changelog writer: I type what changed, it adds it to CHANGELOG.md'
]

/**
 * Make a tool (or change one) by describing it: a chat writes it as a plugin, has it checked and
 * installed, and the user allows what it needs before it opens.
 */
export function MakeTool({ editId }: { editId?: string }) {
  const chats = useStore((s) => s.project?.agents ?? [])
  const editing = useStore((s) => (editId ? s.plugins.find((p) => p.manifest.id === editId) : undefined))
  const [text, setText] = useState('')
  const [to, setTo] = useState('new')
  const [busy, setBusy] = useState(false)
  const close = () => useStore.getState().set({ modal: null })
  const go = async () => {
    if (!text.trim()) return
    setBusy(true)
    try {
      const id = await api().pluginMake(text, to, editId)
      close()
      useStore.getState().openChat(id)
    } catch (e) {
      useStore.getState().toast('error', String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title={editing ? `Change ${editing.manifest.name}` : 'Make a tool'} onClose={close} width="w-[580px]">
      <div className="space-y-4 p-5" data-testid="make-tool">
        <div className="flex items-start gap-3">
          {editing ? (
            <PluginIcon plugin={editing} size={44} />
          ) : (
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-fuchsia-500 to-violet-600 shadow-[0_8px_22px_-8px_#a855f7]">
              <Wand2 size={22} className="text-white" />
            </span>
          )}
          <p className="text-[13px] leading-relaxed text-indigo-100/85">
            {editing
              ? 'Say what should change. A chat edits the tool, checks it and installs the new version; its window reloads.'
              : 'Describe the tool you want. A chat builds it as a plugin, checks it and installs it here, under Tools. You allow what it needs before it opens.'}
          </p>
        </div>
        <textarea
          className="field min-h-[110px] resize-y text-sm"
          placeholder={editing ? 'e.g. add a button that rerolls the whole table' : 'e.g. a loot table editor for data/loot/*.json, with each drop chance as a bar'}
          value={text}
          autoFocus
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && void go()}
          data-testid="make-tool-input"
        />
        {!editing && (
          <div className="flex flex-wrap gap-1.5">
            {IDEAS.map((idea) => (
              <button key={idea} className="row rounded-full border border-white/10 px-2.5 py-1 text-left text-[11px] text-indigo-200/80 hover:border-violet-400/50 hover:bg-violet-500/10 hover:text-white" onClick={() => setText(idea)}>
                {idea}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2 border-t border-white/10 pt-4">
          <span className="shrink-0 whitespace-nowrap text-xs text-indigo-300/70">Made by</span>
          <select className="field !w-auto max-w-[240px] !py-1 !text-xs" value={to} onChange={(e) => setTo(e.target.value)} data-testid="make-tool-to">
            <option value="new">A new chat</option>
            {chats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <span className="flex-1" />
          <button className="btn shrink-0" onClick={close}>
            Cancel
          </button>
          <button className="btn btn-primary shrink-0 whitespace-nowrap" disabled={!text.trim() || busy} onClick={() => void go()} title="Ctrl+Enter" data-testid="make-tool-go">
            <Wand2 size={14} /> {editing ? 'Change it' : 'Make it'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
