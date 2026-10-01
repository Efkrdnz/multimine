import { Container, Graphics, Sprite, Text } from 'pixi.js'
import type { AgentStatus } from '@shared/types'
import { glowTexture } from './textures'

type Pt = [number, number]

interface Spark {
  sprite: Sprite
  path: Pt[]
  t: number
  speed: number
}

/**
 * Mastermind: a brain in the middle of everything. Two lobed hemispheres with gyri, neural sparks
 * running along them (a storm of them while it thinks), orbit rings, and an amber pulse while
 * anything waits on the user.
 */
export class BrainNode extends Container {
  readonly R = 78
  private halo = new Sprite(glowTexture())
  private halo2 = new Sprite(glowTexture())
  private orbits = new Graphics()
  private brain = new Graphics()
  private sparksLayer = new Container()
  private alert = new Graphics()
  private nameText = new Text({ text: 'MASTERMIND', style: { fontFamily: 'Space Grotesk, Inter, sans-serif', fontSize: 17, fontWeight: '800', letterSpacing: 4, fill: 0xf5d0fe, dropShadow: { color: 0x000000, blur: 8, distance: 0, alpha: 1 } } })
  private sub = new Text({ text: '', style: { fontFamily: 'Inter, sans-serif', fontSize: 11, fill: 0xc4b5fd, dropShadow: { color: 0x000000, blur: 4, distance: 0, alpha: 1 } } })
  private badge = new Text({ text: '', style: { fontFamily: 'Space Grotesk, Inter, sans-serif', fontSize: 14, fontWeight: '800', fill: 0x2a1700 } })
  private paths: Pt[][] = []
  private sparks: Spark[] = []
  private t = 0
  status: AgentStatus = 'idle'
  pending = 0
  hovered = false
  private talkUntil = 0

  constructor() {
    super()
    for (const h of [this.halo, this.halo2]) {
      h.anchor.set(0.5)
      h.blendMode = 'add'
    }
    this.halo.tint = 0xa855f7
    this.halo2.tint = 0xec4899
    this.nameText.anchor.set(0.5, 0)
    this.sub.anchor.set(0.5, 0)
    this.badge.anchor.set(0.5)
    this.nameText.y = this.R + 22
    this.sub.y = this.R + 44
    this.addChild(this.halo, this.halo2, this.orbits, this.brain, this.sparksLayer, this.alert, this.badge, this.nameText, this.sub)
    this.drawBrain()
    this.eventMode = 'static'
    this.cursor = 'pointer'
    this.hitArea = { contains: (x: number, y: number) => x * x + y * y <= (this.R + 10) ** 2 }
    this.on('pointerover', () => (this.hovered = true))
    this.on('pointerout', () => (this.hovered = false))
  }

  setSubtitle(s: string): void {
    this.sub.text = s
  }

  talk(): void {
    this.talkUntil = this.t + 0.3
  }

  private hemisphere(side: -1 | 1): Pt[] {
    const R = this.R
    const pts: Pt[] = []
    const steps = 64
    for (let i = 0; i <= steps; i++) {
      const a = -Math.PI / 2 + (i / steps) * Math.PI // top to bottom around the outside
      const bump = 1 + 0.055 * Math.sin(a * 9 + side) + 0.03 * Math.sin(a * 17)
      const rx = R * 0.92 * bump
      const ry = R * 0.76 * bump * (a > 0.6 ? 0.9 : 1)
      pts.push([side * (4 + Math.cos(a) * rx), Math.sin(a) * ry - 4])
    }
    return pts
  }

  private drawBrain(): void {
    const g = this.brain.clear()
    let seed = 99
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    for (const side of [-1, 1] as const) {
      const outline = this.hemisphere(side)
      g.poly(outline.flat(), true).fill({ color: 0xc026d3, alpha: 0.92 })
      // inner shading: a smaller, lighter lobe
      g.poly(outline.map(([x, y]) => [x * 0.82 + side * 6, y * 0.78 - 6]).flat(), true).fill({ color: 0xf0abfc, alpha: 0.35 })
      g.poly(outline.flat(), true).stroke({ width: 2.5, color: 0xfae8ff, alpha: 0.85 })
      // gyri: wandering folds inside the hemisphere
      for (let i = 0; i < 9; i++) {
        const path: Pt[] = []
        let x = side * (12 + rnd() * this.R * 0.62)
        let y = -this.R * 0.55 + rnd() * this.R * 1.0
        let dir = rnd() * Math.PI * 2
        for (let s = 0; s < 9; s++) {
          path.push([x, y])
          dir += (rnd() - 0.5) * 1.6
          const nx = x + Math.cos(dir) * 9
          const ny = y + Math.sin(dir) * 9
          const inside = (nx / (this.R * 0.84)) ** 2 + ((ny + 4) / (this.R * 0.68)) ** 2 < 1 && Math.sign(nx) === side && Math.abs(nx) > 8
          if (!inside) {
            dir += Math.PI * 0.8
            continue
          }
          x = nx
          y = ny
        }
        if (path.length < 3) continue
        this.paths.push(path)
        g.moveTo(path[0][0], path[0][1])
        for (let j = 1; j < path.length - 1; j++) {
          const [cx, cy] = path[j]
          const [nx, ny] = path[j + 1]
          g.quadraticCurveTo(cx, cy, (cx + nx) / 2, (cy + ny) / 2)
        }
        g.stroke({ width: 3, color: 0x701a75, alpha: 0.8, cap: 'round', join: 'round' })
        g.moveTo(path[0][0] - 1, path[0][1] - 1.5)
        for (let j = 1; j < path.length - 1; j++) {
          const [cx, cy] = path[j]
          const [nx, ny] = path[j + 1]
          g.quadraticCurveTo(cx - 1, cy - 1.5, (cx + nx) / 2 - 1, (cy + ny) / 2 - 1.5)
        }
        g.stroke({ width: 1.2, color: 0xfdf4ff, alpha: 0.45, cap: 'round', join: 'round' })
      }
    }
    // central fissure and stem
    g.moveTo(0, -this.R * 0.8).quadraticCurveTo(-3, 0, 0, this.R * 0.6).stroke({ width: 3, color: 0x4a044e, alpha: 0.9 })
    g.roundRect(-9, this.R * 0.55, 18, 22, 8).fill({ color: 0xa21caf, alpha: 0.9 })
  }

