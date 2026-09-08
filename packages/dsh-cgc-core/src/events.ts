/**
 * Event channel (U7 / KTD8 / R13): the SOLE exit for CGC tool-activity
 * events. Two host-side sources feed one aggregator — `tools/post-execute`
 * (hooks.ts) and the session log's `session/event` append feed — which
 * dedupes by call id (exactly-once), stamps a monotonic per-process seq,
 * keeps a bounded ring for polling catch-up, mirrors feed-worthy entries
 * into the ActivityLog (activityEntryForObservation is the single feed
 * policy), and broadcasts to the WS subscribers the routes/events.ts
 * upgrade route manages.
 *
 * Payload discipline: tool name + success/failure + a redacted one-line
 * summary (literal replacement first, KTD2/U2) — never arguments, never
 * result payloads, never credential material (AE7). The seq ring is NOT
 * cleared on platform disconnect: seqs stay monotonic across connection
 * generations so a stale panel cursor is detected as a gap rather than
 * silently colliding with a restarted sequence.
 */

import type { Context } from '@deepseek-ai/cordis'
import { activityEntryForObservation, type ActivityLog, type CgcToolObservation } from './activity.ts'
import { CGC_TOOL_PREFIX, type CgcErrorCode } from './protocol.ts'
import { redactText } from './redact.ts'

/** seq ring capacity: fixed length; overflow evicts the oldest entries. */
export const EVENT_BUFFER_LIMIT = 200

/** One event on the panel wire (WS frame payload and polling rows). */
export interface CgcEvent {
  /** Monotonic per-process sequence, 1-based. */
  seq: number
  /** Epoch milliseconds. */
  at: number
  /** Full public tool name (`mcp__cgc-2046__<raw>`). */
  tool: string
  /** Whether the call succeeded. */
  ok: boolean
  /** Redacted one-line summary ('ok' on success). */
  summary: string
  /** The bridge's machine code when the call failed. */
  code?: string
  /** The call's workspace_id when it was a plain string. */
  workspaceId?: string
}

/**
 * GET /events?afterSeq= value (U8 consumes this shape). On `gap: true` the
 * caller's cursor fell out of the retained window: drop it, full-refetch
 * via the U6 data routes, then resume polling from `latestSeq`.
 */
export interface CgcEventsPage {
  /** Cursor fell out of the retained window (full-refetch signal). */
  gap: boolean
  /** Events with seq > afterSeq, seq-ascending; on a gap, the retained window. */
  events: CgcEvent[]
  /** High-water mark — the cursor for the next poll. */
  latestSeq: number
  /** Gap only: the oldest retained seq. */
  oldestSeq?: number
}

/**
 * The aggregator. Dedupe: the first source to report a call id wins
 * (post-execute normally lands before the session commit and carries the
 * richer redacted message; the session feed covers pipeline failures that
 * bypass the post-execute waterfall). Dedupe state is a FIFO set bounded
 * to the ring capacity — a repeat observation of a live call id is dropped,
 * so one call produces exactly one ring entry, exactly one WS frame, and
 * at most one ActivityLog record.
 */
export class CgcEventHub {
  private seq = 0
  private ring: CgcEvent[] = []
  private seen = new Set<string>()
  private subscribers = new Set<(event: CgcEvent) => void>()

  constructor(
    private readonly activity: ActivityLog,
    private readonly secrets: () => readonly string[] = () => [],
    readonly limit: number = EVENT_BUFFER_LIMIT,
  ) {}

  /** High-water mark (0 before the first event). */
  get latestSeq(): number {
    return this.seq
  }

