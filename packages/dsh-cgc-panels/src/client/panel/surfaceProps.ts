/**
 * The surface component contract: every one of the six role surfaces (plus
 * the hub) receives the same runtime face, so state handling, injection, and
 * event refetch behave identically across the family.
 */
import type { PanelsApi } from '../api.ts'
import type { EventChannel } from '../events.ts'
import type { SessionsLike } from '../session.ts'
import type { PanelsController } from './controller.ts'

/** The inject face the slot registration hands to the entry component. */
export interface PanelsRuntime {
  readonly controller: PanelsController
  readonly api: PanelsApi
  readonly events: EventChannel
  readonly sessions: SessionsLike | undefined
  /** External-link opener (window.open wrapper — injectable for tests). */
  readonly openExternal: (url: string) => void
}

/** Props every surface component receives. */
export interface SurfaceProps {
  readonly runtime: PanelsRuntime
}

/** Workspace/enrollment kind carried by discover + admin offering rows. */
export type OfferingKind = 'event' | 'course'

/** Narrow a raw kind field onto the platform's enrollment enum. */
export function offeringKindOf(raw: string | undefined): OfferingKind | undefined {
  return raw === 'event' || raw === 'course' ? raw : undefined
}
