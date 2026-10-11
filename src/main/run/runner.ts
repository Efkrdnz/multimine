import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { detectTarget } from '@shared/sketch/targets'
import { exitProblem, findProblems, type Crash } from '@shared/run/crash'
import type { MainEvent, RunState } from '@shared/types'
import { readJson, writeJson } from '../store/fsx'
import { placesFor } from './places'

export interface RunConfig {
  command: string
}

/** Lines of output kept for the panel. */
const KEEP = 5000
/** Problems kept per run. */
const MAX_PROBLEMS = 30
/** A trace that has printed nothing for this long is finished. */
const SETTLE_MS = 1500

/** Colour codes and cursor moves: the panel shows plain text. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

/**
 * The command that starts this kind of project, or null when it needs an editor to run (Unity,
 * Unreal) and the user has to say.
 */
export async function suggestCommand(dir: string, platform = process.platform): Promise<string | null> {
  let names: string[] = []
  try {
    names = (await readdir(dir, { withFileTypes: true })).map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
  } catch {
    return null
  }
  const read = (n: string) => readFile(join(dir, n), 'utf8').catch(() => null)
  const has = (n: string) => names.includes(n)
  const gradlew = platform === 'win32' ? 'gradlew.bat' : './gradlew'
  const target = await detectTarget(names, read)
  if (target === 'minecraft') return has('gradlew') || has('gradlew.bat') ? `${gradlew} runClient` : 'gradle runClient'
  if (target === 'godot') return 'godot --path .'
  if (target === 'unity' || target === 'unreal') return null
  if (has('package.json')) {
    const pkg = JSON.parse((await read('package.json')) ?? '{}') as { scripts?: Record<string, string> }
    if (pkg.scripts?.dev) return 'npm run dev'
    if (pkg.scripts?.start) return 'npm start'
  }
  if (has('Cargo.toml')) return 'cargo run'
  if (has('go.mod')) return 'go run .'
  if (has('main.py')) return platform === 'win32' ? 'python main.py' : 'python3 main.py'
  if (has('build.gradle') || has('build.gradle.kts')) return has('gradlew') || has('gradlew.bat') ? `${gradlew} run` : 'gradle run'
  return null
}

/**
 * The project's run button: one process at a time, started through the shell in the project folder.
 * Its output streams to the window in batches and is read for crashes and errors as it comes;
 * each one found is matched to the project's files and shown once.
 */
