/**
 * Panels controller: the single owner of the panel's open/closed state, the
 * active surface tab, the entry trigger element (focus return on Escape),
 * and the transient notice line (injection outcomes). Framework-free (core's
 * panel/controller.ts precedent) so the DOM mounts and the React tree share
 * one tiny subscription surface. State lives only for the browser session.
 */

import type { SurfaceId } from '../../protocol.ts'

/** Immutable controller snapshot for UI subscriptions. */
export interface PanelsControllerSnapshot {
  panelOpen: boolean
  surface: SurfaceId
  /** Transient user notice; empty when none. */
  notice: string
  /** Monotonic notice id so consecutive identical notices still re-render. */
  noticeSeq: number
}

/** The panel state owner the sidebar entry toggles and the shell renders from. */
export class PanelsController {
  private panelOpen = false
  private surface: SurfaceId = 'hub'
  private notice = ''
  private noticeSeq = 0
  private listeners = new Set<() => void>()
  /** The sidebar entry button — Escape returns focus here. */
  trigger: HTMLElement | undefined

  private snapshotCache: PanelsControllerSnapshot = { panelOpen: false, surface: 'hub', notice: '', noticeSeq: 0 }

  /** The cached immutable snapshot (useSyncExternalStore requires identity stability). */
  getSnapshot(): PanelsControllerSnapshot {
    return this.snapshotCache
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  open(): void {
    if (this.panelOpen) return
    this.panelOpen = true
    this.notify()
  }

  close(): void {
    if (!this.panelOpen) return
    this.panelOpen = false
    this.notify()
  }

  toggle(): void {
    if (this.panelOpen) this.close()
    else this.open()
  }

  select(surface: SurfaceId): void {
    if (this.surface === surface) return
    this.surface = surface
    this.notify()
  }

  /** Show a transient notice (aria-live polite region). */
  showNotice(text: string): void {
    this.notice = text
    this.noticeSeq += 1
    this.notify()
  }

  /** Close the panel and return focus to the entry trigger (Escape path). */
  closeAndRefocus(): void {
    this.close()
    this.trigger?.focus()
  }

  private notify(): void {
    this.snapshotCache = { panelOpen: this.panelOpen, surface: this.surface, notice: this.notice, noticeSeq: this.noticeSeq }
    for (const fn of [...this.listeners]) fn()
  }
}
