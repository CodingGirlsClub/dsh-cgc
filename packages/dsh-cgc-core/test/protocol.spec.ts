/**
 * CGC_WRITE_TOOLS contract: the write-operation set recorded in the
 * activity ring. Re-derived 2026-09 from the platform source — server.ex
 * registrations minus the read-only tools; the confirmation-flow subset is
 * the `execute_confirmed/2` hit set in mcp/tools/*.ex (26 files), plus
 * confirm_operation / cancel_operation, plus the 12 direct writes.
 * CONTRACT.md freezes the same set and CI re-checks it (KTD10) — update
 * both together.
 */

import { describe, expect, it } from 'vitest'
import { CGC_WRITE_TOOLS } from '../src/protocol.ts'

/** The 40 mutating tools, derived from the platform source (see header). */
const EXPECTED_WRITE_TOOLS: readonly string[] = [
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

describe('CGC_WRITE_TOOLS', () => {
  it('matches the write set derived from the platform source', () => {
    expect([...CGC_WRITE_TOOLS].sort()).toEqual([...EXPECTED_WRITE_TOOLS].sort())
  })

  it('carries the confirmation-flow anchors', () => {
    expect(CGC_WRITE_TOOLS).toContain('confirm_operation')
    expect(CGC_WRITE_TOOLS).toContain('cancel_operation')
  })

  it('excludes read-only tools', () => {
    for (const read of ['get_workspace_context', 'list_members', 'get_role_playbook', 'get_learning_state', 'discover_offerings', 'list_workspace_orders']) {
      expect(CGC_WRITE_TOOLS).not.toContain(read)
    }
  })

  it('has no duplicates', () => {
    expect(new Set(CGC_WRITE_TOOLS).size).toBe(CGC_WRITE_TOOLS.length)
  })
})
