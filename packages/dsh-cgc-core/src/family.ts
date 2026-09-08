/**
 * Family handoff surface: process-wide handles sibling packages
 * (dsh-cgc-panels) read at request time. The channel is
 * `globalThis[Symbol.for(...)]`, NOT a module-level singleton: the host
 * loader consumes core's bundled lib/index.js (family.ts inlined), so a
 * module instance can never be shared across the two module graphs — the
 * global symbol registry is the only graph-spanning singleton.
 *
 * The panels host half injects `familyHandles()?.csrfBootstrapField()` into
 * its client bootstrap channel so the panel page can mint write requests.
 * The token itself is never served by a public route and never written into
 * a response body — see csrf.ts for the full discipline (RSK5).
 */

import type { CsrfTokenStore } from './csrf.ts'

/** Global-registry key both package graphs resolve identically. */
const FAMILY_KEY = Symbol.for('dsh-cgc-core:family-handoff')

/** Handles core publishes for the family; read lazily, per use. */
export interface FamilyHandles {
  csrfBootstrapField(): Record<string, string>
}

type FamilyGlobal = { [FAMILY_KEY]?: FamilyHandles }

/** Called once from apply(); the handles live for the plugin activation. */
export function registerFamilyHandles(handles: { csrf: CsrfTokenStore }): void {
  ;(globalThis as FamilyGlobal)[FAMILY_KEY] = { csrfBootstrapField: () => handles.csrf.bootstrapField() }
}

/** Cleared on unload so a re-activated generation never leaks the old token. */
export function unregisterFamilyHandles(): void {
  delete (globalThis as FamilyGlobal)[FAMILY_KEY]
}

/** The family handles; undefined before core mounts or after unload. */
export function familyHandles(): FamilyHandles | undefined {
  return (globalThis as FamilyGlobal)[FAMILY_KEY]
}
