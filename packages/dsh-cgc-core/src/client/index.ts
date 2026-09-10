/**
 * Browser-half entry for the dsh-cgc-core plugin — runs inside the dsh web
 * GUI.
 *
 * Registers the dsh-cgc locale dictionaries and mounts the two DOM surfaces:
 * the sidebar entry row (toggles the panel) and the CGC connection panel in
 * the center column. Failure policy: DOM mounting problems are logged, never
 * thrown — the web shell fails the whole boot when a plugin apply throws, and
 * an external plugin must not take the GUI down.
 *
 * Export discipline (packages/client rule): the /client surface carries what
 * cordis loading needs plus types only — all value exports stay internal.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the LocaleNamespaceMap merge table.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { CgcApi } from './api.ts'
import { en, zh, type CgcKey } from './locales.ts'
import { mountPanel } from './mount.tsx'
import { PanelController } from './panel/controller.ts'
import { mountSidebarEntry } from './sidebar-entry.ts'

/** Locale namespace this plugin owns. */
const NS = 'dsh-cgc'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-cgc surface copy. */
    'dsh-cgc': CgcKey
  }
}

/** Required services (fiber inject waiting — the runtime must be up first). */
export const inject = ['slots', 'locale']

/** Type-only surface (export discipline: no value exports beyond the plugin contract). */
export type { PanelControllerSnapshot } from './panel/controller.ts'
export type { CgcPanelProps } from './panel/CgcPanel.tsx'
export type { CgcKey } from './locales.ts'

/**
 * Mount the CGC panel.
 * @param ctx - client root context (locale service).
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-cgc: dictionaries')

  const controller = new PanelController()
  const api = new CgcApi()
  const disposers: Array<() => void> = []
  try {
    disposers.push(mountSidebarEntry(controller))
    disposers.push(mountPanel(controller, api))
  } catch (error) {
    // DOM failures degrade the panel, never the GUI.
    console.warn('[dsh-cgc] mount failed:', error)
  }
  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) dispose()
  }, 'dsh-cgc: ui mounts')
}
