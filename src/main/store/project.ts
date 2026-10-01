import { mkdir, readdir, rm } from 'node:fs/promises'
import { basename } from 'node:path'
import { parseAgentFile, serializeAgentFile, slugify } from '@shared/agentFile'
import { MULTIMINE_TEMPLATE, roleTemplate } from '@shared/templates'
import { MASTERMIND_ID, type AgentSpec, type ProjectInfo } from '@shared/types'
import { projectPaths, type ProjectPaths } from './paths'
import { readJson, readText, writeAtomic, writeJson } from './fsx'

/** Agents, multimine.md and the layout of one opened project folder. */
export class ProjectStore {
  readonly paths: ProjectPaths
  private agents = new Map<string, AgentSpec>()
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
    const md = await readText(p.multimineMd)
    if (md == null) await writeAtomic(p.multimineMd, MULTIMINE_TEMPLATE)
    store.multimineMd = md ?? MULTIMINE_TEMPLATE
    await store.reloadAgents()
    if (!store.agents.has(MASTERMIND_ID)) {
      await store.saveAgent({ ...roleTemplate('mastermind', MASTERMIND_ID), ...mastermindDefaults, id: MASTERMIND_ID, role: 'mastermind' })
    }
    store.layout = await readJson(p.layout, {})
    return store
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
    const all = [...this.agents.values()]
    return all.sort((a, b) => (a.id === MASTERMIND_ID ? -1 : b.id === MASTERMIND_ID ? 1 : a.name.localeCompare(b.name)))
  }

  get(id: string): AgentSpec | undefined {
    return this.agents.get(id)
  }

  /** Finds an agent by id or (case-insensitively) by name, which is how agents address each other. */
  find(ref: string): AgentSpec | undefined {
    const r = ref.trim().toLowerCase()
    return this.agents.get(r) ?? this.list().find((a) => a.name.toLowerCase() === r || slugify(a.name) === slugify(r))
  }

  contextHandler(): AgentSpec | undefined {
    return this.list().find((a) => a.role === 'context-handler')
  }

  /** A slug not used by any other agent. */
  freeId(name: string): string {
    const base = slugify(name)
    let id = base
    for (let i = 2; this.agents.has(id); i++) id = `${base}-${i}`
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
