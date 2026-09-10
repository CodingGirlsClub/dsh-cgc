/**
 * Tool bridge: registers the CGC MCP server's tools on the harness
 * ToolRuntime under deterministic server-qualified public names, mirroring
 * dsh-mcp-client's bridge (same publicToolName rule, same raw-JSON-Schema
 * parameters, same content extraction) so names are identical no matter
 * which client connected the server.
 *
 * The bridge boundary (KTD1): no reconnect supervision (Streamable HTTP
 * retries per call against an unreachable server), no tools/list_changed
 * re-sync — every (re)connect re-runs tools/list, so platform tool growth
 * is picked up on reconnect by construction.
 */

import { createHash } from 'node:crypto'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { JsonSchemaNode, ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import {
  CGC_MCP_AUTH,
  CGC_MCP_BUSINESS,
  CGC_MCP_CONNECTION,
  CGC_MCP_TIMEOUT,
} from './protocol.ts'
import { redactText } from './redact.ts'

/**
 * DeepSeek function-name contract: at most 64 characters, only
 * `[A-Za-z0-9_-]` (wire-protocol constants, not configuration).
 */
const MAX_PUBLIC_NAME_LENGTH = 64
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g

/** Hex chars of the SHA-256 identity hash appended on lossy normalization. */
const HASH_LENGTH = 12

/** JSON-RPC RequestTimeout, raised client-side when a call exceeds its budget. */
const MCP_REQUEST_TIMEOUT_CODE = -32001

/** Per-call timeout handed to the MCP SDK (ms). */
export const CGC_TOOL_CALL_TIMEOUT_MS = 60_000

/** Raw result record: the bridge owns JSON-value validation after transport. */
const RawCallToolResultSchema = z.record(z.string(), z.unknown())

/**
 * Derive the model-facing public name for one MCP tool. Deterministic pure
 * function of (serverName, rawName): the clean case is
 * `mcp__<serverName>__<rawName>` verbatim; when normalization changes the
 * name or it exceeds 64 chars, a 12-hex SHA-256 of the identity is appended
 * so distinct identities never collide.
 */
export function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}

/** Canonical MCP result exposed to the harness without discarding protocol blocks. */
type McpResult = { content: JsonValue[]; structuredContent?: JsonValue }

/** The shape read from each MCP content block (looser than the SDK's: network trust boundary). */
interface McpContentBlock {
  type: string
  text?: string
}

/**
 * Extract text from an MCP content array into a single string: text blocks
 * joined with '\n', everything else replaced with a placeholder.
 */
function extractText(mcpContent: JsonValue[], toolName: string): string {
  const parts: string[] = []
  for (const value of mcpContent) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      parts.push('[unsupported content type: unknown]')
      continue
    }
    const block = value as unknown as McpContentBlock
    if (block.type === 'text' && block.text !== undefined) {
      parts.push(block.text)
    } else {
      parts.push(`[unsupported content type: ${block.type || 'unknown'}]`)
    }
  }
  const text = parts.join('\n')
  return text.length > 0 ? text : `${toolName} completed without output`
}

/** Keep a supported advertised schema; unsupported MCP vocabulary falls back to JsonValue. */
function supportedOutputSchema(candidate: unknown): JsonSchemaNode | undefined {
  if (candidate === undefined) return undefined
  try {
    assertSupportedJsonSchema(candidate)
    return candidate
  } catch {
    return undefined
  }
}

/** Build the canonical result schema and the Native text projection. */
function createOutput(rawName: string, structuredSchema: JsonSchemaNode | undefined): ToolDefinition['output'] {
  return {
    schema: {
      type: 'object',
      properties: {
        content: { type: 'array', items: {} },
        structuredContent: structuredSchema ?? {},
      },
      required: structuredSchema === undefined ? ['content'] : ['content', 'structuredContent'],
      additionalProperties: false,
    },
    render(_args, value) {
      const result = value as unknown as McpResult
      return [{ type: 'text', text: extractText(result.content, rawName) }]
    },
  }
}

/** Human-readable, credential-free message from an arbitrary thrown value. */
function bridgeErrorMessage(error: unknown, secrets: readonly string[]): string {
  const raw = error instanceof Error ? error.message : String(error)
  return redactText(raw, secrets)
}

/**
 * Classify a bridge failure (tools/call transport error or engine connect
 * error) into the plugin's machine codes (KTD4: coded, never text-sniffed at
 * the hook layer). Caller cancellation is re-thrown untouched — abort
 * semantics belong to the pipeline.
 * @param error - the thrown transport/SDK failure.
 * @param label - what was being done (raw tool name or 'connect').
 * @param secrets - live secret literals stripped from the message first (RSK6).
 */
export function classifyBridgeError(error: unknown, label: string, secrets: readonly string[] = []): HarnessError {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    throw error
  }
  const message = bridgeErrorMessage(error, secrets)
  const shape = error as { name?: unknown; code?: unknown } | null
  // McpError sets its name; its codes are JSON-RPC (negative).
  if (typeof shape === 'object' && shape !== null && shape.name === 'McpError' && typeof shape.code === 'number') {
    if (shape.code === MCP_REQUEST_TIMEOUT_CODE) {
      return new HarnessError(`CGC-2046 tool "${label}" timed out: ${message}`, CGC_MCP_TIMEOUT)
    }
    return new HarnessError(`CGC-2046 tool "${label}" failed: ${message}`, CGC_MCP_BUSINESS)
  }
  // StreamableHTTPError carries the HTTP status as `code` but never sets
  // `name` — duck-type on a status-range number instead.
  if (typeof shape === 'object' && shape !== null && typeof shape.code === 'number' && shape.code >= 100 && shape.code < 600) {
    const status = shape.code
    if (status === 401 || status === 403) {
      return new HarnessError(`CGC-2046 authentication failed (HTTP ${status}) — the connection token is invalid or revoked: ${message}`, CGC_MCP_AUTH)
    }
    return new HarnessError(`CGC-2046 MCP server returned HTTP ${status}: ${message}`, CGC_MCP_CONNECTION)
  }
  return new HarnessError(`CGC-2046 MCP call failed (${label}): ${message}`, CGC_MCP_CONNECTION)
}

