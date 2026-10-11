import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FileChange, TurnChanges } from '@shared/types'

/**
 * Left out of snapshots on top of the project's own .gitignore: build output, caches and engine
 * folders that are large, rebuilt on every run, and never what a chat edits.
 */
const EXCLUDE = [
  '.multimine/',
  'node_modules/',
  '.gradle/',
  'build/',
  'run/',
  'out/',
  'dist/',
  'target/',
  'obj/',
  '.godot/',
  '.import/',
  'Library/',
  'Temp/',
  'Logs/',
  'UserSettings/',
  'Binaries/',
  'Intermediate/',
  'DerivedDataCache/',
  'Saved/',
  '.vs/',
  '.idea/',
  '__pycache__/',
  '*.log'
]

/** How many files a turn lists; the rest are counted. */
const MAX_FILES = 200

interface Result {
  ok: boolean
  out: string
  err: string
}

/**
 * Snapshots of the project's files before and after each chat turn, so a turn's changes can be
 * listed, diffed and undone. They live in a git store of Multimine's own (`.multimine/history.git`)
 * that never touches the project's repository, its index or its branches, and works in a folder
 * that is not a repository at all. Every call is queued: chats running at once share one store.
 */
export class Checkpoints {
  readonly gitDir: string
  private queue: Promise<unknown> = Promise.resolve()
  private ready: Promise<boolean> | null = null
  /** Set when snapshots cannot work here (no git, a failed first snapshot): turns simply go without. */
  broken: string | null = null

  constructor(private readonly dir: string, private readonly timeoutMs = 60_000) {
    this.gitDir = join(dir, '.multimine', 'history.git')
  }

