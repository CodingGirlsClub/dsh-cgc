/**
 * The /api/dsh-cgc-core route family: connect, status, disconnect, the
 * activity projection, and (through src/routes/*) the Appendix A data
 * plane. Every route sits behind the shared loopback trust fence
 * (src/fence.ts) — these endpoints rewrite the connection config and proxy
 * platform data, so LAN-exposed dsh web deployments must not serve them.
 * No route ever returns the token, the Authorization header, or the CSRF
 * token.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { ActivityLog } from './activity.ts'
import type { CgcEventHub } from './events.ts'
import type { CsrfTokenStore } from './csrf.ts'
import type { CgcEngine } from './engine.ts'
import { fenceOrReject } from './fence.ts'
import { CGC_API, CGC_API_BASE, type CgcStatusBody } from './protocol.ts'
import { redactText } from './redact.ts'
import { courseRoutes } from './routes/courses.ts'
import { eventRoutes } from './routes/events.ts'
import { learnerRoutes } from './routes/learner.ts'
import type { CgcDataSource, DataRouteDeps } from './routes/pipeline.ts'
import { workspaceRoutes } from './routes/workspace.ts'
import { validateMcpUrl, type ConnectionStore } from './store.ts'

/** Live secret literals for literal-first redaction: the store's current token (RSK6). */
function storeSecrets(store: ConnectionStore): readonly string[] {
  const token = store.get().token
  return token === '' ? [] : [token]
}

/** Cap on JSON request bodies (connect payloads are tiny). */
const MAX_JSON_BODY_BYTES = 64 * 1024

/** One JSON response. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(payload)
}

/** Read a JSON request body (undefined when too large or unparseable). */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** Route family dependencies. */
export interface CgcRoutesDeps {
  /** The connection config store (settings-backed). */
  store: ConnectionStore
  /** The bridge engine (live connected flag). */
  engine: CgcEngine
  /** The recent-activity ring. */
  activity: ActivityLog
  /**
   * The MCP call path for the data routes. Optional until the engine grows
   * its callTool surface (orchestrator integration); while absent every
   * data route answers 503 not_connected.
   */
  data?: CgcDataSource | undefined
  /**
   * The host-side CSRF token store. Optional for the same integration
   * window; while absent every data write route fails closed with 403.
   */
  csrf?: CsrfTokenStore | undefined
  /**
   * The U7 event hub; when present the seq polling route
   * (GET /events?afterSeq=) joins the family. The WS push endpoint is
   * registered separately via installEventChannel (registerUpgrade).
   */
  events?: CgcEventHub | undefined
}

/** The GET /status body: public projection only, never the token. */
export function statusBody(deps: CgcRoutesDeps): CgcStatusBody {
  const config = deps.store.get()
  let webUrl = config.web_url
  if (webUrl === '' && config.url !== '') {
    try {
      webUrl = new URL(config.url).origin
    } catch {
      // A hand-edited settings.yaml can hold an unparseable URL; report no site.
      webUrl = ''
    }
  }
  return {
    configured: deps.store.configured(),
    url: config.url,
    token_configured: config.token !== '',
    connected: deps.engine.connected,
    web_url: webUrl,
    activity: deps.activity.list(),
  }
}

/**
 * Validate one connect payload field; returns the trimmed string, undefined
 * when absent, or throws a 400-worthy reason.
 */
function readField(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`)
  }
  return value.trim()
}

/**
 * Build every /api/dsh-cgc-core route. The legacy connect/status routes
 * keep their `{error}` shape (the existing client depends on it); the data
 * plane routes run the shared KTD5 pipeline with the `{ok, value}` /
 * `{ok:false, error:{code,message}}` envelope.
 * @param deps - store, engine, activity ring, optional data source and
 *   CSRF store.
 * @returns the route list to register on ctx.webServer.
 */
export function makeRoutes(deps: CgcRoutesDeps): WebRoute[] {
  const dataDeps: DataRouteDeps = {
    data: deps.data,
    csrf: deps.csrf,
    secrets: () => storeSecrets(deps.store),
  }
  return [
    {
      kind: 'exact',
      path: CGC_API.connect,
      handler: async (req, res) => {
        if (!fenceOrReject(req, res)) return
        const method = req.method ?? 'GET'
        if (method === 'POST') {
          const body = await readJsonBody(req)
          if (body === undefined) {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          let url: string | undefined
          let webUrl: string | undefined
          let token: string | undefined
          try {
            url = readField(body, 'url')
            webUrl = readField(body, 'web_url')
            token = readField(body, 'token')
          } catch (error) {
            writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
            return
          }
          if (url === undefined && webUrl === undefined && token === undefined) {
            writeJson(res, 400, { error: 'url, web_url or token is required' })
            return
          }
          if (url !== undefined) {
            const problem = validateMcpUrl(url)
            if (problem !== undefined) {
              writeJson(res, 400, { error: problem })
              return
            }
          }
          if (webUrl !== undefined) {
            try {
              const site = new URL(webUrl)
              if (site.protocol !== 'https:' && site.protocol !== 'http:') throw new Error('scheme')
              webUrl = site.origin
            } catch {
              writeJson(res, 400, { error: 'web_url must be an http(s) URL' })
              return
            }
          }
          try {
            await deps.store.connect({
              ...url === undefined ? {} : { url },
              ...webUrl === undefined ? {} : { web_url: webUrl },
              ...token === undefined ? {} : { token },
            })
          } catch (error) {
            writeJson(res, 503, { error: redactText(error instanceof Error ? error.message : String(error), storeSecrets(deps.store)) })
            return
          }
          writeJson(res, 200, { status: statusBody(deps) })
          return
        }
        if (method === 'DELETE') {
          try {
            await deps.store.disconnect()
          } catch (error) {
            writeJson(res, 503, { error: redactText(error instanceof Error ? error.message : String(error), storeSecrets(deps.store)) })
            return
          }
          writeJson(res, 200, { status: statusBody(deps) })
          return
        }
        writeJson(res, 405, { error: `method not allowed: ${method}` })
      },
    },
    {
      kind: 'exact',
      path: CGC_API.status,
      handler: (req, res) => {
        if (!fenceOrReject(req, res)) return
        if (req.method !== 'GET') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        writeJson(res, 200, statusBody(deps))
      },
    },
    {
      kind: 'exact',
      path: CGC_API_BASE + '/activity',
      handler: (req, res) => {
        if (!fenceOrReject(req, res)) return
        if (req.method !== 'GET') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        // The plugin-owned ActivityLog replaces the platform-side activity
        // scan (Appendix A); entries are pre-redacted at push time.
        writeJson(res, 200, { ok: true, activity: deps.activity.list() })
      },
    },
    ...courseRoutes(dataDeps, CGC_API_BASE),
    ...learnerRoutes(dataDeps, CGC_API_BASE),
    ...workspaceRoutes(dataDeps, CGC_API_BASE),
    // U7: seq incremental polling (the WS push endpoint's fallback), same
    // shared fence and redaction discipline as the data plane (RSK3).
    ...deps.events === undefined ? [] : eventRoutes(deps.events, CGC_API_BASE, () => storeSecrets(deps.store)),
  ]
}
