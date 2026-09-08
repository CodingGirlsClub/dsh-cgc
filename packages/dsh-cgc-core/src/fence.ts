/**
 * Shared loopback trust fence for every /api/dsh-cgc-core route — the data
 * routes (U6) and the event channel (U7) run the exact same gate (KTD5 /
 * RSK3). Moved verbatim out of routes.ts; the semantics MUST NOT be
 * relaxed:
 *
 * - the TCP peer is a loopback literal (127.0.0.1 / ::1 / ::ffff:127.0.0.1),
 * - the Host header parses and names a loopback hostname (trusted hosts:
 *   127.0.0.1 / localhost / [::1]),
 * - `sec-fetch-site: cross-site` is rejected outright,
 * - an Origin header, when present, must match Host with STRICT host:port
 *   equality (the openclacky-ext fence compared host-only — that was its
 *   documented weakness; here a cross-port "same host" origin is refused).
 *
 * Requests without an Origin (curl, host-internal calls) pass the origin
 * check: loopback trust is by network location, not caller identity (the
 * accepted residual risk, RSK5).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** The fence verdict for one incoming request. */
export function isLoopbackRequest(request: IncomingMessage): boolean {
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

/**
 * Run the fence; on refusal write the 403 and return false so the caller
 * stops the pipeline. The body deliberately says nothing beyond the verdict.
 */
export function fenceOrReject(request: IncomingMessage, res: ServerResponse): boolean {
  if (isLoopbackRequest(request)) return true
  const payload = JSON.stringify({ error: 'forbidden: loopback-only' })
  res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(payload)
  return false
}
