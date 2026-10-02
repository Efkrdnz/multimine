import { Container, Graphics, Sprite, Text } from 'pixi.js'
import type { AgentStatus } from '@shared/types'
import { glowTexture, hexNum, orbTexture } from './textures'

export interface OrbLook {
  name: string
  subtitle: string
  color: string
  radius: number
  stern?: boolean
  /** Running on a temporary model: the subtitle turns amber and pulses. */
  temp?: boolean
  /** Running on a fallback provider: the subtitle turns sky blue and pulses. */
  fallback?: boolean
}

const STATUS_RING: Record<AgentStatus, number> = {
  idle: 0xffffff,
  thinking: 0xa78bfa,
  working: 0x34d399,
  waiting: 0xfbbf24,
  error: 0xf87171
}

/**
 * An agent in space: a glowing sphere in its colour with a chibi face that blinks, talks while text
 * streams, looks up while thinking, squints while working, goes wide-eyed waiting on you, and
 * crosses its eyes on an error.
 */
export class AgentOrb extends Container {
  readonly halo = new Sprite(glowTexture())
  readonly body = new Sprite()
  private ring = new Graphics()
  private face = new Graphics()
  private bubble = new Graphics()
  private nameText = new Text({ text: '', style: { fontFamily: 'Space Grotesk, Inter, system-ui, sans-serif', fontSize: 15, fontWeight: '700', fill: 0xffffff, dropShadow: { color: 0x000000, blur: 6, distance: 0, alpha: 0.9 } } })
  private sub = new Text({ text: '', style: { fontFamily: 'Inter, system-ui, sans-serif', fontSize: 11, fill: 0xa5b4fc, dropShadow: { color: 0x000000, blur: 4, distance: 0, alpha: 0.9 } } })
  private qmark = new Text({ text: '?', style: { fontFamily: 'Space Grotesk, Inter, sans-serif', fontSize: 16, fontWeight: '800', fill: 0x3b1d00 } })
  private activityText = new Text({ text: '', style: { fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 10, fill: 0xe0e7ff } })
  look: OrbLook = { name: '', subtitle: '', color: '#7c9cff', radius: 34 }
  status: AgentStatus = 'idle'
  activity = ''
  selected = false
  hovered = false
  private t = Math.random() * 10
  private phase = Math.random() * Math.PI * 2
  private nextBlink = 1 + Math.random() * 4
  private blinkUntil = 0
  private talkUntil = 0
  private born = 0
  homeX = 0
  homeY = 0

  constructor() {
    super()
    this.halo.anchor.set(0.5)
    this.halo.blendMode = 'add'
    this.body.anchor.set(0.5)
    this.nameText.anchor.set(0.5, 0)
    this.sub.anchor.set(0.5, 0)
    this.activityText.anchor.set(0.5, 1)
    this.qmark.anchor.set(0.5)
    this.addChild(this.halo, this.ring, this.body, this.face, this.bubble, this.qmark, this.nameText, this.sub, this.activityText)
    this.eventMode = 'static'
    this.cursor = 'pointer'
    this.on('pointerover', () => (this.hovered = true))
    this.on('pointerout', () => (this.hovered = false))
  }

  setLook(look: OrbLook): void {
    const changed = look.color !== this.look.color || look.radius !== this.look.radius
    this.look = look
    if (changed || !this.body.texture || this.body.texture.label === 'EMPTY') {
      this.body.texture = orbTexture(look.color)
      this.body.width = this.body.height = look.radius * 2
      this.halo.tint = hexNum(look.color)
    }
    this.nameText.text = look.name
    this.sub.text = look.subtitle
    this.sub.style.fill = look.fallback ? 0x7dd3fc : look.temp ? 0xfcd34d : 0xa5b4fc
    this.sub.style.fontWeight = look.temp || look.fallback ? '700' : '400'
    this.nameText.y = look.radius + 12
    this.sub.y = look.radius + 31
    this.hitArea = { contains: (x: number, y: number) => x * x + y * y <= (look.radius + 8) ** 2 }
  }

  talk(): void {
    this.talkUntil = this.t + 0.28
  }

  update(dt: number): void {
    const s = dt / 1000
    this.t += s
    this.born = Math.min(1, this.born + s * 1.8)
    const { radius } = this.look
    const appear = 1 - Math.pow(1 - this.born, 3)
    const bob = Math.sin(this.t * 1.4 + this.phase) * 3
    const hover = this.hovered ? 1.07 : 1
    this.body.y = this.face.y = this.ring.y = this.halo.y = this.bubble.y = bob
    this.body.scale.set((radius * 2 * hover * appear) / this.body.texture.width)

    const active = this.status === 'thinking' || this.status === 'working'
    const pulse = active ? 0.5 + 0.5 * Math.sin(this.t * 5) : 0.5 + 0.5 * Math.sin(this.t * 1.2)
    const haloSize = radius * (this.status === 'idle' ? 4.2 : 5.4) * (0.92 + pulse * 0.12) * appear
    this.halo.width = this.halo.height = haloSize
    this.halo.alpha = this.status === 'idle' ? 0.55 : 0.85

    // blink
    if (this.t > this.nextBlink) {
      this.blinkUntil = this.t + 0.12
      this.nextBlink = this.t + 2.2 + Math.random() * 4.5
    }
    this.drawRing(radius * hover * appear)
    this.drawFace(radius * hover * appear)
    this.drawBubble(radius * appear)

    this.activityText.text = this.activity && this.status !== 'idle' ? this.activity.slice(0, 28) : ''
    this.activityText.y = -radius - 16 + bob
    this.nameText.alpha = appear
    this.sub.alpha = appear * (this.look.temp || this.look.fallback ? 0.75 + 0.25 * Math.sin(this.t * 4) : 1)
  }

