/**
 * Wire contract between the host half (routes.ts) and the browser half
 * (client/api.ts), plus the plugin's shared constants. Pure types and string
 * literals only — imported by both halves, bundled into each, no runtime
 * identity to share.
 */

/** Stable cordis plugin id / npm package name. */
export const CGC_PLUGIN_ID = 'dsh-cgc-core'

/**
 * Settings namespace the connection config lives under. Spelled here rather
 * than imported: the browser half spells the same value and must not depend
 * on a host package.
 */
export const CGC_SETTINGS_NAMESPACE = 'dsh-cgc-core'

/**
 * MCP server namespace the bridge registers tools under
 * (`mcp__cgc-2046__<rawName>`). The core package owns this namespace
 * outright (family contract KTD7): no sibling plugin may register it.
 */
export const CGC_SERVER_NAME = 'cgc-2046'

/** Public tool-name prefix every bridged CGC tool carries. */
export const CGC_TOOL_PREFIX = `mcp__${CGC_SERVER_NAME}__`

/** Default MCP endpoint: the platform's loopback development value. */
export const DEFAULT_MCP_URL = 'http://localhost:4102/mcp'

/** Machine-routable error codes the bridge throws (HarnessError.code). */
export const CGC_MCP_CONNECTION = 'CGC_MCP_CONNECTION'
export const CGC_MCP_AUTH = 'CGC_MCP_AUTH'
export const CGC_MCP_TIMEOUT = 'CGC_MCP_TIMEOUT'
export const CGC_MCP_BUSINESS = 'CGC_MCP_BUSINESS'

export type CgcErrorCode =
  | typeof CGC_MCP_CONNECTION
  | typeof CGC_MCP_AUTH
  | typeof CGC_MCP_TIMEOUT
  | typeof CGC_MCP_BUSINESS

/**
 * Codes the panel surfaces as connection failures (business errors stay in
 * the agent conversation only — R9 scope).
 */
export const CGC_CONNECTION_ERROR_CODES: readonly CgcErrorCode[] = [
  CGC_MCP_CONNECTION,
  CGC_MCP_AUTH,
  CGC_MCP_TIMEOUT,
]

/**
 * The platform's write/management tools (raw names). Successful calls to
 * these are recorded in recent activity (name + timestamp + workspace_id
 * only — never arguments, never results, never the one-time
 * invitation_token a confirmed create_invitation returns).
 */
export const CGC_WRITE_TOOLS: readonly string[] = [
  'save_step_output',
  'create_invitation',
  'confirm_operation',
  'cancel_operation',
]

/** One recent-activity entry (in-memory ring; cleared on disconnect). */
export interface CgcActivityEntry {
  kind: 'error' | 'write'
  /** Epoch milliseconds. */
  at: number
  /** error entries: where the failure was observed. */
  source?: 'connect' | 'tool'
  /** error entries: the bridge's machine code. */
  code?: CgcErrorCode
  /** error entries: redacted human-readable message (never carries credentials). */
  message?: string
  /** tool entries / tool-observed errors: the public tool name. */
  tool?: string
  /** write entries: the call's workspace_id when it was a plain string. */
  workspaceId?: string
}

/** GET /status response body. Never carries the token or request headers. */
export interface CgcStatusBody {
  /** Local config exists (url + token stored). */
  configured: boolean
  /** Stored MCP URL ('' when unset). */
  url: string
  /** A token is stored. */
  token_configured: boolean
  /** The bridge currently holds a live connection. */
  connected: boolean
  /** Platform web origin derived from the MCP URL ('' when unset). */
  web_url: string
  /** Recent activity ring, newest first. */
  activity: CgcActivityEntry[]
}

/** POST /connect payload. */
export interface CgcConnectPayload {
  url?: string
  token?: string
}

/** JSON error body used by every route. */
export interface ApiErrorBody {
  error: string
}

/** Route paths the client calls (shared literals). */
export const CGC_API_BASE = '/api/dsh-cgc-core' as const

export const CGC_API = {
  connect: CGC_API_BASE + '/connect',
  status: CGC_API_BASE + '/status',
} as const
