/**
 * Shared data-route pipeline (KTD5). Every data route runs the same stages,
 * in order:
 *
 *   fence (fence.ts: loopback + trusted hosts + sec-fetch-site + strict
 *   host:port Origin match) → method → CSRF (write routes only:
 *   `X-CGC-CSRF-Token` vs the host-injected token; fail-closed when the
 *   store is absent) → Content-Type application/json (write routes; 415) →
 *   per-field 400 validation → tool call via the injected data source →
 *   envelope.
 *
 * Response discipline:
 * - envelope `{ ok: true, value }` / `{ ok: false, error: { code, message } }`;
 * - JSON request bodies capped at 1 MiB;
 * - error layering: 503 not connected, 502 upstream (incl. MCP isError
 *   results), 409 when a conflict route's upstream message carries the
 *   `version_conflict` substring, 500 for anything unexpected;
 * - redaction is the U2 two-pass pipeline: redactValue over the structured
 *   value, then redactText with the live secret literals (connection token
 *   AND the CSRF token) over the final serialized body — no route response
 *   can carry a `cgc_` token, a Bearer value, or the CSRF token itself.
 *
 * The dispatcher has no generic passthrough: each route declaration names
 * its whitelist key and the tool comes from ROUTE_WHITELIST, so request
 * input can never steer the tool choice (R19 structural unreachability).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { CGC_CSRF_HEADER, type CsrfTokenStore } from '../csrf.ts'
import { fenceOrReject } from '../fence.ts'
import { redactText, redactValue } from '../redact.ts'
import { ROUTE_WHITELIST, type RouteWhitelistKey } from '../whitelist.ts'

/** Cap on data-route JSON request bodies (KTD5). */
const MAX_DATA_BODY_BYTES = 1024 * 1024

/** The live-connection surface the data routes call through. */
export interface CgcDataSource {
  /** Whether the bridge currently holds a live MCP connection. */
  readonly connected: boolean
  /**
   * Call one whitelisted platform tool; resolves with the raw MCP result
   * (`{ content, structuredContent?, isError? }` shape), rejects on
   * transport/protocol failure.
   */
  callTool(rawName: string, args: Record<string, unknown>): Promise<unknown>
}

/** Dependencies the data pipeline needs from the route family. */
export interface DataRouteDeps {
  /** The MCP call path; undefined or disconnected → every data route 503s. */
  readonly data: CgcDataSource | undefined
  /** The CSRF token store; absent → write routes fail closed (403). */
  readonly csrf: CsrfTokenStore | undefined
  /** Live secret literals for the literal-first redaction pass (RSK6). */
  readonly secrets: () => readonly string[]
}

/** Machine-routable envelope error codes. */
export type DataErrorCode =
  | 'forbidden'
  | 'method_not_allowed'
  | 'not_found'
  | 'bad_request'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'not_connected'
  | 'upstream'
  | 'version_conflict'
  | 'internal'

/** One validated field source: route capture / query string, or JSON body. */
type FieldSource = 'param' | 'body'

/** Field validation kinds (mirror the openclacky-ext declaration table). */
type FieldCheck = 'pass' | 'required' | 'optional' | 'object' | 'integer' | { enum: readonly string[] }

export type FieldDecl = readonly [FieldSource, string, FieldCheck]

/** One data-route declaration (Appendix A row). */
export interface DataRouteDecl {
  readonly method: 'GET' | 'POST'
  /** Path pattern relative to the API base, e.g. '/courses/:course_id/content'. */
  readonly pattern: string
  /** The whitelist row this route draws its tool from. */
  readonly whitelistKey: RouteWhitelistKey
  /** Map the upstream `version_conflict` substring to 409 (optimistic concurrency). */
  readonly conflict409?: boolean
  /** Collect every missing required param into one message with this separator. */
  readonly missingJoin?: string
  readonly fields: readonly FieldDecl[]
}

/** One JSON envelope response, redacted over the final serialized body. */
function writeEnvelope(
  res: ServerResponse,
  status: number,
  body: unknown,
  secrets: readonly string[],
): void {
  const payload = redactText(JSON.stringify(body), secrets)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(payload)
}

function writeError(
  res: ServerResponse,
  status: number,
  code: DataErrorCode,
  message: string,
  secrets: readonly string[],
): void {
  writeEnvelope(res, status, { ok: false, error: { code, message } }, secrets)
}

/**
 * Match a request pathname against a declaration pattern; returns the
 * capture map or undefined. Patterns are literal segments plus `:name`
 * captures; matching is exact in segment count (no trailing-slash games).
 */
