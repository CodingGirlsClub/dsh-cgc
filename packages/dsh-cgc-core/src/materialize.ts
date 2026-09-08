/**
 * KTD6 content materialization: the package ships the cgc-assistant agent
 * preset and the cgc-core-onboarding skill in its own agents/ and skills/
 * trees, but DSH only discovers them under the user roots
 * (`<dshHome>/.agent-presets/` and `<dshHome>/skills/`). On activation the
 * plugin copies its snapshot into those roots (overwrite — the copy is
 * idempotent and re-materialization covers snapshot drift); on unload it
 * removes exactly its own two subdirectories and nothing else.
 */

import { cp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The preset/skill ids this package owns (directory names under the user roots). */
export const CGC_PRESET_ID = 'cgc-assistant'
export const CGC_SKILL_ID = 'cgc-core-onboarding'

/** Package root: src/ and lib/ both sit one level below it. */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The harness home directory ($DSH_HOME, else ~/.dsh). */
export function dshHome(): string {
  return process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
}

/** Where the preset snapshot lands for discovery. */
export function presetTargetDir(home: string): string {
  return join(home, '.agent-presets', CGC_PRESET_ID)
}

/** Where the skill snapshot lands for discovery. */
export function skillTargetDir(home: string): string {
  return join(home, 'skills', CGC_SKILL_ID)
}

/**
 * Copy the shipped preset and skill into the user roots (idempotent
 * overwrite).
 */
export async function materializeAgentFaces(home: string = dshHome()): Promise<void> {
  await cp(join(PACKAGE_ROOT, 'agents', CGC_PRESET_ID), presetTargetDir(home), { recursive: true, force: true })
  await cp(join(PACKAGE_ROOT, 'skills', CGC_SKILL_ID), skillTargetDir(home), { recursive: true, force: true })
}

/**
 * Remove exactly this plugin's materialized subdirectories (plugin unload).
 * Single-profile deactivation keeps them: the directories are user-global
 * and may serve another profile.
 */
export async function removeAgentFaces(home: string = dshHome()): Promise<void> {
  await rm(presetTargetDir(home), { recursive: true, force: true })
  await rm(skillTargetDir(home), { recursive: true, force: true })
}
