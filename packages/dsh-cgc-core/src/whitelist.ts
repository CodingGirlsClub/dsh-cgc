/**
 * The data-plane whitelist (KTD5 / R19): a POSITIVE, per-route, named table
 * mapping each panel route onto the exact platform MCP tool it may call.
 *
 * Structural unreachability invariant: the dispatcher has no generic
 * passthrough — a request can only ever invoke the tool named in its
 * route's row, so `confirm_operation` / `cancel_operation` and the 26
 * confirmation-flow tools (CONTRACT.md contract-checklist `gate` lines)
 * simply never appear here and cannot be reached over HTTP, no matter what
 * a request body carries.
 *
 * Decoupling rule (wave contract): this table must NOT import
 * CGC_CONFIRMATION_TOOLS from protocol.ts — the invariant holds by
 * construction (positive naming), and test/whitelist.spec.ts re-verifies it
 * against CONTRACT.md's frozen checklist.
 *
 * Write rows are restricted to the platform's direct-write tools
 * (save_course_content, create_enrollment — the confirmation-exempt writes
 * per Appendix A); the spec asserts write rows ⊆ (CGC_WRITE_TOOLS minus the
 * confirmation set).
 */

/** Route key shape: '<METHOD> <path pattern>' with `:param` captures. */
export const ROUTE_WHITELIST = {
  'GET /courses/:course_id/content': 'get_course_content',
  'POST /courses/:course_id/content': 'save_course_content',
  'GET /courses/:course_id/prep': 'get_prep_status',
  'GET /me/workspaces': 'list_my_workspaces',
  'GET /tasks': 'list_my_tasks',
  'GET /learning_state': 'get_learning_state',
  'GET /courses/:course_id/revision': 'get_course_revision',
  'GET /discover': 'discover_offerings',
  'GET /enrollment_summary': 'get_enrollment_summary',
  'POST /enrollments': 'create_enrollment',
  'GET /me/enrollments': 'get_my_enrollments',
  'GET /order_status': 'get_order_status',
  'GET /workspace/courses': 'list_workspace_courses',
  'GET /workspace/events': 'list_workspace_events',
  'GET /workspace/orders': 'list_workspace_orders',
  'GET /workspace/enrollments': 'list_enrollments',
} as const

export type RouteWhitelistKey = keyof typeof ROUTE_WHITELIST

/** Every tool any route may invoke (read + write). */
export const WHITELISTED_TOOLS: readonly string[] = Object.values(ROUTE_WHITELIST)

/** The tools write routes may invoke (the panel direct-write subset). */
export const WHITELISTED_WRITE_TOOLS: readonly string[] = Object.entries(ROUTE_WHITELIST)
  .filter(([key]) => key.startsWith('POST '))
  .map(([, tool]) => tool)
