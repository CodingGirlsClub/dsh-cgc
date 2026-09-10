/**
 * Browser-half entry for dsh-cgc-panels — runs inside the dsh web GUI.
 *
 * Registers the dsh-cgc-panels locale dictionaries and the sidebar
 * footer-action entry (the hub of the right-docked panel family). Failure
 * policy mirrors the core client: DOM/locale problems degrade the panel,
 * never the GUI — but a host too old to declare the sidebar.footer.action
 * slot IS reported: after the boot settle window with no registration, a
 * user-visible banner names the minimum DSH version (fail-fast check, RSK1).
 *
 * Export discipline (packages/client rule): the /client surface carries what
 * cordis loading needs plus types only — all value exports stay internal.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the sidebar slot declarations (sidebar.footer.action).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: pulls the slots service Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { PanelsApi } from './api.ts'
import { readBoot } from './boot.ts'
import { EventChannel } from './events.ts'
import { en, zh, type PanelsKey } from './locales.ts'
import { CGC_PANEL_API } from '../protocol.ts'
import { PanelsController } from './panel/controller.ts'
import { tt } from './panel/helpers.ts'
import { PanelsEntry } from './panel/PanelsShell.tsx'
import type { PanelsRuntime } from './panel/surfaceProps.ts'
import type { SessionsLike } from './session.ts'

/** Locale namespace this plugin owns. */
const NS = 'dsh-cgc-panels'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-cgc-panels surface copy. */
    'dsh-cgc-panels': PanelsKey
  }
}

/** Required services (fiber inject waiting — the runtime must be up first). */
export const inject = ['slots', 'locale']

/** Minimum DSH version the client half activates against (mirrors host). */
export const MIN_DSH_VERSION = '0.1.0-rc.6'

/** Boot settle window before the missing-slot error banner shows. */
const SLOT_PROBE_MS = 5000

/** Type-only surface (export discipline: no value exports beyond the plugin contract). */
export type { PanelsControllerSnapshot } from './panel/controller.ts'
export type { PanelsRuntime, SurfaceProps } from './panel/surfaceProps.ts'
export type { PanelsKey } from './locales.ts'

/** The WS endpoint URL for the event channel (scheme mirrors the page). */
function eventsWsUrl(): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${window.location.host}${CGC_PANEL_API.events}`
}

/**
 * Mount the CGC panel family.
 * @param ctx - client root context (slots + locale services; sessions read
 *   opportunistically so a runtime-less host degrades to the hub).
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-cgc-panels: dictionaries')

  const boot = readBoot()
  const api = new PanelsApi(boot.csrfToken)
  const controller = new PanelsController()
  const events = new EventChannel({
    wsUrl: eventsWsUrl,
    fetchPage: (afterSeq) => api.events(afterSeq),
  })
  const sessions: SessionsLike | undefined = ctx.get('sessions')
  const runtime: PanelsRuntime = {
    controller,
    api,
    events,
    sessions,
    openExternal: (url) => { window.open(url, '_blank', 'noopener,noreferrer') },
  }

  // Register the hub entry into the sidebar footer action row (declared by
  // ui-sidebar; inject waits out declaration order). Track whether the
  // registration ever landed for the fail-fast probe below.
  let registered = false
  const disposeSlot = ctx.slots.inject('sidebar.footer.action', () => {
    registered = true
    return ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'dsh-cgc-panels',
      order: 90,
      label: () => tt('entry.label'),
      inject: (): PanelsRuntime => runtime,
    }, PanelsEntry)
  })
  ctx.effect(() => disposeSlot, 'dsh-cgc-panels: sidebar entry')

  // Fail-fast probe (RSK1): if the host never declares sidebar.footer.action
  // (a DSH older than the slot contract), the entry silently never appears —
  // surface a user-visible banner naming the minimum DSH version instead.
  const probe = setTimeout(() => {
    if (registered) return
    if (ctx.slots.spec('sidebar.footer.action') !== undefined) return
    const banner = document.createElement('div')
    banner.setAttribute('data-dsh-cgc-panels-version-error', '')
    banner.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:9999;background:#8b1a1a;color:#fff;padding:8px 12px;border-radius:6px;font-size:12px;max-width:320px'
    banner.textContent = tt('panel.versionError', { version: MIN_DSH_VERSION, missing: 'sidebar.footer.action' })
    document.body.appendChild(banner)
    console.error(`[dsh-cgc-panels] requires DSH >= ${MIN_DSH_VERSION}: sidebar.footer.action slot not declared`)
  }, SLOT_PROBE_MS)
  ctx.effect(() => () => { clearTimeout(probe) }, 'dsh-cgc-panels: slot probe')

  events.start()
  ctx.effect(() => () => { events.stop() }, 'dsh-cgc-panels: event channel')
}
