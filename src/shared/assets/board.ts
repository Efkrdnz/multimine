import type { TargetId } from '../sketch/targets'

/**
 * The asset board: what art and sound the project needs, what each one must be, where it goes, and
 * how far it has got. It lives in `.multimine/assets/board.json` so it is committed with the project.
 * The Asset Creator never writes into the project: it shows each attempt in the gallery titled
 * `asset:<id>`, the board picks those up as candidates, and only an approval copies one into place.
 */
export const BOARD_PATH = '.multimine/assets/board.json'

export const ASSET_KINDS = ['sprite', 'texture', 'icon', 'ui', 'vfx', 'model', 'sound', 'music'] as const
export type AssetKind = (typeof ASSET_KINDS)[number]

export const KIND_LABEL: Record<AssetKind, string> = {
  sprite: 'Sprite',
  texture: 'Texture',
  icon: 'Icon',
  ui: 'UI art',
  vfx: 'VFX',
  model: '3D model',
  sound: 'Sound',
  music: 'Music'
}

export const ASSET_STATUS = ['wanted', 'requested', 'review', 'approved', 'rejected'] as const
export type AssetStatus = (typeof ASSET_STATUS)[number]

export interface AssetSpec {
  /** Pixels for images (`64x64`), a triangle budget for models, a length for audio. */
  size: string
  format: string
  notes: string
}

export interface Candidate {
  mediaId: string
  path: string
  kind: string
  ts: number
  title?: string
}

export interface HistoryEntry {
  ts: number
  status: AssetStatus
  note?: string
}

export interface Asset {
  id: string
  name: string
  kind: AssetKind
  spec: AssetSpec
  /** Where an approved candidate is copied, relative to the project root. */
  targetPath: string
  status: AssetStatus
  candidates: Candidate[]
  chosen?: string
  history: HistoryEntry[]
}

export interface StyleGuide {
  text: string
  palette: string[]
}

export interface Board {
  schema: 1
  style: StyleGuide
  assets: Asset[]
}

export const emptyBoard = (): Board => ({ schema: 1, style: { text: '', palette: [] }, assets: [] })

/** Lower-case words joined by underscores: a name every engine (and Minecraft's resource locations) accepts. */
export const snake = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'asset'

export const IMAGE_KINDS: ReadonlySet<AssetKind> = new Set(['sprite', 'texture', 'icon', 'ui', 'vfx'])

const EXT: Record<AssetKind, string> = { sprite: 'png', texture: 'png', icon: 'png', ui: 'png', vfx: 'png', model: 'glb', sound: 'ogg', music: 'ogg' }

/** What a new asset of a kind asks for by default, on a target. */
export function defaultSpec(kind: AssetKind, engine: TargetId | null): AssetSpec {
  const mc = engine === 'minecraft'
  switch (kind) {
    case 'sprite':
      return { size: mc ? '16x16' : '128x128', format: 'PNG, transparent background', notes: '' }
    case 'texture':
      return { size: mc ? '16x16' : '1024x1024', format: mc ? 'PNG' : 'PNG, tileable', notes: '' }
    case 'icon':
      return { size: mc ? '16x16' : '64x64', format: 'PNG, transparent background', notes: '' }
    case 'ui':
      return { size: mc ? '256x256' : '512x512', format: 'PNG, nine-slice friendly borders', notes: '' }
    case 'vfx':
      return { size: mc ? '16x16' : '512x512', format: 'PNG sprite sheet, 8 frames in a row', notes: '' }
    case 'model':
      return { size: mc ? 'low poly, blocky' : '5k triangles', format: 'GLB with PBR textures', notes: '' }
    case 'sound':
      return { size: 'under 2 s', format: 'OGG, mono', notes: '' }
    case 'music':
      return { size: '60 s, seamless loop', format: 'OGG, stereo', notes: '' }
  }
}

