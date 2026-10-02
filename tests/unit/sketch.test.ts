import { describe, expect, it } from 'vitest'
import { add, anchorPoint, byId, ELEMENT_TYPES, guessAnchor, layoutAt, copy, descendants, drawOrder, duplicate, exportJson, History, move, newSketch, parseSketch, paste, remove, reorder, settle, slug, snapRect, summary, tree, update } from '@shared/sketch/model'
import { cells, drawSketch } from '@shared/sketch/draw'
import { detectTarget, logicalSize, MC_SLOT, TARGETS } from '@shared/sketch/targets'
import { revisionBrief, sketchBrief, uiCreator } from '@shared/sketch/brief'

describe('sketch model', () => {
  it('starts a Minecraft sketch as vanilla lays out a container', () => {
    const sk = newSketch('Furnace', 'minecraft')
    expect(sk.canvas).toEqual({ w: 427, h: 240 })
    const win = sk.elements.find((e) => e.type === 'window')!
    expect([win.w, win.h]).toEqual([176, 166])
    const inv = sk.elements.find((e) => e.name === 'Player inventory')!
    const bar = sk.elements.find((e) => e.name === 'Hotbar')!
    expect([inv.x - win.x, inv.y - win.y, inv.w, inv.h, inv.cols, inv.rows]).toEqual([8, 84, 162, 54, 9, 3])
    expect([bar.x - win.x, bar.y - win.y, bar.h]).toEqual([8, 142, MC_SLOT])
    // everything inside the window was parented to it on the way in
    for (const e of sk.elements) if (e !== win) expect(e.parent).toBe(win.id)
    expect(cells(inv)).toHaveLength(27)
    expect(cells(inv)[10]).toEqual({ x: inv.x + MC_SLOT, y: inv.y + MC_SLOT, w: MC_SLOT, h: MC_SLOT })
    expect(newSketch('Page', 'web').elements).toHaveLength(0)
  })

  it('moves a container with its contents and re-parents what is dropped elsewhere', () => {
    let sk = newSketch('S', 'web')
    const a = add(sk, { type: 'panel', x: 0, y: 0, w: 200, h: 200 })
    sk = a.sketch
    const b = add(sk, { type: 'button', x: 20, y: 20, w: 40, h: 20 })
    sk = b.sketch
    expect(byId(sk, b.id)!.parent).toBe(a.id)
    sk = move(sk, [a.id, b.id], 10, 5) // the child is selected too, but moves only once
    expect(byId(sk, b.id)).toMatchObject({ x: 30, y: 25 })
    const c = add(sk, { type: 'panel', x: 400, y: 0, w: 200, h: 200 })
    sk = move(c.sketch, [b.id], 400, 0)
    sk = settle(sk, [b.id])
    expect(byId(sk, b.id)!.parent).toBe(c.id)
    // a container never lands inside itself
    sk = settle(move(sk, [c.id], -380, 0), [c.id])
    expect(byId(sk, c.id)!.parent).toBe(a.id)
    expect(descendants(sk, a.id).map((e) => e.id)).toEqual([c.id, b.id])
    // update carries the contents along too
    sk = update(sk, a.id, { x: 100 })
    expect(byId(sk, b.id)!.x).toBe(byId(sk, c.id)!.x + 30)
    expect(remove(sk, [a.id]).elements).toHaveLength(0)
  })

  it('duplicates, copies and pastes with fresh ids and parents kept', () => {
    let sk = newSketch('S', 'web')
    const p = add(sk, { type: 'panel', x: 0, y: 0, w: 100, h: 100 })
    sk = add(p.sketch, { type: 'label', x: 10, y: 10, w: 40, h: 20 }).sketch
    const d = duplicate(sk, [p.id], 8)
    expect(d.sketch.elements).toHaveLength(4)
    const copyPanel = byId(d.sketch, d.ids[0])!
    expect(copyPanel).toMatchObject({ x: 8, y: 8, name: 'Panel copy' })
    expect(descendants(d.sketch, copyPanel.id)).toHaveLength(1)
    const pasted = paste(sk, copy(sk, [p.id]), 300)
    expect(pasted.sketch.elements).toHaveLength(4)
    expect(new Set(pasted.sketch.elements.map((e) => e.id)).size).toBe(4)
    expect(descendants(pasted.sketch, pasted.ids[0])[0]).toMatchObject({ x: 310, y: 310 })
  })

  it('reorders among siblings and draws children after their parent', () => {
    let sk = newSketch('S', 'web')
    const a = add(sk, { type: 'panel', x: 0, y: 0, w: 50, h: 50 }, null)
    const b = add(a.sketch, { type: 'panel', x: 100, y: 0, w: 50, h: 50 }, null)
    const c = add(b.sketch, { type: 'button', x: 5, y: 5, w: 10, h: 10 })
    sk = reorder(c.sketch, a.id, 'top')
    expect(drawOrder(sk).map((e) => e.id)).toEqual([b.id, a.id, c.id])
    expect(reorder(sk, a.id, 'top')).toBe(sk)
  })

  it('snaps to the grid, or lines up with a nearby edge', () => {
    let sk = newSketch('S', 'web')
    const a = add(sk, { type: 'panel', x: 100, y: 100, w: 100, h: 100 })
    sk = a.sketch
    expect(snapRect(sk, { x: 13, y: 501, w: 10, h: 10 }, new Set(), 8, 4)).toMatchObject({ x: 16, y: 504, guides: [] })
    const near = snapRect(sk, { x: 203, y: 400, w: 20, h: 20 }, new Set(), 8, 4)
    expect(near.x).toBe(200)
    expect(near.guides).toEqual([{ axis: 'x', at: 200 }])
  })

  it('exports a tree with relative positions and reads it back', () => {
    const sk = newSketch('Furnace GUI', 'minecraft')
    const t = tree(sk)
    expect(t).toHaveLength(1)
    expect(t[0].children!.find((n) => n.name === 'Hotbar')).toMatchObject({ x: 8, y: 142 })
    const json = JSON.parse(exportJson(sk))
    expect(json.units).toBe('GUI px')
    const back = parseSketch(json)!
    expect(back.elements.map((e) => [e.id, e.parent, e.x, e.y])).toEqual(sk.elements.map((e) => [e.id, e.parent, e.x, e.y]))
    expect(parseSketch({ preset: 'nope', elements: [] })).toBeNull()
    // a hand-edited file with a loop or a missing parent still opens
    const broken = parseSketch({ preset: 'web', elements: [{ id: 'a', type: 'panel', parent: 'b' }, { id: 'b', type: 'panel', parent: 'a' }, { id: 'c', type: 'nope' }, { id: 'd', type: 'label', parent: 'zz' }] })!
    expect(broken.elements.map((e) => e.id)).toEqual(['a', 'b', 'd'])
    expect(broken.elements.find((e) => e.id === 'd')!.parent).toBeNull()
    expect(broken.elements.some((e) => e.parent === null && (e.id === 'a' || e.id === 'b'))).toBe(true)
    expect(slug('../Furnace GUI!')).toBe('furnace-gui')
  })

  it('undoes and redoes whole sketches', () => {
    const h = new History()
    const s0 = newSketch('S', 'web')
    const s1 = add(s0, { type: 'button', x: 0, y: 0, w: 10, h: 10 }).sketch
    h.push(s0)
    expect(h.undo(s1)).toBe(s0)
    expect(h.redo(s0)).toBe(s1)
    expect(h.canRedo).toBe(false)
  })
})

