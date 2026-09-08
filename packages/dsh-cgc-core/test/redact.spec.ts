/**
 * Redact tests (U7, F7 negative path): token shapes, Bearer headers, bare
 * JWTs, and the platform's sensitive-key list — the safety net behind every
 * surfaced message.
 */

import { describe, expect, it } from 'vitest'
import { REDACTED, isSensitiveKey, redactText, redactValue } from '../src/redact.ts'

const TOKEN = 'cgc_' + 'a'.repeat(43)
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'

describe('redactText', () => {
  it('scrubs the platform token shape, preserving the cgc_ prefix', () => {
    expect(redactText(`request failed for token ${TOKEN} on /mcp`)).toBe(`request failed for token cgc_${REDACTED} on /mcp`)
  })

  it('scrubs Bearer header values case-insensitively', () => {
    expect(redactText(`header: Bearer ${TOKEN}`)).toBe(`header: Bearer ${REDACTED}`)
    expect(redactText(`bearer abc123`)).toBe(`Bearer ${REDACTED}`)
  })

  it('scrubs bare JWTs', () => {
    expect(redactText(`saw ${JWT} in payload`)).toBe(`saw ${REDACTED} in payload`)
  })

  it('leaves ordinary text and non-token cgc_ shapes untouched', () => {
    expect(redactText('CGC-2046 MCP server returned HTTP 502')).toBe('CGC-2046 MCP server returned HTTP 502')
    expect(redactText('cgc_short is not a token')).toBe('cgc_short is not a token')
  })

  it('is idempotent', () => {
    const once = redactText(`${TOKEN} Bearer x ${JWT}`)
    expect(redactText(once)).toBe(once)
  })
})

describe('isSensitiveKey', () => {
  it('matches exact, snake suffix, camelCase tail (case-insensitive exact)', () => {
    for (const key of ['token', 'Token', 'plain_token', 'access_token', 'apiToken', 'refreshToken', 'password', 'authorization']) {
      expect(isSensitiveKey(key), key).toBe(true)
    }
  })

  it('rejects innocent keys', () => {
    for (const key of ['workspace_id', 'monkey', 'plaintoken', 'tokens', 'tokenize', 'status', 'url']) {
      expect(isSensitiveKey(key), key).toBe(false)
    }
  })
})

describe('redactValue', () => {
  it('redacts sensitive-keyed values recursively through maps and lists', () => {
    const input = {
      workspace_id: 'w1',
      plain_token: TOKEN,
      nested: [{ accessToken: 'abc', keep: 'me' }, { auth: 'x' }],
    }
    expect(redactValue(input)).toEqual({
      workspace_id: 'w1',
      plain_token: REDACTED,
      nested: [{ accessToken: REDACTED, keep: 'me' }, { auth: REDACTED }],
    })
  })

  it('still scrubs token shapes smuggled under innocent keys', () => {
    expect(redactValue({ note: `token was ${TOKEN}` })).toEqual({ note: `token was cgc_${REDACTED}` })
  })

  it('passes primitives through', () => {
    expect(redactValue(42)).toBe(42)
    expect(redactValue(null)).toBe(null)
    expect(redactValue(true)).toBe(true)
  })
})
