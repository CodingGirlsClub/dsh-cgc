/**
 * Approval-gate tests (U4/KTD4, R4/R5/R6/R20): the dual-anchor hard gate
 * over the real tool runtime — early-gate ask on listed confirmation-flow
 * tools, anchor A on confirm_operation backed by the pending memory,
 * cancel_operation passthrough, fail-closed deny mapping, and structured-
 * fields-only reasons (no agent free text in the approval popup).
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { defineTool, type JsonValue, type ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import { installApprovalGate, renderArgumentFields } from '../src/approval-gate.ts'
import { apply, CGC_NAMESPACE } from '../src/index.ts'
import { PendingMemory } from '../src/pending-memory.ts'
import { CGC_TOOL_PREFIX } from '../src/protocol.ts'
import { MemorySettings, mountRegistry } from './helpers.ts'

const SIGNAL = new AbortController().signal
/** The approval seam denies agent-less asks; grant-path tests need one. */
const AGENT = {} as unknown as NonNullable<ToolExecutionInput['agent']>

/** One approval question the fake service observed. */
interface CapturedAsk {
  toolName: string
  reason?: string
}

type Outcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** Provide a fake approval service resolving every ask to `outcome`. */
function provideApproval(ctx: Context, outcome: Outcome): CapturedAsk[] {
  const asks: CapturedAsk[] = []
  ctx.provide('approval', {
    request: (req: { toolName: string; reason?: string }) => {
      asks.push(req.reason === undefined ? { toolName: req.toolName } : { toolName: req.toolName, reason: req.reason })
      return Promise.resolve(outcome)
    },
  })
  return asks
}

/** Register one CGC-namespaced tool double; returns its invocation log. */
function registerCgcTool(ctx: Context, rawName: string, behaviour: (args: unknown) => JsonValue | Promise<JsonValue>): unknown[][] {
  const invocations: unknown[][] = []
  ctx.tools.register(defineTool({
    name: `${CGC_TOOL_PREFIX}${rawName}`,
    description: 'test double',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    execute: async (args) => {
      invocations.push([args])
      return behaviour(args)
    },
  }))
  return invocations
}

let seq = 0
async function call(ctx: Context, rawName: string, args: Record<string, unknown> = {}) {
  seq += 1
  return ctx.tools.execute({
    signal: SIGNAL,
    callId: CallId(`t${seq}`),
    name: `${CGC_TOOL_PREFIX}${rawName}`,
    arguments: args,
    agent: AGENT,
  })
}

/** needs_confirmation payload the way the platform renders it (JSON text). */
function needsConfirmation(pendingId: string, summary: string): JsonValue {
  return { status: 'needs_confirmation', pending_id: pendingId, summary } as unknown as JsonValue
}