/**
 * Create the execute function for one bridged tool: sends an uncached
 * tools/call with the raw wire name, maps isError results to coded business
 * failures, and classifies transport failures. `secrets` carries the live
 * connection token so error text is literal-stripped before shape regexes.
 */
function createExecutor(client: Client, rawName: string, secrets: readonly string[]): ToolDefinition['execute'] {
  return async (args, exec) => {
    // The agent loop passes JSON.parse(model_arguments); a bare scalar means
    // the model misbehaved — fall back to {} so the server produces a
    // specific "missing required param" error the model can learn from.
    const argsObj = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
    let result: Record<string, unknown>
    try {
      result = await client.request(
        { method: 'tools/call', params: { name: rawName, arguments: argsObj } },
        RawCallToolResultSchema,
        { signal: exec.signal, timeout: CGC_TOOL_CALL_TIMEOUT_MS },
      )
    } catch (error) {
      throw classifyBridgeError(error, rawName, secrets)
    }

    // Legacy toolResult shape; normalize to a content array.
    if (!Array.isArray(result['content'])) {
      const rendered: unknown = 'toolResult' in result ? JSON.stringify(result['toolResult']) : '(no output)'
      const text = typeof rendered === 'string' ? rendered : '(no output)'
      if (result['isError'] === true) {
        throw new HarnessError(redactText(text, secrets), CGC_MCP_BUSINESS)
      }
      return {
        content: [{ type: 'text', text }],
        ...result['structuredContent'] !== undefined ? { structuredContent: result['structuredContent'] as JsonValue } : {},
      }
    }

    const content = result['content'] as JsonValue[]
    const text = extractText(content, rawName)
    if (result['isError'] === true) {
      // Platform business failure (e.g. expired pending confirmation): the
      // server answered; the model reads the text and recovers.
      throw new HarnessError(redactText(text, secrets), CGC_MCP_BUSINESS)
    }
    return {
      content,
      ...result['structuredContent'] !== undefined ? { structuredContent: result['structuredContent'] as JsonValue } : {},
    }
  }
}

/**
 * Data-plane call path (U6): invoke one whitelisted platform tool on the
 * live client and return the raw result record. Same transport, timeout,
 * and classified/redacted errors as the bridged executors, but no
 * executor-side normalization or isError mapping — the route pipeline owns
 * result shaping (structuredContent/text) and the 502 isError layer.
 */
export async function callRawTool(
  client: Client,
  rawName: string,
  args: Record<string, unknown>,
  secrets: readonly string[] = [],
): Promise<Record<string, unknown>> {
  try {
    return await client.request(
      { method: 'tools/call', params: { name: rawName, arguments: args } },
      RawCallToolResultSchema,
      { timeout: CGC_TOOL_CALL_TIMEOUT_MS },
    )
  } catch (error) {
    throw classifyBridgeError(error, rawName, secrets)
  }
}

/** One listed MCP tool, the fields the bridge consumes. */
export interface ListedTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
}

/**
 * Fetch the server's full tool list (uncached pagination drain) and build
 * this generation's ToolDefinitions without touching the registry.
 * `secrets` is forwarded to every executor for literal-first redaction.
 */
export async function fetchToolDefinitions(client: Client, serverName: string, secrets: readonly string[] = []): Promise<Map<string, ToolDefinition>> {
  const definitions = new Map<string, ToolDefinition>()
  let cursor: string | undefined
  do {
    const response = await client.request(
      { method: 'tools/list', ...cursor === undefined ? {} : { params: { cursor } } },
      ListToolsResultSchema,
    )
    for (const tool of response.tools as ListedTool[]) {
      const publicName = publicToolName(serverName, tool.name)
      if (definitions.has(publicName)) {
        throw new HarnessError(
          `CGC-2046 MCP server listed tool "${tool.name}" more than once — invalid tool list`,
          CGC_MCP_CONNECTION,
        )
      }
      definitions.set(publicName, {
        name: publicName,
        description: tool.description ?? '',
        parameters: tool.inputSchema,
        output: createOutput(tool.name, supportedOutputSchema(tool.outputSchema)),
        execute: createExecutor(client, tool.name, secrets),
      })
    }
    cursor = response.nextCursor
  } while (cursor)
  return definitions
}

/**
 * Register one generation of definitions, rolling back on conflict: the
 * model sees either the full set or none of it. Returns the live disposers.
 */
export function registerTools(ctx: Context, definitions: Map<string, ToolDefinition>): Map<string, () => void> {
  const disposers = new Map<string, () => void>()
  try {
    for (const [publicName, definition] of definitions) {
      disposers.set(publicName, ctx.tools.register(definition))
    }
  } catch (error) {
    for (const dispose of disposers.values()) dispose()
    throw error
  }
  return disposers
}

