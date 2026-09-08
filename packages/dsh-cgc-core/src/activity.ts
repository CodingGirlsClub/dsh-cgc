/**
 * Recent-activity ring: the panel's "最近活动" feed. In-memory only,
 * newest-first, bounded, cleared on disconnect (R9: a client-side
 * recent-activity list, not audit-grade evidence).
 *
 * U7 generalizes the ring's input to panel-readable tool-call
 * observations: every writer (the post-execute hook and the event
 * aggregator) maps through activityEntryForObservation, the single
 * feed-policy definition, so the two paths can never drift.
 */

import {
  CGC_CONNECTION_ERROR_CODES,
  CGC_TOOL_PREFIX,
  CGC_WRITE_TOOLS,
  type CgcActivityEntry,
  type CgcErrorCode,
} from './protocol.ts'

/**
 * One panel-readable CGC tool-call observation (U7): the shared input the
 * post-execute hook and the session/event source both hand to the event
 * aggregator. Never carries arguments or result payloads.
 */
export interface CgcToolObservation {
  /** Provider-issued call id when the source knows it (the dedupe key). */
  callId?: string
  /** Full public tool name (`mcp__cgc-2046__<raw>`). */
  tool: string
  /** Whether the call succeeded. */
  ok: boolean
  /** The bridge's machine code when the call failed. */
  code?: CgcErrorCode
  /** Human-readable error text, already credential-redacted by the caller. */
  message?: string
  /** The call's workspace_id when it was a plain string. */
  workspaceId?: string
}

/**
 * Map one observation to the feed entry it earns, or undefined when the
 * call stays out of the feed. The feed policy (R9 scope): connection-class
 * failures and successful write operations are recorded; business failures
 * and plain reads stay in the agent conversation only.
 * @param obs - the observation (message already redacted).
 * @param at - epoch milliseconds stamped on the entry.
 */
export function activityEntryForObservation(obs: CgcToolObservation, at: number): CgcActivityEntry | undefined {
  if (!obs.ok) {
    if (obs.code === undefined || !CGC_CONNECTION_ERROR_CODES.includes(obs.code)) return undefined
    return { kind: 'error', at, source: 'tool', code: obs.code, message: obs.message ?? '', tool: obs.tool }
  }
  const rawName = obs.tool.startsWith(CGC_TOOL_PREFIX) ? obs.tool.slice(CGC_TOOL_PREFIX.length) : obs.tool
  if (!CGC_WRITE_TOOLS.includes(rawName)) return undefined
  return {
    kind: 'write',
    at,
    tool: obs.tool,
    ...obs.workspaceId === undefined ? {} : { workspaceId: obs.workspaceId },
  }
}

/** Default ring capacity. */
export const ACTIVITY_LIMIT = 50

/** Bounded newest-first activity buffer. */
export class ActivityLog {
  private entries: CgcActivityEntry[] = []

  constructor(readonly limit: number = ACTIVITY_LIMIT) {}

  /** Append one entry at the head, evicting the oldest past the cap. */
  push(entry: CgcActivityEntry): void {
    this.entries.unshift(entry)
    if (this.entries.length > this.limit) this.entries.length = this.limit
  }

  /** Newest-first snapshot (detached copy). */
  list(): CgcActivityEntry[] {
    return [...this.entries]
  }

  /** Disconnect semantics: the feed belongs to a connection generation. */
  clear(): void {
    this.entries = []
  }
}

