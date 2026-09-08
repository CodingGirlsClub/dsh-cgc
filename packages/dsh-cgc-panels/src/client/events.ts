/**
 * Event channel consumer (U7 wire): WS primary, afterSeq polling fallback.
 *
 * - WS: GET /api/dsh-cgc-core/events upgraded — a `{type:'hello',latestSeq}`
 *   frame arrives first (adopt the cursor), then `{type:'event',event}` per
 *   tool-activity event.
 * - Fallback: when the socket fails to open or drops, poll
 *   GET /events?afterSeq=N. A `{gap:true}` page means the cursor fell out of
 *   the retained window: drop it, signal subscribers to full-refetch through
 *   the data routes, and resume from `latestSeq`.
 * - While polling, the channel retries the WS every `wsRetryMs`; a hello
 *   re-adopts the cursor and polling stops.
 *
 * Timers and the socket factory are injectable so specs drive time and the
 * handshake deterministically (jsdom has no WebSocket).
 */

import type { CgcEvent, CgcEventsPage } from '../protocol.ts'

/** The subset of the browser WebSocket the channel uses. */
export interface WebSocketLike {
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
  close(): void
}

/** Timer pair (globals at call time by default; fake-timer friendly). */
export interface ChannelTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface EventChannelOptions {
  /** The WS endpoint URL (ws:// or wss://). */
  wsUrl: () => string
  /** Polling page fetch (GET /events?afterSeq=N). */
  fetchPage: (afterSeq: number) => Promise<CgcEventsPage>
  /** Socket factory; defaults to the platform WebSocket. */
  createWs?: (url: string) => WebSocketLike
  /** Polling cadence while in fallback (default 3000ms). */
  pollMs?: number
  /** WS re-probe cadence while polling (default 30000ms). */
  wsRetryMs?: number
  timers?: ChannelTimers
}

export type ChannelMode = 'idle' | 'ws' | 'poll'

/** One WS frame on the events wire. */
type WireFrame =
  | { type: 'hello'; latestSeq: number }
  | { type: 'event'; event: CgcEvent }

/** Parse a WS text frame; undefined on anything off-shape (wire boundary). */
function parseFrame(data: unknown): WireFrame | undefined {
  if (typeof data !== 'string') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || !('type' in parsed)) return undefined
  if (parsed.type === 'hello' && 'latestSeq' in parsed && typeof parsed.latestSeq === 'number') {
    return { type: 'hello', latestSeq: parsed.latestSeq }
  }
  if (parsed.type === 'event' && 'event' in parsed) {
    const event = parsed.event
    if (typeof event === 'object' && event !== null && 'seq' in event && typeof event.seq === 'number'
      && 'tool' in event && typeof event.tool === 'string') {
      return { type: 'event', event: event as CgcEvent }
    }
  }
  return undefined
}

const defaultTimers: ChannelTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  // The handle always originates from this module's own setTimeout call.
  clearTimeout: (handle) => { globalThis.clearTimeout(handle as NodeJS.Timeout) },
}

/** The panel family's push-feed consumer. */
export class EventChannel {
  private readonly options: EventChannelOptions
  private readonly timers: ChannelTimers
  private readonly pollMs: number
  private readonly wsRetryMs: number
  private eventListeners = new Set<(event: CgcEvent) => void>()
  private gapListeners = new Set<() => void>()
  private socket: WebSocketLike | undefined
  private pollTimer: unknown
  private wsRetryTimer: unknown
  private running = false
  private channelMode: ChannelMode = 'idle'
  private cursorValue = 0

  constructor(options: EventChannelOptions) {
    this.options = options
    this.timers = options.timers ?? defaultTimers
    this.pollMs = options.pollMs ?? 3000
    this.wsRetryMs = options.wsRetryMs ?? 30000
  }

  get mode(): ChannelMode {
    return this.channelMode
  }

  /** The current seq cursor (test/diagnostic surface). */
  get cursor(): number {
    return this.cursorValue
  }

