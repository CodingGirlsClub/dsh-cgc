/**
 * dsh-cgc-panels — host half. Owns no routes and no tools: the panel family
 * consumes dsh-cgc-core's /api/dsh-cgc-core route family over HTTP/WS. The
 * host half's single job is the fail-fast extension-point check plus the
 * CSRF bootstrap index tap (see boot-inject.ts) that hands core's csrfToken
 * to the browser half. The browser half (./client) renders the panel hub.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { makeBootIndexTap } from './boot-inject.ts'

/** Stable cordis plugin name. */
export const name = 'dsh-cgc-panels'

/** Services required before the panels host half can mount. */
export const inject = ['webServer']

/**
 * The minimum DSH host version this package activates against. Bumped when a
 * consumed extension point (webServer.registerUpgrade / webServer.tapIndex /
 * the ctx.approval seam / the sidebar.footer.action slot) lands in a later
 * host release; the activation error names this version.
 */
export const MIN_DSH_VERSION = '0.1.0-rc.6'

/** The narrow structural probe the activation check runs against. */
export interface HostExtensionProbe {
  webServer?: {
    registerUpgrade?: unknown
    tapIndex?: unknown
  }
  /** cordis Context.get — opportunistic service lookup. */
  get?(name: string): unknown
}

/** Runtime narrowing for the opportunistic approval-seam probe. */
function isApprovalSeam(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  if (!('request' in value)) return false
  return typeof value.request === 'function'
}

/**
 * The host extension points the panel family depends on (RSK1/RSK5):
 * - `webServer.registerUpgrade` — core's U7 event channel (the panel's push
 *   feed) mounts through it; a host too old to have it cannot serve the
 *   events endpoint.
 * - `webServer.tapIndex` — the CSRF bootstrap channel this package injects.
 * - `ctx.approval` — the fail-closed local approval seam (U4 hard gate) that
 *   panel-injected write directives resolve through; without it the ask
 *   degrades to deny and the family misleads the user about its write paths.
 * @returns the missing extension-point names (empty = host is new enough).
 */
export function missingHostExtensionPoints(ctx: HostExtensionProbe): string[] {
  const missing: string[] = []
  if (typeof ctx.webServer?.registerUpgrade !== 'function') missing.push('webServer.registerUpgrade')
  if (typeof ctx.webServer?.tapIndex !== 'function') missing.push('webServer.tapIndex')
  const approval = ctx.get?.('approval')
  if (!isApprovalSeam(approval)) missing.push('ctx.approval')
  return missing
}

/**
 * Mount the panels host half.
 * @param ctx - host plugin context carrying the webServer service.
 * @throws when a required host extension point is absent; the error names the
 *   minimum DSH version so the user sees an upgrade instruction, not a stack.
 */
export function apply(ctx: Context): void {
  const missing = missingHostExtensionPoints(ctx)
  if (missing.length > 0) {
    throw new Error(
      `dsh-cgc-panels requires DSH >= ${MIN_DSH_VERSION}: missing host extension point(s): ${missing.join(', ')}. `
      + 'Upgrade DSH and reload the profile. / '
      + `dsh-cgc-panels 需要 DSH >= ${MIN_DSH_VERSION}（缺失宿主扩展点：${missing.join('、')}），请升级 DSH 后重载 profile。`,
    )
  }

  // The family handoff module is a process singleton owned by the installed
  // dsh-cgc-core instance — resolve it at runtime (never bundle a copy) and
  // tolerate its absence: without core the tap injects an empty bootstrap
  // and the client disables write flows with a visible notice.
  let familyField: () => Record<string, string> | undefined = () => undefined
  void import('dsh-cgc-core/src/family.ts').then(
    (mod) => { familyField = mod.familyCsrfBootstrapField },
    (error: unknown) => {
      ctx.logger.warn(
        `dsh-cgc-panels: dsh-cgc-core family handoff unavailable (${error instanceof Error ? error.message : String(error)}); `
        + 'write flows stay disabled until core is installed and active.',
      )
    },
  )

  ctx.effect(
    () => ctx.webServer.tapIndex(makeBootIndexTap(() => familyField())),
    'dsh-cgc-panels: csrf bootstrap',
  )
}
