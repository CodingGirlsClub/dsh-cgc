/**
 * CSRF token store tests (KTD5): host-side generation, constant-time
 * matching, and the bootstrap field that is the token's only exit path.
 */

import { describe, expect, it } from 'vitest'
import { CGC_CSRF_BOOTSTRAP_FIELD, CsrfTokenStore } from '../src/csrf.ts'

describe('CsrfTokenStore', () => {
  it('generates a 256-bit hex token, unique per store', () => {
    const a = new CsrfTokenStore()
    const b = new CsrfTokenStore()
    expect(a.token).toMatch(/^[0-9a-f]{64}$/)
    expect(b.token).toMatch(/^[0-9a-f]{64}$/)
    expect(a.token).not.toBe(b.token)
  })

  it('matches only the exact live token', () => {
    const store = new CsrfTokenStore()
    expect(store.matches(store.token)).toBe(true)
    expect(store.matches(undefined)).toBe(false)
    expect(store.matches('')).toBe(false)
    expect(store.matches(store.token.toUpperCase())).toBe(false)
    expect(store.matches('0'.repeat(64))).toBe(false)
    // Different length must not throw (timingSafeEqual precondition).
    expect(store.matches(store.token.slice(1))).toBe(false)
    expect(store.matches(store.token + '00')).toBe(false)
  })

  it('the bootstrap field is named csrfToken and carries the live token', () => {
    const store = new CsrfTokenStore()
    expect(store.bootstrapField()).toEqual({ [CGC_CSRF_BOOTSTRAP_FIELD]: store.token })
    expect(CGC_CSRF_BOOTSTRAP_FIELD).toBe('csrfToken')
  })
})
