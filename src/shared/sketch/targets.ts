import type { ElementType, SketchElement } from './model'

/**
 * What a sketch is for: an engine or platform, with the screen it is designed at, the screens it is
 * previewed at, how that platform scales a UI between them, the elements that make sense there, and
 * what the agent who builds it is told about building and capturing it.
 */
export type TargetId = 'godot' | 'unity' | 'unreal' | 'minecraft' | 'web' | 'mobile' | 'desktop'
export type SketchStyle = 'game' | 'minecraft' | 'web' | 'desktop'

/**
 * How a screen of another size is laid out:
 * - `fit`: the engine scales the UI by the smaller of the two ratios and widens the other axis
 *   (Godot's canvas_items stretch with aspect "expand", Unity's Canvas Scaler in Expand mode, Unreal's
 *   DPI curve on the short side).
 * - `fixed`: one unit is one pixel (the web and desktop apps).
 * - `minecraft`: the automatic GUI scale, the largest integer that leaves at least 320x240.
 */
export type UiScale = 'fit' | 'fixed' | 'minecraft'

export interface Screen {
  label: string
  w: number
  h: number
}

export interface Target {
  id: TargetId
  label: string
  family: 'game' | 'app'
  engine: string
  /** The design canvas, in the target's own units. */
  canvas: { w: number; h: number }
  /** Screens the mockup is previewed at, in device pixels. */
  screens: Screen[]
  uiScale: UiScale
  units: string
  /** Positions and sizes snap to this. */
  grid: number
  /** Device pixels per unit in the exported PNGs. */
  scale: number
  style: SketchStyle
  /** Title-safe inset as a fraction of each side, for game screens; 0 for none. */
  safeArea: number
  /** The palette, in order. */
  elements: ElementType[]
  sizes: Record<ElementType, { w: number; h: number }>
  /** How the agent should build it, and how it should look at the result. */
  build: string[]
  capture: string[]
}

/** One inventory slot in GUI pixels: 16px item plus a 1px border either side. */
export const MC_SLOT = 18

const COMMON: ElementType[] = ['window', 'panel', 'group', 'button', 'label', 'textfield', 'image', 'icon', 'list', 'tabs', 'dropdown', 'slider', 'checkbox', 'toggle', 'progress', 'tooltip', 'modal']
const GAME: ElementType[] = ['bar', 'ability', 'slot', 'slotgrid', 'minimap', 'dialogue', 'crosshair', 'joystick', 'toast']

type Sizes = Target['sizes']

const GAME_SIZES: Sizes = {
  window: { w: 640, h: 480 },
  panel: { w: 400, h: 260 },
  group: { w: 300, h: 200 },
  button: { w: 220, h: 56 },
  label: { w: 240, h: 32 },
  textfield: { w: 360, h: 56 },
  slot: { w: 72, h: 72 },
  slotgrid: { w: 72 * 6, h: 72 * 2 },
  image: { w: 160, h: 160 },
  icon: { w: 48, h: 48 },
  list: { w: 360, h: 400 },
  tabs: { w: 480, h: 52 },
  dropdown: { w: 280, h: 52 },
  slider: { w: 320, h: 32 },
  checkbox: { w: 36, h: 36 },
  toggle: { w: 72, h: 36 },
  progress: { w: 320, h: 16 },
  tooltip: { w: 280, h: 80 },
  modal: { w: 720, h: 420 },
  bar: { w: 360, h: 28 },
  ability: { w: 80, h: 80 },
  minimap: { w: 240, h: 240 },
  dialogue: { w: 1100, h: 220 },
  crosshair: { w: 48, h: 48 },
  joystick: { w: 220, h: 220 },
  toast: { w: 420, h: 72 }
}

const WEB_SIZES: Sizes = {
  window: { w: 960, h: 640 },
  panel: { w: 320, h: 200 },
  group: { w: 200, h: 120 },
  button: { w: 120, h: 40 },
  label: { w: 160, h: 24 },
  textfield: { w: 240, h: 40 },
  slot: { w: 48, h: 48 },
  slotgrid: { w: 48 * 4, h: 48 * 3 },
  image: { w: 160, h: 120 },
  icon: { w: 24, h: 24 },
  list: { w: 280, h: 320 },
  tabs: { w: 400, h: 44 },
  dropdown: { w: 240, h: 40 },
  slider: { w: 200, h: 24 },
  checkbox: { w: 24, h: 24 },
  toggle: { w: 44, h: 24 },
  progress: { w: 240, h: 8 },
  tooltip: { w: 160, h: 40 },
  modal: { w: 560, h: 360 },
  bar: { w: 240, h: 12 },
  ability: { w: 56, h: 56 },
  minimap: { w: 200, h: 200 },
  dialogue: { w: 640, h: 160 },
  crosshair: { w: 32, h: 32 },
  joystick: { w: 160, h: 160 },
  toast: { w: 360, h: 64 }
}

