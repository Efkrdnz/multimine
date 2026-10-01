import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { newId } from '@shared/ids'
import type { MediaItem } from '@shared/types'

const KIND_BY_EXT: Record<string, MediaItem['kind']> = {
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', bmp: 'image', svg: 'image',
  mp4: 'video', webm: 'video', mov: 'video', m4v: 'video',
  glb: 'model', gltf: 'model', obj: 'model', fbx: 'model', stl: 'model', usdz: 'model', ply: 'model',
  mp3: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio', flac: 'audio'
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'model/gltf-binary': 'glb', 'model/gltf+json': 'gltf',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg'
}

export function kindOf(pathOrUrl: string): MediaItem['kind'] | null {
  const clean = pathOrUrl.split(/[?#]/)[0]
  const ext = extname(clean).slice(1).toLowerCase()
  return KIND_BY_EXT[ext] ?? null
}

export function extFromMime(mime: string): string | null {
  return MIME_EXT[mime.toLowerCase()] ?? null
}

/** Media URLs mentioned in a tool result or a message: anything http(s) ending in a media extension. */
export function findMediaUrls(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) {
    const url = m[0].replace(/[.,;]+$/, '')
    if (kindOf(url)) out.add(url)
  }
  return [...out]
}

export class MediaStore {
  constructor(private readonly dir: string) {}

  private async target(ext: string): Promise<{ id: string; path: string }> {
    await mkdir(this.dir, { recursive: true })
    const id = newId('m')
    return { id, path: join(this.dir, `${id}.${ext}`) }
  }

  async fromBase64(data: string, mime: string, agentId: string, source: string, title?: string): Promise<MediaItem | null> {
    const ext = extFromMime(mime)
    if (!ext) return null
    const kind = kindOf(`x.${ext}`)!
    const { id, path } = await this.target(ext)
    await writeFile(path, Buffer.from(data, 'base64'))
    return { id, kind, path, source, agentId, ts: Date.now(), title }
  }

  async fromUrl(url: string, agentId: string, source: string, title?: string): Promise<MediaItem | null> {
    if (url.startsWith('data:')) {
      const m = /^data:([^;]+);base64,(.*)$/.exec(url)
      return m ? this.fromBase64(m[2], m[1], agentId, source, title) : null
    }
    const res = await fetch(url)
    if (!res.ok) throw new Error(`download failed: ${res.status}`)
    const mimeExt = extFromMime((res.headers.get('content-type') ?? '').split(';')[0])
    const ext = extname(url.split(/[?#]/)[0]).slice(1).toLowerCase() || mimeExt
    if (!ext || !kindOf(`x.${ext}`)) return null
    const { id, path } = await this.target(ext)
    await writeFile(path, Buffer.from(await res.arrayBuffer()))
    return { id, kind: kindOf(`x.${ext}`)!, path, source: url, agentId, ts: Date.now(), title: title ?? source }
  }

  async fromFile(file: string, agentId: string, title?: string): Promise<MediaItem | null> {
    const kind = kindOf(file)
    if (!kind) return null
    const { id, path } = await this.target(extname(file).slice(1).toLowerCase())
    await copyFile(file, path)
    return { id, kind, path, source: file, agentId, ts: Date.now(), title }
  }
}
