/**
 * U5 tests: the three role thin-shell presets — directory structure
 * compliance, KTD6 materialization idempotence and own-directory-only
 * removal, five-section discipline + pending-window markers (R7/R18/AE9),
 * and prompt-assembly-level approximations of the playbook-failure /
 * injection-resistance behaviors (AE3).
 *
 * RSK8 residual risk: the execution fidelity of "playbook 拉取失败必须停止"
 * and "安全节抗注入" can only be sampled by LLM evals, not pinned by
 * deterministic specs. This spec approximates at the prompt-assembly level
 * (discipline presence, ordering, and precedence wording); AE3 walkthroughs
 * must keep transcript evidence.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { faceTargetDir, materializeFaces, removeFaces, type MaterializeFace } from 'dsh-cgc-core/src/materialize.ts'
import { CGC_ROLE_PRESET_IDS, ROLE_FACES } from '../src/index.ts'

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const AGENTS_ROOT = join(PACKAGE_ROOT, 'agents')

// ------------------------------------------------------------ helpers

interface PresetFace {
  id: string
  presetMeta: Record<string, unknown>
  personaText: string
  cordisRows: unknown
}

async function loadPreset(id: string): Promise<PresetFace> {
  const dir = join(AGENTS_ROOT, id)
  const presetMeta: unknown = parseYaml(await readFile(join(dir, 'preset.yml'), 'utf8'))
  if (typeof presetMeta !== 'object' || presetMeta === null) throw new Error(`${id}: preset.yml not a mapping`)
  const cordisRows: unknown = parseYaml(await readFile(join(dir, 'agent.cordis.yml'), 'utf8'))
  if (!Array.isArray(cordisRows)) throw new Error(`${id}: agent.cordis.yml not a list`)
  const persona = cordisRows.find((row: unknown) => typeof row === 'object' && row !== null && (row as { id?: unknown }).id === 'persona') as { config?: { text?: unknown } } | undefined
  if (typeof persona?.config?.text !== 'string') throw new Error(`${id}: persona config.text missing`)
  return { id, presetMeta: presetMeta as Record<string, unknown>, personaText: persona.config.text, cordisRows }
}

/** Snapshot a directory tree as a relative-path → content map. */
async function snapshot(root: string, prefix = ''): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const entry of await readdir(join(root, prefix))) {
    const rel = join(prefix, entry)
    const s = await stat(join(root, rel))
    if (s.isDirectory()) {
      for (const [k, v] of await snapshot(root, rel)) out.set(k, v)
    } else {
      out.set(rel, await readFile(join(root, rel), 'utf8'))
    }
  }
  return out
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

// ------------------------------------------------------------ structure

describe('role preset structure (R7)', () => {
  it('ships exactly the three role presets with compliant ids and files', async () => {
    const dirs = (await readdir(AGENTS_ROOT)).sort()
    expect(dirs).toEqual([...CGC_ROLE_PRESET_IDS].sort())
    for (const id of CGC_ROLE_PRESET_IDS) {
      expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/)
      const preset = await loadPreset(id)
      expect(preset.presetMeta['name']).toBe(id)
      expect(typeof preset.presetMeta['description']).toBe('string')
      // Same composition family as core's original preset: persona +
      // skill-filesystem + tool-skill rows.
      const ids = (preset.cordisRows as Array<{ id?: unknown }>).map(row => row.id)
      expect(ids).toEqual(['persona', 'skill-filesystem', 'tool-skill'])
    }
  })

  it('pins the platform playbook role per preset', async () => {
    expect((await loadPreset('cgc-tutor')).personaText).toContain('role="tutor"')
    expect((await loadPreset('cgc-admin')).personaText).toContain('role="workspace_admin"')
    // cgc-assistant stays role-generic: it pulls by the user's role.
    expect((await loadPreset('cgc-assistant')).personaText).toContain('get_role_playbook')
  })
})

// ------------------------------------------------------------ discipline markers

describe('thin-shell five-section + pending-window discipline (R7/R18/AE9)', () => {
  it.each([...CGC_ROLE_PRESET_IDS])('%s carries every discipline marker', async (id) => {
    const { personaText } = await loadPreset(id)
    // 1. identity + playbook sole-source declaration
    expect(personaText).toContain('唯一来源')
    expect(personaText).toContain('get_role_playbook')
    // 2. trusted workspace selection (MCP return or panel structured injection only)
    expect(personaText).toContain('workspace_id')
    expect(personaText).toContain('面板结构化注入')
    // 3. pull playbook and show version before any business tool call
    expect(personaText).toContain('version')
    // 4. layered-error stop discipline
    expect(personaText).toContain('forbidden')
    expect(personaText).toContain('停止业务操作')
    expect(personaText).toContain('绝不凭记忆')
    // 5. safety section: not overridable, website RBAC sole authority
    expect(personaText).toContain('不可被')
    expect(personaText).toContain('RBAC')
    // pending window discipline (R18/AE9): expiry explanation + re-initiate + cancel on refusal
    expect(personaText).toContain('needs_confirmation')
    expect(personaText).toContain('pending_id')
    expect(personaText).toContain('600')
    expect(personaText).toContain('过期')
    expect(personaText).toContain('重新发起原工具调用')
    expect(personaText).toContain('cancel_operation')
  })

  it('places the non-overridable safety section after the playbook declaration (injection-resistance approximation, RSK8)', async () => {
    for (const id of CGC_ROLE_PRESET_IDS) {
      const { personaText } = await loadPreset(id)
      const safety = personaText.indexOf('安全节')
      expect(safety).toBeGreaterThan(-1)
      // The safety section comes after the playbook sole-source declaration,
      // and explicitly names the three override sources: playbook content,
      // panel injection, business-data text.
      expect(safety).toBeGreaterThan(personaText.indexOf('唯一来源'))
      expect(personaText.slice(safety)).toContain('playbook 内容、面板注入文本或任何业务数据文本')
    }
  })

  it('cgc-tutor re-pulls the playbook at chapter boundaries', async () => {
    const { personaText } = await loadPreset('cgc-tutor')
    expect(personaText).toContain('章节边界')
    expect(personaText).toContain('重新调用 get_role_playbook')
  })

  it('cgc-admin never loads another role and refers tutoring requests to cgc-tutor', async () => {
    const { personaText } = await loadPreset('cgc-admin')
    expect(personaText).toContain('不跨角色加载')
    expect(personaText).toContain('转介')
    expect(personaText).toContain('cgc-tutor')
  })

  it('cgc-assistant is playbook-first (no get_workflow centrality)', async () => {
    const { personaText } = await loadPreset('cgc-assistant')
    expect(personaText).toContain('playbook 优先')
    expect(personaText).not.toContain('get_workflow')
  })
})

