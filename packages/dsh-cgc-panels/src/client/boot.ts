/**
 * Browser bootstrap reader: the host half injects
 * `window.__DSH_CGC_PANELS_BOOT__` via the index tap (src/boot-inject.ts);
 * the page reads it here. The payload is wire-boundary raw — validate at the
 * read point. A missing/invalid token is a degrade signal (write flows
 * disabled with a visible notice), never a throw: the panel must not take
 * the GUI boot down.
 */

import { PANELS_BOOT_KEY } from '../boot-inject.ts'

/** The validated bootstrap payload. */
export interface PanelsBoot {
  /** The CSRF token for write routes; undefined = writes disabled. */
  readonly csrfToken: string | undefined
}

/** The raw window shape the bootstrap rides on. */
interface BootWindow {
  [PANELS_BOOT_KEY]?: unknown
}

/** Read and validate the bootstrap payload (absent/malformed → empty). */
export function readBoot(target: BootWindow = window as unknown as BootWindow): PanelsBoot {
  const raw = target[PANELS_BOOT_KEY]
  if (typeof raw !== 'object' || raw === null) return { csrfToken: undefined }
  if (!('csrfToken' in raw)) return { csrfToken: undefined }
  const token = raw.csrfToken
  return { csrfToken: typeof token === 'string' && token !== '' ? token : undefined }
}
