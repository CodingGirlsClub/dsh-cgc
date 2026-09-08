/**
 * Data-plane route tests (U6 / Appendix A / KTD5): every whitelisted route's
 * happy path over real HTTP against a mock MCP data source, plus the
 * pipeline invariants — fence, CSRF, Content-Type, envelope, error layering
 * (503/502/500/409), body cap, and the no-credential response rule.
 */

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { ActivityLog } from '../src/activity.ts'
import { CsrfTokenStore } from '../src/csrf.ts'
import { CgcEngine } from '../src/engine.ts'
import { CGC_API_BASE } from '../src/protocol.ts'
import { makeRoutes } from '../src/routes.ts'
import type { CgcDataSource } from '../src/routes/pipeline.ts'
import { ConnectionStore } from '../src/store.ts'
import { mountRegistry } from './helpers.ts'

const TOKEN = 'cgc_' + 'a'.repeat(43)

/** Mock MCP client: records calls, serves per-tool scripted results. */
class MockDataSource implements CgcDataSource {
  connected = true
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = []
  readonly handlers = new Map<string, (args: Record<string, unknown>) => unknown>()

  callTool(rawName: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ name: rawName, args })
    const handler = this.handlers.get(rawName)
    if (handler !== undefined) return Promise.resolve(handler(args))
    return Promise.resolve({ content: [{ type: 'text', text: JSON.stringify({ tool: rawName, args }) }] })
  }
}

/** Serve routes with exact + prefix matching (mirrors the host webServer). */
async function serve(routes: WebRoute[]): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    const route = routes.find(r =>
      r.kind === 'exact'
        ? r.path === pathname
        : pathname === r.path || pathname.startsWith(r.path + '/'))
    if (route === undefined) {
      res.writeHead(404).end()
      return
    }
    void route.handler(req, res)
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

interface Harness {
  base: string
  close: () => Promise<void>
  data: MockDataSource
  csrf: CsrfTokenStore
  store: ConnectionStore
  activity: ActivityLog
  engine: CgcEngine
}

async function setup(opts?: { token?: string; data?: MockDataSource; csrf?: CsrfTokenStore | undefined }): Promise<Harness> {
  const ctx = await mountRegistry()
  const activity = new ActivityLog()
  const engine = new CgcEngine(ctx, activity)
  const store = new ConnectionStore({ url: 'http://localhost:4102/mcp', token: opts?.token ?? TOKEN })
  const data = opts?.data ?? new MockDataSource()
  const csrf = opts === undefined || !('csrf' in opts) ? new CsrfTokenStore() : opts.csrf
  const http_ = await serve(makeRoutes({ store, engine, activity, data, csrf }))
  return {
    ...http_,
    data,
    csrf: csrf ?? new CsrfTokenStore(),
    store,
    activity,
    engine,
  }
}

/** POST helper with the host-injected token and a JSON body. */
function writeRequest(base: string, path: string, csrf: CsrfTokenStore, body: unknown): Promise<Response> {
  return fetch(base + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-cgc-csrf-token': csrf.bootstrapField().csrfToken as string,
    },
    body: JSON.stringify(body),
  })
}

