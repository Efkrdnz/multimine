/**
 * Finding crashes and errors in a running game's output: Java and Kotlin stack traces (Minecraft
 * mods, Gradle), Minecraft crash reports, Godot script errors, Python tracebacks, JavaScript and C#
 * (Unity, .NET) stack traces and Rust panics. Pure, so it runs on any text and is unit tested.
 */

export type CrashKind = 'java' | 'minecraft' | 'godot' | 'python' | 'js' | 'csharp' | 'rust' | 'exit'

/** A place in a stack trace: a file and a line, as the trace names them. */
export interface Frame {
  file: string
  line: number
  /** The function or method, when the trace says. */
  symbol?: string
  /** For JVM frames: the source path the class implies (`com/mana/spells/Fireball.java`). */
  hint?: string
}

/** A frame found in the project: its path relative to the project, and the code around the line. */
export interface Place {
  path: string
  line: number
  snippet?: string
}

export interface Crash {
  id: string
  kind: CrashKind
  title: string
  /** The innermost cause (`Caused by: ...`), when there is one. */
  cause?: string
  /** The trace as printed, log prefixes removed. */
  trace: string[]
  frames: Frame[]
  /** Frames found in the project (filled in by the main process). */
  places?: Place[]
  /** The process died of it (a crash), rather than logging it and carrying on. */
  fatal: boolean
  /** A Minecraft crash report file the game wrote. */
  reportFile?: string
  /** What makes two reports the same problem, to show it once. */
  signature: string
  ts: number
}

/** Log prefixes in front of a line: `[12:34:56] [Render thread/ERROR] (Minecraft):`, `2024-01-01 12:00:00 ERROR` and the like. */
const PREFIX = /^(?:\s*\[[^\]]{1,80}\])+\s*(?:\([^)]{1,60}\))?\s*:?\s*|^\d{4}-\d\d-\d\d[ T][\d:.,]+\s+(?:[A-Z]+\s+)?(?:\[[^\]]*\]\s+)?(?:[\w.$]+\s+-\s+)?/
const strip = (l: string) => l.replace(PREFIX, '')

