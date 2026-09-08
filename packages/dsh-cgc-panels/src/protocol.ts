/**
 * Wire contract between the panels package's two halves and dsh-cgc-core's
 * route family. Route paths and envelope shapes MIRROR core's protocol.ts /
 * routes/pipeline.ts / routes/events.ts — spelled here rather than imported
 * because the browser bundle must not inline host code (bundle purity gate).
 * Type-only imports from dsh-cgc-core (erased at build) keep the payload
 * shapes drift-free.
 */

import type { CgcActivityEntry, CgcStatusBody } from 'dsh-cgc-core/src/protocol.ts'
import type { CgcEvent, CgcEventsPage } from 'dsh-cgc-core/src/events.ts'

export type { CgcActivityEntry, CgcEvent, CgcEventsPage, CgcStatusBody }

/** Core's route family base (mirror of core protocol.ts CGC_API_BASE). */
export const CGC_API_BASE = '/api/dsh-cgc-core' as const

/** Route paths the panels client calls (mirror of core's route table). */
export const CGC_PANEL_API = {
  connect: CGC_API_BASE + '/connect',
  status: CGC_API_BASE + '/status',
  activity: CGC_API_BASE + '/activity',
  events: CGC_API_BASE + '/events',
  discover: CGC_API_BASE + '/discover',
  enrollmentSummary: CGC_API_BASE + '/enrollment_summary',
  enrollments: CGC_API_BASE + '/enrollments',
  myEnrollments: CGC_API_BASE + '/me/enrollments',
  myWorkspaces: CGC_API_BASE + '/me/workspaces',
  orderStatus: CGC_API_BASE + '/order_status',
  tasks: CGC_API_BASE + '/tasks',
  learningState: CGC_API_BASE + '/learning_state',
  workspaceCourses: CGC_API_BASE + '/workspace/courses',
  workspaceEvents: CGC_API_BASE + '/workspace/events',
  workspaceOrders: CGC_API_BASE + '/workspace/orders',
  workspaceEnrollments: CGC_API_BASE + '/workspace/enrollments',
} as const

/** Parameterized course routes (Appendix A). */
export function courseContentPath(courseId: string): string {
  return `${CGC_API_BASE}/courses/${encodeURIComponent(courseId)}/content`
}
export function coursePrepPath(courseId: string): string {
  return `${CGC_API_BASE}/courses/${encodeURIComponent(courseId)}/prep`
}
export function courseRevisionPath(courseId: string): string {
  return `${CGC_API_BASE}/courses/${encodeURIComponent(courseId)}/revision`
}

/** Write-route CSRF header (mirror of core csrf.ts CGC_CSRF_HEADER). */
export const CGC_CSRF_HEADER = 'x-cgc-csrf-token' as const

/** Data-route success envelope (mirror of core routes/pipeline.ts). */
export interface DataOk<T> {
  ok: true
  value: T
}

/** Machine-routable envelope error codes (mirror of core DataErrorCode). */
export type DataErrorCode =
  | 'forbidden'
  | 'method_not_allowed'
  | 'not_found'
  | 'bad_request'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'not_connected'
  | 'upstream'
  | 'version_conflict'
  | 'internal'

/** Data-route failure envelope. */
export interface DataErr {
  ok: false
  error: { code: DataErrorCode | string; message: string }
}

export type DataEnvelope<T> = DataOk<T> | DataErr

/** The seven panel surfaces (Appendix B). */
export const SURFACE_IDS = ['hub', 'learning', 'course', 'discover', 'tutor', 'editor', 'admin'] as const
export type SurfaceId = (typeof SURFACE_IDS)[number]

/**
 * Role gating (AE4): which active-session agent preset reveals a surface.
 * The preset ids are owned by dsh-cgc-roles (agents/<id>/preset.yml);
 * an empty list means always visible (hub). Sessions without a CGC preset
 * see the hub only.
 */
export const SURFACE_ROLES: Record<SurfaceId, readonly string[]> = {
  hub: [],
  learning: ['cgc-assistant'],
  course: ['cgc-assistant'],
  discover: ['cgc-assistant'],
  tutor: ['cgc-tutor'],
  editor: ['cgc-tutor'],
  admin: ['cgc-admin'],
}

/** Whether a surface is visible under the active preset (undefined = none). */
export function surfaceVisible(surface: SurfaceId, preset: string | undefined): boolean {
  const roles = SURFACE_ROLES[surface]
  if (roles.length === 0) return true
  return preset !== undefined && roles.includes(preset)
}

/**
 * Id-referenced directive discipline (RSK4): row-click injection carries a
 * fixed verb plus a validated identifier — never platform free text. Ids are
 * UUIDs or plain numerics; anything else is refused before it can reach the
 * composer.
 */
export const DIRECTIVE_ID = /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|\d{1,15})$/

/** The fixed verb set a directive may carry. */
export const DIRECTIVE_VERBS = {
  course: '查看课程',
  event: '查看活动',
  order: '查看订单',
  enrollment: '查看报名',
  task: '查看任务',
} as const
export type DirectiveVerb = keyof typeof DIRECTIVE_VERBS

/**
 * Build the directive text for one row action; undefined when the id is not
 * a validated identifier (UUID / numeric).
 */
export function buildDirective(verb: DirectiveVerb, id: string): string | undefined {
  const trimmed = id.trim()
  if (!DIRECTIVE_ID.test(trimmed)) return undefined
  return `${DIRECTIVE_VERBS[verb]} ${trimmed}`
}
