/**
 * dsh-cgc-roles — the CGC-2046 role thin-shell preset family (cgc-assistant,
 * cgc-tutor, cgc-admin). Each preset is a discipline-only shell: the role's
 * methods and tool guidance come solely from the platform's get_role_playbook
 * (R7). This package's only runtime behavior is KTD6 materialization of its
 * own agents/ snapshot into <dshHome>/.agent-presets/ and the symmetric
 * removal of exactly its own subdirectories on unload.
 */

import type { Context } from '@deepseek-ai/cordis'
import { fileURLToPath } from 'node:url'
import { materializeFaces, removeFaces, type MaterializeFace } from 'dsh-cgc-core/src/materialize.ts'

/** Stable cordis plugin name. */
export const name = 'dsh-cgc-roles'

/** The role preset ids this package owns (directory names under agents/). */
export const CGC_ROLE_PRESET_IDS = ['cgc-assistant', 'cgc-tutor', 'cgc-admin'] as const

/** The faces this package materializes (one preset directory per role). */
export const ROLE_FACES: readonly MaterializeFace[] = CGC_ROLE_PRESET_IDS.map(id => ({ kind: 'preset', id }))

/** Package root: src/ and lib/ both sit one level below it. */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Materialize the three role presets into the user roots (idempotent
 * overwrite); remove exactly our own three subdirectories on unload (KTD6 —
 * each member materializes its own faces; core does not own presets).
 */
export function apply(ctx: Context): void {
  void materializeFaces(PACKAGE_ROOT, ROLE_FACES).catch((error: unknown) => {
    ctx.logger.warn(`dsh-cgc-roles: preset materialization failed: ${error instanceof Error ? error.message : String(error)}`)
  })
  ctx.effect(() => () => {
    void removeFaces(ROLE_FACES).catch(() => {})
  }, 'dsh-cgc-roles: agent faces')
}
