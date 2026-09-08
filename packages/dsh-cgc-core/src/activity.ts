/**
 * Recent-activity ring: the panel's "最近活动" feed. In-memory only,
 * newest-first, bounded, cleared on disconnect (R9: a client-side
 * recent-activity list, not audit-grade evidence).
 */

import type { CgcActivityEntry } from './protocol.ts'

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
