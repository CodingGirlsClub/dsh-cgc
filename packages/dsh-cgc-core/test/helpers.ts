/**
 * Shared test fixtures: a real in-process MCP server speaking Streamable
 * HTTP (the SDK's own server side) so engine tests exercise the true client
 * path, plus a cordis context bootstrap and an in-memory settings provider.
 */

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

// ------------------------------------------------------------ mock MCP server

/** One tool the mock server lists. */
export interface MockTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

/** Handler for one tools/call against the mock server. */
export type MockCallHandler = (args: Record<string, unknown>) => {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

export interface MockMcpServer {
  /** The /mcp endpoint URL. */
  url: string
  /** Every tools/call observed, in order (raw names + arguments). */
  calls: Array<{ name: string; arguments: Record<string, unknown> }>
  close(): Promise<void>
}

/** The platform's 8 tools with their documented parameter shapes. */
export const PLATFORM_TOOLS: MockTool[] = [
  { name: 'get_workspace_context', inputSchema: { type: 'object', properties: { workspace_id: { type: 'string' } }, required: ['workspace_id'] } },
  { name: 'list_members', inputSchema: { type: 'object', properties: { workspace_id: { type: 'string' } }, required: ['workspace_id'] } },
  { name: 'get_workflow', inputSchema: { type: 'object', properties: { workspace_id: { type: 'string' }, run_id: { type: 'string' } }, required: ['workspace_id', 'run_id'] } },
  { name: 'get_step_output', inputSchema: { type: 'object', properties: { workspace_id: { type: 'string' }, run_id: { type: 'string' }, step_key: { type: 'string' } }, required: ['workspace_id', 'run_id', 'step_key'] } },
  { name: 'save_step_output', inputSchema: { type: 'object', properties: { workspace_id: { type: 'string' }, run_id: { type: 'string' }, step_key: { type: 'string' }, output: { type: 'object' } }, required: ['workspace_id', 'run_id', 'step_key', 'output'] } },
  { name: 'create_invitation', inputSchema: { type: 'object', properties: { workspace_id: { type: 'string' }, target_email: { type: 'string' }, expires_in_hours: { type: 'integer' } }, required: ['workspace_id'] } },
  { name: 'confirm_operation', inputSchema: { type: 'object', properties: { pending_id: { type: 'string' } }, required: ['pending_id'] } },
  { name: 'cancel_operation', inputSchema: { type: 'object', properties: { pending_id: { type: 'string' } }, required: ['pending_id'] } },
]

/** Default call handler: echoes a canned text result per tool. */
function defaultHandler(name: string): MockCallHandler {
  return () => ({ content: [{ type: 'text', text: `${name} result` }] })
}

/**
 * Start a mock CGC MCP server on 127.0.0.1 with a random port. Stateless
 * mode (the SDK-documented per-request server+transport pattern): every
 * request is independent, so client disconnect/reconnect cycles just work.
 * @param opts - bearer token to enforce (absent/mismatched → 401 like the
 *   platform's mcp_auth_plug), tool list, and per-tool call handlers.
 */
export async function startMockMcp(opts?: {
  token?: string
  tools?: MockTool[]
  handlers?: Record<string, MockCallHandler>
}): Promise<MockMcpServer> {
  const tools = opts?.tools ?? PLATFORM_TOOLS
  const calls: MockMcpServer['calls'] = []

  const httpServer = http.createServer((req, res) => {
    void (async () => {
      if (opts?.token !== undefined && req.headers.authorization !== `Bearer ${opts.token}`) {
        res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="cgc-2046-mcp"' })
        res.end(JSON.stringify({ error: 'invalid_token' }))
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      let body: unknown
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        body = undefined
      }
      // Stateless: one server + transport pair per request (SDK pattern).
      const server = new Server({ name: 'cgc-2046', version: '0.0.0-test' }, { capabilities: { tools: {} } })
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params
        calls.push({ name, arguments: (args ?? {}) as Record<string, unknown> })
        const handler = opts?.handlers?.[name] ?? defaultHandler(name)
        return handler((args ?? {}) as Record<string, unknown>)
      })
      // sessionIdGenerator: undefined selects the SDK's documented stateless
      // mode; its .d.ts lacks `| undefined` under exactOptionalPropertyTypes.
      const stateless = { sessionIdGenerator: undefined } as unknown as { sessionIdGenerator: () => string }
      const transport = new StreamableHTTPServerTransport(stateless)
      res.on('close', () => {
        void transport.close().then(() => server.close()).catch(() => {})
      })
      // The SDK constructed the object, so the cast records only the
      // .d.ts optional-property widening (exactOptionalPropertyTypes).
      await server.connect(transport as Transport)
      await transport.handleRequest(req, res, body)
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })

  const listening = Promise.withResolvers<void>()
  httpServer.once('error', listening.reject)
  httpServer.listen(0, '127.0.0.1', listening.resolve)
  await listening.promise
  const { port } = httpServer.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    async close() {
      const closed = Promise.withResolvers<void>()
      httpServer.close(() => closed.resolve())
      await closed.promise
      httpServer.closeAllConnections()
    },
  }
}

// ------------------------------------------------------------ context bootstrap

/** A context with the real tool runtime mounted (it injects systemPrompt first). */
export async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

// ------------------------------------------------------------ memory settings

/** In-memory settings provider (mirrors dsh-settings' own tests/memory.ts). */
export class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown>

  constructor(ctx: Context, options?: { doc?: Record<string, unknown> }) {
    super(ctx)
    this.doc = structuredClone(options?.doc ?? {})
  }

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns as string] = structuredClone(section)
    return Promise.resolve()
  }
}

/** A context with the in-memory settings provider mounted. */
export async function mountSettings(doc?: Record<string, unknown>): Promise<{ ctx: Context; provider: MemorySettings }> {
  const ctx = new Context()
  await ctx.plugin(MemorySettings, doc === undefined ? undefined : { doc })
  return { ctx, provider: ctx.get('settings') as MemorySettings }
}
