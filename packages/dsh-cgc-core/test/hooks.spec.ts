/**
 * Hook tests (U7/KTD4): the tools/post-execute observer records CGC
 * connection-class failures (redacted) and write-tool activity, and ignores
 * business failures, non-CGC tools, and plain reads.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { CallId, HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
import { ActivityLog } from '../src/activity.ts'
import { installErrorHook } from '../src/hooks.ts'
import { CGC_MCP_AUTH, CGC_MCP_BUSINESS } from '../src/protocol.ts'
import { mountRegistry } from './helpers.ts'

const TOKEN = 'cgc_' + 'a'.repeat(43)
const SIGNAL = new AbortController().signal

/** Register one CGC-namespaced tool with the given behaviour. */
function registerCgcTool(ctx: Context, rawName: string, execute: () => Promise<JsonValue>): void {
  ctx.tools.register(defineTool({
    name: `mcp__cgc-2046__${rawName}`,
    description: 'test double',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    execute,
  }))
}

async function call(ctx: Context, name: string, args: Record<string, unknown> = {}) {
  return ctx.tools.execute({ signal: SIGNAL, callId: CallId('t1'), name, arguments: args })
}

describe('installErrorHook', () => {
  let ctx: Context | undefined
  afterEach(async () => {
    if (ctx !== undefined) await ctx.fiber.dispose()
    ctx = undefined
  })

  async function setup() {
    ctx = await mountRegistry()
    const activity = new ActivityLog()
    installErrorHook(ctx, activity)
    return { activity }
  }

  it('records connection-class failures with the code, redacted (F7)', async () => {
    const { activity } = await setup()
    registerCgcTool(ctx!, 'save_step_output', async () => {
      throw new HarnessError(`CGC-2046 authentication failed for Bearer ${TOKEN}`, CGC_MCP_AUTH)
    })
    const result = await call(ctx!, 'mcp__cgc-2046__save_step_output')
    expect(result.isError).toBe(true)
    const entries = activity.list()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'error', source: 'tool', code: CGC_MCP_AUTH, tool: 'mcp__cgc-2046__save_step_output' })
    expect(JSON.stringify(entries)).not.toContain(TOKEN)
  })

  it('strips the live token literal even when it misses the shape regex (RSK6)', async () => {
    // A rotated token format the shape regexes do not match.
    const weirdToken = 'cgc2!rotated-format'
    ctx = await mountRegistry()
    const activity = new ActivityLog()
    installErrorHook(ctx, activity, () => [weirdToken])
    registerCgcTool(ctx, 'waive_payment', async () => {
      throw new HarnessError(`CGC-2046 authentication failed for ${weirdToken}`, CGC_MCP_AUTH)
    })
    const result = await call(ctx, 'mcp__cgc-2046__waive_payment')
    expect(result.isError).toBe(true)
    const entries = activity.list()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'error', source: 'tool', code: CGC_MCP_AUTH })
    expect(JSON.stringify(entries)).not.toContain(weirdToken)
    expect(JSON.stringify(entries)).toContain('[REDACTED]')
  })

  it('does not record business failures (they stay in the conversation)', async () => {
    const { activity } = await setup()
    registerCgcTool(ctx!, 'get_workspace_context', async () => {
      throw new HarnessError('workspace not found', CGC_MCP_BUSINESS)
    })
    const result = await call(ctx!, 'mcp__cgc-2046__get_workspace_context')
    expect(result.isError).toBe(true)
    expect(activity.list()).toHaveLength(0)
  })

  it('records successful write tools by name + workspace_id only (R9 negative)', async () => {
    const { activity } = await setup()
    registerCgcTool(ctx!, 'create_invitation', async () => ({ status: 'created', invitation_token: 'one-time-secret' }))
    const result = await call(ctx!, 'mcp__cgc-2046__create_invitation', { workspace_id: 'w-42', role: 'tutor' })
    expect(result.isError).toBe(false)
    const entries = activity.list()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'write', tool: 'mcp__cgc-2046__create_invitation', workspaceId: 'w-42' })
    // Never arguments, never results: the one-time invitation token must not leak.
    expect(JSON.stringify(entries)).not.toContain('one-time-secret')
    expect(JSON.stringify(entries)).not.toContain('tutor')
  })

  it('ignores plain reads and non-CGC tools entirely', async () => {
    const { activity } = await setup()
    registerCgcTool(ctx!, 'get_workflow', async () => ({ ok: true }))
    ctx!.tools.register(defineTool({
      name: 'unrelated_tool',
      description: 'test double',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: () => [{ type: 'text' as const, text: 'never' }],
      },
      execute: async () => {
        throw new HarnessError('boom', 'SOME_OTHER_CODE')
      },
    }))
    await call(ctx!, 'mcp__cgc-2046__get_workflow')
    const result = await call(ctx!, 'unrelated_tool')
    expect(result.isError).toBe(true)
    expect(activity.list()).toHaveLength(0)
  })

  it('never breaks the waterfall when the observer itself throws', async () => {
    ctx = await mountRegistry()
    // A pathological activity sink that throws on push.
    const sink = {
      push() { throw new Error('ring exploded') },
      list() { return [] },
    }
    installErrorHook(ctx, sink as unknown as ActivityLog)
    registerCgcTool(ctx, 'create_invitation', async () => ({ status: 'created' }))
    const result = await call(ctx, 'mcp__cgc-2046__create_invitation', { workspace_id: 'w-1' })
    expect(result.isError).toBe(false)
  })
})
