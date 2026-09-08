/**
 * Family handoff surface: process-singleton handles sibling packages
 * (dsh-cgc-panels, U8) read from the same installed dsh-cgc-core instance
 * (both run in one host process; the family pins one core version).
 *
 * The panels host half injects `familyCsrfBootstrapField()` into its own
 * client bootstrap channel so the panel page can mint write requests. The
 * token itself is never served by a public route and never written into a
 * response body — see csrf.ts for the full discipline (RSK5).
 */

import type { CsrfTokenStore } from './csrf.ts'

let csrfStore: CsrfTokenStore | undefined

/** Called once from apply(); the handles live for the plugin activation. */
export function registerFamilyHandles(handles: { csrf: CsrfTokenStore }): void {
  csrfStore = handles.csrf
}

/** Cleared on unload so a re-activated generation never leaks the old token. */
export function unregisterFamilyHandles(): void {
  csrfStore = undefined
}

/** The csrf bootstrap payload for the panels client; undefined before core mounts. */
export function familyCsrfBootstrapField(): Record<string, string> | undefined {
  return csrfStore?.bootstrapField()
}
