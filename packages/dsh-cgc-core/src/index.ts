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
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { ActivityLog } from './activity.ts'
import { installApprovalGate } from './approval-gate.ts'
import { CsrfTokenStore } from './csrf.ts'
import { registerFamilyHandles, unregisterFamilyHandles } from './family.ts'
import { CgcEngine } from './engine.ts'
import { CgcEventHub, installSessionEventSource } from './events.ts'
import { installErrorHook } from './hooks.ts'
import { materializeAgentFaces, removeAgentFaces } from './materialize.ts'
import { PendingMemory } from './pending-memory.ts'
import { CGC_ANNOUNCEMENT, CGC_ANNOUNCEMENT_NAME, SECTION_ORDER } from './prompt.ts'
import { CONFIRMATION_TTL_SETTING, CGC_SETTINGS_NAMESPACE, DEFAULT_CONFIRMATION_TTL_SECONDS } from './protocol.ts'
import { makeRoutes } from './routes.ts'
import { installEventChannel } from './routes/events.ts'
import { Config, ConnectionStore } from './store.ts'

/** Stable cordis plugin name. */
export const name = 'dsh-cgc-core'

/** Services required before the CGC surfaces can mount. */
export const inject = ['webServer', 'tools', 'systemPrompt']

/** The settings namespace the connection section lives under. */
export const CGC_NAMESPACE = CGC_SETTINGS_NAMESPACE

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
  /** Live secret literals for literal-first redaction (RSK6). */
  const storeSecrets = (): readonly string[] => {
    const token = store.get().token
    return token === '' ? [] : [token]
  }
  // U7 event channel: one aggregator per activation (seq stays monotonic
  // across connection generations so stale panel cursors surface as gaps).
  const events = new CgcEventHub(activity, storeSecrets)

  // KTD4 hard gate: dual-anchor fail-closed approval over mcp__cgc-2046__*.
  // Registered once rather than per sync — the listeners only fire for CGC
  // tools, which exist only while the bridge is connected. The pending
  // memory's TTL re-reads the resolved settings section on every check, so
  // a `confirmation_ttl_seconds` edit applies without a reload; the key is
  // not schema-declared (schemastery passes user keys through) and invalid
  // values fall back to the platform default.
  const pendingMemory = new PendingMemory({
    ttlSeconds: () => {
      const section = ctx.get('settings')?.get(CGC_NAMESPACE)
      const ttl = typeof section === 'object' && section !== null
        ? (section as Record<string, unknown>)[CONFIRMATION_TTL_SETTING]
        : undefined
      return typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0
        ? ttl
        : DEFAULT_CONFIRMATION_TTL_SECONDS
    },
  })
  installApprovalGate(ctx, {
    memory: pendingMemory,
    secrets: storeSecrets,
  })
  const engine = new CgcEngine(ctx, activity)
  ctx.effect(() => () => { engine.dispose() }, 'dsh-cgc-core: engine')

  // Register the connection section on the settings service and capture its
  // scope/writer while the service is live (routes write through the writer;
  // absence fails loud at write). The trailing sync() below still covers
  // deployments with no settings service — the inject callback never fires
  // there, so reads stay on the composition entry.
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(CGC_NAMESPACE, Config, { base: config ?? {} })
    store.setSource(() => scope.get())
    store.setWriter(ops => sctx.settings.mutate(CGC_NAMESPACE, ops))
    // scope.watch fires on commits only — restore the boot connection from
    // the just-attached resolved section, then keep riding future commits.
    sync()
    const unwatch = scope.watch(() => { sync() })
    sctx.effect(() => () => {
      unwatch()
      store.setWriter(undefined)
      store.resetSource()
    }, 'dsh-cgc-core: settings scope')
  })

  // CSRF store (KTD5): one process-lifetime token; write routes require the
  // X-CGC-CSRF-Token header to match. The panels family (U8) reads it
  // through the family handoff to inject into its client bootstrap channel.
  const csrf = new CsrfTokenStore()
  registerFamilyHandles({ csrf })
  ctx.effect(() => () => { unregisterFamilyHandles() }, 'dsh-cgc-core: family handles')

  // Data plane (U6): routes invoke whitelisted platform tools through the
  // engine's live generation (engine.callTool); while disconnected every
  // data route answers 503 and write routes fail-closed 403 by construction.
  const routes = makeRoutes({ store, engine, activity, data: engine, csrf, events })
  let disposeRoutes: (() => void) | undefined
  let disposeSection: (() => void) | undefined
  let disposeHook: (() => void) | undefined
  let disposeEventSource: (() => void) | undefined

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
    if (disposeEventSource !== undefined) {
      disposeEventSource()
      disposeEventSource = undefined
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
        // U7: the WS push endpoint shares the routes' lifecycle.
        disposers.push(installEventChannel(ctx, events, storeSecrets))
        return () => { for (const dispose of disposers) dispose() }
      },
      'dsh-cgc-core: routes',
    )
    // U7 dual sources: the post-execute hook observes into the aggregator
    // (which owns the feed mirror); the session/event subscription pairs
    // tool/call → tool/result and dedupes by call id in the aggregator.
    disposeHook = installErrorHook(ctx, activity, storeSecrets, events)
    disposeEventSource = installSessionEventSource(ctx, events)
    // Settings-driven bridge rebuild (boot-restore and reconnect ride the
    // same path; connect failures land in the activity ring for /status).
    void engine.sync(
      value.url !== '' && value.token !== '' ? { url: value.url, token: value.token } : undefined,
    )
  }

  // Initial registration from the composition entry (covers deployments with
  // no settings service, whose inject callback above never fires).
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
