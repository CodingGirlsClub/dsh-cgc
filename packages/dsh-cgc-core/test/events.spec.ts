/**
 * Event-channel tests (U7 / KTD8 / R13 / RSK3 / AE7): the aggregator's
 * exactly-once dedupe across the dual sources, the bounded seq ring with
 * gap indication, the WS push wire, the afterSeq polling fallback, and the
 * shared fence on both endpoints — all with redacted payloads.
 */

import { randomBytes } from 'node:crypto'
import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId, HarnessError } from '@deepseek-ai/dsh-llm'
import type { Duplex } from 'node:stream'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { ActivityLog } from '../src/activity.ts'
import { CgcEventHub, installSessionEventSource, type CgcEvent, type CgcEventsPage } from '../src/events.ts'
import { installErrorHook } from '../src/hooks.ts'
import { CGC_API_BASE, CGC_MCP_AUTH, CGC_MCP_BUSINESS } from '../src/protocol.ts'
import { eventRoutes, makeEventUpgradeHandler } from '../src/routes/events.ts'
import { mountRegistry } from './helpers.ts'

const TOKEN = 'cgc_' + 'a'.repeat(43)
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gVSFOEjEmk'
const EVENTS_PATH = CGC_API_BASE + '/events'
const SIGNAL = new AbortController().signal

function sleep(ms: number): Promise<void> {
  const nap = Promise.withResolvers<void>()
  setTimeout(nap.resolve, ms)
  return nap.promise
}

// ------------------------------------------------------------ HTTP + WS harness

interface Harness {
  base: string
  port: number
  close: () => Promise<void>
}

/** Serve the polling route and the WS upgrade handler on one real server. */
async function serve(hub: CgcEventHub, secrets: () => readonly string[] = () => [TOKEN]): Promise<Harness> {
  const routes = eventRoutes(hub, CGC_API_BASE, secrets)
  const upgrade = makeEventUpgradeHandler(hub, secrets)
  const upgraded = new Set<Duplex>()
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    const route = routes.find(r => r.kind === 'exact' && r.path === pathname)
    if (route === undefined) {
      res.writeHead(404).end()
      return
    }
    void route.handler(req, res)
  })
  server.on('upgrade', (req, socket, head) => {
    upgraded.add(socket)
    socket.on('close', () => { upgraded.delete(socket) })
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    if (pathname === EVENTS_PATH) {
      upgrade(req, socket, head)
      return
    }
    socket.destroy()
  })
  const listening = Promise.withResolvers<void>()
  server.once('error', listening.reject)
  server.listen(0, '127.0.0.1', listening.resolve)
  await listening.promise
  const { port } = server.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    async close() {
      // Upgraded sockets are not tracked by close(); destroy them first.
      for (const socket of upgraded) socket.destroy()
      const closed = Promise.withResolvers<void>()
      server.close(() => closed.resolve())
      server.closeAllConnections()
      await closed.promise
    },
  }
}

interface WsClient {
  statusLine: string
  frames: Array<Record<string, unknown>>
  close: () => void
}

