/**
 * The panel shell: the sidebar footer-action entry button plus the
 * right-docked panel mounted as a body portal (createPortal — the panel
 * floats over the shell without disturbing its reconciliation). Stable
 * selectors: [data-dsh-cgc-panels-entry], [data-dsh-cgc-panels].
 *
 * Accessibility baseline: the entry and every tab/action are native
 * <button>/<a> elements; focus moves INTO the panel on open (the close
 * button); Escape closes the panel and returns focus to the entry trigger.
 */
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { surfaceVisible, SURFACE_IDS, type SurfaceId } from '../../protocol.ts'
import { activePreset } from '../session.ts'
import type { PanelsRuntime } from './surfaceProps.ts'
import { AdminView } from './surfaces/AdminView.tsx'
import { CourseLearning } from './surfaces/CourseLearning.tsx'
import { DiscoverView } from './surfaces/DiscoverView.tsx'
import { LearningView } from './surfaces/LearningView.tsx'
import { TutorEditor } from './surfaces/TutorEditor.tsx'
import { TutorView } from './surfaces/TutorView.tsx'
import { HubSurface } from './HubSurface.tsx'
import { tt } from './helpers.ts'
import css from './panel.module.css'

/** Stable selector for the entry row. */
export const ENTRY_SELECTOR = '[data-dsh-cgc-panels-entry]'
/** Stable selector for the docked panel. */
export const PANEL_SELECTOR = '[data-dsh-cgc-panels]'

export interface PanelsShellProps {
  readonly runtime: PanelsRuntime
}

/** The surface tab label key. */
const TAB_KEY: Record<SurfaceId, 'tabs.hub' | 'tabs.learning' | 'tabs.course' | 'tabs.discover' | 'tabs.tutor' | 'tabs.editor' | 'tabs.admin'> = {
  hub: 'tabs.hub',
  learning: 'tabs.learning',
  course: 'tabs.course',
  discover: 'tabs.discover',
  tutor: 'tabs.tutor',
  editor: 'tabs.editor',
  admin: 'tabs.admin',
}

/** Render the active surface body. */
function SurfaceBody({ surface, runtime }: { surface: SurfaceId; runtime: PanelsRuntime }): ReactNode {
  switch (surface) {
    case 'hub': return <HubSurface api={runtime.api} channel={runtime.events} />
    case 'learning': return <LearningView runtime={runtime} />
    case 'course': return <CourseLearning runtime={runtime} />
    case 'discover': return <DiscoverView runtime={runtime} />
    case 'tutor': return <TutorView runtime={runtime} />
    case 'editor': return <TutorEditor runtime={runtime} />
    case 'admin': return <AdminView runtime={runtime} />
  }
}

/** The right-docked panel (portal body). */
export function PanelsShell({ runtime }: PanelsShellProps): ReactNode {
  const { controller } = runtime
  const closeRef = useRef<HTMLButtonElement>(null)

  // Focus moves into the panel on open.
  useEffect(() => {
    closeRef.current?.focus()
  }, [])

  // Escape closes and returns focus to the trigger.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        controller.closeAndRefocus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [controller])

  const preset = activePreset(runtime.sessions)
  const snapshot = useSyncExternalStore(
    (fn) => controller.subscribe(fn),
    () => controller.getSnapshot(),
  )
  const visibleTabs = SURFACE_IDS.filter((id) => surfaceVisible(id, preset))
  const active = visibleTabs.includes(snapshot.surface) ? snapshot.surface : 'hub'

  return (
    <div className={css.dock} data-dsh-cgc-panels="" role="dialog" aria-label={tt('panel.title')}>
      <div className={css.head}>
        <h2 className={css.title}>{tt('panel.title')}</h2>
        <button type="button" ref={closeRef} className={css.closeButton} data-action="close" onClick={() => { controller.closeAndRefocus() }}>
          {tt('panel.close')}
        </button>
      </div>
      <nav className={css.tabs} aria-label={tt('panel.title')}>
        {visibleTabs.map((id) => (
          <button
            type="button"
            key={id}
            className={id === active ? css.tabActive : css.tab}
            data-tab={id}
            aria-pressed={id === active}
            onClick={() => { controller.select(id) }}
          >
            {tt(TAB_KEY[id])}
          </button>
        ))}
      </nav>
      {snapshot.notice !== '' && (
        <p className={css.notice} data-notice="" role="status" aria-live="polite" key={snapshot.noticeSeq}>
          {snapshot.notice}
        </p>
      )}

      <div className={css.body}>
        <SurfaceBody surface={active} runtime={runtime} />
      </div>
    </div>
  )
}

/** The slot-composed props of the entry component (runtime face spread; host globals optional for direct mounts). */
export type PanelsEntryProps = { wide: boolean } & PanelsRuntime & Partial<GlobalStandardProps>

/** The sidebar footer-action component: entry button + portal-mounted panel. */
export function PanelsEntry(props: PanelsEntryProps): ReactNode {
  const { wide, controller } = props
  const open = useSyncExternalStore(
    (fn) => controller.subscribe(fn),
    () => controller.getSnapshot().panelOpen,
  )
  return (
    <>
      <button
        type="button"
        ref={(el) => { controller.trigger = el ?? undefined }}
        className={css.entry}
        data-dsh-cgc-panels-entry=""
        aria-expanded={open}
        title={tt('entry.tooltip')}
        onClick={() => { controller.toggle() }}
      >
        {wide ? tt('entry.label') : 'CGC'}
      </button>
      {open && createPortal(<PanelsShell runtime={props} />, document.body)}
    </>
  )
}

