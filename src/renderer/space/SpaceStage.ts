import 'pixi.js/unsafe-eval'
import { Application, Container, Graphics, Rectangle, type FederatedPointerEvent } from 'pixi.js'
import { modelLabel } from '@shared/catalog'
import { MASTERMIND_ID, type AgentSpec, type AgentStatus, type AppSettings, type Channel, type CouncilCritic, type MainEvent } from '@shared/types'
import { AgentOrb } from './AgentOrb'
import { BrainNode } from './BrainNode'
import { LinkLayer } from './LinkLayer'
import { Starfield } from './Starfield'

export interface SceneState {
  agents: AgentSpec[]
  layout: Record<string, { x: number; y: number }>
  status: Record<string, { status: AgentStatus; activity?: string; temp?: { model: string; effort: string; difficulty: string } }>
  pending: number
  council: CouncilCritic[]
  channels: Channel[]
  focused: string | null
  catalog: AppSettings['catalog']
}

export interface SceneCallbacks {
  open(id: string): void
  edit(id: string): void
  move(id: string, x: number, y: number): void
}

/**
 * Where a new agent with no saved position goes: the slot on the orbit ellipses farthest from every
 * orb already placed, so a growing team spreads out instead of stacking on one spot.
 */
export function freeSlot(taken: { x: number; y: number }[]): { x: number; y: number } {
  const slots: { x: number; y: number }[] = []
  for (const [rx, ry, n, off] of [
    [360, 250, 8, 0],
    [520, 360, 12, Math.PI / 12]
  ] as const)
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + off + (i / n) * Math.PI * 2
      slots.push({ x: Math.round(Math.cos(a) * rx), y: Math.round(Math.sin(a) * ry) })
    }
  let best = slots[0]
  let bestD = -1
  for (const s of slots) {
    const d = taken.length ? Math.min(...taken.map((t) => Math.hypot(t.x - s.x, t.y - s.y))) : Infinity
    // prefer the inner ring until it is crowded
    const score = Math.min(d, 400) - (Math.abs(s.x) > 400 ? 60 : 0)
    if (score > bestD) {
      bestD = score
      best = s
    }
  }
  return best
}

/** The whole space scene. React hands it state; it owns animation, camera and dragging. */
export class SpaceStage {
  private app = new Application()
  private sky = new Starfield()
  private world = new Container()
  private rings = new Graphics()
  private links: LinkLayer
  private nodes = new Container()
  private brain = new BrainNode()
  private orbs = new Map<string, AgentOrb>()
  private critics = new Map<string, AgentOrb>()
  private state: SceneState | null = null
  private cam = { x: 0, y: 0, zoom: 1 }
  /** Until the user pans or zooms, the camera keeps the whole team in view. */
  private manualCam = false
  private lastBgClick = 0
  private drag: { kind: 'pan' | 'node'; id?: string; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null = null
  private lastClick = { id: '', at: 0 }
  private t = 0
  private ready = false

  constructor(private readonly cb: SceneCallbacks) {
    this.links = new LinkLayer((id) => this.locate(id), MASTERMIND_ID)
  }

  async mount(host: HTMLElement): Promise<void> {
    try {
      await this.app.init({ resizeTo: host, background: '#04050d', antialias: true, autoDensity: true, resolution: Math.min(2, window.devicePixelRatio || 1), preference: 'webgl' })
    } catch (e) {
      // no WebGL (a GPU blocklist, a remote desktop): the panels still work over a plain sky
      host.style.background = 'radial-gradient(ellipse at 30% 30%, #2e1065 0%, #04050d 60%)'
      console.error('Space view unavailable:', e)
      return
    }
    host.appendChild(this.app.canvas)
    this.app.stage.addChild(this.sky, this.world)
    this.world.addChild(this.rings, this.links, this.nodes)
    this.nodes.addChild(this.brain)
    this.brain.on('pointertap', () => this.cb.open(MASTERMIND_ID))

    const stage = this.app.stage
    stage.eventMode = 'static'
    stage.hitArea = new Rectangle(-1e5, -1e5, 2e5, 2e5)
    stage.on('pointerdown', (e) => this.down(e))
    stage.on('globalpointermove', (e) => this.moveTo(e))
    stage.on('pointerup', () => this.up())
    stage.on('pointerupoutside', () => this.up())
    this.app.canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false })