const MOBILE_SIZES: Sizes = {
  ...WEB_SIZES,
  window: { w: 358, h: 600 },
  panel: { w: 326, h: 160 },
  button: { w: 326, h: 48 },
  textfield: { w: 326, h: 48 },
  list: { w: 358, h: 400 },
  tabs: { w: 358, h: 48 },
  dropdown: { w: 326, h: 48 },
  slider: { w: 280, h: 24 },
  progress: { w: 280, h: 8 },
  modal: { w: 340, h: 300 },
  toast: { w: 340, h: 56 }
}

const MC_SIZES: Sizes = {
  window: { w: 176, h: 166 },
  panel: { w: 80, h: 60 },
  group: { w: 60, h: 40 },
  button: { w: 60, h: 20 },
  label: { w: 60, h: 10 },
  textfield: { w: 100, h: 20 },
  slot: { w: MC_SLOT, h: MC_SLOT },
  slotgrid: { w: MC_SLOT * 9, h: MC_SLOT * 3 },
  image: { w: 16, h: 16 },
  icon: { w: 16, h: 16 },
  list: { w: 120, h: 80 },
  tabs: { w: 130, h: 26 },
  dropdown: { w: 100, h: 20 },
  slider: { w: 120, h: 20 },
  checkbox: { w: 20, h: 20 },
  toggle: { w: 40, h: 20 },
  progress: { w: 24, h: 16 },
  tooltip: { w: 80, h: 24 },
  modal: { w: 200, h: 120 },
  // a row of ten hearts is 81 wide; the hotbar slot is 20 inside its 22px frame; a toast is 160x32
  bar: { w: 81, h: 9 },
  ability: { w: 22, h: 22 },
  minimap: { w: 64, h: 64 },
  dialogue: { w: 220, h: 54 },
  crosshair: { w: 15, h: 15 },
  joystick: { w: 40, h: 40 },
  toast: { w: 160, h: 32 }
}

const ENGINE_SCREENS: Screen[] = [
  { label: 'Full HD', w: 1920, h: 1080 },
  { label: 'HD', w: 1280, h: 720 },
  { label: 'QHD', w: 2560, h: 1440 },
  { label: 'Ultrawide', w: 3440, h: 1440 },
  { label: 'Steam Deck', w: 1280, h: 800 },
  { label: 'Phone', w: 2340, h: 1080 }
]

const engine = (id: 'godot' | 'unity' | 'unreal', label: string, build: string[], capture: string[]): Target => ({
  id,
  label,
  family: 'game',
  engine: label,
  canvas: { w: 1920, h: 1080 },
  screens: ENGINE_SCREENS,
  uiScale: 'fit',
  units: 'px at 1920x1080',
  grid: 8,
  scale: 1,
  style: 'game',
  safeArea: 0.05,
  elements: [...COMMON, ...GAME],
  sizes: GAME_SIZES,
  build,
  capture
})

const ANCHOR_NOTE = 'Each element has an anchor (the corner, edge midpoint or centre of its parent it keeps its distance to) and may stretch on x and/or y; use exactly those anchors so it holds at every screen in `sizes`.'

