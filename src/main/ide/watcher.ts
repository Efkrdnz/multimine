import { watch, type FSWatcher } from 'chokidar'
import { relative, sep } from 'node:path'
import { SKIP } from '../chat/workspace'

export type ChangeKind = 'added' | 'changed' | 'deleted'

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