const FOLDERS: Record<'godot' | 'unity' | 'unreal' | 'web' | 'other', Record<AssetKind, string>> = {
  godot: { sprite: 'assets/sprites', texture: 'assets/textures', icon: 'assets/icons', ui: 'assets/ui', vfx: 'assets/vfx', model: 'assets/models', sound: 'assets/audio/sfx', music: 'assets/audio/music' },
  unity: { sprite: 'Assets/Art/Sprites', texture: 'Assets/Art/Textures', icon: 'Assets/Art/Icons', ui: 'Assets/Art/UI', vfx: 'Assets/Art/VFX', model: 'Assets/Art/Models', sound: 'Assets/Audio/SFX', music: 'Assets/Audio/Music' },
  // Unreal imports source files into Content as .uasset; the raw files are kept beside the project
  unreal: { sprite: 'SourceArt/Sprites', texture: 'SourceArt/Textures', icon: 'SourceArt/Icons', ui: 'SourceArt/UI', vfx: 'SourceArt/VFX', model: 'SourceArt/Models', sound: 'SourceArt/Audio/SFX', music: 'SourceArt/Audio/Music' },
  web: { sprite: 'public/assets/sprites', texture: 'public/assets/textures', icon: 'public/assets/icons', ui: 'public/assets/ui', vfx: 'public/assets/vfx', model: 'public/assets/models', sound: 'public/assets/audio', music: 'public/assets/audio/music' },
  other: { sprite: 'assets/sprites', texture: 'assets/textures', icon: 'assets/icons', ui: 'assets/ui', vfx: 'assets/vfx', model: 'assets/models', sound: 'assets/audio', music: 'assets/audio/music' }
}

const MC_FOLDERS: Record<AssetKind, string> = {
  sprite: 'textures/item',
  texture: 'textures/block',
  icon: 'textures/gui',
  ui: 'textures/gui',
  vfx: 'textures/particle',
  model: 'models/source',
  sound: 'sounds',
  music: 'sounds/music'
}

/** Where an asset of this kind belongs in a project of this kind. */
export function suggestPath(engine: TargetId | null, kind: AssetKind, name: string, modId = 'examplemod'): string {
  const file = `${snake(name)}.${EXT[kind]}`
  if (engine === 'minecraft') return `src/main/resources/assets/${snake(modId)}/${MC_FOLDERS[kind]}/${file}`
  const set = engine === 'godot' || engine === 'unity' || engine === 'unreal' ? engine : engine === 'web' || engine === 'mobile' ? 'web' : 'other'
  return `${FOLDERS[set][kind]}/${file}`
}

/** The mod id a Minecraft project declares in gradle.properties. */
export function modIdFrom(gradleProperties: string): string | null {
  return /^\s*mod_id\s*=\s*([A-Za-z0-9_.-]+)\s*$/m.exec(gradleProperties)?.[1] ?? null
}

