import { createHash } from 'node:crypto'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parseAgentFile, serializeAgentFile, slugify } from '@shared/agentFile'
import { MULTIMINE_TEMPLATE, roleTemplate } from '@shared/templates'
import { MASTERMIND_ID, type AgentSpec, type ProjectInfo } from '@shared/types'
import { projectPaths, type ProjectPaths } from './paths'
import { readJson, readText, writeAtomic, writeJson } from './fsx'

/** Fingerprints of the role instructions an old version wrote, whitespace aside. */
const OLD_PURPOSE = { mastermind: 'eebf71eaa27c3fe8101df0c40c968c161f4bb609', planner: '6e2af982c693b4a754d4df80d05b4f25a93a1002', leanMastermind: 'efcf2d48849728990ae1684d251144204eb61ea4' }

const purposeHash = (purpose: string) => createHash('sha1').update(purpose.replace(/\s+/g, ' ').trim()).digest('hex')

/** Agents, multimine.md and the layout of one opened project folder. */
export class ProjectStore {
  readonly paths: ProjectPaths
  private agents = new Map<string, AgentSpec>()
  /** Agents that exist only while something runs (a CLI in the IDE terminal); never written to disk. */
  private virtuals = new Map<string, AgentSpec>()
  private layout: Record<string, { x: number; y: number }> = {}
  multimineMd = ''

  private constructor(readonly dir: string) {
    this.paths = projectPaths(dir)
  }

  /**
   * Opens a folder, creating `.multimine/`, `multimine.md` and a Mastermind when missing.
   * `mastermindDefaults` lets the caller pick the provider it detected (a CLI login, or mock).
   */
  static async open(dir: string, mastermindDefaults: Partial<AgentSpec> = {}): Promise<ProjectStore> {
    const store = new ProjectStore(dir)
    const p = store.paths
    for (const d of [p.root, p.agents, p.context, p.media, p.sessions]) await mkdir(d, { recursive: true })
    // agents and the context map belong in the repository; chat logs and generated media do not
    if ((await readText(join(p.root, '.gitignore'))) == null) await writeAtomic(join(p.root, '.gitignore'), 'sessions/\nmedia/\nlayout.json\n')
    const md = await readText(p.multimineMd)
    if (md == null) await writeAtomic(p.multimineMd, MULTIMINE_TEMPLATE)
    store.multimineMd = md ?? MULTIMINE_TEMPLATE
    await store.reloadAgents()
    if (!store.agents.has(MASTERMIND_ID)) {
      await store.saveAgent({ ...roleTemplate('mastermind', MASTERMIND_ID), ...mastermindDefaults, id: MASTERMIND_ID, role: 'mastermind' })
    }
    store.layout = await readJson(p.layout, {})
    store.migrated = await store.migrate()
    return store
  }

  /** What the migrations changed when this project was opened, one notice each. */
  migrated: string[] = []

  /**
   * One-time fixes to agents still on an old default. Only the exact old value is touched, and each
   * migration runs once per project (recorded with the local session data), so a value the user
   * sets back by hand stays.
   */
  private async migrate(): Promise<string[]> {
    const file = join(this.paths.sessions, 'migrations.json')
    const done = await readJson<string[]>(file, [])
    const notes: string[] = []
    if (!done.includes('implementer-effort-high')) {
      // the Implementer used to default to Opus at xhigh: the slowest, costliest setting there is
      const changed: string[] = []
      for (const a of this.agents.values()) {
        if (a.role === 'implementer' && a.model === 'claude-opus-5-5' && a.effort === 'xhigh') {
          await this.saveAgent({ ...a, effort: 'high' })
          changed.push(a.name)
        }
      }
      if (changed.length) notes.push(`${changed.join(', ')}: effort lowered from xhigh to high to save usage. Change it back in the agent editor if you want.`)
      done.push('implementer-effort-high')
    }
    if (!done.includes('lean-team-v1')) {
      // Mastermind used to send every request through the Planner, the council and two approvals;
      // agents still on those exact instructions get the version with a fast path for small tasks
      let lean = false
      for (const a of this.agents.values()) {
        if (a.role === 'mastermind' && purposeHash(a.purpose) === OLD_PURPOSE.mastermind) {
          await this.saveAgent({ ...a, purpose: roleTemplate('mastermind', a.id).purpose })
          lean = true
        }
        if (a.role === 'planner' && a.planMode && purposeHash(a.purpose) === OLD_PURPOSE.planner) {
          await this.saveAgent({ ...a, planMode: false, purpose: roleTemplate('planner', a.id).purpose })
          lean = true
        }
      }
      if (lean) notes.push('Mastermind now sends small, clear tasks straight to the Implementer (one approval, no Planner or council), and the Planner no longer asks for an approval of its own.')
      done.push('lean-team-v1')
    }
    if (!done.includes('fresh-context-v1')) {
      // the lean Mastermind, taught that delegated tasks start clean and when to continue instead
      for (const a of this.agents.values()) {
        if (a.role === 'mastermind' && purposeHash(a.purpose) === OLD_PURPOSE.leanMastermind) await this.saveAgent({ ...a, purpose: roleTemplate('mastermind', a.id).purpose })
      }
      done.push('fresh-context-v1')
    }
    await writeJson(file, done)
    return notes
  }

