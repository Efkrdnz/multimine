import { newId } from '@shared/ids'
import type { MainEvent, TerminalInfo, TerminalKind } from '@shared/types'

type PtyModule = typeof import('node-pty')
type Pty = import('node-pty').IPty

let ptyModule: PtyModule | null = null
let loadError: string | null = null

/** node-pty is native; if it cannot load (no prebuild, a broken install) the IDE runs without a terminal. */
async function loadPty(): Promise<PtyModule | null> {
  if (ptyModule || loadError) return ptyModule
  try {
    const mod: any = await import('node-pty')
    ptyModule = (mod.default ?? mod) as PtyModule
  } catch (e) {
    loadError = `The terminal could not start: ${(e as Error).message}. Try \`npm install-scripts approve node-pty\` then \`npm install\`.`
  }
  return ptyModule
}

export function defaultShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') return { file: 'powershell.exe', args: ['-NoLogo'] }
  return { file: process.env.SHELL || '/bin/bash', args: ['-l'] }
}

/** Quotes one argument for the shell the terminal runs (PowerShell or a POSIX shell); single quotes work in both. */
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, process.platform === 'win32' ? "''" : `'\\''`)}'`
}

interface Session {
  info: TerminalInfo
  pty: Pty
}

/** Real shells for the IDE window. Output streams to the renderer as `terminal-data` events. */
export class Terminals {
  private sessions = new Map<string, Session>()

  constructor(private readonly emit: (e: MainEvent) => void) {}

  async available(): Promise<{ ok: boolean; error?: string }> {
    return (await loadPty()) ? { ok: true } : { ok: false, error: loadError ?? 'unknown' }
  }

  /**
   * Opens a shell in `cwd`. `startup` is typed into it once it is up, so a CLI starts inside a
   * normal shell and the user lands back at the prompt when it exits.
   */
  async open(cwd: string, kind: TerminalKind, cols: number, rows: number, title: string, startup?: string): Promise<TerminalInfo> {
    const pty = await loadPty()
    if (!pty) throw new Error(loadError ?? 'The terminal is unavailable.')
    const sh = defaultShell()
    const p = pty.spawn(sh.file, sh.args, {
      name: 'xterm-256color',
      cols: Math.max(20, cols),
      rows: Math.max(5, rows),
      cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>
    })
    const info: TerminalInfo = { id: newId('t'), kind, title }
    this.sessions.set(info.id, { info, pty: p })
    p.onData((data) => this.emit({ type: 'terminal-data', id: info.id, data }))
    p.onExit(({ exitCode }) => {
      this.sessions.delete(info.id)
      this.emit({ type: 'terminal-exit', id: info.id, code: exitCode })
    })
    if (startup) setTimeout(() => p.write(`${startup}\r`), 350)
    return info
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    try {
      this.sessions.get(id)?.pty.resize(Math.max(20, cols), Math.max(5, rows))
    } catch {
      // a pty that is exiting refuses a resize
    }
  }

  close(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    try {
      s.pty.kill()
    } catch {
      // already gone
    }
  }

  list(): TerminalInfo[] {
    return [...this.sessions.values()].map((s) => s.info)
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id)
  }
}
