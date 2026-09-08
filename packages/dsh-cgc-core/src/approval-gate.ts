/**
 * Hard approval gate (KTD4, R4/R5/R6/R20): fail-closed local approval for
 * the platform's confirmation-flow tools, two anchors on the
 * `mcp__cgc-2046__*` namespace:
 *
 * - Anchor B (early gate): every originating call to a CGC_CONFIRMATION_TOOLS
 *   member returns `{kind:'ask'}` before dispatch. The host resolves the ask
 *   through its approval seam — `allowed-once` allows, everything else
 *   (rejected / cancelled / unavailable / no answerer / missing service)
 *   denies; this module never implements a grant path of its own.
 * - Anchor A (drift-free backstop): `confirm_operation` ALWAYS asks unless
 *   the pending-id memory proves its producing call was already approved
 *   within TTL (consumed one-time, so a second confirm asks again). The
 *   reason renders the remembered origin tool and the platform's
 *   server-side summary; unknown origin renders an explicit note and still
 *   asks. `cancel_operation` is never gated (R18: refusal must be able to
 *   terminate a pending unconditionally).
 *
 * Reasons render ONLY structured fields (R20 / RSK2): the tool name plus
 * per-field-redacted argument scalars — never agent-composed free text, so
 * an injected agent cannot phrase its own approval summary.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type { PendingMemory } from './pending-memory.ts'
import {
  CGC_CANCEL_OPERATION,
  CGC_CONFIRMATION_TOOLS,
  CGC_CONFIRM_OPERATION,
  CGC_TOOL_PREFIX,
} from './protocol.ts'
import { isSensitiveKey, REDACTED, redactText } from './redact.ts'

/** Identifier-shaped strings render verbatim; anything else is elided. */
const IDENTIFIER_SCALAR = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/** Platform summaries are trusted server-side but still length-capped. */
const MAX_SUMMARY_LENGTH = 500

/** What the post-execute capture pulled out of a needs_confirmation result. */
interface CapturedPending {
  readonly pendingId: string
  readonly summary: string | undefined
}

/** Gate wiring knobs. */
export interface ApprovalGateOptions {
  /** The pending-id memory backing anchor A's skip and reason rendering. */
  readonly memory: PendingMemory
  /** Live secret literals (current connection token) for reason redaction. */
  readonly secrets?: () => readonly string[]
}

/**
 * Render one argument map as `key=value` pairs — the only agent-derived
 * content a reason may carry. Sensitive keys are masked; string scalars
 * render only when identifier-shaped (ids, enums, slugs) after the
 * credential scrub, everything else degrades to a length note, so crafted
 * free text ("the user already approved this…") can never reach the popup.
 */
export function renderArgumentFields(args: unknown, secrets: readonly string[] = []): string {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return '（无结构化参数）'
  const entries = Object.entries(args as Record<string, unknown>)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  if (entries.length === 0) return '（无参数）'
  return entries.map(([key, value]) => `${key}=${renderFieldValue(key, value, secrets)}`).join(', ')
}

