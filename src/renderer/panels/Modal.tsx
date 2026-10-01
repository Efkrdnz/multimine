import { useEffect } from 'react'
import { X } from 'lucide-react'

export function Modal({ title, onClose, children, width = 'w-[920px]' }: { title: React.ReactNode; onClose: () => void; children: React.ReactNode; width?: string }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/55 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`glass rise flex max-h-[92vh] ${width} max-w-[96vw] flex-col rounded-2xl`}>
        <div className="flex items-center gap-2 border-b border-white/10 px-5 py-3.5">
          <div className="flex-1 font-display text-base font-bold">{title}</div>
          <button className="btn btn-ghost !p-1" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
