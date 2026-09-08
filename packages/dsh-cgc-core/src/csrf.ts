/**
 * CSRF defense for the data-plane write routes (KTD5).
 *
 * The token is generated once on the host side at plugin start and held in
 * process memory only. It reaches the plugin's own panel frontend as the
 * `csrfToken` client bootstrap field (injected by the host half through the
 * client bootstrap channel — the same `describe({redactSecrets: true})`
 * surface the GUI already trusts), and is deliberately NOT served by any
 * public route and NEVER written into a route response body: a cross-site
 * page cannot read the bootstrap channel, so it cannot mint a valid write
 * request. The token is not a credential (it authenticates the page origin,
 * not the user — RSK5), so bootstrap redaction must not strip it; the field
 * is declared separately from the settings secret roles.
 *
 * Write routes require the `X-CGC-CSRF-Token` header to match; comparison
 * is constant-time (alignment with the host's secure_compare precedent —
 * loopback makes this unexploitable in practice, it is defense hygiene).
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'

/** Request header carrying the CSRF proof on write routes. */
export const CGC_CSRF_HEADER = 'x-cgc-csrf-token'

/** Client bootstrap field name the panel reads the token from. */
export const CGC_CSRF_BOOTSTRAP_FIELD = 'csrfToken'

/** Process-lifetime CSRF token holder (one per plugin activation). */
export class CsrfTokenStore {
  /** The live token; 256 bits, hex-encoded. */
  readonly token: string

  constructor(token?: string) {
    this.token = token ?? randomBytes(32).toString('hex')
  }

  /** Constant-time match of a presented header value against the live token. */
  matches(presented: string | undefined): boolean {
    if (presented === undefined) return false
    const a = Buffer.from(presented)
    const b = Buffer.from(this.token)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  /**
   * The client bootstrap payload the host half injects into its own panel
   * frontend. This is the ONLY sanctioned way the token leaves the process.
   */
  bootstrapField(): Record<string, string> {
    return { [CGC_CSRF_BOOTSTRAP_FIELD]: this.token }
  }
}
