/**
 * Workspace/workbench-domain data routes (Appendix A): identity context,
 * the task list, and the admin/tutor read projections (courses, events,
 * orders, and the per-offering enrollment queue).
 */

import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  makeExactDataRoute,
  type DataRouteDecl,
  type DataRouteDeps,
} from './pipeline.ts'

const WORKSPACE_DECLS: readonly DataRouteDecl[] = [
  {
    method: 'GET',
    pattern: '/me/workspaces',
    whitelistKey: 'GET /me/workspaces',
    fields: [],
  },
  {
    method: 'GET',
    pattern: '/tasks',
    whitelistKey: 'GET /tasks',
    fields: [['param', 'workspace_id', 'required']],
  },
  {
    method: 'GET',
    pattern: '/workspace/courses',
    whitelistKey: 'GET /workspace/courses',
    fields: [['param', 'workspace_id', 'required']],
  },
  {
    method: 'GET',
    pattern: '/workspace/events',
    whitelistKey: 'GET /workspace/events',
    fields: [['param', 'workspace_id', 'required']],
  },
  {
    method: 'GET',
    pattern: '/workspace/orders',
    whitelistKey: 'GET /workspace/orders',
    fields: [['param', 'workspace_id', 'required']],
  },
  {
    method: 'GET',
    pattern: '/workspace/enrollments',
    whitelistKey: 'GET /workspace/enrollments',
    missingJoin: ' / ',
    fields: [
      ['param', 'workspace_id', 'required'],
      ['param', 'kind', 'required'],
      ['param', 'offering_id', 'required'],
    ],
  },
]

/** The workspace/workbench fixed-path routes. */
export function workspaceRoutes(deps: DataRouteDeps, base: string): WebRoute[] {
  return WORKSPACE_DECLS.map(decl => makeExactDataRoute(decl, deps, base))
}