  private git(args: string[], timeout = this.timeoutMs): Promise<Result> {
    return new Promise((resolve) => {
      execFile(
        'git',
        ['--git-dir', this.gitDir, '--work-tree', this.dir, '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.quotepath=false', ...args],
        { cwd: this.dir, timeout, maxBuffer: 50_000_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } },
        (error, stdout, stderr) => resolve({ ok: !error, out: String(stdout), err: String(stderr || (error ? error.message : '')) })
      )
    })
  }

  private async must(args: string[], timeout?: number): Promise<string> {
    const r = await this.git(args, timeout)
    if (!r.ok) throw new Error((r.err || r.out).trim() || `git ${args[0]} failed`)
    return r.out
  }

  /** One store operation at a time. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(() => undefined)
    return next
  }

  /** Resolves once nothing is writing to the store (the project is closing). */
  idle(): Promise<void> {
    return this.queue.then(() => undefined)
  }

  /** Creates the store the first time; false (and `broken` says why) when git is not there. */
  start(): Promise<boolean> {
    this.ready ??= this.serial(async () => {
      try {
        if (!existsSync(join(this.gitDir, 'HEAD'))) {
          await mkdir(this.gitDir, { recursive: true })
          await this.must(['init', '--quiet'])
          await this.must(['config', 'core.bare', 'false'])
          await this.must(['config', 'user.name', 'Multimine'])
          await this.must(['config', 'user.email', 'checkpoints@multimine.local'])
          await this.must(['config', 'gc.autoDetach', 'false'])
        }
        await mkdir(join(this.gitDir, 'info'), { recursive: true })
        await writeFile(join(this.gitDir, 'info', 'exclude'), `${EXCLUDE.join('\n')}\n`)
        // the project's own repository never lists the store, with or without .multimine/.gitignore
        await writeFile(join(this.gitDir, '.gitignore'), '*\n')
        return true
      } catch (e) {
        this.broken = `Turn snapshots are off: ${(e as Error).message.split('\n')[0]}`
        return false
      }
    })
    return this.ready
  }

  /**
   * The project's files as they are now, as a tree in the store. The store's index remembers file
   * times, so after the first snapshot only files that changed are read again. Each snapshot is
   * committed on a branch of the store so git never collects it while a chat may still undo it.
   */
  snapshot(label: string): Promise<string | null> {
    return this.start().then((ok) =>
      !ok || this.broken
        ? null
        : this.serial(async () => {
            try {
              await this.must(['add', '--all', '--ignore-errors', '.'])
              const tree = (await this.must(['write-tree'])).trim()
              const head = await this.git(['rev-parse', '--verify', '--quiet', 'refs/heads/snapshots'])
              const commit = (await this.must(['commit-tree', tree, '-m', label.slice(0, 200), ...(head.ok ? ['-p', head.out.trim()] : [])])).trim()
              await this.must(['update-ref', 'refs/heads/snapshots', commit])
              return tree
            } catch (e) {
              this.broken = `Turn snapshots are off: ${(e as Error).message.split('\n')[0]}`
              return null
            }
          })
    )
  }

  /** The files that differ between two snapshots, with lines added and removed. */
  changes(before: string, after: string): Promise<Pick<TurnChanges, 'files' | 'more'>> {
    if (before === after) return Promise.resolve({ files: [] })
    return this.serial(() => this.list(before, after))
  }

  private async list(before: string, after: string, limit = MAX_FILES): Promise<Pick<TurnChanges, 'files' | 'more'>> {
    const [status, counts] = await Promise.all([
      this.must(['diff', '--no-renames', '--name-status', '-z', before, after]),
      this.must(['diff', '--no-renames', '--numstat', '-z', before, after])
    ])
    return parseChanges(status, counts, limit)
  }

  /** The unified diff of one file between two snapshots. */
  diff(before: string, after: string, path: string): Promise<string> {
    return this.serial(() => this.must(['diff', '--no-renames', before, after, '--', path]))
  }

  /**
   * Puts the files a turn changed back as they were before it. A file changed again since the turn
   * (by the user, a later turn, another chat) is not touched unless `force`: those come back as
   * conflicts for the user to decide on.
   */
  undo(c: Pick<TurnChanges, 'before' | 'after'>, force = false): Promise<{ undone: boolean; conflicts: string[] }> {
    return this.serial(async () => {
      const { files } = await this.list(c.before, c.after, Infinity)
      const paths = files.map((f) => f.path)
      const conflicts: string[] = []
      for (const f of files) {
        const now = existsSync(join(this.dir, f.path)) ? (await this.git(['hash-object', '--', f.path])).out.trim() : null
        const then = f.status === 'D' ? null : (await this.git(['rev-parse', '--verify', '--quiet', `${c.after}:${f.path}`])).out.trim() || null
        if (now !== then) conflicts.push(f.path)
      }
      if (conflicts.length && !force) return { undone: false, conflicts }
      const added = files.filter((f) => f.status === 'A').map((f) => f.path)
      const back = paths.filter((p) => !added.includes(p))
      for (const p of added) await rm(join(this.dir, p), { force: true })
      for (let i = 0; i < back.length; i += 100) await this.must(['checkout', c.before, '--', ...back.slice(i, i + 100)])
      return { undone: true, conflicts }
    })
  }
}

/** Reads `git diff --name-status -z` and `--numstat -z` into a list of changed files. */
export function parseChanges(status: string, counts: string, limit = MAX_FILES): Pick<TurnChanges, 'files' | 'more'> {
  const s = status.split('\0').filter(Boolean)
  const kinds = new Map<string, FileChange['status']>()
  for (let i = 0; i + 1 < s.length; i += 2) {
    const k = s[i][0]
    kinds.set(s[i + 1], k === 'A' ? 'A' : k === 'D' ? 'D' : 'M')
  }
  const files: FileChange[] = []
  for (const row of counts.split('\0').filter(Boolean)) {
    const [add, del, ...rest] = row.split('\t')
    const path = rest.join('\t')
    if (!path) continue
    const binary = add === '-'
    files.push({ path, status: kinds.get(path) ?? 'M', add: binary ? 0 : Number(add) || 0, del: binary ? 0 : Number(del) || 0, ...(binary ? { binary } : {}) })
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  return files.length > limit ? { files: files.slice(0, limit), more: files.length - limit } : { files }
}