    this.app.ticker.add((ticker) => this.frame(ticker.deltaMS))
    this.ready = true
    if (this.state) this.sync(this.state)
  }

  destroy(): void {
    this.app.destroy(true, { children: true })
  }

  private locate(id: string): { x: number; y: number } | null {
    if (id === MASTERMIND_ID || id === 'user' || id === 'council') return { x: 0, y: 0 }
    if (id === 'context') {
      const handler = this.state?.agents.find((a) => a.role === 'context-handler')
      return handler ? this.locate(handler.id) : { x: 0, y: 0 }
    }
    const critic = this.critics.get(id)
    if (critic) return { x: critic.x, y: critic.y }
    const orb = this.orbs.get(id)
    return orb ? { x: orb.x, y: orb.y } : null
  }

  sync(state: SceneState): void {
    const prevCouncil = this.state?.council ?? []
    this.state = state
    if (!this.ready) return
    const others = state.agents.filter((a) => a.id !== MASTERMIND_ID)
    const seen = new Set<string>()
    others.forEach((a) => {
      seen.add(a.id)
      let orb = this.orbs.get(a.id)
      if (!orb) {
        orb = new AgentOrb()
        let pos = state.layout[a.id]
        if (!pos) {
          pos = freeSlot([...this.orbs.values()].map((o) => ({ x: o.x, y: o.y })))
          // remember it, so the team keeps its shape across restarts
          this.cb.move(a.id, pos.x, pos.y)
        }
        orb.position.set(pos.x, pos.y)
        orb.on('pointerdown', (e: FederatedPointerEvent) => {
          e.stopPropagation()
          this.drag = { kind: 'node', id: a.id, sx: e.global.x, sy: e.global.y, ox: orb!.x, oy: orb!.y, moved: false }
        })
        this.orbs.set(a.id, orb)
        this.nodes.addChild(orb)
      } else if (state.layout[a.id] && !(this.drag?.id === a.id)) {
        orb.position.set(state.layout[a.id].x, state.layout[a.id].y)
      }
      const temp = state.status[a.id]?.temp
      orb.setLook({
        name: a.name,
        // a temporary (economy) model is shown in place of the agent's own, marked and tinted
        subtitle: a.terminal ? 'live terminal session' : temp ? `⚡ ${modelLabel(state.catalog, a.provider, temp.model)} · ${temp.effort} (this task)` : `${modelLabel(state.catalog, a.provider, a.model)} · ${a.effort}`,
        color: a.color,
        radius: a.role === 'context-handler' ? 30 : 34,
        temp: !!temp
      })
      orb.status = state.status[a.id]?.status ?? 'idle'
      orb.activity = state.status[a.id]?.activity ?? ''
      orb.selected = state.focused === a.id
    })
    for (const [id, orb] of this.orbs)
      if (!seen.has(id)) {
        orb.destroy({ children: true })
        this.orbs.delete(id)
      }
    // agents dropped onto a saved layout spot that is now unused get a default one on next sync
    const mm = state.agents.find((a) => a.id === MASTERMIND_ID)
    if (mm) this.brain.setSubtitle(`${modelLabel(state.catalog, mm.provider, mm.model)} · ${mm.effort}`)
    this.brain.status = state.status[MASTERMIND_ID]?.status ?? 'idle'
    this.brain.pending = state.pending
    this.links.spokes = others.map((a) => a.id)
    this.links.channels = state.channels

    // council critics appear round the brain while a review runs
    const ids = new Set(state.council.map((c) => c.id))
    state.council.forEach((c, i) => {
      let orb = this.critics.get(c.id)
      if (!orb) {
        orb = new AgentOrb()
        orb.eventMode = 'none'
        orb.setLook({ name: c.lens.split(':')[0], subtitle: 'council', color: '#ef4444', radius: 18 })
        this.critics.set(c.id, orb)
        this.nodes.addChild(orb)
        ;(orb as any).slot = i
      }
      const was = prevCouncil.find((p) => p.id === c.id)
      orb.status = c.status === 'thinking' ? 'thinking' : c.status === 'error' ? 'error' : 'idle'
      if (!was) this.links.fire(MASTERMIND_ID, c.id, 'critique')
      if (was && was.status === 'thinking' && c.status !== 'thinking') this.links.fire(c.id, MASTERMIND_ID, 'critique')
    })
    for (const [id, orb] of this.critics)
      if (!ids.has(id)) {
        orb.destroy({ children: true })
        this.critics.delete(id)
      }
  }

  event(e: MainEvent): void {
    if (e.type === 'bus') this.links.fire(e.event.from, e.event.to, e.event.kind)
    if (e.type === 'talk') {
      if (e.agentId === MASTERMIND_ID) this.brain.talk()
      else this.orbs.get(e.agentId)?.talk()
    }
  }

  /** Where an agent (or the brain) is on screen, in page pixels, and how big it is drawn. */
  screenOf(id: string): { x: number; y: number; r: number } | null {
    if (!this.ready) return null
    if (id === MASTERMIND_ID) {
      const p = this.world.toGlobal({ x: 0, y: 0 })
      return { x: p.x, y: p.y, r: this.brain.R * this.cam.zoom }
    }
    const orb = this.orbs.get(id)
    if (!orb) return null
    const p = this.world.toGlobal({ x: orb.x, y: orb.y })
    return { x: p.x, y: p.y, r: orb.look.radius * this.cam.zoom }
  }

  /** Centres the camera on an agent (used when a chat tab is focused). */
  focus(id: string): void {
    const p = this.locate(id)
    if (p && this.manualCam) {
      this.cam.x = p.x * 0.35
      this.cam.y = p.y * 0.35
    }
  }

  private frame(dt: number): void {
    this.t += dt / 1000
    const w = this.app.screen.width
    const h = this.app.screen.height
    // the scene lives in the band between the side drawer and the chat dock
    const band = this.band()
    const visibleW = band.width
    if (!this.manualCam) {
      // fit every orb (and the labels under them) into the part of the window not under the dock
      let ex = 260
      let ey = 220
      for (const o of this.orbs.values()) {
        ex = Math.max(ex, Math.abs(o.x) + 110)
        ey = Math.max(ey, Math.abs(o.y) + 90)
      }
      const fit = Math.max(0.35, Math.min(1.15, (visibleW - 140) / (2 * ex), (h - 130) / (2 * ey)))
      const k = Math.min(1, dt / 220)
      this.cam.zoom += (fit - this.cam.zoom) * k
      this.cam.x += (0 - this.cam.x) * k
      this.cam.y += (12 - this.cam.y) * k
    }
    this.world.position.set(band.left + visibleW / 2 - this.cam.x * this.cam.zoom, h / 2 - this.cam.y * this.cam.zoom)
    this.world.scale.set(this.cam.zoom)
    this.sky.resize(w, h)
    this.sky.update(dt, this.cam.x, this.cam.y)

    const r = this.rings.clear()
    for (const [rx, ry, a] of [
      [200, 140, 0.07],
      [360, 250, 0.1],
      [520, 360, 0.05]
    ] as const)
      r.ellipse(0, 0, rx, ry).stroke({ width: 1, color: 0x818cf8, alpha: a })

    this.brain.update(dt)
    for (const orb of this.orbs.values()) orb.update(dt)
    let i = 0
    const n = this.critics.size
    for (const orb of this.critics.values()) {
      const a = this.t * 0.5 + (i++ / Math.max(1, n)) * Math.PI * 2
      orb.position.set(Math.cos(a) * 165, Math.sin(a) * 120)
      orb.update(dt)
    }
    this.links.update(dt)
  }

  /** The horizontal band of the window not covered by the left drawer or the chat dock. */
  private band(): { left: number; width: number } {
    const w = this.app.screen.width
    const dock = document.querySelector('[data-chat-dock]') as HTMLElement | null
    const drawer = document.querySelector('[data-left-drawer]') as HTMLElement | null
    const left = drawer ? drawer.getBoundingClientRect().right : 60
    const right = dock ? dock.getBoundingClientRect().left : w
    return { left, width: Math.max(200, right - left) }
  }

  private toWorld(gx: number, gy: number): { x: number; y: number } {
    return { x: (gx - this.world.x) / this.cam.zoom, y: (gy - this.world.y) / this.cam.zoom }
  }

  private down(e: FederatedPointerEvent): void {
    if (this.drag) return
    const now = performance.now()
    if (now - this.lastBgClick < 350) this.manualCam = false // double-click the sky: back to the whole team
    this.lastBgClick = now
    this.drag = { kind: 'pan', sx: e.global.x, sy: e.global.y, ox: this.cam.x, oy: this.cam.y, moved: false }
  }

  private moveTo(e: FederatedPointerEvent): void {
    const d = this.drag
    if (!d) return
    const dx = e.global.x - d.sx
    const dy = e.global.y - d.sy
    if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true
    if (d.kind === 'pan') {
      if (d.moved) this.manualCam = true
      this.cam.x = d.ox - dx / this.cam.zoom
      this.cam.y = d.oy - dy / this.cam.zoom
    } else if (d.id && d.moved) {
      const orb = this.orbs.get(d.id)
      if (orb) orb.position.set(d.ox + dx / this.cam.zoom, d.oy + dy / this.cam.zoom)
    }
  }

  private up(): void {
    const d = this.drag
    this.drag = null
    if (!d || d.kind !== 'node' || !d.id) return
    if (d.moved) {
      const orb = this.orbs.get(d.id)
      if (orb) this.cb.move(d.id, orb.x, orb.y)
      return
    }
    const now = performance.now()
    if (this.lastClick.id === d.id && now - this.lastClick.at < 350) this.cb.edit(d.id)
    else this.cb.open(d.id)
    this.lastClick = { id: d.id, at: now }
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault()
    this.manualCam = true
    const before = this.toWorld(e.offsetX, e.offsetY)
    this.cam.zoom = Math.max(0.35, Math.min(2.2, this.cam.zoom * Math.exp(-e.deltaY * 0.0012)))
    // keep the point under the cursor fixed
    const band = this.band()
    this.cam.x = before.x - (e.offsetX - band.left - band.width / 2) / this.cam.zoom
    this.cam.y = before.y - (e.offsetY - this.app.screen.height / 2) / this.cam.zoom
  }
}