export class Runner {
  state: RunState = { status: 'idle', command: '', problems: [] }
  private lines: string[] = []
  /** Output not yet read for problems (a trace may still be printing). */
  private pending: string[] = []
  private outbox: string[] = []
  private partial = { out: '', err: '' }
  private child: ChildProcess | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private settleTimer: ReturnType<typeof setTimeout> | null = null
  private exited: Promise<void> = Promise.resolve()
  /** Problems being matched to files: a run's end waits for them. */
  private resolving: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly dir: string,
    private readonly emit: (e: MainEvent) => void
  ) {}

  private get configFile(): string {
    return join(this.dir, '.multimine', 'run.json')
  }

  async config(): Promise<RunConfig | null> {
    const c = await readJson<RunConfig | null>(this.configFile, null)
    return c && typeof c.command === 'string' && c.command.trim() ? { command: c.command } : null
  }

  async saveConfig(c: RunConfig): Promise<void> {
    await writeJson(this.configFile, { command: c.command.trim() })
  }

  output(): string[] {
    return this.lines
  }

  private publish(): void {
    this.emit({ type: 'run', state: { ...this.state, problems: [...this.state.problems] } })
  }

  async start(command: string): Promise<void> {
    if (!command.trim()) throw new Error('Set the command that starts the game first.')
    await this.stop()
    this.lines = []
    this.pending = []
    this.outbox = []
    this.partial = { out: '', err: '' }
    this.state = { status: 'running', command, startedAt: Date.now(), problems: [] }
    this.emit({ type: 'run-output', lines: [], reset: true })
    this.publish()
    const win = process.platform === 'win32'
    const child = spawn(command, {
      cwd: this.dir,
      shell: true,
      // its own process group, so Stop ends everything it started (Gradle's game, a dev server's children)
      detached: !win,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb' }
    })
    this.child = child
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => this.take('out', d))
    child.stderr?.on('data', (d: string) => this.take('err', d))
    this.exited = new Promise((resolve) => {
      const done = (code: number | null, signal: NodeJS.Signals | null) => {
        if (this.child !== child) return resolve()
        this.child = null
        for (const k of ['out', 'err'] as const) if (this.partial[k]) this.push(this.partial[k])
        this.partial = { out: '', err: '' }
        this.flush()
        this.scan(true)
        void this.resolving.then(() => {
          const failed = !this.state.stopped && (code ? code !== 0 : !!signal)
          if (failed) {
            const fatal = this.state.problems.find((p) => p.fatal)
            // the last error printed is what killed it; with none, its last lines say why
            if (!fatal && this.state.problems.length) this.state.problems[this.state.problems.length - 1].fatal = true
            else if (!fatal) this.state.problems.push(exitProblem(code, signal, this.lines.slice(-40)))
          }
          this.state = { ...this.state, status: 'exited', endedAt: Date.now(), code, signal }
          this.publish()
          if (failed) {
            const p = this.state.problems.find((x) => x.fatal)
            this.emit({ type: 'toast', level: 'error', text: `The game ${p && p.kind !== 'exit' ? `crashed: ${p.title.slice(0, 160)}` : `exited with code ${code ?? signal}`}` })
          }
          resolve()
        })
      }
      child.on('exit', done)
      child.on('error', (e) => {
        this.push(`Could not start: ${e.message}`)
        done(127, null)
      })
    })
  }

  private take(stream: 'out' | 'err', data: string): void {
    const text = this.partial[stream] + data
    const parts = text.split('\n')
    this.partial[stream] = parts.pop() ?? ''
    for (const p of parts) this.push(p)
    // a progress line that never ends (a download bar) still shows once it is long
    if (this.partial[stream].length > 4000) {
      this.push(this.partial[stream])
      this.partial[stream] = ''
    }
    this.flushTimer ??= setTimeout(() => this.flush(), 120)
  }

  private push(raw: string): void {
    // a carriage return redraws the line: keep what it ended as
    const line = raw.replace(ANSI, '').replace(/\r$/, '').split('\r').pop() ?? ''
    this.lines.push(line)
    if (this.lines.length > KEEP) this.lines.splice(0, this.lines.length - KEEP)
    this.outbox.push(line)
    this.pending.push(line)
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    if (this.outbox.length) {
      this.emit({ type: 'run-output', lines: this.outbox })
      this.outbox = []
    }
    this.scan(false)
    if (this.settleTimer) clearTimeout(this.settleTimer)
    // output that stops mid-trace (the game froze, or simply printed nothing more) is read anyway
    this.settleTimer = this.pending.length ? setTimeout(() => this.scan(true), SETTLE_MS) : null
  }

  private scan(done: boolean): void {
    if (!this.pending.length) return
    const { problems, settled } = findProblems(this.pending, done || this.pending.length > 2000)
    this.pending = this.pending.slice(settled)
    for (const p of problems) this.add(p)
  }

  private add(p: Crash): void {
    if (this.state.problems.some((x) => x.signature === p.signature) || this.state.problems.length >= MAX_PROBLEMS) return
    this.state.problems.push(p)
    this.publish()
    const work = this.enrich(p).then(() => this.publish())
    this.resolving = Promise.all([this.resolving, work.catch(() => undefined)])
  }

  /** Matches a problem to the project's files; a Minecraft crash report the game saved fills in its trace. */
  private async enrich(p: Crash): Promise<void> {
    if (p.reportFile && !p.frames.length) {
      const file = isAbsolute(p.reportFile) || /^[A-Za-z]:[\\/]/.test(p.reportFile) ? p.reportFile : join(this.dir, p.reportFile)
      if (existsSync(file)) {
        const text = await readFile(file, 'utf8').catch(() => '')
        const inner = findProblems(text.split(/\r?\n/), true).problems.find((x) => x.kind === 'minecraft' || x.kind === 'java')
        if (inner) Object.assign(p, { title: inner.title, cause: inner.cause, trace: inner.trace, frames: inner.frames })
      }
    }
    p.places = await placesFor(this.dir, p)
  }

  /** Ends the run and everything it started. */
  async stop(): Promise<void> {
    const child = this.child
    if (!child?.pid) return
    this.state.stopped = true
    const pid = child.pid
    if (process.platform === 'win32') execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined)
    else {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
      const hard = setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          // already gone
        }
      }, 4000)
      void this.exited.then(() => clearTimeout(hard))
    }
    await Promise.race([this.exited, new Promise((r) => setTimeout(r, 6000))])
  }

  find(id: string): Crash | undefined {
    return this.state.problems.find((p) => p.id === id)
  }
}
