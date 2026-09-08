/**
 * The /api/dsh-cgc-core route family: connect, status, disconnect. Every
 * route carries a loopback-only trust fence (plus browser same-origin
 * markers, mirroring dsh-ssh) — these endpoints rewrite the connection
 * config, so LAN-exposed dsh web deployments must not serve them. No route
 * ever returns the token or the Authorization header.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { ActivityLog } from './activity.ts'
import type { CgcEngine } from './engine.ts'
import { CGC_API, type CgcStatusBody } from './protocol.ts'
import { redactText } from './redact.ts'
import { validateMcpUrl, type ConnectionStore } from './store.ts'

/** Cap on JSON request bodies (connect payloads are tiny). */
const MAX_JSON_BODY_BYTES = 64 * 1024

/** Loopback literal check plus browser same-origin markers (mirrors the dsh-ssh routes' fence). */
function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

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
}

/** The GET /status body: public projection only, never the token. */
export function statusBody(deps: CgcRoutesDeps): CgcStatusBody {
  const config = deps.store.get()
  let webUrl = ''
  if (config.url !== '') {
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
 * Build every /api/dsh-cgc-core route (exact paths).
 * @param deps - store, engine, activity ring.
 * @returns the route list to register on ctx.webServer.
 */
export function makeRoutes(deps: CgcRoutesDeps): WebRoute[] {
  return [
    {
      kind: 'exact',
      path: CGC_API.connect,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        const method = req.method ?? 'GET'
        if (method === 'POST') {
          const body = await readJsonBody(req)
          if (body === undefined) {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          let url: string | undefined
          let token: string | undefined
          try {
            url = readField(body, 'url')
            token = readField(body, 'token')
          } catch (error) {
            writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
            return
          }
          if (url === undefined && token === undefined) {
            writeJson(res, 400, { error: 'url or token is required' })
            return
          }
          if (url !== undefined) {
            const problem = validateMcpUrl(url)
            if (problem !== undefined) {
              writeJson(res, 400, { error: problem })
              return
            }
          }
          try {
            await deps.store.connect({ ...url === undefined ? {} : { url }, ...token === undefined ? {} : { token } })
          } catch (error) {
            writeJson(res, 503, { error: redactText(error instanceof Error ? error.message : String(error)) })
            return
          }
          writeJson(res, 200, { status: statusBody(deps) })
          return
        }
        if (method === 'DELETE') {
          try {
            await deps.store.disconnect()
          } catch (error) {
            writeJson(res, 503, { error: redactText(error instanceof Error ? error.message : String(error)) })
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
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if (req.method !== 'GET') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        writeJson(res, 200, statusBody(deps))
      },
    },
  ]
}
