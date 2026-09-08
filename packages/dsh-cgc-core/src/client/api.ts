/**
 * Browser-side API client for the /api/dsh-cgc-core route family. The only
 * data access path the panel uses — plain fetch, same origin.
 */

import { CGC_API, type CgcConnectPayload, type CgcStatusBody } from '../protocol.ts'

/** Error carrying the route's JSON error message. */
export class CgcApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CgcApiError'
  }
}

/** Parse a JSON response or throw a CgcApiError. */
async function readJson<T>(response: Response): Promise<T> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new CgcApiError(`HTTP ${response.status}: invalid JSON response`)
  }
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
      ? body.error
      : `HTTP ${response.status}`
    throw new CgcApiError(message)
  }
  return body as T
}

/** The panel's only data entry point. */
export class CgcApi {
  /** GET /status. */
  async status(): Promise<CgcStatusBody> {
    return readJson<CgcStatusBody>(await fetch(CGC_API.status))
  }

  /** POST /connect; returns the post-write status snapshot. */
  async connect(payload: CgcConnectPayload): Promise<CgcStatusBody> {
    const body = await readJson<{ status: CgcStatusBody }>(await fetch(CGC_API.connect, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }))
    return body.status
  }

  /** DELETE /connect; returns the post-clear status snapshot. */
  async disconnect(): Promise<CgcStatusBody> {
    const body = await readJson<{ status: CgcStatusBody }>(await fetch(CGC_API.connect, { method: 'DELETE' }))
    return body.status
  }
}
