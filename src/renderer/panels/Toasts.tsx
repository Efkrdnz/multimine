import { useStore } from '../state/store'

export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  return (
    <div className="pointer-events-none absolute bottom-5 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <div key={t.id} className={`glass rise max-w-xl whitespace-pre-wrap rounded-xl px-4 py-2 text-sm ${t.level === 'error' ? 'border-red-400/40 text-red-100' : 'text-indigo-100'}`}>
          {t.text}
        </div>
      ))}
    </div>
  )
}
