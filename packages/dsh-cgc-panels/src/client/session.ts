/**
 * Active-session observation (AE4): role surfaces show/hide by the active
 * session's agent preset. The sessions service face is read opportunistically
 * (`ctx.get('sessions')`) so a host without the runtime service degrades to
 * hub-only instead of failing the plugin fiber.
 */

import type { ISessions } from '@deepseek-ai/dsh-client-runtime/client'

/** The slice of the sessions service the panel family reads. */
export type SessionsLike = Pick<ISessions, 'list'>

/** The active session's agent preset (undefined = none / no current session). */
export function activePreset(sessions: SessionsLike | undefined): string | undefined {
  if (sessions === undefined) return undefined
  const snapshot = sessions.list.getSnapshot()
  const current = snapshot.current
  if (current === undefined) return undefined
  return snapshot.byId[current]?.agentPreset
}

/** Whether a session is currently open (row-click injection needs one). */
export function hasActiveSession(sessions: SessionsLike | undefined): boolean {
  return sessions?.list.getSnapshot().current !== undefined
}
