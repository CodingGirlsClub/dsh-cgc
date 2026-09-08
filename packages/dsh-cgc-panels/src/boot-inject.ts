/**
 * Host-half bootstrap plumbing (KTD3/KTD5): the panels package owns no write
 * routes of its own — it consumes dsh-cgc-core's data plane, whose write
 * routes require the X-CGC-CSRF-Token header. Core hands the token to this
 * package through the family handoff on globalThis (familyHandles, Symbol.for key);
 * this module injects it into the SPA document as `window.__DSH_CGC_PANELS_BOOT__`
 * via the web server's index tap — the same channel dsh-client-modules uses
 * for window.__DSH_BOOT__, and the ONLY sanctioned way the token leaves the
 * host process (see core csrf.ts: never a route response body).
 *
 * The tap is a pure function re-evaluated on every index render, so a core
 * (re)activation rotating the token reaches the next page load without a
 * panels reload.
 */

/** Window key the browser half reads the bootstrap payload from. */
export const PANELS_BOOT_KEY = '__DSH_CGC_PANELS_BOOT__' as const

/**
 * Build the index.html transform injecting the bootstrap script as the first
 * child of <head> (before the shell bundle runs, matching the __DSH_BOOT__
 * precedent). `<` is escaped in the JSON so the payload cannot break out of
 * the script element.
 * @param boot - lazy bootstrap field reader (core's familyHandles;
 *   may answer undefined before core mounts — the page then gets an empty
 *   object and write flows stay disabled).
 */
export function makeBootIndexTap(boot: () => Record<string, string> | undefined): (html: string) => string {
  return (html) => {
    const json = JSON.stringify(boot() ?? {}).replaceAll('<', '\\u003c')
    const script = `<script>window.${PANELS_BOOT_KEY} = ${json}</script>`
    const head = html.indexOf('<head>')
    if (head !== -1) return `${html.slice(0, head + 6)}${script}${html.slice(head + 6)}`
    // Headless fixture pages may lack <head>; prepending keeps the read-before-shell ordering.
    return script + html
  }
}