describe('sketch drawing and briefs', () => {
  it('draws every element in every look, inside the canvas', () => {
    let sk = newSketch('All', 'minecraft')
    const types = ELEMENT_TYPES.filter((t) => t !== 'window')
    types.forEach((type, i) => (sk = add(sk, { type, x: 2 + (i % 7) * 60, y: 2 + Math.floor(i / 7) * 40, w: 50, h: 30 }, null).sketch))
    for (const look of ['wireframe', 'minecraft', 'web', 'desktop', 'game'] as const) {
      const ops = drawSketch(sk, look)
      const drawn = new Set(ops.map((o) => ('el' in o ? o.el : undefined)).filter(Boolean))
      // groups are invisible in the styled looks; everything else draws something
      for (const e of sk.elements) if (look === 'wireframe' || e.type !== 'group') expect(drawn.has(e.id), `${e.type} in ${look}`).toBe(true)
      for (const o of ops) if (o.k === 'rect') expect(o.x + o.w).toBeLessThanOrEqual(sk.canvas.w + 1)
      for (const o of ops) for (const v of Object.values(o)) if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true)
    }
    // hidden elements and everything inside them are left out
    const win = sk.elements.find((e) => e.type === 'window')!
    const hidden = drawSketch(update(sk, win.id, { hidden: true }), 'wireframe')
    expect(hidden.some((o) => 'el' in o && o.el === win.id)).toBe(false)
    expect(hidden.some((o) => 'el' in o && sk.elements.find((e) => e.id === o.el)?.parent === win.id)).toBe(false)
    expect(TARGETS.minecraft.canvas.w * TARGETS.minecraft.scale).toBeGreaterThanOrEqual(1280)
  })

  it('briefs Mastermind with the paths, the outline and the UI Creator', () => {
    const sk = newSketch('Furnace', 'minecraft')
    const none = sketchBrief(sk, [{ id: 'mastermind', name: 'Mastermind', role: 'mastermind' }], 'make it look vanilla')
    expect(none).toContain('.multimine/sketches/furnace/sketch.json')
    expect(none).toContain('From the user: make it look vanilla')
    expect(none).toContain('slotgrid "Player inventory" 162x54 at 8,84 9x3')
    expect(none).toContain('role `ui-creator`')
    const team = [{ id: 'ui', name: 'Pixel', role: 'ui-creator' }]
    expect(uiCreator(team)!.id).toBe('ui')
    expect(sketchBrief(sk, team, '')).toContain('delegate this to Pixel (`ui`)')
    expect(summary(sk).split('\n')[0]).toMatch(/^- window "Container" 176x166/)
    expect(revisionBrief(sk, '.multimine/sketches/furnace/revision-1.png', 'move the arrow')).toContain('move the arrow')
  })
})