  private drawRing(r: number): void {
    const g = this.ring.clear()
    const color = STATUS_RING[this.status]
    if (this.selected) g.circle(0, 0, r + 9).stroke({ width: 2, color: 0xffffff, alpha: 0.7 })
    if (this.status === 'idle') return
    if (this.status === 'thinking' || this.status === 'working') {
      const start = this.t * (this.status === 'working' ? 4 : 2.2)
      g.arc(0, 0, r + 5, start, start + Math.PI * 0.75).stroke({ width: 3, color, alpha: 0.95, cap: 'round' })
      g.arc(0, 0, r + 5, start + Math.PI, start + Math.PI * 1.45).stroke({ width: 3, color, alpha: 0.6, cap: 'round' })
    } else {
      const a = 0.45 + 0.45 * Math.sin(this.t * 6)
      g.circle(0, 0, r + 5).stroke({ width: 3, color, alpha: a })
    }
  }

  private drawFace(r: number): void {
    const g = this.face.clear()
    const k = r / 34
    const blinking = this.t < this.blinkUntil
    const talking = this.t < this.talkUntil
    const st = this.status
    // gaze: up while thinking, a little side to side while idle
    const gx = st === 'thinking' ? 2.5 * k : Math.sin(this.t * 0.6 + this.phase) * 1.6 * k
    const gy = st === 'thinking' ? -3 * k : 0
    const ex = 10.5 * k
    const ey = 1 * k
    const ink = 0x1a1033

    for (const side of [-1, 1]) {
      const x = side * ex
      if (st === 'error') {
        // > <
        const d = 4.5 * k
        g.moveTo(x + side * d, ey - d).lineTo(x - side * d, ey).lineTo(x + side * d, ey + d)
        g.stroke({ width: 2.4 * k, color: ink, cap: 'round', join: 'round' })
        continue
      }
      if (blinking) {
        g.moveTo(x - 5 * k, ey).quadraticCurveTo(x, ey + 3 * k, x + 5 * k, ey).stroke({ width: 2.4 * k, color: ink, cap: 'round' })
        continue
      }
      const h = st === 'working' ? 5.2 * k : st === 'waiting' ? 8.6 * k : 7.4 * k
      const w = st === 'waiting' ? 6.2 * k : 5.6 * k
      g.ellipse(x, ey, w, h).fill({ color: ink })
      // two highlights: the chibi sparkle
      g.circle(x - 1.8 * k + gx * 0.4, ey - h * 0.42 + gy * 0.3, 2.1 * k).fill({ color: 0xffffff })
      g.circle(x + 1.9 * k + gx * 0.4, ey + h * 0.25 + gy * 0.3, 1.1 * k).fill({ color: 0xffffff, alpha: 0.85 })
      if (st === 'working') g.moveTo(x - 6 * k, ey - h - 2 * k).lineTo(x + 6 * k, ey - h - 0.5 * k * side).stroke({ width: 2 * k, color: ink, cap: 'round' })
    }
    // blush
    g.ellipse(-16 * k, 9 * k, 5 * k, 2.6 * k).fill({ color: 0xff6b9d, alpha: 0.38 })
    g.ellipse(16 * k, 9 * k, 5 * k, 2.6 * k).fill({ color: 0xff6b9d, alpha: 0.38 })
    // mouth
    const my = 11 * k
    if (talking) {
      const open = 2.5 + Math.abs(Math.sin(this.t * 28)) * 3.5
      g.ellipse(0, my + 1 * k, 3.6 * k, open * k).fill({ color: 0x4a1030 })
    } else if (st === 'error') {
      g.moveTo(-5 * k, my + 2 * k).quadraticCurveTo(-2.5 * k, my - 1 * k, 0, my + 2 * k).quadraticCurveTo(2.5 * k, my + 5 * k, 5 * k, my + 2 * k).stroke({ width: 2 * k, color: ink, cap: 'round' })
    } else if (st === 'waiting') {
      g.circle(0, my + 1.5 * k, 2.4 * k).fill({ color: 0x4a1030 })
    } else if (st === 'working') {
      g.moveTo(-3.5 * k, my + 1 * k).lineTo(3.5 * k, my + 1 * k).stroke({ width: 2 * k, color: ink, cap: 'round' })
    } else {
      g.moveTo(-4.5 * k, my).quadraticCurveTo(0, my + 4.5 * k, 4.5 * k, my).stroke({ width: 2 * k, color: ink, cap: 'round' })
    }
  }

  private drawBubble(r: number): void {
    const g = this.bubble.clear()
    if (this.status === 'thinking') {
      for (let i = 0; i < 3; i++) {
        const a = this.t * 2.4 + (i * Math.PI * 2) / 3
        g.circle(Math.cos(a) * (r + 16), -r * 0.2 + Math.sin(a) * (r * 0.3 + 6), 2.6).fill({ color: 0xc4b5fd, alpha: 0.9 })
      }
    } else if (this.status === 'waiting') {
      const y = -r - 22 + Math.sin(this.t * 4) * 2
      g.roundRect(r * 0.5, y - 12, 22, 22, 8).fill({ color: 0xfbbf24 })
      g.moveTo(r * 0.5 + 5, y + 9).lineTo(r * 0.5 + 2, y + 15).lineTo(r * 0.5 + 11, y + 10).fill({ color: 0xfbbf24 })
      this.qmark.position.set(r * 0.5 + 11, y - 1 + this.bubble.y)
    }
    this.qmark.visible = this.status === 'waiting'
  }
}
