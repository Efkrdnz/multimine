import { useState } from 'react'
import { createPortal } from 'react-dom'
import { ExternalLink, Loader2, X } from 'lucide-react'
import type { Attachment, ImageUpload } from '@shared/types'
import { api, useStore } from '../state/store'
import { Modal } from './Modal'

/** Longest side an attached image is sent at: what models look at in detail, and well under every size limit. */
const MAX_EDGE = 2048
/** Images over this are re-encoded as JPEG. */
const MAX_BYTES = 4_500_000
const KEEP = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

/** An image in the composer: ready to send, or still being read. */
export interface Pending extends Partial<ImageUpload> {
  id: string
  name: string
  url?: string
  error?: string
}

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}

/**
 * Reads an image for sending: one that is small enough goes as it is; a larger one, or a type a
 * model would not take, is redrawn at most 2048 pixels on its longest side.
 */
export async function prepareImage(file: Blob, name: string): Promise<ImageUpload & { url: string }> {
  if (!file.type.startsWith('image/')) throw new Error(`${name} is not an image`)
  const bmp = await createImageBitmap(file)
  const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height))
  const w = Math.max(1, Math.round(bmp.width * scale))
  const h = Math.max(1, Math.round(bmp.height * scale))
  let blob: Blob = file
  let mime = file.type
  if (scale < 1 || !KEEP.includes(file.type) || file.size > MAX_BYTES) {
    const canvas = new OffscreenCanvas(w, h)
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, w, h)
    mime = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png'
    blob = await canvas.convertToBlob({ type: mime, quality: 0.9 })
    if (blob.size > MAX_BYTES) blob = await canvas.convertToBlob({ type: (mime = 'image/jpeg'), quality: 0.85 })
  }
  bmp.close()
  return { name, mime, data: await base64(blob), w, h, url: URL.createObjectURL(blob) }
}

/** What a pasted image is called: the clipboard names them all image.png. */
export function pastedName(file: File): string {
  if (file.name && file.name !== 'image.png') return file.name
  const t = new Date()
  return `Pasted ${t.getHours().toString().padStart(2, '0')}.${t.getMinutes().toString().padStart(2, '0')}.${t.getSeconds().toString().padStart(2, '0')}.png`
}

/** The images about to go with a message, each with a way to take it off. */
export function AttachTray({ items, onRemove }: { items: Pending[]; onRemove: (id: string) => void }) {
  if (!items.length) return null
  return (
    <div className="flex flex-wrap gap-2 px-1 pb-2 pt-1" data-testid="attach-tray">
      {items.map((p) => (
        <div key={p.id} className="pop group relative h-16 w-16 shrink-0" title={p.error ?? `${p.name}${p.w ? ` · ${p.w}×${p.h}` : ''}`} data-testid="attach-thumb">
          {p.url ? (
            <img src={p.url} className="h-full w-full rounded-xl border border-white/15 object-cover shadow-[0_6px_18px_-8px_rgba(0,0,0,0.8)]" draggable={false} />
          ) : (
            <div className={`flex h-full w-full items-center justify-center rounded-xl border ${p.error ? 'border-red-400/50 bg-red-950/40 text-red-200' : 'border-white/10 bg-white/5 text-indigo-300'}`}>
              {p.error ? <X size={16} /> : <Loader2 size={16} className="animate-spin" />}
            </div>
          )}
          <button
            className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-white/20 bg-[#16173a] text-indigo-100 opacity-0 shadow transition group-hover:opacity-100 hover:bg-red-500/80 focus-visible:opacity-100"
            title="Remove"
            onClick={() => onRemove(p.id)}
            data-testid="attach-remove"
          >
            <X size={11} />
          </button>
        </div>
      ))}
    </div>
  )
}

/** A file of the open project as the window loads it. */
export function projectFileUrl(dir: string, rel: string): string {
  return `mm://media/${encodeURIComponent(`${dir.replace(/[\\/]+$/, '')}/${rel}`)}`
}

/** A message's images: thumbnails that open full size. */
export function AttachmentGrid({ items }: { items: Attachment[] }) {
  const dir = useStore((s) => s.project?.dir ?? '')
  const [open, setOpen] = useState<Attachment | null>(null)
  const single = items.length === 1
  return (
    <>
      <div className={`mb-1.5 flex flex-wrap gap-1.5 ${single ? '' : 'max-w-[360px]'}`} data-testid="message-images">
        {items.map((a) => (
          <button key={a.path} className="overflow-hidden rounded-xl border border-white/15 transition hover:border-white/40 hover:brightness-110" title={`${a.name}${a.w ? ` · ${a.w}×${a.h}` : ''}`} onClick={() => setOpen(a)}>
            <img src={projectFileUrl(dir, a.path)} className={single ? 'max-h-60 max-w-[320px] object-contain' : 'h-24 w-24 object-cover'} draggable={false} alt={a.name} />
          </button>
        ))}
      </div>
      {open &&
        createPortal(
          <Modal title={<span className="truncate text-sm">{open.name}</span>} onClose={() => setOpen(null)} width="w-auto">
            <div className="flex min-h-0 flex-col items-center gap-3 p-4" data-testid="image-lightbox">
              <img src={projectFileUrl(dir, open.path)} className="max-h-[72vh] max-w-[86vw] rounded-lg object-contain" alt={open.name} />
              <div className="flex items-center gap-3 text-[11px] text-indigo-300/70">
                {open.w ? `${open.w}×${open.h} · ` : ''}
                {Math.max(1, Math.round(open.bytes / 1024))} KB
                <button className="btn !py-0.5 !text-[11px]" onClick={() => void api().openPath(`${dir}/${open.path}`)}>
                  <ExternalLink size={11} /> Open
                </button>
              </div>
            </div>
          </Modal>,
          document.body
        )}
    </>
  )
}