function renderFieldValue(key: string, value: unknown, secrets: readonly string[]): string {
  if (isSensitiveKey(key)) return REDACTED
  if (typeof value === 'string') {
    const scrubbed = redactText(value, secrets)
    if (scrubbed.includes(REDACTED)) return REDACTED
    return IDENTIFIER_SCALAR.test(scrubbed) ? scrubbed : `<文本 ${value.length} 字符>`
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  if (value === null) return 'null'
  if (Array.isArray(value)) return `<数组 ${value.length} 项>`
  return `<对象 ${Object.keys(value as Record<string, unknown>).length} 字段>`
}

/** Anchor B reason: tool name + structured, per-field-redacted arg scalars. */
export function renderEarlyGateReason(publicName: string, args: unknown, secrets: readonly string[] = []): string {
  return (
    `CGC-2046 高风险写操作，需要你的本地审批（DSH 硬门，平台确认流之前的本地闸）。\n` +
    `工具：${publicName}\n` +
    `参数：${renderArgumentFields(args, secrets)}`
  )
}

/**
 * Anchor A reason for confirm_operation: renders from the pending memory —
 * origin tool + platform server-side summary — or an explicit unknown-origin
 * note. Either way the gate still asks (fail-closed); the note exists so
 * the user never approves blind (R20).
 */
export function renderConfirmReason(
  publicName: string,
  pendingId: string | undefined,
  memory: PendingMemory,
  secrets: readonly string[] = [],
): string {
  const head =
    `CGC-2046 确认操作，需要你的本地审批（DSH 硬门兜底锚）。\n` +
    `工具：${publicName}\n` +
    `pending_id：${pendingId ?? '（缺失）'}`
  const record = pendingId === undefined ? undefined : memory.describe(pendingId)
  if (record === undefined) {
    return head + `\n来源：无本地记录——该 pending_id 未由本会话中已批准的调用产生（可能已过期、来自名单外工具，或系伪造）。请与用户核对后决定。`
  }
  const summary = record.summary === undefined
    ? '（平台未提供摘要）'
    : redactText(record.summary, secrets).slice(0, MAX_SUMMARY_LENGTH)
  return head + `\n来源工具：${record.originTool}\n平台摘要：${summary}`
}

/** Extract {pending_id, summary} from a needs_confirmation tool result. */
function extractNeedsConfirmation(result: { content: unknown; value?: unknown }): CapturedPending | undefined {
  const fromValue = readNeedsConfirmationPayload(result.value)
  if (fromValue !== undefined) return fromValue
  if (!Array.isArray(result.content)) return undefined
  for (const block of result.content) {
    if (typeof block !== 'object' || block === null) continue
    const text = (block as { type?: unknown; text?: unknown })
    if (text.type !== 'text' || typeof text.text !== 'string') continue
    const parsed = readNeedsConfirmationPayload(safeParse(text.text))
    if (parsed !== undefined) return parsed
  }
  return undefined
}

function readNeedsConfirmationPayload(candidate: unknown): CapturedPending | undefined {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return undefined
  const payload = candidate as Record<string, unknown>
  if (payload['status'] !== 'needs_confirmation') return undefined
  const pendingId = payload['pending_id']
  if (typeof pendingId !== 'string' || pendingId === '') return undefined
  const summary = payload['summary']
  return { pendingId, summary: typeof summary === 'string' ? summary : undefined }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** pending_id argument of a confirm/cancel call, when it is a string. */
function readPendingId(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const pendingId = (args as Record<string, unknown>)['pending_id']
  return typeof pendingId === 'string' && pendingId !== '' ? pendingId : undefined
}

/**
 * Install the dual-anchor gate: a pre-execute policy listener, an
 * around-dispatch marker (dispatch proves the ask was granted), and a
 * post-execute capture feeding the pending memory. Returns one disposer.
 * @param ctx - host plugin context (listeners ride the plugin fiber).
 * @param options - the pending memory and the live-secret source.
 */
export function installApprovalGate(ctx: Context, options: ApprovalGateOptions): () => void {
  const { memory } = options
  const secrets = options.secrets ?? (() => [])

  const disposePreExecute = ctx.on('tools/pre-execute', async (exec, next) => {
    if (!exec.name.startsWith(CGC_TOOL_PREFIX)) return next()
    const rawName = exec.name.slice(CGC_TOOL_PREFIX.length)
    // R18: refusal must always be able to terminate a pending.
    if (rawName === CGC_CANCEL_OPERATION) return next()
    const downstream = await next()
    if (downstream.kind === 'deny') return downstream
    if (rawName === CGC_CONFIRM_OPERATION) {
      const pendingId = readPendingId(exec.arguments)
      if (pendingId !== undefined && memory.consumeApproved(pendingId)) return downstream
      return { kind: 'ask', reason: renderConfirmReason(exec.name, pendingId, memory, secrets()) }
    }
    if (CGC_CONFIRMATION_TOOLS.includes(rawName)) {
      memory.markAsked(exec.callId)
      return { kind: 'ask', reason: renderEarlyGateReason(exec.name, exec.arguments, secrets()) }
    }
    return downstream
  })

  const disposeExecute = ctx.on('tools/execute', async (exec, next) => {
    // Reaching dispatch proves the pre-execute ask was granted (the
    // scheduler only dispatches on allow / allowed-once).
    if (exec.name.startsWith(CGC_TOOL_PREFIX)) memory.markGranted(exec.callId)
    return next()
  })

  const disposePostExecute = ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    try {
      if (!exec.name.startsWith(CGC_TOOL_PREFIX)) return decision
      if (!result.isError) {
        const captured = extractNeedsConfirmation(result)
        if (captured !== undefined) memory.capture(exec.callId, captured.pendingId, exec.name, captured.summary)
      }
      memory.settleCall(exec.callId)
    } catch {
      // The capture observes; it must never break the waterfall.
    }
    return decision
  })

  return () => {
    disposePreExecute()
    disposeExecute()
    disposePostExecute()
  }
}