export function matchDataPath(pattern: string, pathname: string): Record<string, string> | undefined {
  const patternSegments = pattern.split('/').filter(s => s !== '')
  const pathSegments = pathname.split('/').filter(s => s !== '').map(s => {
    try {
      return decodeURIComponent(s)
    } catch {
      return s
    }
  })
  if (patternSegments.length !== pathSegments.length) return undefined
  const captures: Record<string, string> = {}
  for (let i = 0; i < patternSegments.length; i += 1) {
    const expected = patternSegments[i] as string
    const actual = pathSegments[i] as string
    if (expected.startsWith(':')) {
      captures[expected.slice(1)] = actual
    } else if (expected !== actual) {
      return undefined
    }
  }
  return captures
}

/** Read a JSON body within the 1 MiB cap; distinguishes oversize from unparseable. */
async function readDataBody(
  req: IncomingMessage,
): Promise<{ kind: 'ok'; body: Record<string, unknown> } | { kind: 'too_large' } | { kind: 'invalid' }> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_DATA_BODY_BYTES) return { kind: 'too_large' }
    chunks.push(buffer)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? { kind: 'ok', body: parsed as Record<string, unknown> }
      : { kind: 'invalid' }
  } catch {
    return { kind: 'invalid' }
  }
}

/** Collapse an MCP result into the panel-facing value (structuredContent wins, then joined text parsed as JSON). */
function normalizeMcpResult(result: unknown): unknown {
  if (typeof result !== 'object' || result === null) return result
  const record = result as Record<string, unknown>
  if ('structuredContent' in record && record.structuredContent !== undefined) return record.structuredContent
  const content = record.content
  if (!Array.isArray(content)) return result
  const texts = content.flatMap(block =>
    typeof block === 'object' && block !== null && typeof (block as Record<string, unknown>).text === 'string'
      ? [(block as Record<string, unknown>).text as string]
      : [],
  )
  if (texts.length === 0) return result
  const joined = texts.join('\n')
  try {
    return JSON.parse(joined) as unknown
  } catch {
    return joined
  }
}

/** The upstream-reported error text of an isError MCP result. */
function isErrorText(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined
  const record = result as Record<string, unknown>
  if (record.isError !== true || !Array.isArray(record.content)) return undefined
  const texts = record.content.flatMap(block =>
    typeof block === 'object' && block !== null && typeof (block as Record<string, unknown>).text === 'string'
      ? [(block as Record<string, unknown>).text as string]
      : [],
  )
  return texts.join('\n')
}

/**
 * Assemble tool arguments from the request per the field contract; returns
 * the failure message when validation fails (missing_join declarations
 * collect every absent required param into one report).
 */