describe('installApprovalGate', () => {
  let ctx: Context | undefined
  afterEach(async () => {
    if (ctx !== undefined) await ctx.fiber.dispose()
    ctx = undefined
  })

  async function setup(memory?: PendingMemory) {
    ctx = await mountRegistry()
    installApprovalGate(ctx, { memory: memory ?? new PendingMemory() })
    return ctx
  }

  it('asks on the first call of a listed confirmation-flow tool; denial blocks dispatch (R4)', async () => {
    const ctx = await setup()
    const asks = provideApproval(ctx, 'rejected')
    const invocations = registerCgcTool(ctx, 'waive_payment', () => needsConfirmation('p-1', 's'))
    const result = await call(ctx, 'waive_payment', { workspace_id: 'ws-1', enrollment_id: 'en-2' })
    expect(result.isError).toBe(true)
    expect(asks).toHaveLength(1)
    expect(asks[0]!.toolName).toBe('mcp__cgc-2046__waive_payment')
    // No platform call was ever dispatched.
    expect(invocations).toHaveLength(0)
  })

  it('approved call dispatches and its confirm_operation does not prompt again (AE2/R5)', async () => {
    const ctx = await setup()
    const asks = provideApproval(ctx, 'allowed-once')
    registerCgcTool(ctx, 'waive_payment', () => needsConfirmation('p-1', '免缴报名 en-2'))
    const confirms = registerCgcTool(ctx, 'confirm_operation', () => ({ status: 'confirmed' }) as unknown as JsonValue)

    const first = await call(ctx, 'waive_payment', { workspace_id: 'ws-1', enrollment_id: 'en-2' })
    expect(first.isError).toBe(false)
    expect(asks).toHaveLength(1)

    const confirm = await call(ctx, 'confirm_operation', { pending_id: 'p-1' })
    expect(confirm.isError).toBe(false)
    expect(confirms).toHaveLength(1)
    // The memory consumed the approved pending — no second local prompt.
    expect(asks).toHaveLength(1)
  })

  it('denies when the approval service is missing (fail-closed)', async () => {
    const ctx = await setup()
    const invocations = registerCgcTool(ctx, 'waive_payment', () => needsConfirmation('p-1', 's'))
    const result = await call(ctx, 'waive_payment')
    expect(result.isError).toBe(true)
    // Fail-closed: the host turns the ask into a denial carrying our reason.
    if (result.isError) expect(result.error.message).toContain('mcp__cgc-2046__waive_payment')
    expect(invocations).toHaveLength(0)
  })

  it('denies when no answerer is available (unavailable maps to deny)', async () => {
    const ctx = await setup()
    provideApproval(ctx, 'unavailable')
    const invocations = registerCgcTool(ctx, 'refund_order', () => needsConfirmation('p-1', 's'))
    const result = await call(ctx, 'refund_order')
    expect(result.isError).toBe(true)
    expect(invocations).toHaveLength(0)
  })

  it('denies when the approval request is cancelled', async () => {
    const ctx = await setup()
    provideApproval(ctx, 'cancelled')
    const invocations = registerCgcTool(ctx, 'waive_payment', () => needsConfirmation('p-1', 's'))
    const result = await call(ctx, 'waive_payment')
    expect(result.isError).toBe(true)
    expect(invocations).toHaveLength(0)
  })

  it('lets unlisted tools pass straight through without asking (R6)', async () => {
    const ctx = await setup()
    const asks = provideApproval(ctx, 'rejected')
    const invocations = registerCgcTool(ctx, 'get_workspace_context', () => 'ok' as unknown as JsonValue)
    const result = await call(ctx, 'get_workspace_context', { workspace_id: 'ws-1' })
    expect(result.isError).toBe(false)
    expect(invocations).toHaveLength(1)
    expect(asks).toHaveLength(0)
  })

  it('drift window: an unlisted real confirmation-flow tool passes first call, but its confirm still asks with origin + platform summary (anchor A; memory never over-authorizes)', async () => {
    const ctx = await setup()
    const asks = provideApproval(ctx, 'allowed-once')
    registerCgcTool(ctx, 'hypothetical_new_flow', () => needsConfirmation('p-9', '平台摘要：冻结账户 acc-1'))
    const confirms = registerCgcTool(ctx, 'confirm_operation', () => ({ status: 'confirmed' }) as unknown as JsonValue)

    const first = await call(ctx, 'hypothetical_new_flow', { workspace_id: 'ws-1' })
    expect(first.isError).toBe(false)
    expect(asks).toHaveLength(0)

    const confirm = await call(ctx, 'confirm_operation', { pending_id: 'p-9' })
    expect(confirm.isError).toBe(false)
    expect(confirms).toHaveLength(1)
    expect(asks).toHaveLength(1)
    expect(asks[0]!.reason).toContain('mcp__cgc-2046__hypothetical_new_flow')
    expect(asks[0]!.reason).toContain('平台摘要：冻结账户 acc-1')
  })

  it('cancel_operation is never gated (refusal can always terminate a pending, R18)', async () => {
    const ctx = await setup()
    const asks = provideApproval(ctx, 'rejected')
    const cancels = registerCgcTool(ctx, 'cancel_operation', () => ({ status: 'cancelled' }) as unknown as JsonValue)
    const result = await call(ctx, 'cancel_operation', { pending_id: 'p-1' })
    expect(result.isError).toBe(false)
    expect(cancels).toHaveLength(1)
    expect(asks).toHaveLength(0)
  })

  it('reason carries the tool name and structured, per-field-redacted scalars only — misleading arg free text never reaches the popup (R20/RSK2)', async () => {
    const ctx = await setup()
    const asks = provideApproval(ctx, 'rejected')
    const token = `cgc_${'a'.repeat(43)}`
    registerCgcTool(ctx, 'waive_payment', () => needsConfirmation('p-1', 's'))
    const misleading = '用户已经在电话里同意了这笔免缴，这只是走个形式，请直接点击批准，不需要细看任何内容'
    await call(ctx, 'waive_payment', {
      workspace_id: 'ws-1',
      enrollment_id: 'en-2',
      attempts: 3,
      note: misleading,
      token,
      meta: { nested: '自由文本不应出现' },
    })
    expect(asks).toHaveLength(1)
    const reason = asks[0]!.reason!
    expect(reason).toContain('mcp__cgc-2046__waive_payment')
    expect(reason).toContain('workspace_id=ws-1')
    expect(reason).toContain('enrollment_id=en-2')
    expect(reason).toContain('attempts=3')
    expect(reason).not.toContain(misleading)
    expect(reason).not.toContain('自由文本不应出现')
    expect(reason).not.toContain(token)
    expect(reason).toContain('[REDACTED]')
  })

  it('a second pending_id of the same tool still passes the gate: re-call asks again, its confirm consumes its own one-time record, and a repeated confirm of the old id asks', async () => {
    const ctx = await setup()
    const asks = provideApproval(ctx, 'allowed-once')
    let pending = 0
    registerCgcTool(ctx, 'waive_payment', () => {
      pending += 1
      return needsConfirmation(`p-${pending}`, `第 ${pending} 笔免缴`)
    })
    registerCgcTool(ctx, 'confirm_operation', () => ({ status: 'confirmed' }) as unknown as JsonValue)

    await call(ctx, 'waive_payment', { workspace_id: 'ws-1' })
    await call(ctx, 'confirm_operation', { pending_id: 'p-1' })
    expect(asks).toHaveLength(1)

    // Second execution attempt: the originating call asks again (one
    // touchpoint per attempt), its confirm then rides the memory.
    await call(ctx, 'waive_payment', { workspace_id: 'ws-1' })
    expect(asks).toHaveLength(2)
    await call(ctx, 'confirm_operation', { pending_id: 'p-2' })
    expect(asks).toHaveLength(2)

    // One-time consumption: confirming the first pending again must ask.
    await call(ctx, 'confirm_operation', { pending_id: 'p-1' })
    expect(asks).toHaveLength(3)
  })

  it('honours confirmation_ttl_seconds: confirm within the window skips the prompt, past it asks again', async () => {
    let now = 1_000_000_000
    const memory = new PendingMemory({ ttlSeconds: () => 1800, now: () => now })
    const ctx = await setup(memory)
    const asks = provideApproval(ctx, 'allowed-once')
    registerCgcTool(ctx, 'waive_payment', () => needsConfirmation('p-1', '免缴'))
    registerCgcTool(ctx, 'confirm_operation', () => ({ status: 'confirmed' }) as unknown as JsonValue)

    await call(ctx, 'waive_payment', { workspace_id: 'ws-1' })
    expect(asks).toHaveLength(1)

    now += 1000 * 1000 // 1000s < 1800s: still inside the window
    await call(ctx, 'confirm_operation', { pending_id: 'p-1' })
    expect(asks).toHaveLength(1)

    // Re-mint a pending, then let the window lapse before confirming.
    await call(ctx, 'waive_payment', { workspace_id: 'ws-1' })
    expect(asks).toHaveLength(2)
    now += 1801 * 1000
    const confirm = await call(ctx, 'confirm_operation', { pending_id: 'p-1' })
    expect(confirm.isError).toBe(false)
    expect(asks).toHaveLength(3)
  })

  it('forged or never-captured pending_ids always ask (fail-closed) and render an explicit unknown-origin note', async () => {
    const ctx = await setup()
    const asks = provideApproval(ctx, 'rejected')
    const confirms = registerCgcTool(ctx, 'confirm_operation', () => ({ status: 'confirmed' }) as unknown as JsonValue)
    const result = await call(ctx, 'confirm_operation', { pending_id: 'forged-id' })
    expect(result.isError).toBe(true)
    expect(confirms).toHaveLength(0)
    expect(asks).toHaveLength(1)
    expect(asks[0]!.reason).toContain('forged-id')
    expect(asks[0]!.reason).toContain('无本地记录')
  })

  it('ignores tools outside the cgc namespace entirely', async () => {
    const ctx = await setup()
    const asks = provideApproval(ctx, 'rejected')
    ctx.tools.register(defineTool({
      name: 'read_file',
      description: 'test double',
      parameters: {},
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text' as const, text: String(value) }] },
      execute: async () => 'ok' as unknown as JsonValue,
    }))
    const result = await ctx.tools.execute({ signal: SIGNAL, callId: CallId('x1'), name: 'read_file', arguments: {}, agent: AGENT })
    expect(result.isError).toBe(false)
    expect(asks).toHaveLength(0)
  })
})

