/**
 * Fence unit tests (KTD5): the shared loopback gate used by the data routes
 * and (U7) the event channel. The strict host:port Origin equality is the
 * load-bearing semantic — the openclacky-ext fence compared host-only and
 * that was its documented weakness; it must not regress here.
 */

import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { isLoopbackRequest } from '../src/fence.ts'

/** Minimal IncomingMessage stand-in: the fence reads socket + headers only. */
function req(opts: {
  remoteAddress?: string
  host?: string
  origin?: string
  secFetchSite?: string
}): IncomingMessage {
  const headers: Record<string, string> = {}
  if (opts.host !== undefined) headers.host = opts.host
  if (opts.origin !== undefined) headers.origin = opts.origin
  if (opts.secFetchSite !== undefined) headers['sec-fetch-site'] = opts.secFetchSite
  return {
    socket: { remoteAddress: opts.remoteAddress ?? '127.0.0.1' },
    headers,
  } as unknown as IncomingMessage
}

describe('isLoopbackRequest', () => {
  it('accepts loopback peers with loopback hosts', () => {
    expect(isLoopbackRequest(req({ host: '127.0.0.1:8080' }))).toBe(true)
    expect(isLoopbackRequest(req({ host: 'localhost:3000' }))).toBe(true)
    expect(isLoopbackRequest(req({ remoteAddress: '::1', host: '[::1]:8080' }))).toBe(true)
    expect(isLoopbackRequest(req({ remoteAddress: '::ffff:127.0.0.1', host: '127.0.0.1:8080' }))).toBe(true)
  })

  it('rejects non-loopback peers', () => {
    expect(isLoopbackRequest(req({ remoteAddress: '192.168.1.5', host: '127.0.0.1:8080' }))).toBe(false)
    expect(isLoopbackRequest(req({ remoteAddress: '::ffff:10.0.0.2', host: 'localhost' }))).toBe(false)
  })

  it('rejects foreign or absent Host headers', () => {
    expect(isLoopbackRequest(req({ host: 'evil.example.com' }))).toBe(false)
    expect(isLoopbackRequest(req({}))).toBe(false)
    expect(isLoopbackRequest(req({ host: '127.0.0.1:abc' }))).toBe(false)
  })

  it('rejects cross-site browser markers', () => {
    expect(isLoopbackRequest(req({ host: '127.0.0.1:8080', secFetchSite: 'cross-site' }))).toBe(false)
    // same-origin / same-site markers stay allowed.
    expect(isLoopbackRequest(req({ host: '127.0.0.1:8080', secFetchSite: 'same-origin' }))).toBe(true)
  })

  it('Origin must match Host with strict host:port equality', () => {
    expect(isLoopbackRequest(req({ host: '127.0.0.1:8080', origin: 'http://127.0.0.1:8080' }))).toBe(true)
    // Same host, different port: refused (the ext fence's host-only weakness).
    expect(isLoopbackRequest(req({ host: '127.0.0.1:8080', origin: 'http://127.0.0.1:9090' }))).toBe(false)
    expect(isLoopbackRequest(req({ host: 'localhost:8080', origin: 'http://localhost:80' }))).toBe(false)
    expect(isLoopbackRequest(req({ host: '127.0.0.1:8080', origin: 'http://evil.example.com:8080' }))).toBe(false)
    expect(isLoopbackRequest(req({ host: '127.0.0.1:8080', origin: 'not a url' }))).toBe(false)
  })
})
