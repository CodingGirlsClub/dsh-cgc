/**
 * Credential redaction for every text/value the plugin surfaces: activity
 * entries, route error bodies, log lines. Three layers, mirroring the
 * platform's own Cgc2046.Mcp.Redact plus token-shape scrubbing:
 *
 * 0. Live literals (RSK6): the current connection token is replaced
 *    verbatim first — a token that no longer matches the shape regex
 *    (format evolution, encoding variants) still cannot leak.
 * 1. String shapes: connection tokens (`cgc_` + 43 base64url), Bearer
 *    header values, and bare JWTs are replaced in free text.
 * 2. Key names: in structured values, keys matching the platform's
 *    sensitive list (exact / `_xxx` snake suffix / `Xxx` camelCase tail,
 *    case-insensitive) have their values replaced; maps and lists recurse.
 *
 * The bridge never embeds the Authorization header in messages to begin
 * with; this module is the safety net that keeps it that way.
 */

/** Replacement marker (same literal the platform uses). */
export const REDACTED = '[REDACTED]'

/** Platform connection token: `cgc_` + 43 base64url chars (token.ex). */
const CGC_TOKEN_PATTERN = /cgc_[A-Za-z0-9_-]{43}/g

/** Bearer credential in header-shaped text. */
const BEARER_PATTERN = /bearer\s+[^\s"']+/gi

/** Bare JWT (header.payload.signature, all base64url). */
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g

/**
 * Scrub credentials from free text. Applied to every error message before
 * it reaches the activity log, a route response, or a log line.
 * @param text - the free text to scrub.
 * @param secrets - live secret literals (e.g. the current connection token)
 *   replaced verbatim BEFORE the shape pass (RSK6); empty strings ignored.
 */
export function redactText(text: string, secrets: readonly string[] = []): string {
  let out = text
  for (const secret of secrets) {
    if (secret !== '') out = out.split(secret).join(REDACTED)
  }
  return out
    .replace(CGC_TOKEN_PATTERN, `cgc_${REDACTED}`)
    .replace(BEARER_PATTERN, `Bearer ${REDACTED}`)
    .replace(JWT_PATTERN, REDACTED)
}

/** The platform's sensitive key list (redact.ex @sensitive_keys). */
const SENSITIVE_KEYS: readonly string[] = [
  'token',
  'password',
  'secret',
  'authorization',
  'auth',
  'bearer',
  'api_key',
  'apikey',
  'access_token',
  'refresh_token',
  'plain_token',
  'token_hash',
]

/**
 * camelCase tail match, mirroring redact.ex: the raw key ends with the
 * Capitalized sensitive word and the preceding char is lowercase
 * (`apiToken` hits `token`; `Token` itself and `monkey` do not).
 */
function camelTailMatch(raw: string, sensitive: string): boolean {
  const cap = sensitive.charAt(0).toUpperCase() + sensitive.slice(1)
  if (!raw.endsWith(cap)) return false
  const prefix = raw.slice(0, raw.length - cap.length)
  if (prefix === '') return false
  const last = prefix.charCodeAt(prefix.length - 1)
  return last >= 97 && last <= 122
}

/** Whether a key name names a credential (exact, snake suffix, camel tail). */
export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase()
  return SENSITIVE_KEYS.some(
    sensitive =>
      normalized === sensitive ||
      normalized.endsWith(`_${sensitive}`) ||
      camelTailMatch(key, sensitive),
  )
}

/**
 * Recursively redact sensitive-keyed values in a structured value. Strings
 * reached under non-sensitive keys still get the free-text scrub — a
 * hand-rolled payload can always smuggle a token under an innocent name.
 */
export function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue)
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? REDACTED : redactValue(child)
    }
    return out
  }
  if (typeof value === 'string') return redactText(value)
  return value
}
