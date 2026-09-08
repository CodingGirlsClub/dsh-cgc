/**
 * The shared surface state contract (Appendix B): every one of the seven
 * surfaces renders through these states, so loading / disconnection /
 * permission / failure / emptiness read identically across the family.
 */

import { ApiError } from './api.ts'

export type SurfaceState<T> =
  | { kind: 'loading' }
  | { kind: 'not-connected' }
  | { kind: 'permission'; reason: 'forbidden' | 'token-invalid'; message: string }
  | { kind: 'error'; message: string; retryAfter: number | undefined }
  | { kind: 'empty' }
  | { kind: 'ready'; value: T }

/** Map a fetch failure onto the shared contract. */
export function stateFromError<T>(error: unknown): SurfaceState<T> {
  if (error instanceof ApiError) {
    if (error.status === 503 || error.code === 'not_connected') return { kind: 'not-connected' }
    if (error.status === 401) return { kind: 'permission', reason: 'token-invalid', message: error.message }
    if (error.status === 403 || error.code === 'forbidden') return { kind: 'permission', reason: 'forbidden', message: error.message }
    return { kind: 'error', message: error.message, retryAfter: error.retryAfter }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { kind: 'error', message, retryAfter: undefined }
}