describe('sketch targets', () => {
  it('knows a project by its root', async () => {
    const none = async () => null
    expect(await detectTarget(['project.godot', 'scenes/'], none)).toBe('godot')
    expect(await detectTarget(['Assets/', 'ProjectSettings/', 'Packages/'], none)).toBe('unity')
    expect(await detectTarget(['Shooter.uproject', 'Source/'], none)).toBe('unreal')
    expect(await detectTarget(['build.gradle', 'src/'], async () => "plugins { id 'net.neoforged.moddev' }\nneoForge { version = '21.4' }")).toBe('minecraft')
    expect(await detectTarget(['build.gradle'], async () => "apply plugin: 'java'")).toBeNull()
    expect(await detectTarget(['package.json', 'src/'], none)).toBe('web')
    expect(await detectTarget(['README.md'], none)).toBeNull()
  })

  it('opens a schema 1 sketch as schema 2', () => {
    const old = { schema: 1, name: 'Old', preset: 'minecraft', canvas: { w: 427, h: 240 }, elements: [{ id: 'a', type: 'button', x: 1, y: 2, w: 3, h: 4, parent: null }] }
    const sk = parseSketch(old)!
    expect(sk).toMatchObject({ schema: 2, target: 'minecraft' })
    expect(JSON.parse(exportJson(sk))).toMatchObject({ schema: 2, target: 'minecraft', engine: 'Minecraft', uiScale: 'minecraft' })
  })

  it('anchors what is drawn to the part of the screen it was drawn in', () => {
    const canvas = { x: 0, y: 0, w: 1920, h: 1080 }
    expect(guessAnchor({ x: 40, y: 980, w: 360, h: 28 }, canvas)).toBe('bottom-left')
    expect(guessAnchor({ x: 1640, y: 40, w: 240, h: 240 }, canvas)).toBe('top-right')
    expect(guessAnchor({ x: 936, y: 516, w: 48, h: 48 }, canvas)).toBe('center')
    const sk = add(newSketch('Hud', 'godot'), { type: 'minimap', x: 1640, y: 40, w: 240, h: 240 }).sketch
    expect(sk.elements[0].anchor).toBe('top-right')
    expect(anchorPoint('bottom-right')).toEqual({ x: 1, y: 1 })
  })

  it('lays a HUD out on another screen the way an engine resolves anchors', () => {
    let sk = newSketch('Hud', 'godot')
    sk = add(sk, { type: 'minimap', x: 1640, y: 40, w: 240, h: 240 }).sketch // top-right
    sk = add(sk, { type: 'bar', name: 'Health', x: 40, y: 1012, w: 360, h: 28 }).sketch // bottom-left
    sk = add(sk, { type: 'crosshair', x: 936, y: 516, w: 48, h: 48 }).sketch // centre
    sk = add(sk, { type: 'panel', x: 0, y: 0, w: 1920, h: 64, anchor: 'top', stretch: { x: true } }).sketch
    const [map, bar, aim, strip] = layoutAt(sk, 2560, 1080).elements
    expect(map).toMatchObject({ x: 2280, y: 40, w: 240 }) // kept 40 from the right edge
    expect(bar).toMatchObject({ x: 40, y: 1012 })
    expect(aim).toMatchObject({ x: 1256, y: 516 }) // still centred
    expect(strip).toMatchObject({ x: 0, w: 2560 }) // stretched
    // children follow their parent and keep their own anchor inside it
    let mc = newSketch('Box', 'minecraft')
    const win = mc.elements[0]
    mc = layoutAt(mc, 480, 270)
    const moved = mc.elements.find((e) => e.id === win.id)!
    expect(moved.x).toBe(win.x + Math.round((480 - 427) / 2))
    const hotbar = mc.elements.find((e) => e.name === 'Hotbar')!
    expect([hotbar.x - moved.x, hotbar.y - moved.y]).toEqual([8, 142])
  })

  it('scales a UI the way each platform does', () => {
    expect(logicalSize(TARGETS.godot, { w: 3840, h: 2160 })).toEqual({ w: 1920, h: 1080, scale: 2 })
    expect(logicalSize(TARGETS.unity, { w: 3440, h: 1440 })).toMatchObject({ w: 2580, h: 1080 })
    expect(logicalSize(TARGETS.minecraft, { w: 1280, h: 720 })).toEqual({ w: 426, h: 240, scale: 3 })
    expect(logicalSize(TARGETS.minecraft, { w: 1920, h: 1080 })).toEqual({ w: 480, h: 270, scale: 4 })
    expect(logicalSize(TARGETS.web, { w: 390, h: 844 })).toEqual({ w: 390, h: 844, scale: 1 })
  })

  it('briefs the builder for its engine', () => {
    const godot = sketchBrief(newSketch('Hud', 'godot'), [], '')
    expect(godot).toContain('Build it for Godot')
    expect(godot).toContain('Control scene')
    expect(godot).toContain('2560x1440')
    expect(sketchBrief(newSketch('Hud', 'unity'), [], '')).toContain('UI Toolkit')
    expect(sketchBrief(newSketch('Hud', 'unreal'), [], '')).toContain('UUserWidget')
    expect(godot).toContain('multimine.md')
  })
})
