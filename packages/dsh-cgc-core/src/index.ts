/**
 * dsh-cgc-core — host half. Mounts the CGC MCP bridge engine (the
 * platform's tools as mcp__cgc-2046__*, whatever tools/list returns), the
 * /api/dsh-cgc-core route family, the error/activity hook, the
 * system-prompt announcement, and the KTD6 preset/skill materialization.
 * The browser half (./client) renders the connection status panel.
 * Everything rides official npm SDK packages and the settings service —
 * no dsh source changes.
 */

import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { ActivityLog } from './activity.ts'
import { CgcEngine } from './engine.ts'
import { installErrorHook } from './hooks.ts'
import { materializeAgentFaces, removeAgentFaces } from './materialize.ts'
import { CGC_ANNOUNCEMENT, CGC_ANNOUNCEMENT_NAME, SECTION_ORDER } from './prompt.ts'
import { CGC_SETTINGS_NAMESPACE } from './protocol.ts'
import { makeRoutes } from './routes.ts'
import { Config, ConnectionStore } from './store.ts'

/** Stable cordis plugin name. */
export const name = 'dsh-cgc-core'

/** Services required before the CGC surfaces can mount. */
export const inject = ['webServer', 'tools', 'systemPrompt']

/** The settings namespace (validated) the connection section lives under. */
export const CGC_NAMESPACE = settingsNamespace(CGC_SETTINGS_NAMESPACE)

export { Config }
export type { ConnectionConfig } from './store.ts'

/**
 * Mount the CGC connector surfaces.
 * @param ctx - host plugin context carrying webServer/tools/systemPrompt.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export function apply(ctx: Context, config?: Config): void {
  const store = new ConnectionStore(config)
  const activity = new ActivityLog()
  const engine = new CgcEngine(ctx, activity)
  ctx.effect(() => () => { engine.dispose() }, 'dsh-cgc-core: engine')

  // The provider's path-addressed writer, captured while the settings
  // service is live (routes write through it; absence fails loud at write).
  ctx.inject(['settings'], (sctx) => {
    store.setWriter(ops => sctx.settings.mutate(CGC_NAMESPACE, ops))
    sctx.effect(() => () => { store.setWriter(undefined) }, 'dsh-cgc-core: settings writer')
  })

  const routes = makeRoutes({ store, engine, activity })
  let disposeRoutes: (() => void) | undefined
  let disposeSection: (() => void) | undefined
  let disposeHook: (() => void) | undefined

  // Register (or drop) every surface to match the current section. Each
  // group keeps one disposer; re-registering first tears the old one down so
  // duplicate-name registrations never throw.
  const sync = (): void => {
    const value = store.get()
    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
    if (disposeRoutes !== undefined) {
      disposeRoutes()
      disposeRoutes = undefined
    }
    if (disposeHook !== undefined) {
      disposeHook()
      disposeHook = undefined
    }
    if (!value.enabled) {
      void engine.sync(undefined)
      return
    }
    if (value.announceToAgent) {
      disposeSection = ctx.systemPrompt.section({
        name: CGC_ANNOUNCEMENT_NAME,
        order: SECTION_ORDER,
        text: CGC_ANNOUNCEMENT,
      })
    }
    disposeRoutes = ctx.effect(
      () => {
        const disposers = routes.map(route => ctx.webServer.register(route))
        return () => { for (const dispose of disposers) dispose() }
      },
      'dsh-cgc-core: routes',
    )
    disposeHook = installErrorHook(ctx, activity, () => {
      const token = store.get().token
      return token === '' ? [] : [token]
    })
    // Settings-driven bridge rebuild (boot-restore and reconnect ride the
    // same path; connect failures land in the activity ring for /status).
    void engine.sync(
      value.url !== '' && value.token !== '' ? { url: value.url, token: value.token } : undefined,
    )
  }

  installSettingsSection(ctx, CGC_NAMESPACE, Config, config ?? {}, {
    setSource: (source) => {
      store.setSource(source)
    },
    onChange: sync,
  })

  // Initial registration from the composition entry (covers deployments with
  // no settings service, whose installSettingsSection never fires its hooks).
  sync()

  // KTD6: materialize the agent preset + onboarding skill into the user
  // roots; remove exactly our own two subdirectories on unload.
  void materializeAgentFaces().catch((error: unknown) => {
    ctx.logger.warn(`dsh-cgc-core: preset/skill materialization failed: ${error instanceof Error ? error.message : String(error)}`)
  })
  ctx.effect(() => () => {
    void removeAgentFaces().catch(() => {})
  }, 'dsh-cgc-core: agent faces')
}