function collectArgs(
  decl: DataRouteDecl,
  captures: Record<string, string>,
  query: URLSearchParams,
  body: Record<string, unknown>,
): Record<string, unknown> | string {
  const args: Record<string, unknown> = {}
  const missing: string[] = []
  for (const [source, key, check] of decl.fields) {
    let value: unknown
    if (source === 'param') {
      const raw = captures[key] ?? query.get(key) ?? ''
      value = raw
    } else {
      const raw = body[key]
      value = check === 'object' || check === 'integer' ? raw : typeof raw === 'string' ? raw.trim() : (raw ?? '')
    }
    if (check === 'pass') {
      args[key] = value
    } else if (check === 'required') {
      if (typeof value !== 'string' || value === '') {
        if (decl.missingJoin !== undefined) missing.push(key)
        else return `${key} is required`
      } else {
        args[key] = value
      }
    } else if (check === 'optional') {
      if (typeof value === 'string' && value !== '') args[key] = value
    } else if (check === 'object') {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${key} must be an object`
      args[key] = value
    } else if (check === 'integer') {
      if (typeof value !== 'number' || !Number.isInteger(value)) return `${key} must be an integer`
      args[key] = value
    } else {
      if (typeof value !== 'string' || !check.enum.includes(value)) return `${key} must be ${check.enum.join(' or ')}`
      args[key] = value
    }
  }
  if (missing.length > 0) return `${missing.join(decl.missingJoin)} is required`
  return args
}

/**
 * Build the handler for one data-route declaration. Pathname matching is
 * the caller's job (exact registration, or a prefix dispatcher calling
 * matchDataPath first); `captures` carries the `:param` values.
 */
export function makeDataHandler(
  decl: DataRouteDecl,
  deps: DataRouteDeps,
): (req: IncomingMessage, res: ServerResponse, captures: Record<string, string>, query: URLSearchParams) => Promise<void> {
  return async (req, res, captures, query) => {
    // Live literals for the literal-first pass: the store's connection token
    // plus the CSRF token itself, so no response body can ever echo either.
    // Shape-only redaction is the fallback when the secrets probe fails.
    let secrets: readonly string[] = []
    try {
      secrets = [...deps.secrets(), ...deps.csrf === undefined ? [] : [deps.csrf.token]]
    } catch {
      secrets = []
    }
    try {
      if (req.method !== decl.method) {
        writeError(res, 405, 'method_not_allowed', `method not allowed: ${req.method ?? 'GET'}`, secrets)
        return
      }
      let body: Record<string, unknown> = {}
      if (decl.method === 'POST') {
        // Fail-closed: without a store no presented header can ever match.
        if (!deps.csrf?.matches(typeof req.headers[CGC_CSRF_HEADER] === 'string' ? req.headers[CGC_CSRF_HEADER] as string : undefined)) {
          writeError(res, 403, 'forbidden', 'missing or invalid CSRF token', secrets)
          return
        }
        const contentType = req.headers['content-type']
        if (typeof contentType !== 'string' || !contentType.includes('application/json')) {
          writeError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json', secrets)
          return
        }
        const read = await readDataBody(req)
        if (read.kind === 'too_large') {
          writeError(res, 413, 'payload_too_large', 'request body exceeds 1 MiB', secrets)
          return
        }
        if (read.kind === 'invalid') {
          writeError(res, 400, 'bad_request', 'invalid JSON body', secrets)
          return
        }
        body = read.body
      }
      const args = collectArgs(decl, captures, query, body)
      if (typeof args === 'string') {
        writeError(res, 400, 'bad_request', args, secrets)
        return
      }
      if (deps.data === undefined || !deps.data.connected) {
        writeError(res, 503, 'not_connected', 'cgc-2046 MCP server not connected', secrets)
        return
      }
      const tool = ROUTE_WHITELIST[decl.whitelistKey]
      // The 502/409 layering wraps ONLY the upstream call; failures in our
      // own result handling fall through to the outer 500.
      let result: unknown
      try {
        result = await deps.data.callTool(tool, args)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (decl.conflict409 === true && message.includes('version_conflict')) {
          writeError(res, 409, 'version_conflict', message, secrets)
          return
        }
        writeError(res, 502, 'upstream', `MCP call failed: ${message}`, secrets)
        return
      }
      const failure = isErrorText(result)
      if (failure !== undefined) {
        writeError(res, 502, 'upstream', `MCP call failed: ${failure}`, secrets)
        return
      }
      writeEnvelope(res, 200, { ok: true, value: redactValue(normalizeMcpResult(result)) }, secrets)
    } catch (error) {
      writeError(res, 500, 'internal', error instanceof Error ? error.message : String(error), secrets)
    }
  }
}

/** Parsed request URL helper for the wrappers below. */
function requestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', 'http://localhost')
}

/**
 * Register one fixed-path data route (no `:param` captures). The fence runs
 * before anything else; the envelope writer is the only response path.
 */
export function makeExactDataRoute(decl: DataRouteDecl, deps: DataRouteDeps, base: string): WebRoute {
  const handler = makeDataHandler(decl, deps)
  return {
    kind: 'exact',
    path: base + decl.pattern,
    handler: async (req, res) => {
      if (!fenceOrReject(req, res)) return
      await handler(req, res, {}, requestUrl(req).searchParams)
    },
  }
}

/**
 * Register a prefix route dispatching several parameterized declarations
 * sharing one stem (e.g. '/courses'). The fence runs before path matching,
 * so even 404 answers under the stem stay behind the loopback gate.
 */
export function makePrefixDataRoutes(decls: readonly DataRouteDecl[], deps: DataRouteDeps, base: string, stem: string): WebRoute {
  const handlers = decls.map(decl => ({ decl, handler: makeDataHandler(decl, deps) }))
  return {
    kind: 'prefix',
    path: base + stem,
    handler: async (req, res) => {
      if (!fenceOrReject(req, res)) return
      const url = requestUrl(req)
      const relative = url.pathname.slice(base.length)
      // Path first, then method: a path that exists under another method
      // answers 405 (via that declaration's handler), not 404.
      const matched = handlers.flatMap(entry => {
        const captures = matchDataPath(entry.decl.pattern, relative)
        return captures === undefined ? [] : [{ ...entry, captures }]
      })
      const chosen = matched.find(entry => entry.decl.method === req.method) ?? matched[0]
      if (chosen !== undefined) {
        await chosen.handler(req, res, chosen.captures, url.searchParams)
        return
      }
      writeError(res, 404, 'not_found', `no such route: ${req.method ?? 'GET'} ${url.pathname}`, deps.secrets())
    },
  }
}
