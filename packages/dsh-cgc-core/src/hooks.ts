/**
 * Error hook (KTD4): observes the `tools/post-execute` waterfall for the
 * `mcp__cgc-2046__*` namespace and feeds the recent-activity ring the panel
 * polls. Classification is code-based (HarnessError.code), never text —
 * CGC_MCP_CONNECTION / CGC_MCP_AUTH / CGC_MCP_TIMEOUT land in the feed,
 * business failures (CGC_MCP_BUSINESS) stay in the agent conversation.
 * Successful write-operation calls (CGC_WRITE_TOOLS) are recorded by name +
 * timestamp + workspace_id only — never arguments, never results (write
 * results can carry one-time secrets such as invitation tokens, which must
 * not leak into the feed).
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ActivityLog } from './activity.ts'
import { CGC_CONNECTION_ERROR_CODES, CGC_TOOL_PREFIX, CGC_WRITE_TOOLS, type CgcErrorCode } from './protocol.ts'
import { redactText } from './redact.ts'

/**
 * Install the post-execute observer.
 * @param ctx - host plugin context (the listener rides the plugin fiber).
 * @param activity - the ring the panel's GET /status polls.
 * @param secrets - live secret literals (the store's current connection
 *   token) stripped verbatim from error text before the shape pass (RSK6).
 * @returns disposer removing the listener.
 */
export function installErrorHook(ctx: Context, activity: ActivityLog, secrets: () => readonly string[] = () => []): () => void {
  return ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    try {
      if (!exec.name.startsWith(CGC_TOOL_PREFIX)) return decision
      if (result.isError) {
        const code = result.error.info?.code as CgcErrorCode | undefined
        if (code !== undefined && CGC_CONNECTION_ERROR_CODES.includes(code)) {
          activity.push({
            kind: 'error',
            at: Date.now(),
            source: 'tool',
            code,
            message: redactText(result.error.message, secrets()),
            tool: exec.name,
          })
        }
        return decision
      }
      const rawName = exec.name.slice(CGC_TOOL_PREFIX.length)
      if (CGC_WRITE_TOOLS.includes(rawName)) {
        const args = exec.arguments as Record<string, unknown> | undefined
        const workspaceId = typeof args?.['workspace_id'] === 'string' ? args['workspace_id'] : undefined
        activity.push({
          kind: 'write',
          at: Date.now(),
          tool: exec.name,
          ...workspaceId === undefined ? {} : { workspaceId },
        })
      }
    } catch {
      // The hook observes; it must never break the waterfall for any tool.
    }
    return decision
  })
}
