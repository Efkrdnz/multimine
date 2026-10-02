import type { ElementType, SketchElement } from './model'

export type PresetId = 'minecraft' | 'web' | 'mobile' | 'desktop'
export type SketchStyle = 'minecraft' | 'web' | 'desktop'

export interface Preset {
  id: PresetId
  label: string
  /** The screen the GUI is drawn on, in the target's own units. */
  canvas: { w: number; h: number }
  units: string
  /** Positions and sizes snap to this. */
  grid: number
  /** How many screen pixels one unit is drawn at by default, and in the mockup PNG. */
  scale: number
  style: SketchStyle
  /** The size a click (rather than a drag) puts down for each element type. */
  sizes: Record<ElementType, { w: number; h: number }>
}

/** One inventory slot in GUI pixels: 16px item plus a 1px border either side. */
export const MC_SLOT = 18

const MC_SIZES: Preset['sizes'] = {
  window: { w: 176, h: 166 },
  panel: { w: 80, h: 60 },
  group: { w: 60, h: 40 },
  button: { w: 60, h: 20 },
  label: { w: 60, h: 10 },
  textfield: { w: 100, h: 20 },
  slot: { w: MC_SLOT, h: MC_SLOT },
  slotgrid: { w: MC_SLOT * 9, h: MC_SLOT * 3 },
  image: { w: 16, h: 16 },
  list: { w: 120, h: 80 },
  slider: { w: 120, h: 20 },
  checkbox: { w: 20, h: 20 },
  progress: { w: 24, h: 16 },
  tooltip: { w: 80, h: 24 }
}

const WEB_SIZES: Preset['sizes'] = {
  window: { w: 960, h: 640 },
  panel: { w: 320, h: 200 },
  group: { w: 200, h: 120 },
  button: { w: 120, h: 40 },
  label: { w: 160, h: 24 },
  textfield: { w: 240, h: 40 },
  slot: { w: 48, h: 48 },
  slotgrid: { w: 48 * 4, h: 48 * 3 },
  image: { w: 160, h: 120 },
  list: { w: 280, h: 320 },
  slider: { w: 200, h: 24 },
  checkbox: { w: 24, h: 24 },
  progress: { w: 240, h: 8 },
  tooltip: { w: 160, h: 40 }
}

const MOBILE_SIZES: Preset['sizes'] = {
  ...WEB_SIZES,
  window: { w: 358, h: 600 },
  panel: { w: 326, h: 160 },
  button: { w: 326, h: 48 },
  textfield: { w: 326, h: 48 },
  list: { w: 358, h: 400 },
  slider: { w: 280, h: 24 },
  progress: { w: 280, h: 8 }
}

export const PRESETS: Record<PresetId, Preset> = {
  minecraft: {
    id: 'minecraft',
    label: 'Minecraft GUI',
    // 1280x720 at GUI scale 3
    canvas: { w: 427, h: 240 },
    units: 'GUI px',
    grid: 2,
    scale: 3,
    style: 'minecraft',
    sizes: MC_SIZES
  },
  web: { id: 'web', label: 'Web (desktop)', canvas: { w: 1440, h: 900 }, units: 'px', grid: 8, scale: 1, style: 'web', sizes: WEB_SIZES },
  mobile: { id: 'mobile', label: 'Web (mobile)', canvas: { w: 390, h: 844 }, units: 'px', grid: 8, scale: 1, style: 'web', sizes: MOBILE_SIZES },
  desktop: { id: 'desktop', label: 'Desktop app', canvas: { w: 1280, h: 800 }, units: 'px', grid: 8, scale: 1, style: 'desktop', sizes: WEB_SIZES }
}

export const PRESET_IDS = Object.keys(PRESETS) as PresetId[]

type Draft = Omit<SketchElement, 'id' | 'parent' | 'anchor' | 'states' | 'notes'> & Partial<Pick<SketchElement, 'anchor' | 'states' | 'notes'>>

/**
 * The player inventory as vanilla lays it out inside a 176-wide container: its label at (8, 72), three
 * rows of nine at (8, 84) and the hotbar at (8, 142), relative to the container's corner.
 */
export function inventoryStamp(ox: number, oy: number): Draft[] {
  return [
    { type: 'label', name: 'Inventory label', x: ox + 8, y: oy + 72, w: 60, h: 10, text: 'Inventory' },
    { type: 'slotgrid', name: 'Player inventory', x: ox + 8, y: oy + 84, w: MC_SLOT * 9, h: MC_SLOT * 3, cols: 9, rows: 3 },
    { type: 'slotgrid', name: 'Hotbar', x: ox + 8, y: oy + 142, w: MC_SLOT * 9, h: MC_SLOT, cols: 9, rows: 1 }
  ]
}

/** What a new sketch starts with: for Minecraft, a centred 176x166 container with its title and the player inventory. */
export function starter(id: PresetId): Draft[] {
  if (id !== 'minecraft') return []
  const p = PRESETS.minecraft
  const x = Math.round((p.canvas.w - 176) / 2 / p.grid) * p.grid
  const y = Math.round((p.canvas.h - 166) / 2 / p.grid) * p.grid
  return [
    { type: 'window', name: 'Container', x, y, w: 176, h: 166, anchor: 'center' },
    { type: 'label', name: 'Title', x: x + 8, y: y + 6, w: 80, h: 10, text: 'Container' },
    ...inventoryStamp(x, y)
  ]
}
