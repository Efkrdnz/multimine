import { join } from 'node:path'
import { DEFAULT_CATALOG } from '@shared/catalog'
import { DEFAULT_TIERS } from '@shared/economy'
import type { AppSettings, ProviderKind } from '@shared/types'
import { DEFAULT_WATCHDOG } from '../orchestrator/watchdog'
import { readJson, writeJson } from './fsx'

export const DEFAULT_SETTINGS: AppSettings = {
  automation: false,
  watchdog: DEFAULT_WATCHDOG,
  plugins: {},
  toolOrder: [],
  defaultFallback: [],
  economy: { enabled: false, concise: true, downshift: true, tiers: DEFAULT_TIERS },
  handoffWaitMinutes: 10,
  council: {
    size: 3,
    provider: 'mock',
    model: 'mock',
    effort: 'low',
    lenses: [
      'Skeptic: failure modes, edge cases, what breaks in production',
      'Scope & cost: what is over-built, what is missing, what it costs to maintain',
      'Player/user & design fit: does it fit the existing systems and feel right to use'
    ],
    rounds: 2
  },
  baseUrls: { compatible: 'http://localhost:11434/v1', openrouter: 'https://openrouter.ai/api/v1' },
  catalog: { ...DEFAULT_CATALOG },
  mcpServers: [],
  recentProjects: []
}

/** Encrypts secrets at rest. Electron's safeStorage in the app; a passthrough in tests. */
export interface Cipher {
  encrypt(plain: string): string
  decrypt(blob: string): string
}

/** App-wide settings and API keys, stored under the user-data folder - never inside a project. */
export class AppConfig {
  settings: AppSettings = structuredClone(DEFAULT_SETTINGS)
  private keys: Partial<Record<ProviderKind | string, string>> = {}

  constructor(private readonly dir: string, private readonly cipher: Cipher) {}

  async load(): Promise<void> {
    const saved = await readJson<Partial<AppSettings>>(join(this.dir, 'settings.json'), {})
    this.settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      ...saved,
      council: { ...DEFAULT_SETTINGS.council, ...(saved.council ?? {}) },
      watchdog: { ...DEFAULT_WATCHDOG, ...(saved.watchdog ?? {}) },
      economy: { ...DEFAULT_SETTINGS.economy, ...(saved.economy ?? {}), tiers: { ...DEFAULT_TIERS, ...(saved.economy?.tiers ?? {}) } },
      catalog: { ...DEFAULT_CATALOG, ...(saved.catalog ?? {}) },
      baseUrls: { ...DEFAULT_SETTINGS.baseUrls, ...(saved.baseUrls ?? {}) }
    }
    this.keys = await readJson(join(this.dir, 'keys.json'), {})
  }

  async save(): Promise<void> {
    await writeJson(join(this.dir, 'settings.json'), this.settings)
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.settings = { ...this.settings, ...patch }
    await this.save()
    return this.settings
  }

  getKey(provider: string): string | undefined {
    const blob = this.keys[provider]
    if (!blob) return undefined
    try {
      return this.cipher.decrypt(blob)
    } catch {
      return undefined
    }
  }

  /** Which providers have a key, without revealing any. */
  keyedProviders(): string[] {
    return Object.keys(this.keys).filter((k) => !!this.keys[k])
  }

  async setKey(provider: string, key: string | null): Promise<void> {
    if (key) this.keys[provider] = this.cipher.encrypt(key)
    else delete this.keys[provider]
    await writeJson(join(this.dir, 'keys.json'), this.keys)
  }

  async addRecent(dir: string): Promise<void> {
    this.settings.recentProjects = [dir, ...this.settings.recentProjects.filter((d) => d !== dir)].slice(0, 8)
    await this.save()
  }
}
