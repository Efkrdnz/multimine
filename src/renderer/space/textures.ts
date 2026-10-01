import { Texture } from 'pixi.js'

const cache = new Map<string, Texture>()

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas')
  c.width = c.height = size
  return [c, c.getContext('2d')!]
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function hexNum(hex: string): number {
  return parseInt(hex.replace('#', ''), 16)
}

function mix(a: [number, number, number], b: [number, number, number], t: number): string {
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * t))
  return `rgb(${c[0]},${c[1]},${c[2]})`
}

/** A soft white radial falloff, tinted at draw time: halos, packets, stars. */
export function glowTexture(): Texture {
  const key = 'glow'
  let t = cache.get(key)
  if (t) return t
  const [c, g] = canvas(256)
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.12, 'rgba(255,255,255,0.75)')
  grad.addColorStop(0.35, 'rgba(255,255,255,0.22)')
  grad.addColorStop(0.7, 'rgba(255,255,255,0.05)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 256, 256)
  t = Texture.from(c)
  cache.set(key, t)
  return t
}

/** A lit sphere in the agent's colour: dark rim, bright core, specular highlight. */
export function orbTexture(hex: string): Texture {
  const key = `orb:${hex}`
  let t = cache.get(key)
  if (t) return t
  const size = 256
  const [c, g] = canvas(size)
  const base = hexToRgb(hex)
  const r = size / 2 - 4
  const body = g.createRadialGradient(size * 0.4, size * 0.36, r * 0.05, size / 2, size / 2, r)
  body.addColorStop(0, mix(base, [255, 255, 255], 0.55))
  body.addColorStop(0.45, mix(base, [255, 255, 255], 0.08))
  body.addColorStop(0.85, mix(base, [10, 8, 30], 0.45))
  body.addColorStop(1, mix(base, [5, 4, 20], 0.75))
  g.fillStyle = body
  g.beginPath()
  g.arc(size / 2, size / 2, r, 0, Math.PI * 2)
  g.fill()
  // rim light from below
  const rim = g.createRadialGradient(size / 2, size * 0.62, r * 0.7, size / 2, size / 2, r)
  rim.addColorStop(0, 'rgba(255,255,255,0)')
  rim.addColorStop(0.92, mix(base, [255, 255, 255], 0.3).replace('rgb', 'rgba').replace(')', ',0.0)'))
  rim.addColorStop(1, mix(base, [255, 255, 255], 0.5).replace('rgb', 'rgba').replace(')', ',0.55)'))
  g.fillStyle = rim
  g.beginPath()
  g.arc(size / 2, size / 2, r, 0, Math.PI * 2)
  g.fill()
  // specular
  const spec = g.createRadialGradient(size * 0.36, size * 0.3, 0, size * 0.36, size * 0.3, r * 0.42)
  spec.addColorStop(0, 'rgba(255,255,255,0.75)')
  spec.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = spec
  g.beginPath()
  g.arc(size / 2, size / 2, r, 0, Math.PI * 2)
  g.fill()
  t = Texture.from(c)
  cache.set(key, t)
  return t
}

/** A soft cloud of colour for the nebula, built from overlapping blobs. */
export function nebulaTexture(hexes: string[], seed: number): Texture {
  const key = `neb:${hexes.join()}:${seed}`
  let t = cache.get(key)
  if (t) return t
  const size = 512
  const [c, g] = canvas(size)
  let s = seed
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647)
  g.globalCompositeOperation = 'lighter'
  for (let i = 0; i < 28; i++) {
    const x = size * (0.2 + rnd() * 0.6)
    const y = size * (0.2 + rnd() * 0.6)
    const r = size * (0.08 + rnd() * 0.22)
    const [cr, cg, cb] = hexToRgb(hexes[i % hexes.length])
    const grad = g.createRadialGradient(x, y, 0, x, y, r)
    grad.addColorStop(0, `rgba(${cr},${cg},${cb},${0.1 + rnd() * 0.1})`)
    grad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`)
    g.fillStyle = grad
    g.fillRect(0, 0, size, size)
  }
  t = Texture.from(c)
  cache.set(key, t)
  return t
}
