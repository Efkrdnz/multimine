import { watch, type FSWatcher } from 'chokidar'
import { relative, sep } from 'node:path'
import { SKIP } from '../orchestrator/workspace'

export type ChangeKind = 'added' | 'changed' | 'deleted'

export interface TrackerOptions {
  /** How long the project must be quiet before a batch goes to the Context Handler. */
  quietMs: number
  /** True while an agent is writing: those changes reach the Context Handler through the agent's own report. */
  isAgentWriting: () => boolean
  flush: (files: Map<string, ChangeKind>) => void
  changed: (count: number, files: string[]) => void
}

/**
 * Collects the changes nobody on the team made - edits in the IDE window, IntelliJ, VS Code, a
 * terminal - and hands them over in one batch after a quiet spell, so an editing session costs one
 * Context Handler turn and not one per save.
 */
export class ManualChangeTracker {
  private pending = new Map<string, ChangeKind>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly o: TrackerOptions) {}

  /** `explicit` marks a change known to be the user's (a save in the IDE window) even while an agent runs. */
  record(path: string, kind: ChangeKind, explicit = false): void {
    if (!explicit && this.o.isAgentWriting()) return
    const prev = this.pending.get(path)
    // a file added then changed is still new; one added then deleted never existed
    if (prev === 'added' && kind === 'deleted') this.pending.delete(path)
    else this.pending.set(path, prev === 'added' && kind === 'changed' ? 'added' : kind)
    this.o.changed(this.pending.size, [...this.pending.keys()])
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flushNow(), this.o.quietMs)
  }

  get count(): number {
    return this.pending.size
  }

  flushNow(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.pending.size) return
    const batch = this.pending
    this.pending = new Map()
    this.o.changed(0, [])
    this.o.flush(batch)
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
  }
}

/** Ignored by the watcher: build output, VCS, dependencies, and everything Multimine keeps for itself. */
export function ignoredPath(root: string, path: string): boolean {
  const rel = relative(root, path).split(sep).join('/')
  if (!rel || rel.startsWith('..')) return false
  const parts = rel.split('/')
  return parts[0] === '.multimine' || parts.some((p) => SKIP.has(p)) || /(~|\.swp|\.tmp)$/.test(rel)
}

export class ProjectWatcher {
  private watcher: FSWatcher | null = null

  start(root: string, onChange: (relPath: string, kind: ChangeKind) => void, onListChanged: () => void): void {
    this.watcher = watch(root, {
      ignored: (p) => ignoredPath(root, p),
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 }
    })
    const rel = (p: string) => relative(root, p).split(sep).join('/')
    this.watcher.on('add', (p) => (onChange(rel(p), 'added'), onListChanged()))
    this.watcher.on('change', (p) => onChange(rel(p), 'changed'))
    this.watcher.on('unlink', (p) => (onChange(rel(p), 'deleted'), onListChanged()))
    this.watcher.on('addDir', onListChanged)
    this.watcher.on('unlinkDir', onListChanged)
  }

  async stop(): Promise<void> {
    await this.watcher?.close()
    this.watcher = null
  }
}
