/**
 * Error hook (KTD4) and event source (U7/KTD8): observes the
 * `tools/post-execute` waterfall for the `mcp__cgc-2046__*` namespace.
 * Classification is code-based (HarnessError.code), never text.
 *
 * With an event hub (production wiring) the hook is one of the hub's dual
 * sources: EVERY CGC call is observed into the aggregator (deduped by call
 * id against the session/event source), and the aggregator owns the feed
 * mirror into the activity ring. Without a hub (the legacy/test path) the
 * hook writes the feed directly: CGC_MCP_CONNECTION / CGC_MCP_AUTH /
 * CGC_MCP_TIMEOUT land in the feed, business failures (CGC_MCP_BUSINESS)
 * stay in the agent conversation, and successful write-operation calls
 * (CGC_WRITE_TOOLS) are recorded by name + timestamp + workspace_id only —
 * never arguments, never results (write results can carry one-time secrets
 * such as invitation tokens, which must not leak into the feed).
 */

import type { Context } from '@deepseek-ai/cordis'
import { activityEntryForObservation, type ActivityLog, type CgcToolObservation } from './activity.ts'
import type { CgcEventHub } from './events.ts'
import { CGC_TOOL_PREFIX, type CgcErrorCode } from './protocol.ts'
import { redactText } from './redact.ts'

/**
 * Install the post-execute observer.
 * @param ctx - host plugin context (the listener rides the plugin fiber).
 * @param activity - the ring the panel's GET /status polls.
 * @param secrets - live secret literals (the store's current connection
 *   token) stripped verbatim from error text before the shape pass (RSK6).
 * @param events - the U7 aggregator; when present it is the sole event
 *   exit and owns the activity-feed mirror (exactly-once).
 * @returns disposer removing the listener.
 */
export function installErrorHook(
  ctx: Context,
  activity: ActivityLog,
  secrets: () => readonly string[] = () => [],
  events?: CgcEventHub,
): () => void {
  return ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    try {
      if (!exec.name.startsWith(CGC_TOOL_PREFIX)) return decision
      const args = exec.arguments as Record<string, unknown> | undefined
      const workspaceId = typeof args?.['workspace_id'] === 'string' ? args['workspace_id'] : undefined
      const base = {
        callId: String(exec.callId),
        tool: exec.name,
        ...workspaceId === undefined ? {} : { workspaceId },
      }
      if (result.isError) {
        const code = result.error.info?.code as CgcErrorCode | undefined
        const message = redactText(result.error.message, secrets())
        const observation: CgcToolObservation = { ...base, ok: false, ...code === undefined ? {} : { code }, message }
        if (events !== undefined) {
          events.observe(observation)
          return decision
        }
        const entry = activityEntryForObservation(observation, Date.now())
        if (entry !== undefined) activity.push(entry)
        return decision
      }
      const observation: CgcToolObservation = { ...base, ok: true }
      if (events !== undefined) {
        events.observe(observation)
        return decision
      }
      const entry = activityEntryForObservation(observation, Date.now())
      if (entry !== undefined) activity.push(entry)
    } catch {
      // The hook observes; it must never break the waterfall for any tool.
    }
    return decision
  })
}

