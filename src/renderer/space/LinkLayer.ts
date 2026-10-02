import { Container, Graphics, Sprite } from 'pixi.js'
import type { BusKind, Channel } from '@shared/types'
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
  /** Conversations in progress: drawn as a pulsing, glowing link until they end. */
  channels: Channel[] = []
  private glows = new Map<string, Sprite[]>()

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

  /**
   * A live conversation: a wide breathing glow under a bright core, energy running along it toward
   * whoever is working, and a soft beacon on both ends. It stays lit for as long as the exchange lasts.
   */
  private drawChannels(g: Graphics): void {
    const live = new Set<string>()
    for (const ch of this.channels) {
      const a = this.locate(ch.from)
      const b = this.locate(ch.to)
      if (!a || !b) continue
      const key = `${ch.from}>${ch.to}`
      live.add(key)
      const color = KIND_COLOR[ch.kind]
      const c = curve(a, b)
      const pulse = 0.5 + 0.5 * Math.sin(this.t * 3.2 + (a.x + b.y) * 0.01)
      for (const [w, alpha] of [
        [22, 0.05 + 0.07 * pulse],
        [11, 0.1 + 0.12 * pulse],
        [4.5, 0.35 + 0.25 * pulse],
        [1.8, 0.95]
      ] as const) {
        const p0 = c(0)
        g.moveTo(p0.x, p0.y)
        for (let k = 1; k <= 36; k++) {
          const q = c(k / 36)
          g.lineTo(q.x, q.y)
        }
        g.stroke({ width: w, color, alpha, cap: 'round' })
      }
      // energy flowing toward the agent doing the work
      for (let k = 0; k < 9; k++) {
        const tt = (k / 9 + this.t * 0.45) % 1
        const q = c(tt)
        g.circle(q.x, q.y, 2.6 + 1.4 * Math.sin(tt * Math.PI)).fill({ color: 0xffffff, alpha: 0.75 * Math.sin(tt * Math.PI) })
      }
      let ends = this.glows.get(key)
      if (!ends) {
        ends = [0, 1].map(() => {
          const s = new Sprite(glowTexture())
          s.anchor.set(0.5)
          s.blendMode = 'add'
          this.packetLayer.addChild(s)
          return s
        })
        this.glows.set(key, ends)
      }
      ends.forEach((s, i) => {
        const p = i ? b : a
        s.position.set(p.x, p.y)
        s.tint = color
        s.scale.set(0.9 + 0.35 * pulse)
        s.alpha = 0.35 + 0.3 * pulse
      })
    }
    for (const [key, ends] of this.glows)
      if (!live.has(key)) {
        for (const s of ends) s.destroy()
        this.glows.delete(key)
      }
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

    this.drawChannels(g)

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
