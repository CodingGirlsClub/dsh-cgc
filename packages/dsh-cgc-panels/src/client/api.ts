/**
 * Browser-side API client for dsh-cgc-core's /api/dsh-cgc-core route family —
 * the panel family's only data access path (plain fetch, same origin). Two
 * wire shapes ride it: the legacy connect/status routes (`{error}` /
 * `{status}`) and the U6 data plane envelope (`{ok:true, value}` /
 * `{ok:false, error:{code,message}}`).
 *
 * Write routes carry the X-CGC-CSRF-Token header from the bootstrap channel
 * (boot.ts); the token never appears in URLs, bodies, or the DOM.
 */

import {
  CGC_CSRF_HEADER,
  CGC_PANEL_API,
  courseContentPath,
  coursePrepPath,
  courseRevisionPath,
  type CgcActivityEntry,
  type CgcEventsPage,
  type CgcStatusBody,
  type DataEnvelope,
} from '../protocol.ts'

/** Error carrying the route's HTTP status, envelope code, and Retry-After. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string | undefined
  /** Retry-After in seconds, when the route answered 429 with the header. */
  readonly retryAfter: number | undefined

  constructor(message: string, status: number, code?: string, retryAfter?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.retryAfter = retryAfter
  }
}

/** Parse the Retry-After header (seconds form; anything else is ignored). */
export function parseRetryAfter(response: Response): number | undefined {
  const raw = response.headers.get('retry-after')
  if (raw === null) return undefined
  const seconds = Number(raw)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
}

/** Extract the human message out of either wire shape. */
function errorMessageOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  // Data plane: {ok:false, error:{code, message}}
  if ('error' in body) {
    const error = body.error
    if (typeof error === 'string') return error
    if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
      return error.message
    }
  }
  return undefined
}

/** Extract the data-plane machine code, when present. */
function errorCodeOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  if (!('error' in body)) return undefined
  const error = body.error
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  return undefined
}

/** Read a JSON response of either wire shape; throws ApiError on non-OK. */
async function readJson<T>(response: Response): Promise<T> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new ApiError(`HTTP ${response.status}: invalid JSON response`, response.status)
  }
  if (!response.ok) {
    throw new ApiError(
      errorMessageOf(body) ?? `HTTP ${response.status}`,
      response.status,
      errorCodeOf(body),
      parseRetryAfter(response),
    )
  }
  return body as T
}

/** Read a data-plane envelope; throws ApiError on non-OK or ok:false. */
async function readEnvelope<T>(response: Response): Promise<T> {
  const body = await readJson<DataEnvelope<T>>(response)
  if (!body.ok) {
    throw new ApiError(body.error.message, response.status, body.error.code, parseRetryAfter(response))
  }
  return body.value
}

/** Query-string builder dropping undefined/empty values. */
function queryOf(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, value)
  }
  const text = search.toString()
  return text === '' ? '' : `?${text}`
}

/** The panel family's only data entry point. */
export class PanelsApi {
  private readonly csrfToken: string | undefined
  private readonly fetchImpl: typeof fetch

  constructor(csrfToken: string | undefined, fetchImpl?: typeof fetch) {
    this.csrfToken = csrfToken
    this.fetchImpl = fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  }

  /** Whether write requests can carry a CSRF proof. */
  get canWrite(): boolean {
    return this.csrfToken !== undefined
  }

  /** GET /status (legacy shape). */
  async status(): Promise<CgcStatusBody> {
    return readJson<CgcStatusBody>(await this.fetchImpl(CGC_PANEL_API.status))
  }

