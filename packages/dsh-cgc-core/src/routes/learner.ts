/**
 * Learner-domain data routes (Appendix A): learning state, the merged
 * discovery flow, the enrollment confirmation card, enrollment creation
 * (idempotent direct write), own enrollments, and the order/payment poll.
 */

import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  makeExactDataRoute,
  type DataRouteDecl,
  type DataRouteDeps,
} from './pipeline.ts'

const LEARNER_DECLS: readonly DataRouteDecl[] = [
  {
    method: 'GET',
    pattern: '/learning_state',
    whitelistKey: 'GET /learning_state',
    fields: [['param', 'workspace_id', 'required'], ['param', 'course_id', 'required']],
  },
  {
    method: 'GET',
    pattern: '/discover',
    whitelistKey: 'GET /discover',
    fields: [],
  },
  {
    method: 'GET',
    pattern: '/enrollment_summary',
    whitelistKey: 'GET /enrollment_summary',
    missingJoin: ', ',
    fields: [
      ['param', 'workspace_id', 'required'],
      ['param', 'kind', 'required'],
      ['param', 'offering_id', 'required'],
    ],
  },
  {
    method: 'POST',
    pattern: '/enrollments',
    whitelistKey: 'POST /enrollments',
    fields: [
      ['body', 'workspace_id', 'required'],
      ['body', 'kind', { enum: ['event', 'course'] }],
      ['body', 'offering_id', 'required'],
      ['body', 'reason', 'optional'],
      ['body', 'tier_id', 'optional'],
    ],
  },
  {
    method: 'GET',
    pattern: '/me/enrollments',
    whitelistKey: 'GET /me/enrollments',
    fields: [],
  },
  {
    method: 'GET',
    pattern: '/order_status',
    whitelistKey: 'GET /order_status',
    fields: [['param', 'workspace_id', 'required'], ['param', 'enrollment_id', 'required']],
  },
]

/** The learner fixed-path routes. */
export function learnerRoutes(deps: DataRouteDeps, base: string): WebRoute[] {
  return LEARNER_DECLS.map(decl => makeExactDataRoute(decl, deps, base))
}