/** A short id, unique on the board, that the gallery title carries: `asset:<id>`. */
export function assetId(name: string, taken: ReadonlySet<string>): string {
  const base = snake(name).replace(/_/g, '-').slice(0, 32)
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`
}

export function addAsset(board: Board, name: string, kind: AssetKind, engine: TargetId | null, modId?: string, now = Date.now()): { board: Board; id: string } {
  const id = assetId(name, new Set(board.assets.map((a) => a.id)))
  const asset: Asset = { id, name: name.trim() || 'New asset', kind, spec: defaultSpec(kind, engine), targetPath: suggestPath(engine, kind, name, modId), status: 'wanted', candidates: [], history: [{ ts: now, status: 'wanted' }] }
  return { board: { ...board, assets: [...board.assets, asset] }, id }
}

export function updateAsset(board: Board, id: string, patch: Partial<Omit<Asset, 'id' | 'history' | 'status'>>): Board {
  return { ...board, assets: board.assets.map((a) => (a.id === id ? { ...a, ...patch, spec: { ...a.spec, ...patch.spec } } : a)) }
}

export function removeAsset(board: Board, id: string): Board {
  return { ...board, assets: board.assets.filter((a) => a.id !== id) }
}

/** Which way an asset may move: forward through the pipeline, a rejection back to a request, anything back to wanted. */
export function canMove(from: AssetStatus, to: AssetStatus): boolean {
  if (to === 'wanted') return from !== 'wanted'
  const ok: Record<AssetStatus, AssetStatus[]> = {
    wanted: ['requested'],
    requested: ['review', 'requested'],
    review: ['approved', 'rejected', 'requested'],
    rejected: ['requested', 'review'],
    approved: ['requested']
  }
  return ok[from].includes(to)
}

export function setStatus(board: Board, id: string, to: AssetStatus, note?: string, now = Date.now()): Board {
  return {
    ...board,
    assets: board.assets.map((a) => {
      if (a.id !== id) return a
      if (!canMove(a.status, to)) throw new Error(`An asset that is ${a.status} cannot become ${to}`)
      return { ...a, status: to, history: [...a.history, { ts: now, status: to, ...(note ? { note: note.slice(0, 2000) } : {}) }].slice(-50) }
    })
  }
}

export function approve(board: Board, id: string, mediaId: string, now = Date.now()): Board {
  const a = board.assets.find((x) => x.id === id)
  if (!a?.candidates.some((c) => c.mediaId === mediaId)) throw new Error('That is not one of its candidates')
  return setStatus(updateAsset(board, id, { chosen: mediaId }), id, 'approved', undefined, now)
}

const TITLE = /^\s*asset:([a-z0-9][a-z0-9-]*)\b/i

/**
 * Attaches gallery items titled `asset:<id> ...` to their assets as candidates (once each). An asset
 * waiting on a request, or sent back for a revision, moves to review when something new arrives.
 */
export function matchCandidates(board: Board, media: readonly { id: string; path: string; kind: string; ts: number; title?: string }[], now = Date.now()): { board: Board; arrived: string[] } {
  const arrived = new Set<string>()
  let out = board
  for (const m of media) {
    const id = TITLE.exec(m.title ?? '')?.[1]?.toLowerCase()
    if (!id) continue
    const a = out.assets.find((x) => x.id === id)
    if (!a || a.candidates.some((c) => c.mediaId === m.id)) continue
    out = updateAsset(out, id, { candidates: [...a.candidates, { mediaId: m.id, path: m.path, kind: m.kind, ts: m.ts, title: m.title }] })
    if (a.status === 'requested' || a.status === 'rejected' || a.status === 'wanted') {
      out = a.status === 'wanted' ? setStatus(setStatus(out, id, 'requested', undefined, now), id, 'review', undefined, now) : setStatus(out, id, 'review', undefined, now)
    }
    arrived.add(id)
  }
  return { board: out, arrived: [...arrived] }
}

/** Reads a saved board back, repairing what it can. */
export function parseBoard(raw: unknown): Board {
  const b = emptyBoard()
  if (!raw || typeof raw !== 'object') return b
  const o = raw as Record<string, unknown>
  const st = (o.style ?? {}) as Record<string, unknown>
  b.style = {
    text: typeof st.text === 'string' ? st.text.slice(0, 5000) : '',
    palette: Array.isArray(st.palette) ? st.palette.filter((c): c is string => typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c)).slice(0, 16) : []
  }
  const seen = new Set<string>()
  for (const r of Array.isArray(o.assets) ? (o.assets as Record<string, unknown>[]) : []) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || seen.has(r.id) || !/^[a-z0-9][a-z0-9-]*$/.test(r.id)) continue
    const kind = ASSET_KINDS.includes(r.kind as AssetKind) ? (r.kind as AssetKind) : 'sprite'
    const spec = (r.spec ?? {}) as Record<string, unknown>
    seen.add(r.id)
    b.assets.push({
      id: r.id,
      name: typeof r.name === 'string' ? r.name.slice(0, 80) : r.id,
      kind,
      spec: {
        size: typeof spec.size === 'string' ? spec.size.slice(0, 80) : defaultSpec(kind, null).size,
        format: typeof spec.format === 'string' ? spec.format.slice(0, 120) : defaultSpec(kind, null).format,
        notes: typeof spec.notes === 'string' ? spec.notes.slice(0, 4000) : ''
      },
      targetPath: typeof r.targetPath === 'string' && !r.targetPath.includes('..') ? r.targetPath.slice(0, 300) : suggestPath(null, kind, String(r.name ?? r.id)),
      status: ASSET_STATUS.includes(r.status as AssetStatus) ? (r.status as AssetStatus) : 'wanted',
      candidates: Array.isArray(r.candidates)
        ? (r.candidates as Candidate[]).filter((c) => c && typeof c.mediaId === 'string' && typeof c.path === 'string').map((c) => ({ mediaId: c.mediaId, path: c.path, kind: String(c.kind ?? 'image'), ts: Number(c.ts) || 0, title: typeof c.title === 'string' ? c.title : undefined }))
        : [],
      chosen: typeof r.chosen === 'string' ? r.chosen : undefined,
      history: Array.isArray(r.history) ? (r.history as HistoryEntry[]).filter((h) => h && ASSET_STATUS.includes(h.status)).slice(-50) : []
    })
  }
  return b
}

export const boardJson = (b: Board): string => `${JSON.stringify(b, null, 2)}\n`

/** The width and height an image spec asks for, when it names them (`64x64`, `128 x 64`). */
export function pixelSize(spec: AssetSpec): { w: number; h: number } | null {
  const m = /(\d{1,5})\s*[x×]\s*(\d{1,5})/i.exec(spec.size)
  if (!m) return null
  const w = Number(m[1])
  const h = Number(m[2])
  return w > 0 && h > 0 && w <= 8192 && h <= 8192 ? { w, h } : null
}

function styleLines(style: StyleGuide): string[] {
  const out: string[] = []
  if (style.text.trim()) out.push(`Style guide: ${style.text.trim()}`)
  if (style.palette.length) out.push(`Palette: ${style.palette.join(', ')}`)
  return out
}

/** What the Asset Creator is asked to make. */
export function requestBrief(a: Asset, board: Board, engine: string | null): string {
  return [
    `Asset request from the Asset Board: "${a.name}" (\`${a.id}\`), a ${KIND_LABEL[a.kind].toLowerCase()}${engine ? ` for a ${engine} project` : ''}.`,
    `- Size: ${a.spec.size}`,
    `- Format: ${a.spec.format}`,
    a.spec.notes.trim() ? `- What it is: ${a.spec.notes.trim()}` : null,
    ...styleLines(board.style).map((l) => `- ${l}`),
    `- It will be placed at ${a.targetPath} once approved.`,
    '',
    'Generate it (one to three variations), then call `show_media` for each result with the title',
    `\`asset:${a.id} <short description>\` - that title is how the board finds it. Do not write it into the project yourself: the user picks one on the board and it is copied into place.`,
    'Finish with `report`: the prompts you used and the gallery titles.'
  ]
    .filter((l): l is string => l !== null)
    .join('\n')
}

/** Sends an asset back: what was wrong with what came, and the same rules for the next try. */
export function revisionBrief(a: Asset, note: string): string {
  return [
    `Revision for "${a.name}" (\`${a.id}\`) from the Asset Board: the candidates were not right.`,
    note.trim() ? `What to change: ${note.trim()}` : '',
    `Spec: ${a.spec.size}, ${a.spec.format}.`,
    `Show each new attempt with \`show_media\` titled \`asset:${a.id} <short description>\`, do not write it into the project, and report.`
  ]
    .filter(Boolean)
    .join('\n')
}

/** The agent asset requests go to: an Asset Creator by role, then by name. */
export function assetCreator<T extends { id: string; name: string; role: string }>(team: readonly T[]): T | undefined {
  return team.find((a) => a.role === 'asset-creator') ?? team.find((a) => /asset/i.test(a.name))
}
