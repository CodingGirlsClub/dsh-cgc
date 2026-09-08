/**
 * U4/U5 tests: the apply-level composition — system-prompt announcement,
 * cgc-assistant preset + onboarding skill materialization into DSH_HOME,
 * preset discovery, and removal on plugin unload (KTD6).
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { scanRoot } from '@deepseek-ai/dsh-agent-presets'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import { parse as parseYaml } from 'yaml'
import { apply } from '../src/index.ts'
import { CGC_ANNOUNCEMENT_NAME } from '../src/prompt.ts'
import { CGC_API } from '../src/protocol.ts'
import { CGC_PRESET_ID, CGC_SKILL_ID, presetTargetDir, skillTargetDir } from '../src/materialize.ts'
import { settingsNamespace, type SettingsProvider } from '@deepseek-ai/dsh-settings'
import { MemorySettings, mountRegistry } from './helpers.ts'

/** Poll until the predicate holds or the deadline passes. */
async function eventually(check: () => Promise<boolean> | boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error('eventually: deadline exceeded')
    const delay = Promise.withResolvers<void>()
    setTimeout(delay.resolve, 50)
    await delay.promise
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

describe('apply: agent faces (U4 announcement + U5/U6 materialization)', () => {
  let home = ''
  let ctx: Context | undefined
  let provider: SettingsProvider
  let registeredRoutes: WebRoute[]
  const savedHome = process.env.DSH_HOME

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-cgc-home-'))
    process.env.DSH_HOME = home
    ctx = await mountRegistry()
    await ctx.plugin(MemorySettings)
    const settings = ctx.get('settings')
    if (settings === undefined) throw new Error('settings service not mounted')
    provider = settings
    registeredRoutes = []
    // Deliberate test stub: apply() only calls webServer.register; the real
    // server is covered by routes.spec.ts over HTTP.
    const webServerStub: WebServer = {
      register: (route: WebRoute) => {
        registeredRoutes.push(route)
        return () => {
          const index = registeredRoutes.indexOf(route)
          if (index >= 0) registeredRoutes.splice(index, 1)
        }
      },
    } as unknown as WebServer
    ctx.provide('webServer', webServerStub)
    apply(ctx)
  })

  afterEach(async () => {
    if (ctx !== undefined) await ctx.fiber.dispose()
    process.env.DSH_HOME = savedHome
    await rm(home, { recursive: true, force: true })
  })

  it('announces the plugin in the assembled system prompt (U4)', async () => {
    expect(registeredRoutes.map(r => r.path).sort()).toEqual([CGC_API.connect, CGC_API.status].sort())
    const assembly = await ctx!.systemPrompt.assemble()
    const section = assembly.sections.find(s => s.name === CGC_ANNOUNCEMENT_NAME)
    expect(section, 'announcement section missing').toBeDefined()
    const content = JSON.stringify(section)
    for (const marker of ['mcp__cgc-2046__', 'workspace_id', 'confirm_operation', 'create_invitation', 'token']) {
      expect(content).toContain(marker)
    }
  })

  it('drops the announcement when announceToAgent is disabled', async () => {
    await provider.mutate(settingsNamespace('dsh-cgc-core'), [{ op: 'set', path: ['announceToAgent'], value: false }])
    await eventually(async () => {
      const assembly = await ctx!.systemPrompt.assemble()
      return assembly.sections.every(s => s.name !== CGC_ANNOUNCEMENT_NAME)
    })
  })

  it('materializes the cgc-assistant preset and the onboarding skill into DSH_HOME (KTD6)', async () => {
    const presetDir = presetTargetDir(home)
    const skillDir = skillTargetDir(home)
    await eventually(async () => (await pathExists(join(presetDir, 'agent.cordis.yml'))) && (await pathExists(join(skillDir, 'SKILL.md'))))
    expect(await pathExists(join(presetDir, 'preset.yml'))).toBe(true)

    // The preset is discoverable and not broken.
    const presets = await scanRoot({ path: join(home, '.agent-presets'), trust: 'user' })
    const preset = presets.find(p => p.id === CGC_PRESET_ID)
    if (preset === undefined) throw new Error('cgc-assistant not discovered by scanRoot')
    expect(preset.broken).toBeUndefined()
    expect(preset.description).toContain('CGC-2046')
    const persona = await readFile(join(presetDir, 'agent.cordis.yml'), 'utf8')
    expect(persona).toContain('mcp__cgc-2046__')
    expect(persona).toContain('needs_confirmation')
  })

  it('onboarding skill has valid frontmatter and covers both outcome branches (U5)', async () => {
    const skillPath = join(skillTargetDir(home), 'SKILL.md')
    await eventually(() => pathExists(skillPath))
    const raw = await readFile(skillPath, 'utf8')
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw)
    if (match === null) throw new Error('SKILL.md frontmatter missing')
    const frontmatter: unknown = parseYaml(match[1]!)
    if (typeof frontmatter !== 'object' || frontmatter === null) throw new Error('frontmatter not a mapping')
    if (!('name' in frontmatter) || !('description' in frontmatter)) throw new Error('frontmatter requires name + description')
    expect(frontmatter.name).toBe(CGC_SKILL_ID)
    if (typeof frontmatter.name !== 'string') throw new Error('name not a string')
    expect(isSkillName(frontmatter.name)).toBe(true)
    if (typeof frontmatter.description !== 'string' || frontmatter.description.length <= 20) {
      throw new Error('description missing or too short')
    }
    const body = match[2]!
    // Success branch + failure branches + the three disciplines.
    for (const marker of ['已连接', '401', '连接错误', 'workspace_id', 'confirm_operation', 'create_invitation', '吊销']) {
      expect(body).toContain(marker)
    }
  })

  it('removes the materialized faces when the plugin unloads (KTD6)', async () => {
    const presetDir = presetTargetDir(home)
    const skillDir = skillTargetDir(home)
    await eventually(async () => (await pathExists(join(presetDir, 'agent.cordis.yml'))) && (await pathExists(join(skillDir, 'SKILL.md'))))
    if (ctx === undefined) throw new Error('ctx missing')
    await ctx.fiber.dispose()
    ctx = undefined
    await eventually(async () => !(await pathExists(presetDir)) && !(await pathExists(skillDir)))
  })
})
