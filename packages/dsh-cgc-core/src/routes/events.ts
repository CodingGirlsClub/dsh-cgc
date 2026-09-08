/**
 * Event-channel routes (U7 / KTD8): the WS upgrade endpoint (primary push)
 * and the seq incremental polling endpoint (fallback). Both sit behind the
 * exact same shared fence as the U6 data plane (RSK3): the upgrade handler
 * refuses non-loopback peers / cross-site origins before any negotiation,
 * and the polling route runs fenceOrReject first.
 *
 * Wire shapes (the panels family, U8, consumes these):
 * - WS GET /api/dsh-cgc-core/events (Upgrade: websocket): on accept the
 *   server sends `{"type":"hello","latestSeq":N}`, then one text frame per
 *   event, `{"type":"event","event":CgcEvent}` (see src/events.ts).
 * - GET /api/dsh-cgc-core/events?afterSeq=N → `{ok:true, value:
 *   CgcEventsPage}`; `value.gap === true` means the cursor fell out of the
 *   retained window — drop it, full-refetch via the U6 data routes, and
 *   resume from `value.latestSeq`. Missing afterSeq reads as 0 (the whole
 *   retained window).
 *
 * The codec is dependency-free: the host's registerUpgrade handler owns
 * protocol negotiation outright, so the handshake (RFC 6455 accept key)
 * and unmasked server→client frames are implemented here directly.
 */

import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { CgcEventHub } from '../events.ts'
import { fenceOrReject, isLoopbackRequest } from '../fence.ts'
import { CGC_API_BASE } from '../protocol.ts'
import { redactText } from '../redact.ts'

/** RFC 6455 accept-key magic. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** One unmasked server→client frame (FIN set). */
function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length
  if (length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, length]), payload])
  if (length < 65536) {
    const header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(length, 2)
    return Buffer.concat([header, payload])
  }
  const header = Buffer.alloc(10)
  header[0] = 0x80 | opcode
  header[1] = 127
  header.writeBigUInt64BE(BigInt(length), 2)
  return Buffer.concat([header, payload])
}

/** One JSON text frame, credential-scrubbed over the serialized payload. */
function sendJson(socket: Duplex, frame: object, secrets: readonly string[]): void {
  if (socket.destroyed || !socket.writable) return
  socket.write(encodeFrame(0x1, Buffer.from(redactText(JSON.stringify(frame), secrets), 'utf8')))
}

/** Refuse an upgrade with a plain HTTP response, then hang up. */
function rejectHandshake(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`, () => {
    socket.destroy()
  })
}

/**
 * Drain client→server frames: reply to pings, honor close, ignore
 * everything else. The panel sends nothing meaningful; this keeps the
 * socket healthy with real browser clients.
 * @returns true once a close frame was answered.
 */
function drainClientFrames(socket: Duplex, state: { buf: Buffer }): boolean {
  for (;;) {
    const buf = state.buf
    if (buf.length < 2) return false
    const opcode = buf[0]! & 0x0f
    const masked = (buf[1]! & 0x80) !== 0
    let length = buf[1]! & 0x7f
    let offset = 2
    if (length === 126) {
      if (buf.length < 4) return false
      length = buf.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (buf.length < 10) return false
      length = Number(buf.readBigUInt64BE(2))
      offset = 10
    }
    const maskLength = masked ? 4 : 0
    if (buf.length < offset + maskLength + length) return false
    const payload = Buffer.from(buf.subarray(offset + maskLength, offset + maskLength + length))
    if (masked) {
      const mask = buf.subarray(offset, offset + 4)
      for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!
    }
    state.buf = buf.subarray(offset + maskLength + length)
    if (opcode === 0x8) {
      socket.end(encodeFrame(0x8, Buffer.alloc(0)))
      return true
    }
    if (opcode === 0x9) socket.write(encodeFrame(0xA, payload))
  }
}

/** The raw upgrade handler, exported for direct in-process testing. */
export function makeEventUpgradeHandler(
  hub: CgcEventHub,
  secrets: () => readonly string[],
): (req: IncomingMessage, socket: Duplex, head: Buffer) => void {
  return (req, socket, head) => {
    socket.on('error', () => {})
    // The shared fence (RSK3): a cross-site or non-loopback handshake is
    // refused before any protocol negotiation happens.
    if (!isLoopbackRequest(req)) {
      rejectHandshake(socket, 403, 'Forbidden')
      return
    }
    const key = req.headers['sec-websocket-key']
    const upgrade = req.headers.upgrade
    if (typeof key !== 'string' || key.trim() === '' || typeof upgrade !== 'string' || upgrade.toLowerCase() !== 'websocket') {
      rejectHandshake(socket, 400, 'Bad Request')
      return
    }
    const accept = createHash('sha1').update(key.trim() + WS_GUID).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    sendJson(socket, { type: 'hello', latestSeq: hub.latestSeq }, secrets())
    const unsubscribe = hub.subscribe(event => {
      sendJson(socket, { type: 'event', event }, secrets())
    })
    const state: { buf: Buffer } = { buf: head.length > 0 ? Buffer.from(head) : Buffer.alloc(0) }
    socket.on('data', (chunk: Buffer) => {
      state.buf = state.buf.length === 0 ? chunk : Buffer.concat([state.buf, chunk])
      drainClientFrames(socket, state)
    })
    socket.on('close', () => {
      unsubscribe()
    })
  }
}

/**
 * Register the WS push endpoint on the host web server.
 * @returns the registerUpgrade disposer.
 */
export function installEventChannel(ctx: Context, hub: CgcEventHub, secrets: () => readonly string[]): () => void {
  return ctx.webServer.registerUpgrade({
    path: CGC_API_BASE + '/events',
    handler: makeEventUpgradeHandler(hub, secrets),
  })
}

/**
 * The seq incremental polling route (WS fallback). Envelope discipline
 * mirrors the U6 pipeline: `{ok:true, value}` / `{ok:false, error:{code,
 * message}}`, redacted over the final serialized body.
 */
export function eventRoutes(hub: CgcEventHub, base: string, secrets: () => readonly string[]): WebRoute[] {
  const write = (res: ServerResponse, status: number, body: unknown): void => {
    const payload = redactText(JSON.stringify(body), secrets())
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
    res.end(payload)
  }
  return [
    {
      kind: 'exact',
      path: base + '/events',
      handler: (req, res) => {
        if (!fenceOrReject(req, res)) return
        if (req.method !== 'GET') {
          write(res, 405, { ok: false, error: { code: 'method_not_allowed', message: `method not allowed: ${req.method}` } })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const raw = url.searchParams.get('afterSeq')
        let afterSeq = 0
        if (raw !== null) {
          if (!/^\d{1,15}$/.test(raw)) {
            write(res, 400, { ok: false, error: { code: 'bad_request', message: 'afterSeq must be a non-negative integer' } })
            return
          }
          afterSeq = Number(raw)
        }
        write(res, 200, { ok: true, value: hub.since(afterSeq) })
      },
    },
  ]
}
