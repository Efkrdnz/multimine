import type { ProviderKind } from '@shared/types'
import { AiSdkProvider } from './aiSdk'
import { ClaudeCliProvider } from './claudeCli'
import { CodexCliProvider } from './codexCli'
import { MockProvider, type MockScript } from './mock'
import type { ProviderAdapter } from './types'

export class ProviderRegistry {
  private readonly api = new AiSdkProvider()
  private readonly claude = new ClaudeCliProvider()
  private readonly codex = new CodexCliProvider()
  mock: ProviderAdapter

  constructor(
    mockScript?: MockScript,
    mockDelayMs?: number,
    /** Stand-ins for real providers (tests drive fallbacks across provider kinds with these). */
    private readonly overrides: Partial<Record<ProviderKind, ProviderAdapter>> = {}
  ) {
    this.mock = new MockProvider(mockScript, mockDelayMs)
  }

  get(kind: ProviderKind): ProviderAdapter {
    const o = this.overrides[kind]
    if (o) return o
    if (kind === 'mock') return this.mock
    if (kind === 'claude-cli') return this.claude
    if (kind === 'codex-cli') return this.codex
    return this.api
  }

  /** CLI kinds talk to the bus over MCP; the others get the tools in-process. */
  static isCli(kind: ProviderKind): boolean {
    return kind === 'claude-cli' || kind === 'codex-cli'
  }
}