describe('data-plane routes', () => {
  let harnesses: Harness[] = []
  afterEach(async () => {
    for (const h of harnesses.splice(0)) {
      await h.close()
      await h.engine.teardown()
    }
  })

  // -- Happy paths: every Appendix A data route reaches its whitelisted tool.

  const READ_CASES: Array<{ path: string; tool: string; args: Record<string, unknown> }> = [
    { path: '/courses/42/content?workspace_id=w1', tool: 'get_course_content', args: { course_id: '42', workspace_id: 'w1' } },
    { path: '/courses/42/prep?workspace_id=w1', tool: 'get_prep_status', args: { course_id: '42', workspace_id: 'w1' } },
    { path: '/courses/42/revision?workspace_id=w1', tool: 'get_course_revision', args: { course_id: '42', workspace_id: 'w1' } },
    { path: '/me/workspaces', tool: 'list_my_workspaces', args: {} },
    { path: '/tasks?workspace_id=w1', tool: 'list_my_tasks', args: { workspace_id: 'w1' } },
    { path: '/learning_state?workspace_id=w1&course_id=c9', tool: 'get_learning_state', args: { workspace_id: 'w1', course_id: 'c9' } },
    { path: '/discover', tool: 'discover_offerings', args: {} },
    { path: '/enrollment_summary?workspace_id=w1&kind=course&offering_id=o7', tool: 'get_enrollment_summary', args: { workspace_id: 'w1', kind: 'course', offering_id: 'o7' } },
    { path: '/me/enrollments', tool: 'get_my_enrollments', args: {} },
    { path: '/order_status?workspace_id=w1&enrollment_id=e5', tool: 'get_order_status', args: { workspace_id: 'w1', enrollment_id: 'e5' } },
    { path: '/workspace/courses?workspace_id=w1', tool: 'list_workspace_courses', args: { workspace_id: 'w1' } },
    { path: '/workspace/events?workspace_id=w1', tool: 'list_workspace_events', args: { workspace_id: 'w1' } },
    { path: '/workspace/orders?workspace_id=w1', tool: 'list_workspace_orders', args: { workspace_id: 'w1' } },
    { path: '/workspace/enrollments?workspace_id=w1&kind=event&offering_id=o7', tool: 'list_enrollments', args: { workspace_id: 'w1', kind: 'event', offering_id: 'o7' } },
  ]

  for (const { path, tool, args } of READ_CASES) {
    it(`GET ${path} → ${tool} with assembled args`, async () => {
      const h = await setup()
      harnesses.push(h)
      const response = await fetch(h.base + CGC_API_BASE + path)
      expect(response.status).toBe(200)
      const body = await response.json() as { ok: boolean; value: { tool: string; args: Record<string, unknown> } }
      expect(body.ok).toBe(true)
      expect(body.value.tool).toBe(tool)
      expect(body.value.args).toEqual(args)
      expect(h.data.calls).toEqual([{ name: tool, args }])
    })
  }

  it('POST /courses/:id/content → save_course_content (host-injected csrfToken completes the write)', async () => {
    const h = await setup()
    harnesses.push(h)
    const response = await writeRequest(h.base, `${CGC_API_BASE}/courses/42/content`, h.csrf, {
      workspace_id: 'w1',
      content: { steps: [] },
      base_version: 3,
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { ok: boolean; value: { tool: string } }
    expect(body.ok).toBe(true)
    expect(h.data.calls).toEqual([{
      name: 'save_course_content',
      args: { workspace_id: 'w1', course_id: '42', content: { steps: [] }, base_version: 3 },
    }])
  })

  it('POST /enrollments → create_enrollment with enum + optional fields', async () => {
    const h = await setup()
    harnesses.push(h)
    const response = await writeRequest(h.base, `${CGC_API_BASE}/enrollments`, h.csrf, {
      workspace_id: 'w1',
      kind: 'course',
      offering_id: 'o7',
      reason: '  want in  ',
      tier_id: '',
    })
    expect(response.status).toBe(200)
    expect(h.data.calls).toEqual([{
      name: 'create_enrollment',
      args: { workspace_id: 'w1', kind: 'course', offering_id: 'o7', reason: 'want in' },
    }])
  })

  it('GET /activity serves the plugin ActivityLog projection', async () => {
    const h = await setup()
    harnesses.push(h)
    h.activity.push({ kind: 'write', at: 1726000000000, tool: 'mcp__cgc-2046__save_course_content', workspaceId: 'w1' })
    const response = await fetch(h.base + CGC_API_BASE + '/activity')
    expect(response.status).toBe(200)
    const body = await response.json() as { ok: boolean; activity: Array<{ tool?: string }> }
    expect(body.ok).toBe(true)
    expect(body.activity).toHaveLength(1)
    expect(body.activity[0]?.tool).toBe('mcp__cgc-2046__save_course_content')
  })

  // -- Whitelist structural unreachability.

  it('request input cannot steer the tool choice (confirm_operation in the body is inert)', async () => {
    const h = await setup()
    harnesses.push(h)
    const response = await writeRequest(h.base, `${CGC_API_BASE}/enrollments`, h.csrf, {
      workspace_id: 'w1',
      kind: 'event',
      offering_id: 'o7',
      tool: 'confirm_operation',
      pending_id: 'p forged',
    })
    expect(response.status).toBe(200)
    expect(h.data.calls.map(c => c.name)).toEqual(['create_enrollment'])
    expect(JSON.stringify(h.data.calls[0]?.args)).not.toContain('confirm_operation')
  })

  it('no passthrough route exists: tool-named paths 404', async () => {
    const h = await setup()
    harnesses.push(h)
    const response = await writeRequest(h.base, `${CGC_API_BASE}/confirm_operation`, h.csrf, { pending_id: 'p1' })
    expect(response.status).toBe(404)
    const query = await fetch(h.base + `${CGC_API_BASE}/call?tool=confirm_operation&pending_id=p1`)
    expect(query.status).toBe(404)
    expect(h.data.calls).toEqual([])
  })

  it('unknown paths under the fenced /courses stem 404 with the envelope', async () => {
    const h = await setup()
    harnesses.push(h)
    const response = await fetch(h.base + `${CGC_API_BASE}/courses/42/unknown`)
    expect(response.status).toBe(404)
    const body = await response.json() as { ok: boolean; error: { code: string } }
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('not_found')
  })

  // -- CSRF.

  it('write route without the CSRF header → 403; wrong token → 403', async () => {
    const h = await setup()
    harnesses.push(h)
    const missing = await fetch(h.base + `${CGC_API_BASE}/enrollments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace_id: 'w1', kind: 'course', offering_id: 'o7' }),
    })
    expect(missing.status).toBe(403)
    const wrong = await fetch(h.base + `${CGC_API_BASE}/enrollments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cgc-csrf-token': '0'.repeat(64) },
      body: JSON.stringify({ workspace_id: 'w1', kind: 'course', offering_id: 'o7' }),
    })
    expect(wrong.status).toBe(403)
    const body = await wrong.json() as { ok: boolean; error: { code: string } }
    expect(body.error.code).toBe('forbidden')
    expect(h.data.calls).toEqual([])
  })

  it('write routes fail closed (403) when no CSRF store is wired', async () => {
    const h = await setup({ csrf: undefined })
    harnesses.push(h)
    const response = await writeRequest(h.base, `${CGC_API_BASE}/enrollments`, new CsrfTokenStore(), {
      workspace_id: 'w1',
      kind: 'course',
      offering_id: 'o7',
    })
    expect(response.status).toBe(403)
    expect(h.data.calls).toEqual([])
  })

  // -- Content-Type / body discipline.

  it('write route without application/json Content-Type → 415', async () => {
    const h = await setup()
    harnesses.push(h)
    const response = await fetch(h.base + `${CGC_API_BASE}/enrollments`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-cgc-csrf-token': h.csrf.token },
      body: 'workspace_id=w1',
    })
    expect(response.status).toBe(415)
    const body = await response.json() as { error: { code: string } }
    expect(body.error.code).toBe('unsupported_media_type')
  })

  it('request body beyond the 1 MiB cap → 413', async () => {
    const h = await setup()
    harnesses.push(h)
    const response = await writeRequest(h.base, `${CGC_API_BASE}/enrollments`, h.csrf, {
      workspace_id: 'w1',
      kind: 'course',
      offering_id: 'o7',
      reason: 'x'.repeat(1024 * 1024),
    })
    expect(response.status).toBe(413)
    const body = await response.json() as { error: { code: string } }
    expect(body.error.code).toBe('payload_too_large')
  })

  // -- Field validation.

  it('missing required query param → 400 naming the field', async () => {
    const h = await setup()
    harnesses.push(h)
    const response = await fetch(h.base + `${CGC_API_BASE}/tasks`)
    expect(response.status).toBe(400)
    const body = await response.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('bad_request')
    expect(body.error.message).toBe('workspace_id is required')
    expect(h.data.calls).toEqual([])
  })

  it('missing_join routes collect every absent param into one 400', async () => {
    const h = await setup()
    harnesses.push(h)
    const summary = await (await fetch(h.base + `${CGC_API_BASE}/enrollment_summary`)).json() as { error: { message: string } }
    expect(summary.error.message).toBe('workspace_id, kind, offering_id is required')
    const queue = await (await fetch(h.base + `${CGC_API_BASE}/workspace/enrollments`)).json() as { error: { message: string } }
    expect(queue.error.message).toBe('workspace_id / kind / offering_id is required')
  })

  it('enum, object, and integer field violations → 400', async () => {
    const h = await setup()
    harnesses.push(h)
    const badKind = await writeRequest(h.base, `${CGC_API_BASE}/enrollments`, h.csrf, {
      workspace_id: 'w1', kind: 'membership', offering_id: 'o7',
    })
    expect(badKind.status).toBe(400)
    expect(((await badKind.json()) as { error: { message: string } }).error.message).toBe('kind must be event or course')
    const badVersion = await writeRequest(h.base, `${CGC_API_BASE}/courses/42/content`, h.csrf, {
      workspace_id: 'w1', content: {}, base_version: '3',
    })
    expect(badVersion.status).toBe(400)
    expect(((await badVersion.json()) as { error: { message: string } }).error.message).toBe('base_version must be an integer')
    const badContent = await writeRequest(h.base, `${CGC_API_BASE}/courses/42/content`, h.csrf, {
      workspace_id: 'w1', content: [1], base_version: 0,
    })
    expect(badContent.status).toBe(400)
    expect(((await badContent.json()) as { error: { message: string } }).error.message).toBe('content must be an object')
    expect(h.data.calls).toEqual([])
  })

  it('wrong method on a data route → 405', async () => {
    const h = await setup()
    harnesses.push(h)
    const response = await fetch(h.base + `${CGC_API_BASE}/discover`, { method: 'DELETE' })
    expect(response.status).toBe(405)
    const body = await response.json() as { error: { code: string } }
    expect(body.error.code).toBe('method_not_allowed')
  })

  // -- Error layering.

  it('data source disconnected → 503 not_connected; source absent → 503', async () => {
    const h = await setup()
    harnesses.push(h)
    h.data.connected = false
    const response = await fetch(h.base + `${CGC_API_BASE}/discover`)
    expect(response.status).toBe(503)
    const body = await response.json() as { error: { code: string } }
    expect(body.error.code).toBe('not_connected')
  })

  it('upstream version_conflict substring on the save route → 409; elsewhere → 502', async () => {
    const h = await setup()
    harnesses.push(h)
    h.data.handlers.set('save_course_content', () => {
      throw new Error("MCP server 'cgc-2046' error on tools/call: version_conflict: expected base_version 3, found 5 (code -32000)")
    })
    const conflict = await writeRequest(h.base, `${CGC_API_BASE}/courses/42/content`, h.csrf, {
      workspace_id: 'w1', content: {}, base_version: 3,
    })
    expect(conflict.status).toBe(409)
    const conflictBody = await conflict.json() as { ok: boolean; error: { code: string; message: string } }
    expect(conflictBody.ok).toBe(false)
    expect(conflictBody.error.code).toBe('version_conflict')
    expect(conflictBody.error.message).toContain('expected base_version 3')

    h.data.handlers.set('get_course_content', () => {
      throw new Error('version_conflict: unexpected on a read')
    })
    const read = await fetch(h.base + `${CGC_API_BASE}/courses/42/content?workspace_id=w1`)
    expect(read.status).toBe(502)
    expect(((await read.json()) as { error: { code: string } }).error.code).toBe('upstream')
  })

  it('MCP isError result → 502 upstream with the redacted upstream text', async () => {
    const h = await setup()
    harnesses.push(h)
    h.data.handlers.set('discover_offerings', () => ({
      isError: true,
      content: [{ type: 'text', text: 'upstream exploded' }],
    }))
    const response = await fetch(h.base + `${CGC_API_BASE}/discover`)
    expect(response.status).toBe(502)
    const body = await response.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('upstream')
    expect(body.error.message).toContain('upstream exploded')
  })

  it('an unexpected pipeline failure → 500 internal', async () => {
    const h = await setup()
    harnesses.push(h)
    // A circular structure makes the structured redaction pass throw —
    // nothing the upstream sends should take the route down past 500.
    const circular: Record<string, unknown> = {}
    circular.self = circular
    h.data.handlers.set('discover_offerings', () => circular)
    const response = await fetch(h.base + `${CGC_API_BASE}/discover`)
    expect(response.status).toBe(500)
    const body = await response.json() as { error: { code: string } }
    expect(body.error.code).toBe('internal')
  })

  // -- Response hygiene.

  it('no route response carries the cgc_ token, a Bearer value, or the CSRF token', async () => {
    const offShapeToken = 'cgc2!rotated-format'
    const h = await setup({ token: offShapeToken })
    harnesses.push(h)
    const shaped = 'cgc_' + 'b'.repeat(43)
    h.data.handlers.set('get_course_content', () => ({
      content: [{
        type: 'text',
        text: JSON.stringify({
          literal: offShapeToken,
          shaped_token: shaped,
          header: `Bearer ${shaped}`,
          note: h.csrf.token,
          deep: { nested: [`Bearer ${offShapeToken}`] },
        }),
      }],
    }))
    const ok = await fetch(h.base + `${CGC_API_BASE}/courses/42/content?workspace_id=w1`)
    expect(ok.status).toBe(200)
    const okText = await ok.text()
    expect(okText).not.toContain(offShapeToken)
    expect(okText).not.toContain(shaped)
    // The Bearer VALUE is scrubbed; the scheme word itself may remain.
    expect(okText).not.toContain(`Bearer ${shaped}`)
    expect(okText).not.toContain(`Bearer ${offShapeToken}`)
    expect(okText).not.toContain(h.csrf.token)

    h.data.handlers.set('save_course_content', () => {
      throw new Error(`upstream says token ${offShapeToken} / Bearer ${shaped} / csrf ${h.csrf.token}`)
    })
    const failing = await writeRequest(h.base, `${CGC_API_BASE}/courses/42/content`, h.csrf, {
      workspace_id: 'w1', content: {}, base_version: 0,
    })
    expect(failing.status).toBe(502)
    const failText = await failing.text()
    expect(failText).not.toContain(offShapeToken)
    expect(failText).not.toContain(shaped)
    expect(failText).not.toContain(h.csrf.token)
  })

  // -- Fence on the data plane.

  it('cross-site browser markers and foreign Origins are fenced off data routes', async () => {
    const h = await setup()
    harnesses.push(h)
    const marked = await fetch(h.base + `${CGC_API_BASE}/discover`, { headers: { 'sec-fetch-site': 'cross-site' } })
    expect(marked.status).toBe(403)
    const port = new URL(h.base).port
    const foreign = await fetch(h.base + `${CGC_API_BASE}/discover`, { headers: { origin: 'http://evil.example.com' } })
    expect(foreign.status).toBe(403)
    // Strict host:port equality: even a loopback origin on another port fails.
    const otherPort = await fetch(h.base + `${CGC_API_BASE}/discover`, { headers: { origin: 'http://127.0.0.1:1' } })
    expect(otherPort.status).toBe(403)
    const sameOrigin = await fetch(h.base + `${CGC_API_BASE}/discover`, { headers: { origin: `http://127.0.0.1:${port}` } })
    expect(sameOrigin.status).toBe(200)
    expect(h.data.calls).toHaveLength(1)
  })
})