  /**
   * Record one tool-call observation. Returns the stamped event, or
   * undefined when the call id was already recorded (dual-source repeat).
   */
  observe(obs: CgcToolObservation): CgcEvent | undefined {
    if (obs.callId !== undefined) {
      if (this.seen.has(obs.callId)) return undefined
      this.seen.add(obs.callId)
      if (this.seen.size > this.limit) {
        const oldest = this.seen.values().next().value
        if (oldest !== undefined) this.seen.delete(oldest)
      }
    }
    const event: CgcEvent = {
      seq: ++this.seq,
      at: Date.now(),
      tool: obs.tool,
      ok: obs.ok,
      summary: obs.ok ? 'ok' : redactText(obs.message ?? obs.code ?? 'error', this.secrets()),
      ...obs.ok || obs.code === undefined ? {} : { code: obs.code },
      ...obs.workspaceId === undefined ? {} : { workspaceId: obs.workspaceId },
    }
    this.ring.push(event)
    if (this.ring.length > this.limit) this.ring.shift()
    const feed = activityEntryForObservation({ ...obs, message: event.summary }, event.at)
    if (feed !== undefined) this.activity.push(feed)
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber(event)
      } catch {
        // A misbehaving subscriber forfeits its seat; the ring keeps the record.
        this.subscribers.delete(subscriber)
      }
    }
    return event
  }

  /**
   * The polling window: events with seq > afterSeq, or a gap indication
   * when afterSeq predates the oldest retained seq (the panel then drops
   * its cursor and full-refetches via the U6 data routes). A cold cursor
   * (0 / absent) reads the retained window without a gap.
   */
  since(afterSeq: number): CgcEventsPage {
    const events = this.ring.filter(event => event.seq > afterSeq)
    const oldest = this.ring[0]?.seq
    if (afterSeq > 0 && oldest !== undefined && afterSeq < oldest - 1) {
      return { gap: true, events, latestSeq: this.seq, oldestSeq: oldest }
    }
    return { gap: false, events, latestSeq: this.seq }
  }

  /** Subscribe to live events (the WS upgrade route's broadcast seat). */
  subscribe(listener: (event: CgcEvent) => void): () => void {
    this.subscribers.add(listener)
    return () => {
      this.subscribers.delete(listener)
    }
  }
}

/** The slices of the host session event log this channel reads. */
export interface SessionEventLike {
  type?: unknown
  data?: unknown
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Host session append feed (dsh-session's post-commit firehose). The
     * core package does not depend on dsh-session's types; the slices read
     * here are `tool/call` (callId + name pairing) and `tool/result`
     * (callId + outcome), validated defensively at runtime.
     */
    'session/event'(session: unknown, event: SessionEventLike): void
  }
}

/** Reads the tool-result block of a session `tool/result` event, when present. */
function toolResultBlock(data: object): { callId: string; isError: boolean; text: string } | undefined {
  const message = (data as { message?: unknown }).message
  if (message === null || typeof message !== 'object') return undefined
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content) || content.length === 0) return undefined
  const block = content[0] as { toolCallId?: unknown; isError?: unknown; content?: unknown }
  if (typeof block.toolCallId !== 'string') return undefined
  const blocks = Array.isArray(block.content) ? block.content : []
  const text = blocks
    .filter((b): b is { type: 'text'; text: string } =>
      b !== null && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map(b => b.text)
    .join('\n')
  return { callId: block.toolCallId, isError: block.isError === true, text }
}

/**
 * Install the session/event source (KTD8's second feed): pairs `tool/call`
 * names with `tool/result` outcomes for CGC-prefixed tools and observes
 * them into the hub, where the call-id dedupe keeps exactly-once against
 * the post-execute source. Listener failures never reach the firehose.
 * @param ctx - host plugin context (the listener rides the plugin fiber).
 * @param hub - the aggregator.
 * @returns disposer removing the listener.
 */
export function installSessionEventSource(ctx: Context, hub: CgcEventHub): () => void {
  // callId → tool name for CGC calls awaiting their result; bounded FIFO.
  const pending = new Map<string, string>()
  const dispose = ctx.on('session/event', (_session, event) => {
    try {
      if (event === null || typeof event !== 'object') return
      const data = event.data
      if (data === null || typeof data !== 'object') return
      if (event.type === 'tool/call') {
        const { callId, name } = data as { callId?: unknown; name?: unknown }
        if (typeof callId === 'string' && typeof name === 'string' && name.startsWith(CGC_TOOL_PREFIX)) {
          pending.set(callId, name)
          if (pending.size > 4 * hub.limit) {
            const oldest = pending.keys().next().value
            if (oldest !== undefined) pending.delete(oldest)
          }
        }
        return
      }
      if (event.type !== 'tool/result') return
      const block = toolResultBlock(data)
      if (block === undefined) return
      const tool = pending.get(block.callId)
      if (tool === undefined) return
      pending.delete(block.callId)
      const error = (data as { error?: unknown }).error
      const code = error !== null && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code as CgcErrorCode
        : undefined
      const failed = block.isError || code !== undefined
      hub.observe({
        callId: block.callId,
        tool,
        ok: !failed,
        ...code === undefined ? {} : { code },
        ...failed && block.text !== '' ? { message: block.text } : {},
      })
    } catch {
      // The observer must never throw into the host's append feed.
    }
  })
  return () => {
    dispose()
  }
}
