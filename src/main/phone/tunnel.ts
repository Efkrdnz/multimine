import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The address a Cloudflare quick tunnel prints once it is up. */
export function tunnelUrl(line: string): string | null {
  return /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(line)?.[0] ?? null
}

/** cloudflared's release file for this computer. */
export function cloudflaredAsset(platform = process.platform, arch = process.arch): string {
  if (platform === 'win32') return arch === 'ia32' ? 'cloudflared-windows-386.exe' : 'cloudflared-windows-amd64.exe'
  if (platform === 'darwin') return arch === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz'
  return arch === 'arm64' ? 'cloudflared-linux-arm64' : arch === 'arm' ? 'cloudflared-linux-arm' : 'cloudflared-linux-amd64'
}

/** What the phone server is reached at from the internet. */
export interface PublicUrl {
  /** Resolves to the public base URL (no trailing slash) once it is up. */
  start(localPort: number): Promise<string>
  stop(): Promise<void>
  /** Called when the address stops working (the tunnel process ended): the phone sets up again. */
  onLost?: (why: string) => void
}

/** A public URL the user runs themselves (their own tunnel or server forwarding to the port). */
export class FixedUrl implements PublicUrl {
  constructor(private readonly url: string) {}
  async start(): Promise<string> {
    return this.url.replace(/\/+$/, '')
  }
  async stop(): Promise<void> {}
}

/**
 * A Cloudflare quick tunnel: free, no account. cloudflared is downloaded once into the user-data
 * folder; each start gets a new random https address, which the phone then gives Twilio.
 */
export class QuickTunnel implements PublicUrl {
  private proc: ChildProcess | null = null
  private stopping = false
  onLost?: (why: string) => void

  constructor(
    private readonly binDir: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly log: (line: string) => void = () => undefined
  ) {}

  private get exe(): string {
    return join(this.binDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
  }

  /** Downloads cloudflared from its GitHub releases when it is not there yet. */
  async ensureBinary(): Promise<string> {
    if (existsSync(this.exe)) return this.exe
    await mkdir(this.binDir, { recursive: true })
    const asset = cloudflaredAsset()
    const res = await this.fetcher(`https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`, { redirect: 'follow' })
    if (!res.ok) throw new Error(`Could not download cloudflared (HTTP ${res.status}).`)
    const data = Buffer.from(await res.arrayBuffer())
    const part = `${this.exe}.part`
    if (asset.endsWith('.tgz')) {
      const tgz = join(this.binDir, asset)
      await writeFile(tgz, data)
      await new Promise<void>((resolve, reject) => execFile('tar', ['-xzf', tgz, '-C', this.binDir], (err) => (err ? reject(err) : resolve())))
      await rm(tgz, { force: true })
    } else {
      await writeFile(part, data)
      await rename(part, this.exe)
    }
    if (process.platform !== 'win32') await chmod(this.exe, 0o755)
    return this.exe
  }

  async start(localPort: number): Promise<string> {
    await this.stop()
    const exe = await this.ensureBinary()
    this.stopping = false
    return new Promise<string>((resolve, reject) => {
      const proc = spawn(exe, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${localPort}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      this.proc = proc
      let found = false
      const timer = setTimeout(() => {
        if (!found) {
          proc.kill()
          reject(new Error('The Cloudflare tunnel did not come up within a minute.'))
        }
      }, 60_000)
      const read = (chunk: Buffer) => {
        for (const line of chunk.toString().split(/\r?\n/)) {
          if (line.trim()) this.log(line)
          const url = !found && tunnelUrl(line)
          if (url) {
            found = true
            clearTimeout(timer)
            // the address is printed a moment before the edge accepts it
            setTimeout(() => resolve(url), 1500)
          }
        }
      }
      proc.stdout?.on('data', read)
      proc.stderr?.on('data', read)
      proc.on('error', (e) => {
        clearTimeout(timer)
        if (!found) reject(e)
      })
      proc.on('exit', (code) => {
        clearTimeout(timer)
        if (this.proc === proc) this.proc = null
        if (!found) reject(new Error(`cloudflared exited (code ${code}) before the tunnel came up.`))
        else if (!this.stopping) this.onLost?.(`the tunnel stopped (code ${code})`)
      })
    })
  }

  async stop(): Promise<void> {
    this.stopping = true
    const p = this.proc
    this.proc = null
    if (p && p.exitCode === null) {
      p.kill()
      await new Promise((r) => setTimeout(r, 200))
    }
  }
}
