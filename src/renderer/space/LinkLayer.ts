import { Container, Graphics, Sprite } from 'pixi.js'
import type { BusKind } from '@shared/types'
import { glowTexture } from './textures'

export const KIND_COLOR: Record<BusKind, number> = {
  message: 0x93c5fd,
  delegate: 0xc084fc,
  report: 0x34d399,
  question: 0xfbbf24,
  answer: 0xfde68a,
  approval: 0xfb923c,
  critique: 0xf87171,
  context: 0x22d3ee,
  create: 0xf0abfc
}

type Pos = { x: number; y: number }
type Locate = (id: string) => Pos | null

interface Link {
  from: string
  to: string
  energy: number
  color: number
}

interface Packet {
  from: string
  to: string
  t: number
  speed: number
  color: number
  sprites: Sprite[]
}

const TRAIL = 6

/** A bowed curve from a to b; the bow flips with direction so traffic each way gets its own lane. */
export function curve(a: Pos, b: Pos, bow = 0.16): (t: number) => Pos {
  const mx = (a.x + b.x) / 2
  const my = (a.y + b.y) / 2
  const dx = b.x - a.x
  const dy = b.y - a.y
  const cx = mx - dy * bow
  const cy = my + dx * bow
  return (t) => {
    const u = 1 - t
    return { x: u * u * a.x + 2 * u * t * cx + t * t * b.x, y: u * u * a.y + 2 * u * t * cy + t * t * b.y }
  }
}

/** Lines between agents that talk, and the glowing packets that travel along them. */
export class LinkLayer extends Container {
  private g = new Graphics()
  private packetLayer = new Container()
  private links = new Map<string, Link>()
  private packets: Packet[] = []
  private t = 0
  spokes: string[] = []

  constructor(private readonly locate: Locate, private readonly hub: string) {
    super()
    this.addChild(this.g, this.packetLayer)
  }

  fire(from: string, to: string, kind: BusKind): void {
    if (from === to) return
    const color = KIND_COLOR[kind]
    const key = `${from}>${to}`
    const link = this.links.get(key) ?? { from, to, energy: 0, color }
    link.energy = Math.min(1.6, link.energy + 1)
    link.color = color
    this.links.set(key, link)
    const sprites: Sprite[] = []
    for (let i = 0; i < TRAIL; i++) {
      const s = new Sprite(glowTexture())
      s.anchor.set(0.5)
      s.blendMode = 'add'
      s.tint = i === 0 ? 0xffffff : color
      s.scale.set(i === 0 ? 0.11 : 0.12 - i * 0.012)
      this.packetLayer.addChild(s)
      sprites.push(s)
    }
    this.packets.push({ from, to, t: 0, speed: 0.75 + Math.random() * 0.2, color, sprites })
  }

  update(dt: number): void {
    const s = dt / 1000
    this.t += s
    const g = this.g.clear()
    // faint spokes from the hub to every agent: the team's shape at rest
    const hub = this.locate(this.hub)
    if (hub)
      for (const id of this.spokes) {
        const p = this.locate(id)
        if (!p) continue
        const c = curve(hub, p, 0.05)
        const pts: number[] = []
        for (let k = 0; k <= 24; k++) {
          const q = c(k / 24)
          pts.push(q.x, q.y)
        }
        g.moveTo(pts[0], pts[1])
        for (let k = 2; k < pts.length; k += 2) g.lineTo(pts[k], pts[k + 1])
        g.stroke({ width: 1, color: 0x8b5cf6, alpha: 0.12 + Math.sin(this.t * 0.8 + p.x * 0.01) * 0.04 })
      }

    for (const [key, l] of this.links) {
      l.energy -= s * 0.16
      if (l.energy <= 0) {
        this.links.delete(key)
        continue
      }
      const a = this.locate(l.from)
      const b = this.locate(l.to)
      if (!a || !b) continue
      const c = curve(a, b)
      const e = Math.min(1, l.energy)
      for (const [w, alpha] of [
        [9, 0.08],
        [3.5, 0.22],
        [1.4, 0.85]
      ] as const) {
        const p0 = c(0)
        g.moveTo(p0.x, p0.y)
        for (let k = 1; k <= 32; k++) {
          const q = c(k / 32)
          g.lineTo(q.x, q.y)
        }
        g.stroke({ width: w, color: l.color, alpha: alpha * e, cap: 'round' })
      }
      // flowing dashes show direction
      for (let k = 0; k < 6; k++) {
        const tt = (k / 6 + this.t * 0.35) % 1
        const q = c(tt)
        g.circle(q.x, q.y, 1.8).fill({ color: 0xffffff, alpha: 0.5 * e })
      }
    }

    for (const p of this.packets) {
      p.t += s * p.speed
      const a = this.locate(p.from)
      const b = this.locate(p.to)
      if (!a || !b) {
        p.t = 2
        continue
      }
      const c = curve(a, b)
      const ease = (x: number) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2)
      p.sprites.forEach((sp, i) => {
        const tt = Math.max(0, Math.min(1, p.t - i * 0.025))
        const q = c(ease(tt))
        sp.position.set(q.x, q.y)
        sp.alpha = p.t > 1 ? Math.max(0, 1 - (p.t - 1) * 4) : 1 - i / TRAIL
      })
    }
    this.packets = this.packets.filter((p) => {
      if (p.t < 1.25) return true
      for (const sp of p.sprites) sp.destroy()
      return false
    })
  }
}