export const TARGETS: Record<TargetId, Target> = {
  godot: engine(
    'godot',
    'Godot',
    [
      'Build it as a Control scene (`.tscn`) in the folder the project keeps its UI in: one node per element, the tree as in sketch.json.',
      `${ANCHOR_NOTE} In Godot that is the node's anchor preset plus offsets; stretch is anchor 0..1 on that axis.`,
      'Lists become a ScrollContainer with a VBoxContainer, tabs a TabBar or TabContainer, bars a ProgressBar or TextureProgressBar. Put colours and fonts in a Theme resource if the project has none.',
      'The design size is 1920x1080 with canvas_items stretch and aspect "expand"; if project.godot says otherwise, follow the project.'
    ],
    [
      'Add a small capture script (or reuse one) that opens the scene, waits a few frames, saves `get_viewport().get_texture().get_image()` as PNG and quits; run it with the godot binary (`godot --path . <scene>`), then `show_media` the PNG.',
      'If no godot binary is on PATH, say so and give the user the exact command to run.'
    ]
  ),
  unity: engine(
    'unity',
    'Unity',
    [
      'Use what the project already uses: UI Toolkit (UXML + USS, plus a UIDocument) by default, a UGUI Canvas prefab if the project already builds its UI with UnityEngine.UI. Put files where the project keeps UI.',
      `${ANCHOR_NOTE} In UGUI that is RectTransform anchorMin/anchorMax/pivot plus anchoredPosition; in UI Toolkit, absolute position with left/right/top/bottom and percentage sizes for stretch.`,
      'Lists become a ListView or ScrollView, bars a ProgressBar or a filled Image. Reference resolution 1920x1080 with Canvas Scaler match 0.5 / Expand.'
    ],
    [
      'Capture with an editor or play-mode script using `ScreenCapture.CaptureScreenshot` (or render the UIDocument panel to a RenderTexture) run via `Unity -batchmode -projectPath . -executeMethod <Class.Method>` without -nographics; `show_media` the PNG.',
      'Unity capture is best effort: if it cannot run here, say exactly why and what the user should run.'
    ]
  ),
  unreal: engine(
    'unreal',
    'Unreal',
    [
      'UMG widget blueprints are binary `.uasset` files an agent cannot write as text, so build a C++ `UUserWidget` subclass that constructs its widget tree in code (CanvasPanel slots with anchors), or Slate if the project uses it; a designer can wrap it in a Widget Blueprint later.',
      `${ANCHOR_NOTE} In UMG that is the CanvasPanelSlot's Anchors (min/max), Offsets and Alignment.`,
      'Bars become UProgressBar, lists UListView or a UScrollBox. Design at 1920x1080 with the default DPI curve.'
    ],
    [
      'Capture with the game running the widget and `HighResShot` (or an automation test that takes a screenshot), then `show_media` it.',
      'Unreal builds and captures are slow and often impossible headless: if so, say what to run and how to show the screenshot.'
    ]
  ),
  minecraft: {
    id: 'minecraft',
    label: 'Minecraft GUI',
    family: 'game',
    engine: 'Minecraft',
    // 1280x720 at GUI scale 3
    canvas: { w: 427, h: 240 },
    screens: [
      { label: '1280x720', w: 1280, h: 720 },
      { label: '1920x1080', w: 1920, h: 1080 },
      { label: '2560x1440', w: 2560, h: 1440 },
      { label: '854x480', w: 854, h: 480 }
    ],
    uiScale: 'minecraft',
    units: 'GUI px',
    grid: 2,
    scale: 3,
    style: 'minecraft',
    safeArea: 0,
    elements: [...COMMON, ...GAME.filter((t) => t !== 'joystick')],
    sizes: MC_SIZES,
    build: [
      'Build it as the project builds its screens (a Screen or AbstractContainerScreen with its menu). Units are GUI pixels; a slot is 18, a container 176 wide. Positions in tree[] are relative to the parent, exactly as leftPos/topPos offsets.',
      ANCHOR_NOTE
    ],
    capture: ['Launch the dev client with the project\'s automatic screenshot option (multimine.md and the context map say how), open the screen, and `show_media` the screenshot.']
  },
  web: {
    id: 'web',
    label: 'Web (desktop)',
    family: 'app',
    engine: 'Web',
    canvas: { w: 1440, h: 900 },
    screens: [
      { label: 'Desktop', w: 1440, h: 900 },
      { label: 'Full HD', w: 1920, h: 1080 },
      { label: 'Tablet', w: 1024, h: 768 },
      { label: 'Phone', w: 390, h: 844 }
    ],
    uiScale: 'fixed',
    units: 'px',
    grid: 8,
    scale: 1,
    style: 'web',
    safeArea: 0,
    elements: [...COMMON, 'toast'],
    sizes: WEB_SIZES,
    build: ['Build it with the project\'s own frontend stack and components (framework, styling, design tokens).', ANCHOR_NOTE],
    capture: ['Run the dev server, open the page with Playwright (or the project\'s e2e tool), screenshot it, and `show_media` the PNG.']
  },
  mobile: {
    id: 'mobile',
    label: 'Web (mobile)',
    family: 'app',
    engine: 'Mobile web',
    canvas: { w: 390, h: 844 },
    screens: [
      { label: 'iPhone', w: 390, h: 844 },
      { label: 'Small Android', w: 360, h: 800 },
      { label: 'Large phone', w: 430, h: 932 }
    ],
    uiScale: 'fixed',
    units: 'px',
    grid: 8,
    scale: 1,
    style: 'web',
    safeArea: 0,
    elements: [...COMMON, 'toast'],
    sizes: MOBILE_SIZES,
    build: ['Build it with the project\'s own frontend stack, mobile first.', ANCHOR_NOTE],
    capture: ['Screenshot it in a 390x844 viewport with Playwright and `show_media` the PNG.']
  },
  desktop: {
    id: 'desktop',
    label: 'Desktop app',
    family: 'app',
    engine: 'Desktop',
    canvas: { w: 1280, h: 800 },
    screens: [
      { label: 'Default', w: 1280, h: 800 },
      { label: 'Small', w: 1024, h: 680 },
      { label: 'Large', w: 1920, h: 1080 }
    ],
    uiScale: 'fixed',
    units: 'px',
    grid: 8,
    scale: 1,
    style: 'desktop',
    safeArea: 0,
    elements: [...COMMON, 'toast'],
    sizes: WEB_SIZES,
    build: ['Build it with the project\'s UI toolkit.', ANCHOR_NOTE],
    capture: ['Run the app, screenshot the window, and `show_media` the PNG.']
  }
}

