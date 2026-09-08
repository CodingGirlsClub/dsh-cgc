/**
 * Course-domain data routes (Appendix A): course content read/draft-save,
 * prep status, and the published revision projection. The save route is the
 * optimistic-concurrency write — upstream `version_conflict` maps to 409.
 */

import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  makePrefixDataRoutes,
  type DataRouteDecl,
  type DataRouteDeps,
} from './pipeline.ts'

const COURSE_DECLS: readonly DataRouteDecl[] = [
  {
    method: 'GET',
    pattern: '/courses/:course_id/content',
    whitelistKey: 'GET /courses/:course_id/content',
    fields: [['param', 'course_id', 'pass'], ['param', 'workspace_id', 'required']],
  },
  {
    method: 'POST',
    pattern: '/courses/:course_id/content',
    whitelistKey: 'POST /courses/:course_id/content',
    conflict409: true,
    fields: [
      ['body', 'workspace_id', 'required'],
      ['param', 'course_id', 'pass'],
      ['body', 'content', 'object'],
      ['body', 'base_version', 'integer'],
    ],
  },
  {
    method: 'GET',
    pattern: '/courses/:course_id/prep',
    whitelistKey: 'GET /courses/:course_id/prep',
    fields: [['param', 'course_id', 'pass'], ['param', 'workspace_id', 'required']],
  },
  {
    method: 'GET',
    pattern: '/courses/:course_id/revision',
    whitelistKey: 'GET /courses/:course_id/revision',
    fields: [['param', 'course_id', 'required'], ['param', 'workspace_id', 'required']],
  },
]

/** The /courses/* subtree (one prefix registration, internal dispatch). */
export function courseRoutes(deps: DataRouteDeps, base: string): WebRoute[] {
  return [makePrefixDataRoutes(COURSE_DECLS, deps, base, '/courses')]
}
