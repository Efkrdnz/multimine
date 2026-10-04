import { mkdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { MULTIMINE_TEMPLATE } from '@shared/templates'
import type { AgentSpec, ProjectInfo } from '@shared/types'
import { projectPaths, type ProjectPaths } from './paths'
import { readText, writeAtomic } from './fsx'

/** What Multimine keeps out of the repository: chat logs and generated media are the user's own. */
const IGNORED = ['chats/', 'media/']

/** One opened project folder: its `multimine.md` and its chats. */
export class ProjectStore {
  readonly paths: ProjectPaths
  private chats = new Map<string, AgentSpec>()
  multimineMd = ''

  private constructor(readonly dir: string) {
    this.paths = projectPaths(dir)
  }

  /** Opens a folder, creating `.multimine/` and `multimine.md` when missing. */
  static async open(dir: string): Promise<ProjectStore> {
    const store = new ProjectStore(dir)
    const p = store.paths
    for (const d of [p.root, p.chats, p.media]) await mkdir(d, { recursive: true })
    const ignoreFile = join(p.root, '.gitignore')
    const ignore = (await readText(ignoreFile)) ?? ''
    const missing = IGNORED.filter((line) => !ignore.split(/\r?\n/).includes(line))
    if (missing.length) await writeAtomic(ignoreFile, `${ignore}${ignore && !ignore.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`)
    const md = await readText(p.multimineMd)
    if (md == null) await writeAtomic(p.multimineMd, MULTIMINE_TEMPLATE)
    store.multimineMd = md ?? MULTIMINE_TEMPLATE
    return store
  }

  async reloadMultimineMd(): Promise<string> {
    this.multimineMd = (await readText(this.paths.multimineMd)) ?? ''
    return this.multimineMd
  }

  async saveMultimineMd(text: string): Promise<void> {
    this.multimineMd = text
    await writeAtomic(this.paths.multimineMd, text)
  }

  /** The chats, most recently used first. */
  list(): AgentSpec[] {
    return [...this.chats.values()].sort((a, b) => b.updated - a.updated)
  }

  get(id: string): AgentSpec | undefined {
    return this.chats.get(id)
  }

  set(chat: AgentSpec): void {
    this.chats.set(chat.id, chat)
  }

  delete(id: string): void {
    this.chats.delete(id)
  }

  info(): ProjectInfo {
    return { dir: this.dir, name: basename(this.dir), multimineMd: this.multimineMd, agents: this.list() }
  }
}