  async reloadAgents(): Promise<void> {
    this.agents.clear()
    let files: string[] = []
    try {
      files = await readdir(this.paths.agents)
    } catch {
      files = []
    }
    for (const f of files.sort()) {
      if (!f.endsWith('.md')) continue
      const id = f.slice(0, -3)
      const text = await readText(this.paths.agent(id))
      if (text != null) this.agents.set(id, parseAgentFile(id, text))
    }
  }

  async reloadMultimineMd(): Promise<string> {
    this.multimineMd = (await readText(this.paths.multimineMd)) ?? ''
    return this.multimineMd
  }

  async saveMultimineMd(text: string): Promise<void> {
    this.multimineMd = text
    await writeAtomic(this.paths.multimineMd, text)
  }

  list(): AgentSpec[] {
    const all = [...this.agents.values(), ...this.virtuals.values()]
    return all.sort((a, b) => (a.id === MASTERMIND_ID ? -1 : b.id === MASTERMIND_ID ? 1 : a.name.localeCompare(b.name)))
  }

  get(id: string): AgentSpec | undefined {
    return this.agents.get(id) ?? this.virtuals.get(id)
  }

  addVirtual(agent: AgentSpec): void {
    this.virtuals.set(agent.id, agent)
  }

  removeVirtual(id: string): void {
    this.virtuals.delete(id)
  }

  /** Finds an agent by id or (case-insensitively) by name, which is how agents address each other. */
  find(ref: string): AgentSpec | undefined {
    const r = ref.trim().toLowerCase()
    return this.get(r) ?? this.list().find((a) => a.name.toLowerCase() === r || slugify(a.name) === slugify(r))
  }

  contextHandler(): AgentSpec | undefined {
    return this.list().find((a) => a.role === 'context-handler')
  }

  /** A slug not used by any other agent. */
  freeId(name: string): string {
    const base = slugify(name)
    let id = base
    for (let i = 2; this.agents.has(id) || this.virtuals.has(id); i++) id = `${base}-${i}`
    return id
  }

  async saveAgent(agent: AgentSpec): Promise<AgentSpec> {
    this.agents.set(agent.id, agent)
    await writeAtomic(this.paths.agent(agent.id), serializeAgentFile(agent))
    return agent
  }

  async deleteAgent(id: string): Promise<void> {
    if (id === MASTERMIND_ID) throw new Error('Mastermind cannot be deleted')
    this.agents.delete(id)
    delete this.layout[id]
    await rm(this.paths.agent(id), { force: true })
    await writeJson(this.paths.layout, this.layout)
  }

  async setPosition(id: string, x: number, y: number): Promise<void> {
    this.layout[id] = { x: Math.round(x), y: Math.round(y) }
    await writeJson(this.paths.layout, this.layout)
  }

  info(): ProjectInfo {
    return { dir: this.dir, name: basename(this.dir), multimineMd: this.multimineMd, agents: this.list(), layout: { ...this.layout } }
  }
}
