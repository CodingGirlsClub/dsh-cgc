/**
 * Shared row action + pickers: the "send to session" button every surface
 * row carries (id-referenced directive injection, never auto-submit), and
 * the workspace/course selectors (native <select>, fed by the data routes).
 */
import { useEffect, type ReactNode } from 'react'
import type { PanelsApi } from '../api.ts'
import type { EventChannel } from '../events.ts'
import { injectDirective } from '../inject.ts'
import { buildDirective, type DirectiveVerb } from '../../protocol.ts'
import { fieldText, rowId, rowsOf, type PayloadRow } from '../rows.ts'
import type { SessionsLike } from '../session.ts'
import type { PanelsController } from './controller.ts'
import { tt } from './helpers.ts'
import { useResource } from './SurfaceFrame.tsx'
import css from './panel.module.css'

/** Workspace id field spellings the platform payloads use. */
export const WORKSPACE_ID_KEYS = ['id', 'workspace_id', 'workspaceId'] as const

/** Course id field spellings. */
export const COURSE_ID_KEYS = ['id', 'course_id', 'courseId'] as const

/** Offering id field spellings (discover rows). */
export const OFFERING_ID_KEYS = ['id', 'offering_id', 'offeringId'] as const

/** The notice key for one injection failure reason. */
const FAILURE_NOTICE: Record<string, 'notice.noSession' | 'notice.noComposer' | 'notice.composerBusy'> = {
  'no-session': 'notice.noSession',
  'no-composer': 'notice.noComposer',
  'composer-busy': 'notice.composerBusy',
}

export interface SendRowButtonProps {
  readonly verb: DirectiveVerb
  /** The row's raw identifier; validated (UUID/numeric) before injection. */
  readonly id: string | undefined
  readonly sessions: SessionsLike | undefined
  readonly controller: PanelsController
}

/**
 * The row-level "send directive to composer" action. Builds verb + validated
 * id only — platform free text never reaches the composer (RSK4) and the
 * draft is never submitted (AE5); failures surface as a visible notice.
 */
export function SendRowButton({ verb, id, sessions, controller }: SendRowButtonProps): ReactNode {
  const onClick = (): void => {
    const directive = id === undefined ? undefined : buildDirective(verb, id)
    if (directive === undefined) {
      controller.showNotice(tt('notice.invalidId'))
      return
    }
    const outcome = injectDirective(directive, sessions)
    if (outcome.ok) {
      controller.showNotice(tt('notice.injected'))
      return
    }
    controller.showNotice(tt(FAILURE_NOTICE[outcome.reason] ?? 'notice.noComposer'))
  }
  return (
    <button type="button" className={css.rowAction} data-action="send-directive" onClick={onClick}>
      {tt('action.send')}
    </button>
  )
}

export interface WorkspacePickerProps {
  readonly api: PanelsApi
  readonly value: string
  readonly onChange: (workspaceId: string) => void
  readonly channel?: EventChannel
}

/** Workspace selector fed by GET /me/workspaces; auto-selects the first row. */
export function WorkspacePicker({ api, value, onChange, channel }: WorkspacePickerProps): ReactNode {
  const resource = useResource(
    'me/workspaces',
    () => api.myWorkspaces(),
    (payload) => rowsOf(payload, ['workspaces']).length === 0,
    channel,
  )
  const rows = resource.state.kind === 'ready' ? rowsOf(resource.state.value, ['workspaces']) : []

  // Auto-select the first workspace once rows land.
  useEffect(() => {
    if (value !== '') return
    const first = rows[0]
    if (first === undefined) return
    const id = rowId(first, WORKSPACE_ID_KEYS)
    if (id !== undefined) onChange(id)
  }, [value, rows, onChange])

  return (
    <label className={css.field}>
      <span className={css.fieldLabel}>{tt('workspace.pick')}</span>
      <select
        className={css.select}
        data-field="workspace"
        value={value}
        onChange={(event) => { onChange(event.target.value) }}
      >
        {value === '' && <option value="">—</option>}
        {rows.map((row) => {
          const id = rowId(row, WORKSPACE_ID_KEYS) ?? ''
          return (
            <option key={id} value={id}>
              {fieldText(row, ['name', 'title']) ?? id}
            </option>
          )
        })}
      </select>
      {resource.state.kind !== 'ready' && resource.state.kind !== 'empty' && (
        <span className={css.stateHint} data-state={resource.state.kind}>
          {resource.state.kind === 'loading' ? tt('state.loading') : tt('state.error', { message: 'message' in resource.state ? resource.state.message : '' })}
        </span>
      )}
    </label>
  )
}