  /** Subscribe to events (WS frames and polled rows alike). */
  onEvent(fn: (event: CgcEvent) => void): () => void {
    this.eventListeners.add(fn)
    return () => { this.eventListeners.delete(fn) }
  }

  /** Subscribe to gap signals: drop local state and full-refetch. */
  onGap(fn: () => void): () => void {
    this.gapListeners.add(fn)
    return () => { this.gapListeners.delete(fn) }
  }

  /** Open the channel (WS first). Idempotent. */
  start(): void {
    if (this.running) return
    this.running = true
    this.openSocket()
  }

  /** Close the channel and every pending timer. Idempotent. */
  stop(): void {
    this.running = false
    this.channelMode = 'idle'
    const socket = this.socket
    this.socket = undefined
    socket?.close()
    if (this.pollTimer !== undefined) this.timers.clearTimeout(this.pollTimer)
    if (this.wsRetryTimer !== undefined) this.timers.clearTimeout(this.wsRetryTimer)
    this.pollTimer = undefined
    this.wsRetryTimer = undefined
  }

  private createSocket(url: string): WebSocketLike {
    if (this.options.createWs !== undefined) return this.options.createWs(url)
    return new WebSocket(url) as WebSocketLike
  }

  private openSocket(): void {
    if (!this.running) return
    let socket: WebSocketLike
    try {
      socket = this.createSocket(this.options.wsUrl())
    } catch {
      // No WebSocket in this environment — straight to polling.
      this.startPolling()
      return
    }
    this.socket = socket
    socket.onmessage = (message) => {
      const frame = parseFrame(message.data)
      if (frame === undefined) return
      if (frame.type === 'hello') {
        this.cursorValue = frame.latestSeq
        this.channelMode = 'ws'
        // A recovered socket retires the fallback loop.
        if (this.pollTimer !== undefined) this.timers.clearTimeout(this.pollTimer)
        this.pollTimer = undefined
        return
      }
      this.cursorValue = Math.max(this.cursorValue, frame.event.seq)
      for (const fn of [...this.eventListeners]) fn(frame.event)
    }
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.socket = undefined
      if (this.running) this.startPolling()
    }
    socket.onerror = () => {
      if (this.socket !== socket) return
      // Let onclose drive the transition when both fire; otherwise fall back now.
      this.socket = undefined
      try {
        socket.close()
      } catch { /* closing a failed socket is best-effort */ }
      if (this.running) this.startPolling()
    }
  }

  private startPolling(): void {
    if (!this.running) return
    this.channelMode = 'poll'
    this.scheduleWsRetry()
    void this.pollOnce()
  }

  private scheduleWsRetry(): void {
    if (this.wsRetryTimer !== undefined || !this.running) return
    this.wsRetryTimer = this.timers.setTimeout(() => {
      this.wsRetryTimer = undefined
      if (this.running && this.channelMode === 'poll') this.openSocket()
    }, this.wsRetryMs)
  }

  private async pollOnce(): Promise<void> {
    if (!this.running || this.channelMode !== 'poll') return
    try {
      const page = await this.options.fetchPage(this.cursorValue)
      if (!this.running || this.channelMode !== 'poll') return
      if (page.gap) {
        // Cursor fell out of the retained window: drop it, signal
        // full-refetch, resume from the high-water mark (U7 contract).
        this.cursorValue = page.latestSeq
        for (const fn of [...this.gapListeners]) fn()
      } else {
        for (const event of page.events) {
          for (const fn of [...this.eventListeners]) fn(event)
        }
        this.cursorValue = page.latestSeq
      }
    } catch {
      // A failed page keeps the cursor; the next tick retries.
    }
    if (this.running && this.channelMode === 'poll') {
      this.pollTimer = this.timers.setTimeout(() => {
        this.pollTimer = undefined
        void this.pollOnce()
      }, this.pollMs)
    }
  }
}