export const TARGET_IDS = Object.keys(TARGETS) as TargetId[]

/** The logical size a screen gives the UI, and how many device pixels one unit is there. */
export function logicalSize(t: Target, screen: { w: number; h: number }): { w: number; h: number; scale: number } {
  if (t.uiScale === 'fixed') return { w: screen.w, h: screen.h, scale: 1 }
  if (t.uiScale === 'minecraft') {
    let s = 1
    while (screen.w / (s + 1) >= 320 && screen.h / (s + 1) >= 240) s++
    return { w: Math.floor(screen.w / s), h: Math.floor(screen.h / s), scale: s }
  }
  const s = Math.min(screen.w / t.canvas.w, screen.h / t.canvas.h)
  return { w: Math.round(screen.w / s), h: Math.round(screen.h / s), scale: s }
}

/**
 * Which target a project is, from the names at its root (folders end in `/`) and, for Gradle, what
 * its build file says. Null when nothing gives it away.
 */
export async function detectTarget(names: readonly string[], read: (name: string) => Promise<string | null>): Promise<TargetId | null> {
  const has = (n: string) => names.includes(n)
  if (has('project.godot')) return 'godot'
  if (has('Assets/') && has('ProjectSettings/')) return 'unity'
  if (names.some((n) => n.toLowerCase().endsWith('.uproject'))) return 'unreal'
  for (const g of ['build.gradle', 'build.gradle.kts', 'gradle.properties']) {
    if (!has(g)) continue
    const text = (await read(g)) ?? ''
    if (/neoforge|fabric-loom|fabricmc|minecraftforge|net\.minecraft|minecraft_version/i.test(text)) return 'minecraft'
  }
  if (has('package.json')) return 'web'
  return null
}

type Draft = Omit<SketchElement, 'id' | 'parent' | 'anchor' | 'states' | 'notes'> & Partial<Pick<SketchElement, 'anchor' | 'states' | 'notes'>>

/**
 * The player inventory as vanilla lays it out inside a 176-wide container: its label at (8, 72), three
 * rows of nine at (8, 84) and the hotbar at (8, 142), relative to the container's corner.
 */
export function inventoryStamp(ox: number, oy: number): Draft[] {
  return [
    { type: 'label', name: 'Inventory label', x: ox + 8, y: oy + 72, w: 60, h: 10, text: 'Inventory', anchor: 'top-left' },
    { type: 'slotgrid', name: 'Player inventory', x: ox + 8, y: oy + 84, w: MC_SLOT * 9, h: MC_SLOT * 3, cols: 9, rows: 3, anchor: 'top-left' },
    { type: 'slotgrid', name: 'Hotbar', x: ox + 8, y: oy + 142, w: MC_SLOT * 9, h: MC_SLOT, cols: 9, rows: 1, anchor: 'top-left' }
  ]
}

/** What a new sketch starts with: for Minecraft, a centred 176x166 container with its title and the player inventory; otherwise nothing. */
export function starter(id: TargetId): Draft[] {
  if (id !== 'minecraft') return []
  const p = TARGETS.minecraft
  const x = Math.round((p.canvas.w - 176) / 2 / p.grid) * p.grid
  const y = Math.round((p.canvas.h - 166) / 2 / p.grid) * p.grid
  return [
    { type: 'window', name: 'Container', x, y, w: 176, h: 166, anchor: 'center' },
    { type: 'label', name: 'Title', x: x + 8, y: y + 6, w: 80, h: 10, text: 'Container', anchor: 'top-left' },
    ...inventoryStamp(x, y)
  ]
}
