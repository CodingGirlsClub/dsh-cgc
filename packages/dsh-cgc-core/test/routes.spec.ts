/**
 * Route tests: the /api/dsh-cgc-core family over real HTTP — loopback
 * fence, payload validation, token non-disclosure, R1 invalidation, and the
 * connect→bridge round trip.
 */

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { ActivityLog } from '../src/activity.ts'
import { CgcEngine } from '../src/engine.ts'
import { CGC_API, type CgcStatusBody } from '../src/protocol.ts'
import { makeRoutes } from '../src/routes.ts'
import { Config, ConnectionStore } from '../src/store.ts'
import { mountRegistry, startMockMcp, type MockMcpServer } from './helpers.ts'
import { MemorySettings } from './helpers.ts'

const NS = settingsNamespace('dsh-cgc-core')
const TOKEN = 'cgc_' + 'a'.repeat(43)

/** Serve the route family on 127.0.0.1 with a random port. */
async function serve(routes: WebRoute[]): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = routes.find(r => r.kind === 'exact' && r.path === url.pathname)
    if (route === undefined) {
      res.writeHead(404).end()
      return
    }
    route.handler(req, res)
  })
  const listening = Promise.withResolvers<void>()
  server.once('error', listening.reject)
  server.listen(0, '127.0.0.1', listening.resolve)
  await listening.promise
  const { port } = server.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${port}`,
    async close() {
      const closed = Promise.withResolvers<void>()
      server.close(() => closed.resolve())
      await closed.promise
      server.closeAllConnections()
    },
  }
}

/** Full wiring: real settings provider + store + engine + routes (as apply() does). */
async function setup() {
  const { ctx, provider } = await (async () => {
    const ctx = await mountRegistry()
    await ctx.plugin(MemorySettings)
    return { ctx, provider: ctx.get('settings') as MemorySettings }
  })()
  const store = new ConnectionStore()
  const activity = new ActivityLog()
  const engine = new CgcEngine(ctx, activity)
  installSettingsSection(ctx, NS, Config, {}, {
    setSource: (source) => { store.setSource(source) },
    onChange: () => {
      const value = store.get()
      void engine.sync(value.url !== '' && value.token !== '' ? { url: value.url, token: value.token } : undefined)
    },
  })
  store.setWriter(ops => provider.mutate(NS, ops))
  const routes = makeRoutes({ store, engine, activity })
  const http_ = await serve(routes)
  return { ctx, provider, store, engine, activity, ...http_ }
}

/** Poll until the predicate holds or the deadline passes. */
async function eventually(check: () => Promise<boolean> | boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error('eventually: deadline exceeded')
    const delay = Promise.withResolvers<void>()
    setTimeout(delay.resolve, 50)
    await delay.promise
  }
}

describe('/api/dsh-cgc-core routes', () => {
  let cleanups: Array<() => Promise<void>> = []
  let servers: MockMcpServer[] = []
  afterEach(async () => {
    for (const close of cleanups.splice(0)) await close()
    for (const server of servers.splice(0)) await server.close()
  })

  it('POST /connect persists config and the response never carries the token', async () => {
    const { base, close } = await setup()
    cleanups.push(close)
    const response = await fetch(base + CGC_API.connect, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://localhost:4102/mcp', token: TOKEN }),
    })
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).not.toContain(TOKEN)
    const body = JSON.parse(text) as { status: CgcStatusBody }
    expect(body.status.configured).toBe(true)
    expect(body.status.token_configured).toBe(true)
    expect(body.status.url).toBe('http://localhost:4102/mcp')
    expect(body.status.web_url).toBe('http://localhost:4102')
  })

  it('GET /status reports the unconfigured shape without a token', async () => {
    const { base, close } = await setup()
    cleanups.push(close)
    const response = await fetch(base + CGC_API.status)
    expect(response.status).toBe(200)
    const body = await response.json() as CgcStatusBody
    expect(body).toMatchObject({
      configured: false,
      url: '',
      token_configured: false,
      connected: false,
      web_url: '',
      activity: [],
    })
    expect(JSON.stringify(body)).not.toContain('cgc_')
  })

  it('DELETE /connect clears the connection (configured:false, reconnect needs no restart)', async () => {
    const { base, close, store } = await setup()
    cleanups.push(close)
    await fetch(base + CGC_API.connect, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://localhost:4102/mcp', token: TOKEN }),
    })
    const response = await fetch(base + CGC_API.connect, { method: 'DELETE' })
    expect(response.status).toBe(200)
    const body = await response.json() as { status: CgcStatusBody }
    expect(body.status.configured).toBe(false)
    expect(body.status.token_configured).toBe(false)
    expect(store.get().token).toBe('')
  })

  it('rejects non-loopback Host headers with 403', async () => {
    const { base, close } = await setup()
    cleanups.push(close)
    const port = new URL(base).port
    const responded = Promise.withResolvers<number>()
    const req = http.request(
      { host: '127.0.0.1', port, path: CGC_API.status, method: 'GET', headers: { host: 'evil.example.com' } },
      res => { res.resume(); res.on('end', () => responded.resolve(res.statusCode ?? 0)) },
    )
    req.on('error', responded.reject)
    req.end()
    const status = await responded.promise
    expect(status).toBe(403)
  })

  it('rejects cross-site browser markers with 403', async () => {
    const { base, close } = await setup()
    cleanups.push(close)
    const response = await fetch(base + CGC_API.status, { headers: { 'sec-fetch-site': 'cross-site' } })
    expect(response.status).toBe(403)
  })

  it('rejects userinfo, non-http(s) schemes, and non-loopback http with 400', async () => {
    const { base, close } = await setup()
    cleanups.push(close)
    for (const url of ['https://user:pw@cgc.example.com/mcp', 'ftp://localhost/x', 'http://cgc.example.com/mcp']) {
      const response = await fetch(base + CGC_API.connect, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, token: TOKEN }),
      })
      expect(response.status, url).toBe(400)
    }
  })

  it('URL change without a token re-submit invalidates the stored token (R1, negative)', async () => {
    const { base, close } = await setup()
    cleanups.push(close)
    await fetch(base + CGC_API.connect, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://localhost:4102/mcp', token: TOKEN }),
    })
    const response = await fetch(base + CGC_API.connect, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://cgc.example.com/mcp' }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { status: CgcStatusBody }
    expect(body.status.url).toBe('https://cgc.example.com/mcp')
    expect(body.status.token_configured).toBe(false)
    expect(body.status.configured).toBe(false)
  })

  it('connect → bridge rebuild → GET /status flips connected (AE1 at HTTP level)', async () => {
    const server = await startMockMcp({ token: TOKEN })
    servers.push(server)
    const { base, close, engine } = await setup()
    cleanups.push(close)
    cleanups.push(async () => { await engine.teardown() })

    await fetch(base + CGC_API.connect, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: server.url, token: TOKEN }),
    })
    await eventually(async () => {
      const body = await (await fetch(base + CGC_API.status)).json() as CgcStatusBody
      return body.connected === true
    })
    const body = await (await fetch(base + CGC_API.status)).json() as CgcStatusBody
    expect(body.connected).toBe(true)
    expect(JSON.stringify(body)).not.toContain(TOKEN)
  })

  it('connect with a dead server surfaces a redacted connection error in activity (AE4 path)', async () => {
    const dead = await startMockMcp({ token: TOKEN })
    const deadUrl = dead.url
    await dead.close()
    const { base, close, engine } = await setup()
    cleanups.push(close)
    cleanups.push(async () => { await engine.teardown() })

    await fetch(base + CGC_API.connect, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: deadUrl, token: TOKEN }),
    })
    await eventually(async () => {
      const body = await (await fetch(base + CGC_API.status)).json() as CgcStatusBody
      return body.activity.some(e => e.kind === 'error')
    })
    const body = await (await fetch(base + CGC_API.status)).json() as CgcStatusBody
    const error = body.activity.find(e => e.kind === 'error')
    expect(error?.code).toBe('CGC_MCP_CONNECTION')
    expect(JSON.stringify(body)).not.toContain(TOKEN)
    expect(JSON.stringify(body)).not.toContain('Bearer')
  })

  it('redacts the stored token literal from 503 error bodies even off-shape (RSK6)', async () => {
    const weirdToken = 'cgc2!rotated-format'
    const ctx = await mountRegistry()
    const activity = new ActivityLog()
    const engine = new CgcEngine(ctx, activity)
    cleanups.push(async () => { await engine.teardown() })
    const store = new ConnectionStore({ url: 'http://localhost:4102/mcp', token: weirdToken })
    store.setWriter(async () => { throw new Error(`settings write failed while storing ${weirdToken}`) })
    const http_ = await serve(makeRoutes({ store, engine, activity }))
    cleanups.push(http_.close)

    const response = await fetch(http_.base + CGC_API.connect, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'cgc_' + 'z'.repeat(43) }),
    })
    expect(response.status).toBe(503)
    const text = await response.text()
    expect(text).not.toContain(weirdToken)
    expect(text).toContain('[REDACTED]')
  })
})
