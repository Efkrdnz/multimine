import { Download, RotateCw } from 'lucide-react'
import { api, useStore } from '../state/store'

/** Restarts on the downloaded version, asking first when chats in any open project are still working. */
export async function restartToUpdate(): Promise<void> {
  const s = useStore.getState()
  const busy = s.projects.reduce((n, p) => n + p.busy, 0)
  const running = s.projects.some((p) => p.running)
  const going = [busy ? `${busy} chat${busy > 1 ? 's are' : ' is'} working` : '', running ? 'a game is running' : ''].filter(Boolean).join(' and ')
  if (going && !confirm(`${going[0].toUpperCase()}${going.slice(1)}. Restarting to update stops ${busy + (running ? 1 : 0) > 1 ? 'them' : 'it'}. Restart now?`)) return
  await api()
    .updateInstall()
    .catch((e) => s.toast('error', String((e as Error).message ?? e)))
}

/**
 * The app's update, where it can be acted on: a quiet note while a new version downloads, then a
 * button to restart on it (it also installs by itself the next time Multimine closes).
 */
export function UpdatePill() {
  const u = useStore((s) => s.update)
  if (!u || (u.status !== 'downloading' && u.status !== 'ready')) return null
  if (u.status === 'downloading')
    return (
      <span className="flex items-center gap-1.5 rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-indigo-200/80" title={`Multimine ${u.version} is downloading; it installs when you restart`} data-testid="update-downloading">
        <Download size={12} className="animate-pulse text-cyan-300" /> Update {u.version} · {u.percent ?? 0}%
      </span>
    )
  return (
    <button
      className="pop flex items-center gap-1.5 rounded-full bg-gradient-to-r from-emerald-500 to-cyan-500 px-3 py-1 text-[11.5px] font-semibold text-white shadow-[0_6px_20px_-8px_#10b981] transition hover:brightness-110 active:scale-95"
      title={`Multimine ${u.version} is ready (you have ${u.current}). Restart to use it, or it installs the next time you close Multimine.`}
      onClick={() => void restartToUpdate()}
      data-testid="update-ready"
    >
      <RotateCw size={12} /> Restart to update to {u.version}
    </button>
  )
}