const HEADER = /(?:^|[\s:"])((?:[A-Za-z_$][\w$]*\.)*(?:[A-Z][\w$]*)?(?:Exception|Error|Throwable))\b(?::\s*(.*))?$/
const JVM_FRAME = /^\s*at\s+(?:[\w.-]+(?:@[\w.-]+)?\/)*([\w$.<>]+)\(([^():]+)(?::(\d+))?\)/
const JS_FRAME = /^\s*at\s+(?:(.+?)\s+\()?((?:file:\/\/|node:)?(?:[A-Za-z]:)?[^():]+?):(\d+):(\d+)\)?\s*$/
const UNITY_FRAME = /^\s*([\w.<>`$+]+(?:[:.][\w<>`$+]+)*)\s*\([^)]*\)\s*(?:\[[^\]]*\]\s*)?\(at\s+(.+?):(\d+)\)/
const DOTNET_FRAME = /^\s*at\s+(.+?)\s+in\s+(.+?):line\s+(\d+)/
const CAUSE = /^\s*(?:Caused by|Suppressed):\s*(.+)$/
const MORE = /^\s*\.\.\.\s*\d+\s+(?:more|common frames omitted)/
const MC_REPORT = /----\s*Minecraft Crash Report\s*----/
const MC_SAVED = /Crash report saved to:\s*(?:#@!@#\s*)?(.+?)\s*$/
const GODOT_ERROR = /^\s*(SCRIPT ERROR|USER SCRIPT ERROR|ERROR|USER ERROR):\s*(.+)$/
const GODOT_AT = /(?:^\s*at:\s*|^\s*\[\d+\]\s*)(?:(.+?)\s*)?\(?(res:\/\/[^:()]+):(\d+)\)?/
const PY_START = /^\s*Traceback \(most recent call last\):\s*$/
const PY_FRAME = /^\s*File "(.+?)", line (\d+)(?:, in (.+))?$/
const RUST_PANIC = /thread '(.+?)' panicked at (?:'(.*)', )?(.+?):(\d+):(\d+):?\s*(.*)$/

let seq = 0
const newId = () => `p${Date.now().toString(36)}${(seq++).toString(36)}`

interface FrameHit {
  frame: Frame | null
  kind: CrashKind
}

/** A stack frame line of any kind we read, or null. */
function frameOf(line: string): FrameHit | null {
  let m = JVM_FRAME.exec(line)
  if (m) {
    const symbol = m[1]
    const file = m[2]
    if (!m[3] || !/\.(java|kt|scala|groovy|kts)$/.test(file)) return { frame: null, kind: 'java' }
    // com.mana.spells.Fireball$Inner.cast -> com/mana/spells/Fireball.java
    const parts = symbol.split('.')
    const pkg = parts.slice(0, -2)
    return { frame: { file, line: Number(m[3]), symbol, hint: [...pkg, file].join('/') }, kind: 'java' }
  }
  m = DOTNET_FRAME.exec(line)
  if (m) return { frame: { file: m[2], line: Number(m[3]), symbol: m[1] }, kind: 'csharp' }
  m = UNITY_FRAME.exec(line)
  if (m) return { frame: { file: m[2], line: Number(m[3]), symbol: m[1] }, kind: 'csharp' }
  m = JS_FRAME.exec(line)
  if (m) {
    const file = m[2]
    if (/^(node:|internal\/)/.test(file)) return { frame: null, kind: 'js' }
    return { frame: { file, line: Number(m[3]), symbol: m[1] }, kind: 'js' }
  }
  return null
}

function signature(kind: CrashKind, title: string, frames: Frame[]): string {
  const top = frames[0]
  return `${kind}|${title.replace(/\d+/g, '#').slice(0, 160)}|${top ? `${top.file}:${top.line}` : ''}`
}

function crash(kind: CrashKind, title: string, trace: string[], frames: Frame[], fatal: boolean, extra: Partial<Crash> = {}): Crash {
  return { id: newId(), kind, title: title.trim().slice(0, 300), trace: trace.slice(0, 400), frames, fatal, signature: signature(kind, title, frames), ts: Date.now(), ...extra }
}

/**
 * Problems in `lines`. `done`: the output is complete; otherwise a trace that reaches the last line
 * may still be printing, so it is left for the next call: `settled` is how many lines are finished
 * with (keep the rest and pass them again with what comes next).
 */
export function findProblems(lines: string[], done = false): { problems: Crash[]; settled: number } {
  const problems: Crash[] = []
  const n = lines.length
  let i = 0
  // a block that runs to the end of the output may not be finished yet
  const open = (end: number) => !done && end >= n
  while (i < n) {
    const raw = lines[i]
    const line = strip(raw)

    if (MC_REPORT.test(line)) {
      let end = i + 1
      let description = ''
      while (end < n && !/A detailed walkthrough of the error/.test(lines[end]) && end - i < 400) {
        const d = /^\s*Description:\s*(.+)$/.exec(lines[end])
        if (d && !description) description = d[1]
        end++
      }
      if (open(end)) return { problems, settled: i }
      const body = lines.slice(i, end)
      const inner = findProblems(body.slice(1), true).problems.find((p) => p.kind === 'java')
      const savedLine = lines.slice(Math.max(0, i - 5), Math.min(n, end + 40)).find((l) => MC_SAVED.test(l))
      problems.push(
        crash('minecraft', `Minecraft crashed: ${description || inner?.title || 'see the crash report'}`, inner?.trace ?? body, inner?.frames ?? [], true, {
          cause: inner?.cause ?? inner?.title,
          ...(savedLine ? { reportFile: MC_SAVED.exec(savedLine)![1] } : {})
        })
      )
      i = end + 1
      continue
    }

    const saved = MC_SAVED.exec(line)
    if (saved) {
      // the report itself may not be in the output: its file is
      if (!problems.some((p) => p.kind === 'minecraft')) problems.push(crash('minecraft', 'Minecraft crashed', [line], [], true, { reportFile: saved[1] }))
      else for (const p of problems) if (p.kind === 'minecraft' && !p.reportFile) p.reportFile = saved[1]
      i++
      continue
    }

    if (PY_START.test(line)) {
      let end = i + 1
      const frames: Frame[] = []
      while (end < n && /^\s/.test(strip(lines[end]))) {
        const f = PY_FRAME.exec(strip(lines[end]))
        if (f) frames.push({ file: f[1], line: Number(f[2]), symbol: f[3] })
        end++
      }
      if (open(end)) return { problems, settled: i }
      const last = strip(lines[end] ?? '').trim()
      // the innermost call is printed last
      problems.push(crash('python', last || 'Python error', lines.slice(i, end + 1).map(strip), frames.reverse(), false))
      i = end + 1
      continue
    }

    const panic = RUST_PANIC.exec(line)
    if (panic) {
      const message = panic[2] ?? (panic[6] || strip(lines[i + 1] ?? '').trim())
      if (open(i + 2) && !panic[2] && !panic[6]) return { problems, settled: i }
      const trace = lines.slice(i, i + 3).map(strip)
      problems.push(crash('rust', `panicked: ${message}`, trace, [{ file: panic[3], line: Number(panic[4]) }], true))
      i += panic[2] || panic[6] ? 1 : 2
      continue
    }

    const g = GODOT_ERROR.exec(line)
    if (g) {
      let end = i + 1
      const frames: Frame[] = []
      while (end < n && end - i < 30) {
        const s = strip(lines[end])
        // `[0] _ready (res://...)` would read as a log prefix: try the raw line first
        const at = GODOT_AT.exec(lines[end]) ?? GODOT_AT.exec(s)
        if (at) frames.push({ file: at[2].replace(/^res:\/\//, ''), line: Number(at[3]), symbol: at[1] })
        else if (!/^\s*(GDScript backtrace|<)/.test(lines[end]) || !s.trim()) break
        end++
      }
      if (frames.length || g[1].includes('SCRIPT')) {
        if (open(end)) return { problems, settled: i }
        problems.push(crash('godot', g[2], lines.slice(i, end).map(strip), frames, false))
        i = Math.max(end, i + 1)
        continue
      }
    }

    // an exception line followed by stack frames: JVM, JavaScript, C#
    const h = HEADER.exec(line)
    if (h && i + 1 >= n && !done) return { problems, settled: i }
    if (h && i + 1 < n) {
      let end = i + 1
      const frames: Frame[] = []
      let kind: CrashKind | null = null
      let cause: string | undefined
      for (; end < n; end++) {
        const s = strip(lines[end])
        const hit = frameOf(s)
        if (hit) {
          kind ??= hit.kind
          if (hit.frame) frames.push(hit.frame)
          continue
        }
        const c = CAUSE.exec(s)
        if (c) {
          cause = c[1]
          continue
        }
        if (MORE.test(s)) continue
        break
      }
      if (kind) {
        if (open(end)) return { problems, settled: i }
        const title = `${h[1]}${h[2] ? `: ${h[2]}` : ''}`
        const fatal = /Exception in thread "main"|Unhandled exception|Uncaught|FATAL|Exception in thread "Render thread"/.test(raw)
        problems.push(crash(kind, title, lines.slice(i, end).map(strip), frames, fatal, cause ? { cause } : {}))
        i = end
        continue
      }
      // a header with nothing after it yet may be a trace about to print
      if (end >= n && !done) return { problems, settled: i }
    }
    i++
  }
  return { problems, settled: n }
}

/** A problem for a run that ended badly without printing anything we recognise: its last lines. */
export function exitProblem(code: number | null, signal: string | null, tail: string[]): Crash {
  const title = signal ? `Stopped by ${signal}` : `Exited with code ${code}`
  return crash('exit', title, tail.filter((l) => l.trim()).slice(-30), [], true)
}

/**
 * A trace short enough to send: exception lines and frames in the project stay; runs of other
 * frames shrink to a count, keeping the first few under each exception for context.
 */
export function compactTrace(trace: string[], inProject: (line: string) => boolean, max = 60): string[] {
  const out: string[] = []
  let sinceHeader = 0
  let skipped = 0
  const flush = () => {
    if (skipped) out.push(`    ... ${skipped} more frame${skipped === 1 ? '' : 's'}`)
    skipped = 0
  }
  for (const l of trace) {
    const isFrame = !!frameOf(l) || /^\s*(File "|at:|\[\d+\])/.test(l) || MORE.test(l)
    if (!isFrame) {
      flush()
      sinceHeader = 0
      out.push(l)
      continue
    }
    if (MORE.test(l)) {
      skipped++
      continue
    }
    if (inProject(l) || sinceHeader < 4) {
      flush()
      out.push(l)
    } else skipped++
    sinceHeader++
  }
  flush()
  return out.length > max ? [...out.slice(0, max - 1), `... ${out.length - max + 1} more lines`] : out
}

/** The message a problem becomes when sent to a chat. */
export function crashPrompt(c: Crash, o: { command: string; code?: number | null; report?: string }): string {
  const projectFiles = new Set((c.places ?? []).map((p) => p.path.split('/').pop()!))
  const trace = compactTrace(c.trace, (l) => [...projectFiles].some((f) => l.includes(f)))
  const what = c.kind === 'exit' ? `\`${o.command}\` ${c.title.toLowerCase()}` : c.fatal ? `\`${o.command}\` crashed${o.code != null ? ` (exit code ${o.code})` : ''}` : `\`${o.command}\` printed this error while running`
  const parts = [`# Fix: ${c.title.slice(0, 120)}`, '', `${what}.`, '', '```', ...trace, '```']
  if (c.places?.length) {
    parts.push('', '## Where it points in the project')
    for (const p of c.places.slice(0, 3)) {
      parts.push('', `\`${p.path}:${p.line}\``)
      if (p.snippet) parts.push('```', p.snippet, '```')
    }
  }
  if (o.report) parts.push('', '## From the crash report', '```', o.report, '```')
  parts.push('', 'Find the cause and fix it. Say what it was and how to check the fix. Run the game again only if multimine.md says how and the fix needs it.')
  return parts.join('\n')
}
