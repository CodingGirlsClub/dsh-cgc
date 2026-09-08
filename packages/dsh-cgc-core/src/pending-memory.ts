/**
 * Pending-id memory (KTD4): the state behind the approval gate's "one local
 * touchpoint per execution attempt" rule (R5). Four semantics:
 *
 * 1. An early-gate approval records a short-lived `callId → granted`
 *    association: the pre-execute listener marks the call asked, and the
 *    around-dispatch wrapper promotes it to granted — dispatch is only
 *    reachable through an allow, so reaching it proves the grant.
 * 2. A pending_id captured post-execute is remembered as approved ONLY when
 *    its producing callId holds a granted association; origin tool name and
 *    the platform's server-side summary are recorded unconditionally
 *    (anchor A's confirm reason renders from them even when unapproved).
 * 3. Entries are keyed by exact pending_id and consumed one-time on a
 *    confirm pass — a second confirm of the same id asks again.
 * 4. Entry TTL reads the core setting `confirmation_ttl_seconds`
 *    (default 600, must equal the platform deployment value); forged,
 *    expired, or unapproved pending_ids always ask (fail-closed).
 *
 * Associations are cleaned up when the producing call settles. Everything
 * is in-memory: a restart forgets, and forgotten means "ask again".
 */

import { DEFAULT_CONFIRMATION_TTL_SECONDS } from './protocol.ts'

/** One remembered pending operation. */
export interface PendingRecord {
  /** Exact platform pending_id (the map key). */
  readonly pendingId: string
  /** Public name of the tool call that produced it (`mcp__cgc-2046__*`). */
  readonly originTool: string
  /** Platform server-side summary from the needs_confirmation payload. */
  readonly summary: string | undefined
  /** The producing call was approved by the early gate (R5 skip eligibility). */
  readonly approved: boolean
  /** Epoch milliseconds after which the record no longer skips anchor A. */
  readonly expiresAt: number
}

/** PendingMemory tuning knobs. */
export interface PendingMemoryOptions {
  /** Live TTL source (seconds); re-read per check so settings edits apply. */
  readonly ttlSeconds?: () => number
  /** Clock override for tests; epoch milliseconds. */
  readonly now?: () => number
}

export class PendingMemory {
  private readonly ttlSeconds: () => number
  private readonly now: () => number
  /** callIds whose early-gate ask was issued; dispatch promotes to granted. */
  private readonly asked = new Set<string>()
  /** callId → association expiry (granted approvals, short-lived). */
  private readonly granted = new Map<string, number>()
  /** Exact pending_id → record. */
  private readonly pendings = new Map<string, PendingRecord>()

  constructor(options?: PendingMemoryOptions) {
    this.ttlSeconds = options?.ttlSeconds ?? (() => DEFAULT_CONFIRMATION_TTL_SECONDS)
    this.now = options?.now ?? (() => Date.now())
  }

  /** Pre-execute: the early gate issued an ask for this call. */
  markAsked(callId: string): void {
    this.prune()
    this.asked.add(callId)
  }

  /**
   * Around-dispatch: the call is actually running, so its ask was granted.
   * No-op for calls the gate never asked (passthrough tools, drift window).
   */
  markGranted(callId: string): void {
    if (!this.asked.has(callId)) return
    this.asked.delete(callId)
    this.granted.set(callId, this.now() + this.ttlMs())
  }

  /**
   * Post-execute: remember a captured pending_id. `approved` is true only
   * when the producing callId holds a live granted association — a
   * passthrough confirmation-flow tool's pending stays unapproved, so its
   * confirm still meets anchor A (the memory never over-authorizes).
   */
  capture(callId: string, pendingId: string, originTool: string, summary: string | undefined): void {
    this.prune()
    const grantExpiry = this.granted.get(callId)
    const approved = grantExpiry !== undefined && grantExpiry > this.now()
    this.pendings.set(pendingId, {
      pendingId,
      originTool,
      summary,
      approved,
      expiresAt: this.now() + this.ttlMs(),
    })
  }

  /** Post-execute (any outcome): drop the call's associations. */
  settleCall(callId: string): void {
    this.asked.delete(callId)
    this.granted.delete(callId)
  }

  /**
   * Anchor A pre-check: consume the record when it is present, approved,
   * and fresh — the confirm then proceeds without a second prompt. Exact id
   * keying; a successful consume deletes the record (one-time). Forged,
   * expired, and unapproved ids return false and are left for rendering.
   */
  consumeApproved(pendingId: string): boolean {
    this.prune()
    const record = this.pendings.get(pendingId)
    if (record === undefined || !record.approved || record.expiresAt <= this.now()) return false
    this.pendings.delete(pendingId)
    return true
  }

  /**
   * Anchor A reason source: the record for one pending_id, or undefined
   * when unknown or expired (pruned records render as unknown origin — the
   * gate still asks, fail-closed).
   */
  describe(pendingId: string): PendingRecord | undefined {
    this.prune()
    const record = this.pendings.get(pendingId)
    if (record === undefined || record.expiresAt <= this.now()) return undefined
    return record
  }

  private ttlMs(): number {
    const seconds = this.ttlSeconds()
    return (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_CONFIRMATION_TTL_SECONDS) * 1000
  }

  /** Drop expired granted-associations and pending records. */
  private prune(): void {
    const now = this.now()
    for (const [callId, expiresAt] of this.granted) {
      if (expiresAt <= now) this.granted.delete(callId)
    }
    for (const [pendingId, record] of this.pendings) {
      if (record.expiresAt <= now) this.pendings.delete(pendingId)
    }
  }
}
