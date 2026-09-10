/**
 * U4/U5 tests: the apply-level composition — system-prompt announcement and
 * onboarding skill materialization into DSH_HOME, and removal on plugin
 * unload (KTD6). The role agent presets moved to the dsh-cgc-roles package
 * (U5), which materializes its own agents/ snapshot; core owns only its
 * skill.
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import { parse as parseYaml } from 'yaml'
import { apply } from '../src/index.ts'
import { CGC_ANNOUNCEMENT_NAME } from '../src/prompt.ts'
import { CGC_API } from '../src/protocol.ts'
import { CGC_SKILL_ID, faceTargetDir } from '../src/materialize.ts'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
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
    // Deliberate test stub: apply() calls webServer.register and (since U7)
    // registerUpgrade; the real server is covered by routes.spec.ts and
    // events.spec.ts over HTTP/real handshakes.
    const webServerStub: WebServer = {
      register: (route: WebRoute) => {
        registeredRoutes.push(route)
        return () => {
          const index = registeredRoutes.indexOf(route)
          if (index >= 0) registeredRoutes.splice(index, 1)
        }
      },
      registerUpgrade: () => () => {},
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
    // 路由族不变量（漂移免疫，不断言全集）：全部路由在 core 命名空间内
    //（R12 独占 /api/dsh-cgc-core），且核心路由在场；集合随 U6/U7 增长。
    const routePaths = registeredRoutes.map(r => r.path)
    for (const p of routePaths) expect(p.startsWith('/api/dsh-cgc-core/')).toBe(true)
    for (const corePath of [CGC_API.connect, CGC_API.status]) expect(routePaths).toContain(corePath)
    const assembly = await ctx!.systemPrompt.assemble()
    const section = assembly.sections.find(s => s.name === CGC_ANNOUNCEMENT_NAME)
    expect(section, 'announcement section missing').toBeDefined()
    const content = JSON.stringify(section)
    // Discipline markers only — never specific business tool names.
    for (const marker of ['mcp__cgc-2046__', 'workspace_id', 'confirm_operation', 'tools/list', 'token']) {
      expect(content).toContain(marker)
    }
    // Drift immunity: the announcement must not enumerate the tool set.
    for (const name of ['get_workspace_context', 'list_members', 'get_workflow', 'get_step_output', 'save_step_output', 'create_invitation']) {
      expect(content).not.toContain(name)
    }
  })

  it('drops the announcement when announceToAgent is disabled', async () => {
    await provider.mutate('dsh-cgc-core', [{ op: 'set', path: ['announceToAgent'], value: false }])
    await eventually(async () => {
      const assembly = await ctx!.systemPrompt.assemble()
      return assembly.sections.every(s => s.name !== CGC_ANNOUNCEMENT_NAME)
    })
  })

  it('materializes the onboarding skill into DSH_HOME, and no presets (KTD6 — presets moved to dsh-cgc-roles)', async () => {
    const skillDir = faceTargetDir(home, { kind: 'skill', id: CGC_SKILL_ID })
    await eventually(() => pathExists(join(skillDir, 'SKILL.md')))
    // Core no longer ships or materializes agent presets; dsh-cgc-roles does.
    expect(await pathExists(join(home, '.agent-presets', 'cgc-assistant'))).toBe(false)
  })

  it('onboarding skill has valid frontmatter and covers both outcome branches (U5)', async () => {
    const skillPath = join(faceTargetDir(home, { kind: 'skill', id: CGC_SKILL_ID }), 'SKILL.md')
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
    // Success branch + failure branches + discipline markers (incl. the
    // verify-before-reporting step) — never specific business tool names.
    for (const marker of ['已连接', '401', '连接错误', 'workspace_id', 'confirm_operation', '吊销', '报告完成']) {
      expect(body).toContain(marker)
    }
  })

  it('removes the materialized skill when the plugin unloads (KTD6)', async () => {
    const skillDir = faceTargetDir(home, { kind: 'skill', id: CGC_SKILL_ID })
    await eventually(() => pathExists(join(skillDir, 'SKILL.md')))
    if (ctx === undefined) throw new Error('ctx missing')
    await ctx.fiber.dispose()
    ctx = undefined
    await eventually(async () => !(await pathExists(skillDir)))
  })
})