/** Minimal raw-socket WS client: handshake, then parse unmasked server text frames. */
async function wsConnect(port: number, opts?: { origin?: string; omitKey?: boolean }): Promise<WsClient> {
  const socket = net.connect(port, '127.0.0.1')
  socket.on('error', () => {})
  const connected = Promise.withResolvers<void>()
  socket.once('connect', connected.resolve)
  await connected.promise
  const headers = [
    `GET ${EVENTS_PATH} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    ...opts?.omitKey === true ? [] : [`Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`],
    'Sec-WebSocket-Version: 13',
    ...opts?.origin === undefined ? [] : [`Origin: ${opts.origin}`],
    '',
    '',
  ]
  socket.write(headers.join('\r\n'))
  const client: WsClient = { statusLine: '', frames: [], close: () => socket.destroy() }
  let raw: Buffer = Buffer.alloc(0)
  let headless = false
  socket.on('data', (chunk: Buffer) => {
    raw = raw.length === 0 ? chunk : Buffer.concat([raw, chunk])
    if (!headless) {
      const boundary = raw.indexOf('\r\n\r\n')
      if (boundary === -1) return
      client.statusLine = raw.subarray(0, boundary).toString('utf8').split('\r\n')[0] ?? ''
      raw = raw.subarray(boundary + 4)
      headless = true
    }
    for (;;) {
      if (raw.length < 2) break
      let length = raw[1]! & 0x7f
      let offset = 2
      if (length === 126) {
        if (raw.length < 4) break
        length = raw.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (raw.length < 10) break
        length = Number(raw.readBigUInt64BE(2))
        offset = 10
      }
      if (raw.length < offset + length) break
      const opcode = raw[0]! & 0x0f
      const payload = raw.subarray(offset, offset + length)
      raw = raw.subarray(offset + length)
      if (opcode === 0x1) client.frames.push(JSON.parse(payload.toString('utf8')) as Record<string, unknown>)
    }
  })
  return client
}

/** Poll until the predicate holds or the deadline passes. */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(10)
  }
}

// ------------------------------------------------------------ registry-driven hook + session source

/** Register one CGC-namespaced tool with the given behaviour. */
function registerCgcTool(ctx: Context, rawName: string, execute: () => Promise<JsonValue>): void {
  ctx.tools.register(defineTool({
    name: `mcp__cgc-2046__${rawName}`,
    description: 'test double',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    execute,
  }))
}

/** Emit one session tool/call + tool/result pair (the KTD8 second source). */
function emitSessionPair(ctx: Context, callId: string, name: string, opts?: { isError?: boolean; text?: string; code?: string }): void {
  ctx.emit('session/event', {}, { type: 'tool/call', data: { callId, name, arguments: '{}' } })
  ctx.emit('session/event', {}, {
    type: 'tool/result',
    data: {
      message: {
        content: [{
          toolCallId: callId,
          isError: opts?.isError ?? false,
          content: opts?.text === undefined ? [] : [{ type: 'text', text: opts.text }],
        }],
      },
      ...opts?.code === undefined ? {} : { error: { name: 'HarnessError', code: opts.code } },
    },
  })
}

describe('event channel (U7)', () => {
  let cleanups: Array<() => Promise<void> | void> = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup()
  })

  // -- Aggregator: dedupe, seq ring, feed mirror.

  it('one call produces exactly one event across the dual sources (exactly-once, both orders)', async () => {
    const ctx = await mountRegistry()
    cleanups.push(async () => { await ctx.fiber.dispose() })
    const activity = new ActivityLog()
    const hub = new CgcEventHub(activity, () => [TOKEN])
    installErrorHook(ctx, activity, () => [TOKEN], hub)
    installSessionEventSource(ctx, hub)
    const frames: CgcEvent[] = []
    hub.subscribe(event => { frames.push(event) })
    registerCgcTool(ctx, 'create_invitation', async () => ({ status: 'created' }))

    // post-execute first (the normal order), session twin second.
    const result = await ctx.tools.execute({
      signal: SIGNAL, callId: ToolCallId('call-1'), name: 'mcp__cgc-2046__create_invitation', arguments: { workspace_id: 'w-1' },
    })
    expect(result.isError).toBe(false)
    emitSessionPair(ctx, 'call-1', 'mcp__cgc-2046__create_invitation')

    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ seq: 1, tool: 'mcp__cgc-2046__create_invitation', ok: true, summary: 'ok', workspaceId: 'w-1' })
    // Exactly one ActivityLog record — the hub owns the feed mirror.
    expect(activity.list()).toHaveLength(1)
    expect(activity.list()[0]).toMatchObject({ kind: 'write', tool: 'mcp__cgc-2046__create_invitation', workspaceId: 'w-1' })
    expect(hub.since(0).events).toHaveLength(1)

    // session first, post-execute twin second (pipeline-failure order).
    emitSessionPair(ctx, 'call-2', 'mcp__cgc-2046__create_invitation')
    await ctx.tools.execute({
      signal: SIGNAL, callId: ToolCallId('call-2'), name: 'mcp__cgc-2046__create_invitation', arguments: { workspace_id: 'w-2' },
    })
    expect(frames).toHaveLength(2)
    expect(activity.list()).toHaveLength(2)
    expect(hub.since(0).events.map(e => e.seq)).toEqual([1, 2])
  })

  it('observes business failures and reads as events without touching the activity feed', async () => {
    const ctx = await mountRegistry()
    cleanups.push(async () => { await ctx.fiber.dispose() })
    const activity = new ActivityLog()
    const hub = new CgcEventHub(activity, () => [TOKEN])
    installErrorHook(ctx, activity, () => [TOKEN], hub)
    registerCgcTool(ctx, 'get_workspace_context', async () => {
      throw new HarnessError('workspace not found', CGC_MCP_BUSINESS)
    })
    registerCgcTool(ctx, 'get_workflow', async () => ({ ok: true }))

    await ctx.tools.execute({ signal: SIGNAL, callId: ToolCallId('b1'), name: 'mcp__cgc-2046__get_workspace_context', arguments: {} })
    await ctx.tools.execute({ signal: SIGNAL, callId: ToolCallId('r1'), name: 'mcp__cgc-2046__get_workflow', arguments: {} })

    const events = hub.since(0)
    expect(events.events.map(e => [e.tool, e.ok])).toEqual([
      ['mcp__cgc-2046__get_workspace_context', false],
      ['mcp__cgc-2046__get_workflow', true],
    ])
    // R9 scope holds: business failures and plain reads stay out of the feed.
    expect(activity.list()).toHaveLength(0)
  })

  it('backfills three disconnect-window calls exactly once each, seq-ordered', async () => {
    const ctx = await mountRegistry()
    cleanups.push(async () => { await ctx.fiber.dispose() })
    const activity = new ActivityLog()
    const hub = new CgcEventHub(activity, () => [TOKEN])
    installSessionEventSource(ctx, hub)
    // No subscriber attached: the "disconnected" window.
    for (const [index, id] of ['d1', 'd2', 'd3'].entries()) {
      emitSessionPair(ctx, id, 'mcp__cgc-2046__get_workflow')
      hub.observe({ callId: id, tool: 'mcp__cgc-2046__get_workflow', ok: true }) // post-execute twin — deduped
      expect(hub.latestSeq).toBe(index + 1)
    }
    const page = hub.since(0)
    expect(page.gap).toBe(false)
    expect(page.events.map(e => e.seq)).toEqual([1, 2, 3])
    expect(page.latestSeq).toBe(3)
    expect(activity.list()).toHaveLength(0) // reads are not feed-worthy
  })

  it('signals a gap when afterSeq fell out of the retained window; full-refetch recovery resumes', () => {
    const activity = new ActivityLog()
    const hub = new CgcEventHub(activity, () => [], 3)
    for (const id of ['g1', 'g2', 'g3', 'g4', 'g5']) {
      hub.observe({ callId: id, tool: 'mcp__cgc-2046__get_workflow', ok: true })
    }
    // Retained window: seq 3..5. afterSeq=2 is the newest safe cursor.
    const safe = hub.since(2)
    expect(safe.gap).toBe(false)
    expect(safe.events.map(e => e.seq)).toEqual([3, 4, 5])
    // afterSeq=1 predates the oldest retained seq: gap.
    const gap = hub.since(1)
    expect(gap.gap).toBe(true)
    expect(gap.oldestSeq).toBe(3)
    expect(gap.latestSeq).toBe(5)
    expect(gap.events.map(e => e.seq)).toEqual([3, 4, 5])
    // Recovery: the panel drops its cursor, full-refetches via the U6 data
    // routes, and resumes from latestSeq.
    hub.observe({ callId: 'g6', tool: 'mcp__cgc-2046__get_workflow', ok: true })
    const resumed = hub.since(gap.latestSeq)
    expect(resumed.gap).toBe(false)
    expect(resumed.events.map(e => e.seq)).toEqual([6])
    expect(resumed.latestSeq).toBe(6)
  })

  it('redacts all three credential forms from failure summaries (AE7)', () => {
    const activity = new ActivityLog()
    const hub = new CgcEventHub(activity, () => [TOKEN])
    // TOKEN hits the literal-first pass; the other three hit the shape pass.
    const otherToken = 'cgc_' + 'b'.repeat(43)
    const message = `auth failed for ${TOKEN} with Bearer abc.def.ghi, ${otherToken} and ${JWT}`
    hub.observe({ callId: 'e1', tool: 'mcp__cgc-2046__save_step_output', ok: false, code: CGC_MCP_AUTH, message })
    const event = hub.since(0).events[0]!
    expect(event.ok).toBe(false)
    expect(event.code).toBe(CGC_MCP_AUTH)
    for (const surface of [JSON.stringify(event), JSON.stringify(activity.list())]) {
      expect(surface).not.toContain(TOKEN)
      expect(surface).not.toContain(otherToken)
      expect(surface).not.toContain('abc.def.ghi')
      expect(surface).not.toContain(JWT)
    }
    expect(event.summary).toContain('cgc_[REDACTED]')
    expect(event.summary).toContain('Bearer [REDACTED]')
  })

  // -- Polling route (the WS fallback).

  it('polling returns the afterSeq increment inside the envelope', async () => {
    const activity = new ActivityLog()
    const hub = new CgcEventHub(activity, () => [TOKEN])
    const http_ = await serve(hub)
    cleanups.push(http_.close)
    for (const id of ['p1', 'p2', 'p3']) {
      hub.observe({ callId: id, tool: 'mcp__cgc-2046__get_workflow', ok: true })
    }
    const body = await (await fetch(`${http_.base}${EVENTS_PATH}?afterSeq=1`)).json() as { ok: true; value: CgcEventsPage }
    expect(body.ok).toBe(true)
    expect(body.value.gap).toBe(false)
    expect(body.value.events.map(e => e.seq)).toEqual([2, 3])
    expect(body.value.latestSeq).toBe(3)
    // A missing cursor reads as 0: the whole retained window.
    const full = await (await fetch(`${http_.base}${EVENTS_PATH}`)).json() as { ok: true; value: CgcEventsPage }
    expect(full.value.events.map(e => e.seq)).toEqual([1, 2, 3])
  })

  it('polling reports the gap over the wire', async () => {
    const activity = new ActivityLog()
    const hub = new CgcEventHub(activity, () => [TOKEN], 2)
    const http_ = await serve(hub)
    cleanups.push(http_.close)
    for (const id of ['q1', 'q2', 'q3', 'q4']) {
      hub.observe({ callId: id, tool: 'mcp__cgc-2046__get_workflow', ok: true })
    }
    // Retained window: seq 3..4; the cursor 1 predates it.
    const body = await (await fetch(`${http_.base}${EVENTS_PATH}?afterSeq=1`)).json() as { ok: true; value: CgcEventsPage }
    expect(body.value.gap).toBe(true)
    expect(body.value.oldestSeq).toBe(3)
    expect(body.value.latestSeq).toBe(4)
    expect(body.value.events.map(e => e.seq)).toEqual([3, 4])
  })

  it('polling validates method and cursor', async () => {
    const activity = new ActivityLog()
    const hub = new CgcEventHub(activity, () => [TOKEN])
    const http_ = await serve(hub)
    cleanups.push(http_.close)
    const post = await fetch(`${http_.base}${EVENTS_PATH}`, { method: 'POST' })
    expect(post.status).toBe(405)
    expect(await post.json()).toMatchObject({ ok: false, error: { code: 'method_not_allowed' } })
    const bad = await fetch(`${http_.base}${EVENTS_PATH}?afterSeq=abc`)
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ ok: false, error: { code: 'bad_request' } })
  })

  it('polling stays behind the shared fence (cross-site marker and non-loopback peer 403)', async () => {
    const activity = new ActivityLog()
    const hub = new CgcEventHub(activity, () => [TOKEN])
    const http_ = await serve(hub)
    cleanups.push(http_.close)
    const crossSite = await fetch(`${http_.base}${EVENTS_PATH}?afterSeq=0`, { headers: { 'sec-fetch-site': 'cross-site' } })
    expect(crossSite.status).toBe(403)
    // A non-loopback TCP peer never reaches the pipeline.
    const routes = eventRoutes(hub, CGC_API_BASE, () => [TOKEN])
    const req = {
      method: 'GET',
      url: `${EVENTS_PATH}?afterSeq=0`,
      socket: { remoteAddress: '192.168.1.5' },
      headers: { host: '127.0.0.1:8080' },
    } as unknown as IncomingMessage
    let status = 0
    const res = {
      writeHead(code: number) { status = code; return this },
      end() { return this },
    } as unknown as ServerResponse
    await routes[0]!.handler(req, res)
    expect(status).toBe(403)
  })

  // -- WS push endpoint.

  it('accepts a loopback handshake and pushes redacted event frames', async () => {
    const activity = new ActivityLog()
    const hub = new CgcEventHub(activity, () => [TOKEN])
    const http_ = await serve(hub)
    cleanups.push(http_.close)
    const ws = await wsConnect(http_.port, { origin: `http://127.0.0.1:${http_.port}` })
    cleanups.push(ws.close)
    await waitFor(() => ws.statusLine !== '', 'handshake response')
    expect(ws.statusLine).toBe('HTTP/1.1 101 Switching Protocols')
    await waitFor(() => ws.frames.length >= 1, 'hello frame')
    expect(ws.frames[0]).toEqual({ type: 'hello', latestSeq: 0 })

    hub.observe({ callId: 'w1', tool: 'mcp__cgc-2046__save_step_output', ok: false, code: CGC_MCP_AUTH, message: `denied for Bearer ${TOKEN}` })
    await waitFor(() => ws.frames.length >= 2, 'event frame')
    expect(ws.frames).toHaveLength(2) // hello + exactly one event frame
    const frame = ws.frames[1]!
    expect(frame.type).toBe('event')
    expect(frame.event).toMatchObject({ seq: 1, tool: 'mcp__cgc-2046__save_step_output', ok: false, code: CGC_MCP_AUTH })
    expect(JSON.stringify(frame)).not.toContain(TOKEN)
    expect(JSON.stringify(frame)).toContain('Bearer [REDACTED]')

    // A disconnected subscriber no longer receives frames.
    ws.close()
    await sleep(50) // let the close propagate and unsubscribe
    hub.observe({ callId: 'w2', tool: 'mcp__cgc-2046__get_workflow', ok: true })
    await sleep(50)
    expect(ws.frames).toHaveLength(2)
    // The ring kept both events for polling catch-up.
    expect(hub.since(0).events.map(e => e.seq)).toEqual([1, 2])
  })

  it('rejects a cross-site Origin handshake before negotiation (RSK3)', async () => {
    const activity = new ActivityLog()
    const hub = new CgcEventHub(activity, () => [TOKEN])
    const http_ = await serve(hub)
    cleanups.push(http_.close)
    const ws = await wsConnect(http_.port, { origin: 'http://evil.example.com' })
    cleanups.push(ws.close)
    await waitFor(() => ws.statusLine !== '', 'handshake rejection')
    expect(ws.statusLine).toBe('HTTP/1.1 403 Forbidden')
    expect(ws.frames).toHaveLength(0)
  })

  it('rejects a malformed handshake (no Sec-WebSocket-Key)', async () => {
    const activity = new ActivityLog()
    const hub = new CgcEventHub(activity, () => [TOKEN])
    const http_ = await serve(hub)
    cleanups.push(http_.close)
    const ws = await wsConnect(http_.port, { omitKey: true })
    cleanups.push(ws.close)
    await waitFor(() => ws.statusLine !== '', 'handshake rejection')
    expect(ws.statusLine).toBe('HTTP/1.1 400 Bad Request')
  })
})
