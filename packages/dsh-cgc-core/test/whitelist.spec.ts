/**
 * Whitelist invariant tests (R19 / KTD5), verified against the frozen
 * CONTRACT.md contract-checklist rather than any sibling-owned constant
 * (the wave contract forbids importing CGC_CONFIRMATION_TOOLS here):
 *
 * - no whitelist row names confirm_operation / cancel_operation or any of
 *   the 26 confirmation-flow (`gate`) tools — the confirmation flow is
 *   structurally unreachable over HTTP;
 * - write-route tools are a subset of the platform's DIRECT writes
 *   (CGC_WRITE_TOOLS minus the confirmation set);
 * - every whitelisted tool is a real platform tool (checklist `tool` set) —
 *   a typo in the table fails here, not in production.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CGC_WRITE_TOOLS } from '../src/protocol.ts'
import { ROUTE_WHITELIST, WHITELISTED_TOOLS, WHITELISTED_WRITE_TOOLS } from '../src/whitelist.ts'

/** Parse the frozen contract-checklist block out of CONTRACT.md. */
function contractChecklist(): { tools: Set<string>; gates: Set<string> } {
  const contractPath = path.join(__dirname, '..', '..', '..', 'CONTRACT.md')
  const block = readFileSync(contractPath, 'utf8').match(/```contract-checklist\n([\s\S]*?)```/)
  if (block === null) throw new Error('CONTRACT.md: contract-checklist block not found')
  const tools = new Set<string>()
  const gates = new Set<string>()
  for (const line of block[1]?.split('\n') ?? []) {
    if (line.startsWith('tool ')) tools.add(line.slice(5).trim())
    if (line.startsWith('gate ')) gates.add(line.slice(5).trim())
  }
  return { tools, gates }
}

describe('route whitelist invariants', () => {
  const { tools, gates } = contractChecklist()
  const confirmationFlow = new Set([...gates, 'confirm_operation', 'cancel_operation'])

  it('covers exactly the 16 tool-backed Appendix A rows', () => {
    expect(Object.keys(ROUTE_WHITELIST)).toHaveLength(16)
    expect(new Set(WHITELISTED_TOOLS).size).toBe(16)
  })

  it('no confirmation-flow tool appears in any whitelist row', () => {
    for (const tool of WHITELISTED_TOOLS) {
      expect(confirmationFlow.has(tool), `${tool} must stay unreachable over HTTP`).toBe(false)
    }
  })

  it('write-route tools are a subset of the platform direct writes', () => {
    const directWrites = new Set(CGC_WRITE_TOOLS.filter(tool => !confirmationFlow.has(tool)))
    expect(WHITELISTED_WRITE_TOOLS.length).toBeGreaterThan(0)
    for (const tool of WHITELISTED_WRITE_TOOLS) {
      expect(directWrites.has(tool), `${tool} is not a platform direct write`).toBe(true)
    }
  })

  it('every whitelisted tool exists in the platform tool set', () => {
    for (const tool of WHITELISTED_TOOLS) {
      expect(tools.has(tool), `${tool} missing from CONTRACT.md tool set`).toBe(true)
    }
  })
})
