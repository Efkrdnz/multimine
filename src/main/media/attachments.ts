import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { newId } from '@shared/ids'
import type { Attachment, ImageUpload } from '@shared/types'

/** The image types every provider that sees images accepts. */
export const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
export const MAX_IMAGES = 10
/** Per image, after the window has scaled it down. */
export const MAX_IMAGE_BYTES = 8_000_000

/** Where attachments live, relative to the project: beside the gallery's media, out of git. */
export const ATTACH_DIR = '.multimine/media/attachments'

/** An image as a provider gets it: the file, its type and its bytes as base64. */
export interface TurnImage {
  path: string
  mime: string
  data: string
}

const bytesOf = (b64: string) => Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0)

/** Why these images cannot be sent, or null when they can. */
export function checkUploads(images: ImageUpload[]): string | null {
  if (images.length > MAX_IMAGES) return `At most ${MAX_IMAGES} images per message.`
  for (const i of images) {
    if (!IMAGE_TYPES[i.mime]) return `${i.name}: only PNG, JPEG, GIF and WebP images can be attached.`
    if (bytesOf(i.data) > MAX_IMAGE_BYTES) return `${i.name} is over ${MAX_IMAGE_BYTES / 1e6} MB.`
  }
  return null
}

/**
 * Names the files for a message's images at once (so the message can show them straight away)
 * and writes them; the turn waits on `written` before it reads them back.
 */
export function stageUploads(projectDir: string, images: ImageUpload[]): { attachments: Attachment[]; written: Promise<void> } {
  const ok = images.filter((i) => IMAGE_TYPES[i.mime] && bytesOf(i.data) <= MAX_IMAGE_BYTES).slice(0, MAX_IMAGES)
  const attachments: Attachment[] = ok.map((i) => ({
    path: `${ATTACH_DIR}/${newId('img')}.${IMAGE_TYPES[i.mime]}`,
    mime: i.mime,
    name: (i.name || 'image').slice(0, 120),
    bytes: bytesOf(i.data),
    ...(i.w && i.h ? { w: Math.round(i.w), h: Math.round(i.h) } : {})
  }))
  const written = (async () => {
    await mkdir(join(projectDir, ATTACH_DIR), { recursive: true })
    await Promise.all(ok.map((i, k) => writeFile(join(projectDir, attachments[k].path), Buffer.from(i.data, 'base64'))))
  })()
  return { attachments, written }
}

/** A message's images read back for a provider; ones that are gone are left out. */
export async function loadImages(projectDir: string, attachments: Attachment[] = []): Promise<TurnImage[]> {
  const out: TurnImage[] = []
  for (const a of attachments) {
    const path = join(projectDir, a.path)
    try {
      out.push({ path, mime: a.mime, data: (await readFile(path)).toString('base64') })
    } catch {
      // deleted since: the note in the prompt still names it
    }
  }
  return out
}

/** The line a prompt carries about its images, so the agent knows where they are (to use one as a texture, say). */
export function attachmentNote(attachments: Attachment[] = []): string {
  if (!attachments.length) return ''
  const list = attachments.map((a) => `${a.path} (${a.name}${a.w ? `, ${a.w}x${a.h}` : ''})`).join(', ')
  return `[Attached image${attachments.length > 1 ? 's' : ''}: ${list}]`
}
