import { createServer, type IncomingMessage, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { ToolDef } from '../providers/types'

/** Looks up the tools an agent may call, and what to tell it about them. Returning null refuses the agent. */
export type ToolSource = (agentId: string) => { tools: ToolDef[]; instructions?: string } | null

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      if (!chunks.length) return resolve(undefined)
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

/**
 * The local Multimine MCP server: how CLI agents (Claude Code, Codex) reach the bus. Each agent has
 * its own endpoint, `/mcp/<agentId>?t=<token>`, so a tool call always knows who made it. Stateless:
 * every request builds a fresh server over the same tool handlers. Listens on loopback only.
 */
export class BusServer {
  private server: Server | null = null
  private port = 0
  readonly token = randomBytes(18).toString('hex')

  constructor(private readonly tools: ToolSource) {}

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const m = /^\/mcp\/([a-z0-9-]+)$/.exec(url.pathname)
      if (!m || url.searchParams.get('t') !== this.token) {
        res.writeHead(404).end()
        return
      }
      const found = this.tools(m[1])
      if (!found) {
        res.writeHead(404).end()
        return
      }
      if (req.method !== 'POST') {
        // stateless: no standalone SSE stream and no sessions to delete
        res.writeHead(405, { Allow: 'POST' }).end()
        return
      }
      try {
        const body = await readBody(req)
        const mcp = new McpServer({ name: 'multimine', version: '0.1.0' }, { instructions: found.instructions })
        for (const d of found.tools) {
          mcp.registerTool(d.name, { description: d.description, inputSchema: d.shape }, async (args: any) => {
            try {
              const out = await d.handler(args ?? {})
              return { content: [{ type: 'text' as const, text: out.text }], isError: out.isError }
            } catch (e) {
              return { content: [{ type: 'text' as const, text: String((e as Error).message ?? e) }], isError: true }
            }
          })
        }
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
        res.on('close', () => {
          void transport.close()
          void mcp.close()
        })
        await mcp.connect(transport)
        await transport.handleRequest(req, res, body)
      } catch (e) {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: String((e as Error).message) }, id: null }))
      }
    })
    // tool calls can block for as long as the user takes to answer
    this.server.requestTimeout = 0
    this.server.headersTimeout = 0
    this.server.keepAliveTimeout = 0
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    this.port = (this.server.address() as AddressInfo).port
  }

  url(agentId: string): string {
    return `http://127.0.0.1:${this.port}/mcp/${agentId}?t=${this.token}`
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()))
    this.server = null
  }
}
