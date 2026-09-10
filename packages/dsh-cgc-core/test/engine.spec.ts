/**
 * Engine tests: the CGC MCP bridge against a real in-process MCP server —
 * connect registers whatever tools/list returns under mcp__cgc-2046__*,
 * calls round-trip, teardown unregisters, and failures land in the
 * activity ring with coded, redacted messages.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { ActivityLog } from '../src/activity.ts'
import { CgcEngine } from '../src/engine.ts'
import {
  CGC_MCP_AUTH,
  CGC_MCP_BUSINESS,
  CGC_MCP_CONNECTION,
  CGC_MCP_TIMEOUT,
  CGC_TOOL_PREFIX,
} from '../src/protocol.ts'
import { classifyBridgeError, publicToolName } from '../src/tools.ts'
import { mountRegistry, PLATFORM_TOOLS, startMockMcp, type MockMcpServer } from './helpers.ts'

const testSignal = new AbortController().signal
const TOKEN = 'cgc_' + 'a'.repeat(43)

describe('publicToolName', () => {
  it('joins clean names verbatim', () => {
    expect(publicToolName('cgc-2046', 'get_workspace_context')).toBe('mcp__cgc-2046__get_workspace_context')
    expect(publicToolName('cgc-2046', 'confirm_operation')).toBe('mcp__cgc-2046__confirm_operation')
  })

  it('replaces invalid characters and appends an identity hash', () => {
    const name = publicToolName('cgc-2046', 'admin.reset')
    expect(name).toMatch(/^mcp__cgc-2046__admin_reset_[0-9a-f]{12}$/)
    expect(name.length).toBeLessThanOrEqual(64)
  })

  it('truncates over-long names and appends an identity hash', () => {
    const name = publicToolName('cgc-2046', 'a'.repeat(80))
    expect(name).toHaveLength(64)
    expect(name).toMatch(/_[0-9a-f]{12}$/)
  })

  it('is deterministic and collision-free for distinct identities', () => {
    const a = publicToolName('cgc-2046', 'admin.reset')
    const b = publicToolName('cgc-2046', 'admin_reset')
    expect(a).toBe(publicToolName('cgc-2046', 'admin.reset'))
    expect(a).not.toBe(b)
  })
})

describe('classifyBridgeError', () => {
  it('maps HTTP 401/403 to CGC_MCP_AUTH', () => {
    const error = Object.assign(new Error('Streamable HTTP error: Error POSTing to endpoint: {"error":"invalid_token"}'), { name: 'StreamableHTTPError', code: 401 })
    expect(classifyBridgeError(error, 'connect').code).toBe(CGC_MCP_AUTH)
    const forbidden = Object.assign(new Error('forbidden'), { name: 'StreamableHTTPError', code: 403 })
    expect(classifyBridgeError(forbidden, 'connect').code).toBe(CGC_MCP_AUTH)
  })

  it('maps other HTTP statuses to CGC_MCP_CONNECTION', () => {
    const error = Object.assign(new Error('Streamable HTTP error: 500'), { name: 'StreamableHTTPError', code: 500 })
    expect(classifyBridgeError(error, 'connect').code).toBe(CGC_MCP_CONNECTION)
  })

  it('maps MCP request timeouts to CGC_MCP_TIMEOUT and other MCP errors to CGC_MCP_BUSINESS', () => {
    const timeout = Object.assign(new Error('MCP error -32001: Request timed out'), { name: 'McpError', code: -32001 })
    expect(classifyBridgeError(timeout, 'get_workflow').code).toBe(CGC_MCP_TIMEOUT)
    const other = Object.assign(new Error('MCP error -32602: Invalid params'), { name: 'McpError', code: -32602 })
    expect(classifyBridgeError(other, 'get_workflow').code).toBe(CGC_MCP_BUSINESS)
  })

  it('maps network failures to CGC_MCP_CONNECTION', () => {
    const error = new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })
    expect(classifyBridgeError(error, 'connect').code).toBe(CGC_MCP_CONNECTION)
  })

  it('rethrows caller cancellation untouched', () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
    expect(() => classifyBridgeError(abort, 'get_workflow')).toThrow(abort)
  })

  it('redacts credential shapes in classified messages', () => {
    const error = Object.assign(new Error(`upstream said: Authorization: Bearer ${TOKEN}`), { name: 'StreamableHTTPError', code: 500 })
    const classified = classifyBridgeError(error, 'connect')
    expect(classified.message).not.toContain(TOKEN)
    expect(classified.message).toContain('[REDACTED]')
  })
})

describe('CgcEngine', () => {
  let servers: MockMcpServer[] = []
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close()
  })

  it('connects and registers every listed tool under mcp__cgc-2046__*', async () => {
    const server = await startMockMcp({ token: TOKEN })
    servers.push(server)
    const ctx = await mountRegistry()
    const engine = new CgcEngine(ctx, new ActivityLog())

    await engine.sync({ url: server.url, token: TOKEN })

    expect(engine.connected).toBe(true)
    expect(engine.toolNames).toHaveLength(PLATFORM_TOOLS.length)
    expect(ctx.tools.get('mcp__cgc-2046__get_workspace_context')).toBeDefined()
    expect(ctx.tools.get('mcp__cgc-2046__confirm_operation')).toBeDefined()
    for (const name of engine.toolNames) expect(name.startsWith(CGC_TOOL_PREFIX)).toBe(true)
    await engine.dispose()
  })

  it('round-trips a tool call with raw wire name and arguments', async () => {
    const server = await startMockMcp({ token: TOKEN })
    servers.push(server)
    const ctx = await mountRegistry()
    const engine = new CgcEngine(ctx, new ActivityLog())
    await engine.sync({ url: server.url, token: TOKEN })

    const result = await ctx.tools.execute({
      signal: testSignal,
      callId: ToolCallId('c1'),
      name: 'mcp__cgc-2046__get_workspace_context',
      arguments: { workspace_id: 'ws-1' },
    })

    expect(result.isError).toBe(false)
    expect(server.calls).toEqual([{ name: 'get_workspace_context', arguments: { workspace_id: 'ws-1' } }])
    const text = result.content.map(b => (b.type === 'text' ? b.text : '')).join('')
    expect(text).toContain('get_workspace_context result')
    await engine.dispose()
  })

  it('callTool round-trips the raw record for the data-plane routes', async () => {
    const server = await startMockMcp({ token: TOKEN })
    servers.push(server)
    const ctx = await mountRegistry()
    const engine = new CgcEngine(ctx, new ActivityLog())
    await engine.sync({ url: server.url, token: TOKEN })

    const result = await engine.callTool('get_workspace_context', { workspace_id: 'ws-9' }) as Record<string, unknown>

    expect(server.calls).toEqual([{ name: 'get_workspace_context', arguments: { workspace_id: 'ws-9' } }])
    expect(JSON.stringify(result)).toContain('get_workspace_context result')
    await engine.dispose()
  })

  it('callTool fails closed with CGC_MCP_CONNECTION while disconnected', async () => {
    const ctx = await mountRegistry()
    const engine = new CgcEngine(ctx, new ActivityLog())

    await expect(engine.callTool('get_workspace_context', {})).rejects.toMatchObject({ code: CGC_MCP_CONNECTION })
    await engine.dispose()
  })

  it('carries the two-tool confirmation flow payloads through as-is', async () => {
    const server = await startMockMcp({
      token: TOKEN,
      handlers: {
        create_invitation: () => ({
          content: [{ type: 'text', text: JSON.stringify({ status: 'needs_confirmation', pending_id: 'p-1', summary: 'invite a@b.c' }) }],
        }),
      },
    })
    servers.push(server)
    const ctx = await mountRegistry()
    const engine = new CgcEngine(ctx, new ActivityLog())
    await engine.sync({ url: server.url, token: TOKEN })

    const result = await ctx.tools.execute({
      signal: testSignal,
      callId: ToolCallId('c2'),
      name: 'mcp__cgc-2046__create_invitation',
      arguments: { workspace_id: 'ws-1', target_email: 'a@b.c' },
    })
    expect(result.isError).toBe(false)
    const text = result.content.map(b => (b.type === 'text' ? b.text : '')).join('')
    expect(JSON.parse(text)).toMatchObject({ status: 'needs_confirmation', pending_id: 'p-1' })
    await engine.dispose()
  })

  it('unregisters every tool on disconnect', async () => {
    const server = await startMockMcp({ token: TOKEN })
    servers.push(server)
    const ctx = await mountRegistry()
    const engine = new CgcEngine(ctx, new ActivityLog())
    await engine.sync({ url: server.url, token: TOKEN })
    expect(engine.toolNames).toHaveLength(PLATFORM_TOOLS.length)

    await engine.sync(undefined)

    expect(engine.connected).toBe(false)
    expect(engine.toolNames).toHaveLength(0)
    expect(ctx.tools.get('mcp__cgc-2046__get_workspace_context')).toBeUndefined()
  })

  it('records CGC_MCP_AUTH and registers nothing on a 401 (revoked/invalid token)', async () => {
    const server = await startMockMcp({ token: 'cgc_' + 'b'.repeat(43) })
    servers.push(server)
    const ctx = await mountRegistry()
    const activity = new ActivityLog()
    const engine = new CgcEngine(ctx, activity)

    await engine.sync({ url: server.url, token: TOKEN })

    expect(engine.connected).toBe(false)
    expect(engine.toolNames).toHaveLength(0)
    const entries = activity.list()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'error', source: 'connect', code: CGC_MCP_AUTH })
    expect(entries[0]?.message ?? '').not.toContain(TOKEN)
  })

  it('records CGC_MCP_CONNECTION when the server is unreachable (boot with dead server)', async () => {
    const server = await startMockMcp({ token: TOKEN })
    const deadUrl = server.url
    await server.close()
    const ctx = await mountRegistry()
    const activity = new ActivityLog()
    const engine = new CgcEngine(ctx, activity)

    await engine.sync({ url: deadUrl, token: TOKEN })

    expect(engine.connected).toBe(false)
    expect(engine.toolNames).toHaveLength(0)
    expect(activity.list()[0]).toMatchObject({ kind: 'error', source: 'connect', code: CGC_MCP_CONNECTION })
  })

  it('maps a server isError result to a CGC_MCP_BUSINESS tool failure', async () => {
    const server = await startMockMcp({
      token: TOKEN,
      handlers: {
        confirm_operation: () => ({ content: [{ type: 'text', text: 'pending operation expired' }], isError: true }),
      },
    })
    servers.push(server)
    const ctx = await mountRegistry()
    const engine = new CgcEngine(ctx, new ActivityLog())
    await engine.sync({ url: server.url, token: TOKEN })

    const result = await ctx.tools.execute({
      signal: testSignal,
      callId: ToolCallId('c3'),
      name: 'mcp__cgc-2046__confirm_operation',
      arguments: { pending_id: 'p-stale' },
    })

    expect(result.isError).toBe(true)
    if (result.isError) {
      expect(result.error.info?.code).toBe(CGC_MCP_BUSINESS)
      expect(result.error.message).toContain('pending operation expired')
    }
    await engine.dispose()
  })

  it('boot-restores: a second engine generation reconnects after teardown', async () => {
    const server = await startMockMcp({ token: TOKEN })
    servers.push(server)
    const ctx = await mountRegistry()
    const engine = new CgcEngine(ctx, new ActivityLog())
    await engine.sync({ url: server.url, token: TOKEN })
    await engine.sync(undefined)
    await engine.sync({ url: server.url, token: TOKEN })
    expect(engine.connected).toBe(true)
    expect(engine.toolNames).toHaveLength(PLATFORM_TOOLS.length)
    await engine.dispose()
  })

  it('reports clientInfo.name "dsh" at initialize (KTD1 attribution)', async () => {
    const server = await startMockMcp({ token: TOKEN })
    servers.push(server)
    const ctx = await mountRegistry()
    const engine = new CgcEngine(ctx, new ActivityLog())

    await engine.sync({ url: server.url, token: TOKEN })

    expect(engine.connected).toBe(true)
    expect(server.clientInfos.length).toBeGreaterThan(0)
    for (const info of server.clientInfos) expect(info.name).toBe('dsh')
    await engine.dispose()
  })

  it('registers exactly the tools/list set — N in, N out, schemas passed through (drift-immune parity)', async () => {
    // A hypothetical future confirmation-flow tool the fixture predates.
    const futureTool = {
      name: 'purge_workspace',
      inputSchema: { type: 'object', properties: { workspace_id: { type: 'string' }, reason: { type: 'string' } }, required: ['workspace_id', 'reason'] },
    }
    const tools = [...PLATFORM_TOOLS, futureTool]
    const server = await startMockMcp({ token: TOKEN, tools })
    servers.push(server)
    const ctx = await mountRegistry()
    const engine = new CgcEngine(ctx, new ActivityLog())

    await engine.sync({ url: server.url, token: TOKEN })

    expect(engine.toolNames).toHaveLength(tools.length)
    expect(engine.toolNames.every(name => name.startsWith(CGC_TOOL_PREFIX))).toBe(true)
    for (const tool of tools) {
      const registered = ctx.tools.get(`${CGC_TOOL_PREFIX}${tool.name}`)
      expect(registered, tool.name).toBeDefined()
      expect(registered?.parameters).toEqual(tool.inputSchema)
    }
    await engine.dispose()
  })

  it('strips the live token literal from tool error text even off-shape (RSK6)', async () => {
    // A token format the shape regexes do not match: only the literal pass catches it.
    const weirdToken = 'cgc2!rotated-format.not-base64url'
    const server = await startMockMcp({
      token: weirdToken,
      handlers: {
        waive_payment: () => ({
          content: [{ type: 'text', text: `upstream 401 while presenting ${weirdToken}` }],
          isError: true,
        }),
      },
    })
    servers.push(server)
    const ctx = await mountRegistry()
    const engine = new CgcEngine(ctx, new ActivityLog())
    await engine.sync({ url: server.url, token: weirdToken })

    const result = await ctx.tools.execute({
      signal: testSignal,
      callId: ToolCallId('c4'),
      name: 'mcp__cgc-2046__waive_payment',
      arguments: { workspace_id: 'ws-1', enrollment_id: 'e-1' },
    })

    expect(result.isError).toBe(true)
    if (result.isError) {
      expect(result.error.message).not.toContain(weirdToken)
      expect(result.error.message).toContain('[REDACTED]')
    }
    await engine.dispose()
  })
})
