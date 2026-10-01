import { createElement, useEffect, useState } from 'react'
import '@google/model-viewer'
import type { MediaItem } from '@shared/types'
import { api } from '../state/store'

/** One media file, previewed the way its kind wants: picture, player, or a turntable 3D viewer. */
export function MediaView({ item, compact = false }: { item: MediaItem; compact?: boolean }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    void api().mediaUrl(item.path).then(setUrl)
  }, [item.path])
  if (!url) return <div className="h-24 animate-pulse rounded-lg bg-white/5" />
  const h = compact ? 'max-h-48' : 'max-h-[70vh]'
  switch (item.kind) {
    case 'image':
      return <img src={url} className={`${h} w-full rounded-lg object-contain`} />
    case 'video':
      return <video src={url} className={`${h} w-full rounded-lg`} controls loop />
    case 'audio':
      return <audio src={url} className="w-full" controls />
    case 'model':
      return /\.(glb|gltf)$/i.test(item.path)
        ? createElement('model-viewer', { src: url, 'camera-controls': true, 'auto-rotate': true, 'shadow-intensity': '1', style: { width: '100%', height: compact ? '12rem' : '60vh', background: 'radial-gradient(#1e1b4b, #04050d)', borderRadius: '0.6rem' } })
        : (
            <button className="btn" onClick={() => void api().openPath(item.path)}>
              Open {item.path.split(/[\\/]/).pop()} in your 3D viewer
            </button>
          )
  }
}