  private spawnSpark(): void {
    if (!this.paths.length) return
    const sprite = new Sprite(glowTexture())
    sprite.anchor.set(0.5)
    sprite.blendMode = 'add'
    sprite.tint = Math.random() < 0.5 ? 0x67e8f9 : 0xfde68a
    sprite.scale.set(0.09)
    this.sparksLayer.addChild(sprite)
    const path = this.paths[Math.floor(Math.random() * this.paths.length)]
    this.sparks.push({ sprite, path: Math.random() < 0.5 ? path : [...path].reverse(), t: 0, speed: 0.6 + Math.random() * 1.2 })
  }

  update(dt: number): void {
    const s = dt / 1000
    this.t += s
    const active = this.status === 'thinking' || this.status === 'working' || this.t < this.talkUntil
    const breathe = 1 + Math.sin(this.t * (active ? 4 : 1.3)) * (active ? 0.035 : 0.018)
    const hover = this.hovered ? 1.05 : 1
    this.brain.scale.set(breathe * hover)
    this.sparksLayer.scale.set(breathe * hover)
    this.halo.width = this.halo.height = this.R * (active ? 7.5 : 6.2) * (1 + Math.sin(this.t * 2) * 0.04)
    this.halo.alpha = active ? 0.9 : 0.7
    this.halo2.width = this.halo2.height = this.R * 3.4
    this.halo2.alpha = 0.35 + Math.sin(this.t * 1.7) * 0.1

    const o = this.orbits.clear()
    for (let i = 0; i < 3; i++) {
      const rot = this.t * (0.25 + i * 0.12) * (i % 2 ? -1 : 1) + i
      const rx = this.R * (1.45 + i * 0.16)
      const ry = this.R * (0.42 + i * 0.1)
      const pts: number[] = []
      for (let k = 0; k <= 48; k++) {
        const a = (k / 48) * Math.PI * 2
        const x = Math.cos(a) * rx
        const y = Math.sin(a) * ry
        pts.push(x * Math.cos(rot) - y * Math.sin(rot), x * Math.sin(rot) + y * Math.cos(rot))
      }
      o.poly(pts, true).stroke({ width: 1.2, color: i === 1 ? 0x67e8f9 : 0xe879f9, alpha: 0.28 })
      const a = this.t * (1 + i * 0.4)
      const x = Math.cos(a) * rx
      const y = Math.sin(a) * ry
      o.circle(x * Math.cos(rot) - y * Math.sin(rot), x * Math.sin(rot) + y * Math.cos(rot), 3).fill({ color: 0xffffff, alpha: 0.9 })
    }

    if (Math.random() < s * (active ? 28 : 4)) this.spawnSpark()
    for (const sp of this.sparks) {
      sp.t += s * sp.speed
      const f = Math.min(sp.t, 0.999) * (sp.path.length - 1)
      const i = Math.floor(f)
      const [x0, y0] = sp.path[i]
      const [x1, y1] = sp.path[Math.min(i + 1, sp.path.length - 1)]
      sp.sprite.position.set(x0 + (x1 - x0) * (f - i), y0 + (y1 - y0) * (f - i))
      sp.sprite.alpha = Math.sin(Math.min(sp.t, 1) * Math.PI)
    }
    this.sparks = this.sparks.filter((sp) => {
      if (sp.t < 1) return true
      sp.sprite.destroy()
      return false
    })

    const a = this.alert.clear()
    this.badge.visible = this.pending > 0
    if (this.pending > 0) {
      const p = (this.t * 0.8) % 1
      a.circle(0, 0, this.R * (1.1 + p * 0.6)).stroke({ width: 3, color: 0xfbbf24, alpha: 1 - p })
      a.circle(this.R * 0.78, -this.R * 0.78, 14).fill({ color: 0xfbbf24 })
      this.badge.text = String(this.pending)
      this.badge.position.set(this.R * 0.78, -this.R * 0.78)
    }
    if (this.status === 'error') a.circle(0, 0, this.R + 6).stroke({ width: 3, color: 0xf87171, alpha: 0.6 + Math.sin(this.t * 6) * 0.3 })
  }
}