  /** POST /connect; returns the post-write status snapshot. */
  async connect(payload: { url?: string; token?: string }): Promise<CgcStatusBody> {
    const body = await readJson<{ status: CgcStatusBody }>(await this.fetchImpl(CGC_PANEL_API.connect, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }))
    return body.status
  }

  /** DELETE /connect; returns the post-clear status snapshot. */
  async disconnect(): Promise<CgcStatusBody> {
    const body = await readJson<{ status: CgcStatusBody }>(await this.fetchImpl(CGC_PANEL_API.connect, { method: 'DELETE' }))
    return body.status
  }

  /** GET /activity — the plugin-owned recent-activity ring (pre-redacted). */
  async activity(): Promise<CgcActivityEntry[]> {
    const body = await readJson<{ ok: boolean; activity: CgcActivityEntry[] }>(await this.fetchImpl(CGC_PANEL_API.activity))
    return body.activity
  }

  /** GET /events?afterSeq= — the seq polling fallback of the WS channel. */
  async events(afterSeq: number): Promise<CgcEventsPage> {
    return readEnvelope<CgcEventsPage>(await this.fetchImpl(`${CGC_PANEL_API.events}?afterSeq=${afterSeq}`))
  }

  /** GET a data-plane route; resolves the envelope value. */
  async get<T = unknown>(path: string, params: Record<string, string | undefined> = {}): Promise<T> {
    return readEnvelope<T>(await this.fetchImpl(path + queryOf(params)))
  }

  /** POST a data-plane write route with the CSRF proof header. */
  async post<T = unknown>(path: string, body: Record<string, unknown>): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.csrfToken !== undefined) headers[CGC_CSRF_HEADER] = this.csrfToken
    return readEnvelope<T>(await this.fetchImpl(path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }))
  }

  // ---- Appendix A route helpers (one per surface consumer) ----

  myWorkspaces<T = unknown>(): Promise<T> {
    return this.get(CGC_PANEL_API.myWorkspaces)
  }

  myEnrollments<T = unknown>(): Promise<T> {
    return this.get(CGC_PANEL_API.myEnrollments)
  }

  tasks<T = unknown>(workspaceId: string): Promise<T> {
    return this.get(CGC_PANEL_API.tasks, { workspace_id: workspaceId })
  }

  learningState<T = unknown>(workspaceId: string, courseId: string): Promise<T> {
    return this.get(CGC_PANEL_API.learningState, { workspace_id: workspaceId, course_id: courseId })
  }

  courseContent<T = unknown>(workspaceId: string, courseId: string): Promise<T> {
    return this.get(courseContentPath(courseId), { workspace_id: workspaceId })
  }

  coursePrep<T = unknown>(workspaceId: string, courseId: string): Promise<T> {
    return this.get(coursePrepPath(courseId), { workspace_id: workspaceId })
  }

  courseRevision<T = unknown>(workspaceId: string, courseId: string): Promise<T> {
    return this.get(courseRevisionPath(courseId), { workspace_id: workspaceId })
  }

  saveCourseContent<T = unknown>(workspaceId: string, courseId: string, content: unknown, baseVersion: number): Promise<T> {
    return this.post(courseContentPath(courseId), {
      workspace_id: workspaceId,
      content,
      base_version: baseVersion,
    })
  }

  discover<T = unknown>(): Promise<T> {
    return this.get(CGC_PANEL_API.discover)
  }

  enrollmentSummary<T = unknown>(workspaceId: string, kind: string, offeringId: string): Promise<T> {
    return this.get(CGC_PANEL_API.enrollmentSummary, {
      workspace_id: workspaceId, kind, offering_id: offeringId,
    })
  }

  createEnrollment<T = unknown>(workspaceId: string, kind: 'event' | 'course', offeringId: string): Promise<T> {
    return this.post(CGC_PANEL_API.enrollments, {
      workspace_id: workspaceId, kind, offering_id: offeringId,
    })
  }

  orderStatus<T = unknown>(workspaceId: string, enrollmentId: string): Promise<T> {
    return this.get(CGC_PANEL_API.orderStatus, { workspace_id: workspaceId, enrollment_id: enrollmentId })
  }

  workspaceCourses<T = unknown>(workspaceId: string): Promise<T> {
    return this.get(CGC_PANEL_API.workspaceCourses, { workspace_id: workspaceId })
  }

  workspaceEvents<T = unknown>(workspaceId: string): Promise<T> {
    return this.get(CGC_PANEL_API.workspaceEvents, { workspace_id: workspaceId })
  }

  workspaceOrders<T = unknown>(workspaceId: string): Promise<T> {
    return this.get(CGC_PANEL_API.workspaceOrders, { workspace_id: workspaceId })
  }

  workspaceEnrollments<T = unknown>(workspaceId: string, kind: string, offeringId: string): Promise<T> {
    return this.get(CGC_PANEL_API.workspaceEnrollments, {
      workspace_id: workspaceId, kind, offering_id: offeringId,
    })
  }
}
