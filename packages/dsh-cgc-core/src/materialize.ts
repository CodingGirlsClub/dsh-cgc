/**
 * KTD6 content materialization, generalized per member package: each family
 * member ships its own snapshot trees (agents/ for presets, skills/ for
 * skills) and materializes exactly those into the user roots
 * (`<dshHome>/.agent-presets/` and `<dshHome>/skills/`). The copy is an
 * idempotent overwrite — re-materialization covers snapshot drift; on unload
 * each member removes exactly its own subdirectories and nothing else.
 * dsh-cgc-core owns only its onboarding skill; the role presets live in and
 * are materialized by dsh-cgc-roles.
 */

import { cp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** One materialized face: a directory under the package's agents/ or skills/ snapshot tree. */
export interface MaterializeFace {
  /** 'preset' → agents/ → <dshHome>/.agent-presets/<id>; 'skill' → skills/ → <dshHome>/skills/<id>. */
  readonly kind: 'preset' | 'skill'
  /** Directory name (the preset/skill id). */
  readonly id: string
}

/** The skill id this package owns (directory name under the user root). */
export const CGC_SKILL_ID = 'cgc-core-onboarding'

/** The faces dsh-cgc-core itself materializes (skill only — presets moved to dsh-cgc-roles). */
export const CORE_FACES: readonly MaterializeFace[] = [{ kind: 'skill', id: CGC_SKILL_ID }]

/** Package root: src/ and lib/ both sit one level below it. */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The harness home directory ($DSH_HOME, else ~/.dsh). */
export function dshHome(): string {
  return process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
}

/** The snapshot tree a face of this kind ships from / lands in. */
const SNAPSHOT_DIR = { preset: 'agents', skill: 'skills' } as const
const TARGET_DIR = { preset: '.agent-presets', skill: 'skills' } as const

/** Where a face lands for discovery under the given harness home. */
export function faceTargetDir(home: string, face: MaterializeFace): string {
  return join(home, TARGET_DIR[face.kind], face.id)
}

/**
 * Copy the given faces from the caller's snapshot trees into the user roots
 * (idempotent overwrite). `packageRoot` is the caller's own package root —
 * each member passes its own so only its own snapshot is materialized.
 */
export async function materializeFaces(packageRoot: string, faces: readonly MaterializeFace[], home: string = dshHome()): Promise<void> {
  for (const face of faces) {
    await cp(join(packageRoot, SNAPSHOT_DIR[face.kind], face.id), faceTargetDir(home, face), { recursive: true, force: true })
  }
}

/**
 * Remove exactly the given faces' materialized subdirectories (plugin
 * unload). Single-profile deactivation keeps them: the directories are
 * user-global and may serve another profile.
 */
export async function removeFaces(faces: readonly MaterializeFace[], home: string = dshHome()): Promise<void> {
  for (const face of faces) {
    await rm(faceTargetDir(home, face), { recursive: true, force: true })
  }
}

/** Copy this package's own faces (the onboarding skill) into the user roots. */
export async function materializeAgentFaces(home: string = dshHome()): Promise<void> {
  await materializeFaces(PACKAGE_ROOT, CORE_FACES, home)
}

/** Remove exactly this plugin's materialized subdirectories (plugin unload). */
export async function removeAgentFaces(home: string = dshHome()): Promise<void> {
  await removeFaces(CORE_FACES, home)
}
