import { Container, Sprite } from 'pixi.js'
import { glowTexture, nebulaTexture } from './textures'

interface Star {
  sprite: Sprite
  x: number
  y: number
  depth: number
  phase: number
  speed: number
  base: number
}

interface Shooter {
  sprite: Sprite
  vx: number
  vy: number
  life: number
}

/** Deep background: drifting nebulae, three depths of twinkling stars, the odd shooting star. */
export class Starfield extends Container {
  private stars: Star[] = []
  private nebulae: { sprite: Sprite; depth: number; x: number; y: number; spin: number }[] = []
  private shooters: Shooter[] = []
  private w = 1
  private h = 1
  private t = 0

  constructor() {
    super()
    const neb = [
      { colors: ['#4c1d95', '#1e3a8a', '#7e22ce'], seed: 7, x: -0.25, y: -0.2, scale: 2.6 },
      { colors: ['#0e7490', '#1e40af', '#312e81'], seed: 19, x: 0.3, y: 0.25, scale: 2.2 },
      { colors: ['#831843', '#581c87', '#1e1b4b'], seed: 41, x: 0.35, y: -0.35, scale: 1.8 }
    ]
    for (const n of neb) {
      const sprite = new Sprite(nebulaTexture(n.colors, n.seed))
      sprite.anchor.set(0.5)
      sprite.scale.set(n.scale)
      sprite.alpha = 0.9
      sprite.blendMode = 'add'
      this.addChild(sprite)
      this.nebulae.push({ sprite, depth: 0.04, x: n.x, y: n.y, spin: (Math.random() - 0.5) * 0.00004 })
    }
    const tex = glowTexture()
    let seed = 1234
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    for (let i = 0; i < 520; i++) {
      const depth = i < 320 ? 0.05 : i < 470 ? 0.12 : 0.25
      const sprite = new Sprite(tex)
      sprite.anchor.set(0.5)
      const size = depth === 0.25 ? 0.05 + rnd() * 0.05 : depth === 0.12 ? 0.03 + rnd() * 0.03 : 0.015 + rnd() * 0.02
      sprite.scale.set(size)
      const hue = rnd()
      sprite.tint = hue < 0.15 ? 0xffd9a8 : hue < 0.35 ? 0xb8c8ff : 0xffffff
      sprite.blendMode = 'add'
      this.addChild(sprite)
      this.stars.push({ sprite, x: rnd(), y: rnd(), depth, phase: rnd() * Math.PI * 2, speed: 0.5 + rnd() * 2, base: 0.35 + rnd() * 0.65 })
    }
  }

  resize(w: number, h: number): void {
    this.w = w
    this.h = h
  }

  update(dt: number, camX: number, camY: number): void {
    this.t += dt / 1000
    const { w, h } = this
    for (const n of this.nebulae) {
      n.sprite.x = w / 2 + n.x * w - camX * n.depth
      n.sprite.y = h / 2 + n.y * h - camY * n.depth
      n.sprite.rotation += n.spin * dt
      n.sprite.alpha = 0.75 + Math.sin(this.t * 0.15 + n.x * 10) * 0.15
    }
    for (const s of this.stars) {
      // wrap so panning never runs out of sky
      const px = (((s.x * w - camX * s.depth) % w) + w) % w
      const py = (((s.y * h - camY * s.depth) % h) + h) % h
      s.sprite.x = px
      s.sprite.y = py
      s.sprite.alpha = s.base * (0.6 + 0.4 * Math.sin(this.t * s.speed + s.phase))
    }
    if (Math.random() < dt / 7000) this.shoot()
    for (const sh of this.shooters) {
      sh.sprite.x += sh.vx * dt
      sh.sprite.y += sh.vy * dt
      sh.life -= dt
      sh.sprite.alpha = Math.max(0, Math.min(1, sh.life / 300))
    }
    this.shooters = this.shooters.filter((sh) => {
      if (sh.life > 0) return true
      sh.sprite.destroy()
      return false
    })
  }

  private shoot(): void {
    const sprite = new Sprite(glowTexture())
    sprite.anchor.set(0.5)
    sprite.scale.set(0.5, 0.025)
    sprite.blendMode = 'add'
    sprite.tint = 0xdbeafe
    const angle = Math.PI * (0.15 + Math.random() * 0.2)
    sprite.rotation = angle
    sprite.x = Math.random() * this.w * 0.8
    sprite.y = Math.random() * this.h * 0.4
    this.addChild(sprite)
    this.shooters.push({ sprite, vx: Math.cos(angle) * 0.9, vy: Math.sin(angle) * 0.9, life: 900 })
  }
}