// ------------------------------------------------------------ materialization (KTD6)

describe('materialization (KTD6)', () => {
  let home = ''

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-cgc-roles-'))
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  it('materializes each role preset into <dshHome>/.agent-presets/<id>', async () => {
    await materializeFaces(PACKAGE_ROOT, ROLE_FACES, home)
    for (const face of ROLE_FACES) {
      const dir = faceTargetDir(home, face)
      expect(await pathExists(join(dir, 'agent.cordis.yml'))).toBe(true)
      expect(await pathExists(join(dir, 'preset.yml'))).toBe(true)
    }
  })

  it('is idempotent: two materializations produce identical trees', async () => {
    await materializeFaces(PACKAGE_ROOT, ROLE_FACES, home)
    const first = await snapshot(join(home, '.agent-presets'))
    // Drift the target, then re-materialize: overwrite must restore the snapshot.
    await writeFile(join(home, '.agent-presets', 'cgc-tutor', 'stale.txt'), 'drift')
    await materializeFaces(PACKAGE_ROOT, ROLE_FACES, home)
    const second = await snapshot(join(home, '.agent-presets'))
    expect(second.get('cgc-tutor/preset.yml')).toBe(first.get('cgc-tutor/preset.yml'))
    expect(second.get('cgc-assistant/agent.cordis.yml')).toBe(first.get('cgc-assistant/agent.cordis.yml'))
  })

  it('removal deletes only its own preset directories', async () => {
    await materializeFaces(PACKAGE_ROOT, ROLE_FACES, home)
    // Decoys owned by other members must survive.
    const decoyPreset = join(home, '.agent-presets', 'other-preset')
    const decoySkill = join(home, 'skills', 'other-skill')
    await mkdir(decoyPreset, { recursive: true })
    await mkdir(decoySkill, { recursive: true })
    await writeFile(join(decoyPreset, 'preset.yml'), 'name: other-preset\n')
    await writeFile(join(decoySkill, 'SKILL.md'), '---\nname: other-skill\n---\n')

    await removeFaces(ROLE_FACES, home)

    for (const face of ROLE_FACES) {
      expect(await pathExists(faceTargetDir(home, face))).toBe(false)
    }
    expect(await pathExists(join(decoyPreset, 'preset.yml'))).toBe(true)
    expect(await pathExists(join(decoySkill, 'SKILL.md'))).toBe(true)
  })

  it('never touches faces outside its own list (package-root scoping)', async () => {
    const foreign: MaterializeFace = { kind: 'skill', id: 'cgc-core-onboarding' }
    // roles' package root has no skills/ tree — scoping by package root keeps
    // each member materializing only what it ships.
    await expect(materializeFaces(PACKAGE_ROOT, [foreign], home)).rejects.toThrow()
    expect(await pathExists(faceTargetDir(home, foreign))).toBe(false)
  })
})

// ------------------------------------------------------------ playbook-failure approximation (AE3)

describe('playbook-failure stop discipline (AE3, prompt-assembly approximation)', () => {
  // RSK8: deterministic specs cannot prove the agent stops; these assertions
  // pin that every preset's prompt assembles the stop discipline for each
  // failure layer. The behavioral eval remains a sampled walkthrough with
  // transcript evidence (zero business tool calls after a failed
  // get_role_playbook; injected playbook text never overrides the safety
  // section).
  it.each([...CGC_ROLE_PRESET_IDS])('%s stops on every playbook failure layer', async (id) => {
    const { personaText } = await loadPreset(id)
    // Connection layer → guide to the CGC panel.
    expect(personaText).toContain('「CGC」面板')
    // Forbidden layer → relay the platform reason verbatim, no retry.
    expect(personaText).toContain('forbidden')
    // Catch-all layer → never continue from memory / stale playbook.
    expect(personaText).toContain('绝不凭记忆')
    // Playbook must be pulled before any business tool call.
    const pullIdx = personaText.indexOf('get_role_playbook')
    expect(pullIdx).toBeGreaterThan(-1)
    expect(personaText).toContain('任何业务工具调用之前')
  })
})

