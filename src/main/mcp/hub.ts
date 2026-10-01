import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpServerConfig } from '@shared/types'
import type { ToolDef, ToolOutput } from '../providers/types'

export interface ToolInfo {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

/** Somewhere to put an image/audio block an MCP tool returned. Returns a line to show the model instead. */
export type BlobSink = (data: string, mime: string, source: string) => Promise<string>

/**
 * Clients for the user's external MCP servers (Higgsfield, Meshy, WaveSpeed, anything). CLI agents
 * get the server config itself; API agents get the tools proxied through here.
 */
export class McpHub {
  private clients = new Map<string, Promise<{ client: Client; tools: ToolInfo[] }>>()

  private async connect(cfg: McpServerConfig): Promise<{ client: Client; tools: ToolInfo[] }> {
    const client = new Client({ name: 'multimine', version: '0.1.0' })
    const transport =
      cfg.transport === 'http'
        ? new StreamableHTTPClientTransport(new URL(cfg.url ?? ''), { requestInit: { headers: cfg.headers ?? {} } })
        : new StdioClientTransport({
            command: cfg.command ?? '',
            args: cfg.args ?? [],
            env: { ...(process.env as Record<string, string>), ...(cfg.env ?? {}) }
          })
    await client.connect(transport)
    const listed = await client.listTools()
    return { client, tools: listed.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> })) }
  }

  private get(cfg: McpServerConfig) {
    let p = this.clients.get(cfg.id)
    if (!p) {
      p = this.connect(cfg)
      this.clients.set(cfg.id, p)
      p.catch(() => this.clients.delete(cfg.id))
    }
    return p
  }

  /** Connects (fresh) and lists the tools: the "Test" button in Settings. */
  async test(cfg: McpServerConfig): Promise<ToolInfo[]> {
    await this.drop(cfg.id)
    return (await this.get(cfg)).tools
  }

  async drop(id: string): Promise<void> {
    const p = this.clients.get(id)
    this.clients.delete(id)
    if (p) await p.then((c) => c.client.close()).catch(() => undefined)
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.clients.keys()].map((id) => this.drop(id)))
  }

  /** The server's tools as ToolDefs, named `<server>__<tool>` so two servers never collide. */
  async toolDefs(cfg: McpServerConfig, sink: BlobSink): Promise<ToolDef[]> {
    const { client, tools } = await this.get(cfg)
    const prefix = cfg.id.replace(/[^a-zA-Z0-9_]/g, '_')
    return tools.map((t) => ({
      name: `${prefix}__${t.name}`.slice(0, 64),
      description: `[${cfg.name}] ${t.description ?? t.name}`,
      shape: {},
      jsonSchema: t.inputSchema,
      handler: async (args): Promise<ToolOutput> => {
        const res = (await client.callTool({ name: t.name, arguments: args })) as any
        const parts: string[] = []
        for (const c of res.content ?? []) {
          if (c.type === 'text') parts.push(c.text)
          else if ((c.type === 'image' || c.type === 'audio') && c.data) parts.push(await sink(c.data, c.mimeType, `${cfg.name}.${t.name}`))
          else if (c.type === 'resource_link' || c.type === 'resource') parts.push(c.uri ?? c.resource?.uri ?? JSON.stringify(c))
          else parts.push(JSON.stringify(c))
        }
        if (res.structuredContent && !parts.length) parts.push(JSON.stringify(res.structuredContent))
        return { text: parts.join('\n') || '(no output)', isError: !!res.isError }
      }
    }))
  }
}
