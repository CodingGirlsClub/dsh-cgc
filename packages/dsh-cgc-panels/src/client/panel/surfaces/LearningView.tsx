/**
 * 学习视图 (learning view): the learner's home — my enrollments and my task
 * list for the picked workspace. Routes (Appendix A): GET /me/enrollments,
 * GET /me/workspaces (picker), GET /tasks.
 */
import { useState, type ReactNode } from 'react'
import { rowId, rowLabel, rowsOf } from '../../rows.ts'
import { SendRowButton, WorkspacePicker, WORKSPACE_ID_KEYS } from '../RowActions.tsx'
import { SurfaceFrame, useResource } from '../SurfaceFrame.tsx'
import { tt } from '../helpers.ts'
import css from '../panel.module.css'
import type { SurfaceProps } from '../surfaceProps.ts'

/** Enrollment id spellings on enrollment/task rows. */
const ENROLLMENT_ID_KEYS = ['id', 'enrollment_id', 'enrollmentId'] as const
const TASK_ID_KEYS = ['id', 'task_id', 'taskId'] as const

/** The learning view surface (cgc-assistant preset). */
export function LearningView({ runtime }: SurfaceProps): ReactNode {
  const { api, events, sessions, controller } = runtime
  const [workspaceId, setWorkspaceId] = useState('')

  const enrollments = useResource(
    'me/enrollments',
    () => api.myEnrollments(),
    (payload) => rowsOf(payload, ['enrollments']).length === 0,
    events,
  )
  const tasks = useResource(
    workspaceId === '' ? null : `tasks:${workspaceId}`,
    () => api.tasks(workspaceId),
    (payload) => rowsOf(payload, ['tasks']).length === 0,
    events,
  )

  return (
    <div className={css.surface} data-surface="learning">
      <WorkspacePicker api={api} value={workspaceId} onChange={setWorkspaceId} channel={events} />

      <section className={css.block} data-block="enrollments">
        <SurfaceFrame state={enrollments.state} onRetry={enrollments.reload}>
          {(value) => (
            <ul className={css.rowList}>
              {rowsOf(value, ['enrollments']).map((row, index) => (
                <li className={css.row} key={rowId(row, ENROLLMENT_ID_KEYS) ?? index}>
                  <span className={css.rowLabel}>{rowLabel(row, [...ENROLLMENT_ID_KEYS])}</span>
                  <SendRowButton verb="enrollment" id={rowId(row, ENROLLMENT_ID_KEYS)} sessions={sessions} controller={controller} />
                </li>
              ))}
            </ul>
          )}
        </SurfaceFrame>
      </section>

      {workspaceId !== '' && (
        <section className={css.block} data-block="tasks">
          <SurfaceFrame state={tasks.state} onRetry={tasks.reload}>
            {(value) => (
              <ul className={css.rowList}>
                {rowsOf(value, ['tasks']).map((row, index) => (
                  <li className={css.row} key={rowId(row, TASK_ID_KEYS) ?? index}>
                    <span className={css.rowLabel}>{rowLabel(row, [...TASK_ID_KEYS])}</span>
                    <SendRowButton verb="task" id={rowId(row, TASK_ID_KEYS)} sessions={sessions} controller={controller} />
                  </li>
                ))}
              </ul>
            )}
          </SurfaceFrame>
        </section>
      )}
    </div>
  )
}
