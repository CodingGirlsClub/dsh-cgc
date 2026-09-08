/**
 * Composer directive injection (RSK4 / AE5): a row action fills the session
 * composer draft with an id-referenced directive — fixed verb + validated
 * identifier, built by protocol.ts buildDirective — and NEVER submits. The
 * user reviews and sends; the platform's approval gate still stands between
 * the directive and any write.
 *
 * The shell's composer is a React-controlled <textarea data-phase>, so the
 * draft write goes through the native value setter + a bubbling input event
 * (the only way React picks a DOM-level change up as a draft edit). No
 * Enter/keydown/form submission is ever dispatched.
 */

import { hasActiveSession, type SessionsLike } from './session.ts'

/** The shell composer markers, most specific first. */
const COMPOSER_SELECTORS = [
  'textarea[data-phase]',
  '[data-pane="conversation"] textarea',
] as const

export type InjectFailure = 'no-session' | 'no-composer' | 'composer-busy'

export type InjectOutcome = { ok: true } | { ok: false; reason: InjectFailure }

/** Locate the live composer textarea (skip disabled/readOnly shells). */
function composerTextarea(root: Document): HTMLTextAreaElement | undefined {
  for (const selector of COMPOSER_SELECTORS) {
    const candidate = root.querySelector<HTMLTextAreaElement>(selector)
    if (candidate !== null) return candidate
  }
  return undefined
}

/**
 * Fill the composer draft with the directive text. No-op (with a failure
 * reason) when no session is open, the composer is absent, or it is
 * disabled/readOnly (session removed / machine busy).
 */
export function injectDirective(
  text: string,
  sessions: SessionsLike | undefined,
  root: Document = document,
): InjectOutcome {
  if (!hasActiveSession(sessions)) return { ok: false, reason: 'no-session' }
  const textarea = composerTextarea(root)
  if (textarea === undefined) return { ok: false, reason: 'no-composer' }
  if (textarea.disabled || textarea.readOnly) return { ok: false, reason: 'composer-busy' }
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  if (setter === undefined) return { ok: false, reason: 'no-composer' }
  setter.call(textarea, text)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
  textarea.focus()
  return { ok: true }
}