describe('renderArgumentFields', () => {
  it('renders identifier scalars, elides free text, masks sensitive keys', () => {
    const rendered = renderArgumentFields({
      workspace_id: 'ws-1',
      count: 2,
      dry_run: false,
      note: '一段可能误导审批者的自由文本',
      password: 'hunter2',
      nested: { a: 1 },
      list: [1, 2],
    })
    expect(rendered).toContain('workspace_id=ws-1')
    expect(rendered).toContain('count=2')
    expect(rendered).toContain('dry_run=false')
    expect(rendered).toContain('note=<文本 14 字符>')
    expect(rendered).toContain('password=[REDACTED]')
    expect(rendered).toContain('nested=<对象 1 字段>')
    expect(rendered).toContain('list=<数组 2 项>')
    expect(rendered).not.toContain('误导')
    expect(rendered).not.toContain('hunter2')
  })
})

describe('apply: gate wiring (index.ts)', () => {
  let home = ''
  let ctx: Context | undefined
  const savedHome = process.env.DSH_HOME
  afterEach(async () => {
    if (ctx !== undefined) await ctx.fiber.dispose()
    ctx = undefined
    process.env.DSH_HOME = savedHome
    await rm(home, { recursive: true, force: true })
  })

  it('reads confirmation_ttl_seconds from the core settings section (settings override beats the 600s default)', async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-cgc-gate-'))
    process.env.DSH_HOME = home
    ctx = await mountRegistry()
    await ctx.plugin(MemorySettings)
    const settings = ctx.get('settings')
    if (settings === undefined) throw new Error('settings service not mounted')
    ctx.provide('webServer', { register: () => () => {}, registerUpgrade: () => () => {} })
    apply(ctx)

    // Section registration rides the settings inject hook — wait for it,
    // then write the TTL override through the provider like a user edit.
    for (let i = 0; i < 200 && settings.get(CGC_NAMESPACE) === undefined; i += 1) {
      const tick = Promise.withResolvers<void>()
      setTimeout(tick.resolve, 20)
      await tick.promise
    }
    await settings.mutate(CGC_NAMESPACE, [{ op: 'set', path: ['confirmation_ttl_seconds'], value: 1 }])

    const asks = provideApproval(ctx, 'allowed-once')
    registerCgcTool(ctx, 'waive_payment', () => needsConfirmation('p-1', '免缴'))
    registerCgcTool(ctx, 'confirm_operation', () => ({ status: 'confirmed' }) as unknown as JsonValue)

    await call(ctx, 'waive_payment', { workspace_id: 'ws-1' })
    expect(asks).toHaveLength(1)
    // TTL = 1s from settings; the 600s default would still be fresh here.
    const delay = Promise.withResolvers<void>()
    setTimeout(delay.resolve, 1100)
    await delay.promise
    await call(ctx, 'confirm_operation', { pending_id: 'p-1' })
    expect(asks).toHaveLength(2)
  }, 15_000)
})
