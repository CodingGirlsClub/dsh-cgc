/**
 * Pending-memory unit tests (KTD4 four semantics): granted-association
 * lifecycle, approval keyed to the producing callId, exact-id one-time
 * consumption, and TTL expiry — forged / expired / unapproved pending_ids
 * must never skip anchor A (fail-closed).
 */

import { describe, expect, it } from 'vitest'
import { PendingMemory } from '../src/pending-memory.ts'

const TOOL = 'mcp__cgc-2046__waive_payment'

/** A memory with a controllable clock and TTL. */
function makeMemory(ttlSeconds = 600) {
  let now = 1_000_000_000
  const memory = new PendingMemory({ ttlSeconds: () => ttlSeconds, now: () => now })
  return { memory, advance: (ms: number) => { now += ms } }
}

describe('PendingMemory', () => {
  it('remembers a pending as approved only when its producing callId was granted', () => {
    const { memory } = makeMemory()
    memory.markAsked('c1')
    memory.markGranted('c1')
    memory.capture('c1', 'p-1', TOOL, '免缴报名 en-2')
    const record = memory.describe('p-1')
    expect(record).toMatchObject({ pendingId: 'p-1', originTool: TOOL, summary: '免缴报名 en-2', approved: true })
    expect(memory.consumeApproved('p-1')).toBe(true)
  })

  it('does not mark a pending approved when the call was asked but never dispatched (denied ask)', () => {
    const { memory } = makeMemory()
    memory.markAsked('c1')
    memory.capture('c1', 'p-1', TOOL, undefined)
    expect(memory.describe('p-1')?.approved).toBe(false)
    expect(memory.consumeApproved('p-1')).toBe(false)
  })

  it('does not mark a pending approved for passthrough calls (markGranted without a prior ask is a no-op)', () => {
    const { memory } = makeMemory()
    memory.markGranted('c1')
    memory.capture('c1', 'p-1', TOOL, 'summary')
    expect(memory.describe('p-1')?.approved).toBe(false)
    expect(memory.consumeApproved('p-1')).toBe(false)
  })

  it('clears the granted association when the producing call settles', () => {
    const { memory } = makeMemory()
    memory.markAsked('c1')
    memory.markGranted('c1')
    memory.settleCall('c1')
    memory.capture('c1', 'p-1', TOOL, undefined)
    expect(memory.describe('p-1')?.approved).toBe(false)
  })

  it('consumes an approved pending exactly once (second confirm asks again)', () => {
    const { memory } = makeMemory()
    memory.markAsked('c1')
    memory.markGranted('c1')
    memory.capture('c1', 'p-1', TOOL, undefined)
    expect(memory.consumeApproved('p-1')).toBe(true)
    expect(memory.consumeApproved('p-1')).toBe(false)
    expect(memory.describe('p-1')).toBeUndefined()
  })

  it('keys by exact pending_id', () => {
    const { memory } = makeMemory()
    memory.markAsked('c1')
    memory.markGranted('c1')
    memory.capture('c1', 'p-1', TOOL, undefined)
    expect(memory.consumeApproved('p-1 ')).toBe(false)
    expect(memory.consumeApproved('p-10')).toBe(false)
    expect(memory.consumeApproved('P-1')).toBe(false)
    expect(memory.consumeApproved('p-1')).toBe(true)
  })

  it('fails closed on forged or unknown pending_ids', () => {
    const { memory } = makeMemory()
    expect(memory.consumeApproved('forged')).toBe(false)
    expect(memory.describe('forged')).toBeUndefined()
  })

  it('expires records after the TTL (fresh within the window, forgotten beyond it)', () => {
    const { memory, advance } = makeMemory(1800)
    memory.markAsked('c1')
    memory.markGranted('c1')
    memory.capture('c1', 'p-1', TOOL, undefined)
    advance(1000 * 1000) // 1000s < 1800s
    expect(memory.describe('p-1')).toBeDefined()
    advance(801 * 1000) // now past the 1800s window
    expect(memory.consumeApproved('p-1')).toBe(false)
    expect(memory.describe('p-1')).toBeUndefined()
  })

  it('applies TTL source changes to newly minted entries (existing entries keep their minted expiry)', () => {
    let ttl = 1800
    let now = 0
    const memory = new PendingMemory({ ttlSeconds: () => ttl, now: () => now })
    memory.markAsked('c1')
    memory.markGranted('c1')
    memory.capture('c1', 'p-1', TOOL, undefined) // minted under 1800s
    ttl = 60 // operator tightens the window afterwards
    now = 61 * 1000
    expect(memory.consumeApproved('p-1')).toBe(true) // minted expiry stands
    memory.markAsked('c2')
    memory.markGranted('c2')
    memory.capture('c2', 'p-2', TOOL, undefined) // minted under 60s
    now = 122 * 1000
    expect(memory.consumeApproved('p-2')).toBe(false)
  })


  it('falls back to the 600s default when the TTL source is invalid', () => {
    for (const bad of [Number.NaN, 0, -5]) {
      let now = 0
      const memory = new PendingMemory({ ttlSeconds: () => bad, now: () => now })
      memory.markAsked('c1')
      memory.markGranted('c1')
      memory.capture('c1', 'p-1', TOOL, undefined)
      now = 601 * 1000
      expect(memory.consumeApproved('p-1')).toBe(false)
    }
  })

  it('keeps origin and summary records for unapproved pendings (anchor A reason source)', () => {
    const { memory } = makeMemory()
    memory.capture('c9', 'p-9', 'mcp__cgc-2046__hypothetical_new_flow', '平台摘要：冻结账户')
    const record = memory.describe('p-9')
    expect(record).toMatchObject({
      originTool: 'mcp__cgc-2046__hypothetical_new_flow',
      summary: '平台摘要：冻结账户',
      approved: false,
    })
  })
})
