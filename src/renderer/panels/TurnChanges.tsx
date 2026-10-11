import { useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, ChevronRight, FileDiff, Undo2 } from 'lucide-react'
import type { ChatMessage, FileChange } from '@shared/types'
import { api, useStore } from '../state/store'
import { Diff } from './Diff'
import { Modal } from './Modal'

const WORD: Record<FileChange['status'], string> = { A: 'added', M: 'modified', D: 'deleted' }
const COLOR: Record<FileChange['status'], string> = { A: 'text-emerald-300', M: 'text-amber-200', D: 'text-red-300' }

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * The files a reply's turn changed, under the reply: each one opens its diff, and Undo puts every
 * one of them back as it was before the turn.
 */
export function TurnChanges({ m }: { m: ChatMessage }) {
  const c = m.changes!
  const [open, setOpen] = useState(false)
  const [diff, setDiff] = useState<{ path: string; text: string } | null>(null)
  const [working, setWorking] = useState(false)
  const busy = useStore((s) => !!s.status[m.agentId] && s.status[m.agentId].status !== 'idle' && s.status[m.agentId].status !== 'error')
  const toast = useStore((s) => s.toast)
  const count = c.files.length + (c.more ?? 0)
  const add = c.files.reduce((n, f) => n + f.add, 0)
  const del = c.files.reduce((n, f) => n + f.del, 0)

  const show = (path: string) =>
    void api()
      .turnDiff(m.agentId, m.id, path)
      .then((text) => setDiff({ path, text: text || '(no text difference: a binary file or only its mode changed)' }))
      .catch((e) => toast('error', String((e as Error).message)))

  const undo = async () => {
    const also = c.overlapped?.length ? `\n\n${c.overlapped.join(', ')} ${c.overlapped.length === 1 ? 'was' : 'were'} working at the same time: their edits to these files go too.` : ''
    if (!confirm(`Undo this turn? ${plural(count, 'file')} go back to how they were before it (files it added are deleted).${also}`)) return
    setWorking(true)
    try {
      let r = await api().turnUndo(m.agentId, m.id)
      if (!r.undone && r.conflicts.length) {
        const list = r.conflicts.slice(0, 12).map((p) => `  ${p}`).join('\n')
        if (!confirm(`These files changed again after this turn:\n${list}${r.conflicts.length > 12 ? `\n  and ${r.conflicts.length - 12} more` : ''}\n\nUndo anyway? Those later changes would be lost too.`)) return
        r = await api().turnUndo(m.agentId, m.id, true)
      }
      if (r.undone) toast('info', `Undone: ${plural(count, 'file')} back to how they were before this turn`)
    } catch (e) {
      toast('error', String((e as Error).message))
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className={`mt-2 rounded-lg border text-xs ${c.undone ? 'border-white/5 bg-black/10 opacity-70' : 'border-white/10 bg-black/25'}`} data-testid="turn-changes">
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen(!open)} data-testid="turn-changes-toggle">
          <ChevronRight size={12} className={`shrink-0 transition ${open ? 'rotate-90' : ''}`} />
          <FileDiff size={13} className="shrink-0 text-indigo-300" />
          <span className={`text-indigo-100 ${c.undone ? 'line-through' : ''}`}>Changed {plural(count, 'file')}</span>
          {(add > 0 || del > 0) && (
            <span className="font-mono text-[11px]">
              <span className="text-emerald-300">+{add}</span> <span className="text-red-300">−{del}</span>
            </span>
          )}
          {!open && <span className="min-w-0 truncate font-mono text-[11px] text-indigo-300/60">{c.files.slice(0, 3).map((f) => f.path.split('/').pop()).join(', ')}{count > 3 ? ', ...' : ''}</span>}
        </button>
        {c.undone ? (
          <span className="shrink-0 rounded bg-white/10 px-1.5 py-px text-[10.5px] text-indigo-200" title={new Date(c.undone).toLocaleString()} data-testid="turn-undone">
            Undone
          </span>
        ) : (
          <button className="btn shrink-0 !px-2 !py-0.5 !text-[11px]" disabled={busy || working} title={busy ? 'Wait for the chat to finish (or stop it) first' : 'Put these files back as they were before this turn'} onClick={() => void undo()} data-testid="turn-undo">
            <Undo2 size={12} /> Undo
          </button>
        )}
      </div>
      {c.overlapped?.length ? (
        <div className="flex items-center gap-1.5 border-t border-white/5 px-2.5 py-1 text-[11px] text-amber-200/80">
          <AlertTriangle size={11} className="shrink-0" /> {c.overlapped.join(', ')} {c.overlapped.length === 1 ? 'was' : 'were'} working at the same time: their edits may be listed here too.
        </div>
      ) : null}
      {open && (
        <div className="border-t border-white/10 py-1">
          {c.files.map((f) => (
            <button key={f.path} className="flex w-full items-center gap-2 px-3 py-0.5 text-left font-mono text-[11px] hover:bg-white/5" title={`${WORD[f.status]}: show the diff`} onClick={() => show(f.path)} data-testid="turn-file">
              <span className={`w-3 shrink-0 font-bold ${COLOR[f.status]}`}>{f.status}</span>
              <span className="min-w-0 flex-1 truncate text-indigo-100">{f.path}</span>
              {f.binary ? (
                <span className="shrink-0 text-indigo-300/60">binary</span>
              ) : (
                <span className="shrink-0">
                  <span className="text-emerald-300">+{f.add}</span> <span className="text-red-300">−{f.del}</span>
                </span>
              )}
            </button>
          ))}
          {c.more ? <div className="px-3 py-0.5 text-[11px] text-indigo-300/60">and {plural(c.more, 'more file')}</div> : null}
        </div>
      )}
      {diff &&
        createPortal(
          <Modal title={<span className="font-mono text-sm">{diff.path}</span>} onClose={() => setDiff(null)}>
            <div className="min-h-0 overflow-hidden p-4" data-testid="turn-diff">
              <div className="mb-2 text-[11px] text-indigo-300/70">Before this turn → after it{c.undone ? ' (since undone)' : ''}</div>
              <Diff text={diff.text} tall />
            </div>
          </Modal>,
          document.body
        )}
    </div>
  )
}
