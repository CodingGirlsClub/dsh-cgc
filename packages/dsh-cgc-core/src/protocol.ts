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
 * The platform's write-operation tools (raw names). Successful calls to
 * these are recorded in recent activity (name + timestamp + workspace_id
 * only — never arguments, never results: write results can carry one-time
 * secrets such as invitation tokens, which must not leak into the feed).
 *
 * Derived from the platform source (last checked 2026-09 against
 * server.ex:77-170 and mcp/tools/*.ex): every registered tool that mutates
 * state = the 26 confirmation-flow tools (files defining
 * `execute_confirmed/2`) + `confirm_operation` / `cancel_operation` + the
 * 12 direct writes (`save_step_output`, `save_course_content`,
 * `create_course`, `create_event`, `create_enrollment`, the prep-family
 * writes, the learning-run writes). CONTRACT.md freezes the same set and
 * CI re-verifies it against the platform (KTD10) — update both together.
 */
export const CGC_WRITE_TOOLS: readonly string[] = [
  'admin_approve_workspace_application',
  'admin_create_workspace',
  'admin_demote_user',
  'admin_promote_user',
  'admin_reassign_workspace_owner',
  'admin_reject_workspace_application',
  'approve_join_request',
  'approve_prep',
  'assign_prep_tutor',
  'assign_roles',
  'cancel_course',
  'cancel_event',
  'cancel_operation',
  'claim_prep_authoring',
  'close_course',
  'close_event',
  'confirm_enrollment',
  'confirm_operation',
  'create_course',
  'create_enrollment',
  'create_event',
  'create_invitation',
  'launch_course',
  'launch_event',
  'override_prep_gate',
  'refund_order',
  'reject_enrollment',
  'request_changes_prep',
  'retry_refund',
  'save_course_content',
  'save_step_output',
  'start_learning_run',
  'submit_learning_attempt',
  'submit_prep_for_check',
  'submit_prep_quality_report',
  'update_course',
  'update_event',
  'update_join_policy',
  'update_prep_policy',
  'waive_payment',
]

/**
 * Early-gate list (KTD4 anchor B): the platform's 26 confirmation-flow
 * tools (raw names), which prompt a fail-closed local approval on every
 * originating call. `confirm_operation` is NOT here — it is the drift-free
 * anchor A that always asks unless the pending_id memory proves the
 * producing call was already approved; `cancel_operation` is never gated.
 *
 * This constant is generated from and checked by scripts/check-contract.mjs
 * (three-way equality: platform `execute_confirmed/2` hit set = CONTRACT.md
 * `gate` checklist = this list). Do not hand-edit without updating
 * CONTRACT.md; CI fails on any drift (KTD10).
 */
export const CGC_CONFIRMATION_TOOLS: readonly string[] = [
  'admin_approve_workspace_application',
  'admin_create_workspace',
  'admin_demote_user',
  'admin_promote_user',
  'admin_reassign_workspace_owner',
  'admin_reject_workspace_application',
  'approve_join_request',
  'approve_prep',
  'assign_roles',
  'cancel_course',
  'cancel_event',
  'close_course',
  'close_event',
  'confirm_enrollment',
  'create_invitation',
  'launch_course',
  'launch_event',
  'override_prep_gate',
  'refund_order',
  'reject_enrollment',
  'retry_refund',
  'update_course',
  'update_event',
  'update_join_policy',
  'update_prep_policy',
  'waive_payment',
]

/** Built-in two-tool confirmation-flow tools (raw names), anchor A / passthrough. */
export const CGC_CONFIRM_OPERATION = 'confirm_operation'
export const CGC_CANCEL_OPERATION = 'cancel_operation'

/**
 * Default pending-confirmation TTL in seconds, matching the platform's
 * `@default_ttl_seconds 600` (pending_operation.ex). The core settings
 * section may override it via `confirmation_ttl_seconds`; deployments MUST
 * keep it equal to the platform value (CONTRACT.md, checked by CI).
 */
export const DEFAULT_CONFIRMATION_TTL_SECONDS = 600

/** Settings key (inside the dsh-cgc-core namespace) overriding the pending TTL. */
export const CONFIRMATION_TTL_SETTING = 'confirmation_ttl_seconds'

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
