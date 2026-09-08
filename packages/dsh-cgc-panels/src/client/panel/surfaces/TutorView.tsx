/**
 * 教研视图 (tutor workbench): the workspace's courses and events with
 * per-course prep status. Routes (Appendix A): GET /workspace/courses,
 * GET /workspace/events, GET /courses/:id/prep.
 */
import { useState, type ReactNode } from 'react'
import { rowId, rowLabel, rowsOf } from '../../rows.ts'
import { SurfaceFrame, useResource } from '../SurfaceFrame.tsx'
import { COURSE_ID_KEYS, SendRowButton, WorkspacePicker } from '../RowActions.tsx'
import { ScalarLines } from './CourseLearning.tsx'
import { tt } from '../helpers.ts'
import css from '../panel.module.css'
import type { SurfaceProps } from '../surfaceProps.ts'

/** Event id spellings on workspace event rows. */
const EVENT_ID_KEYS = ['id', 'event_id', 'eventId'] as const

/** The tutor workbench surface (cgc-tutor preset). */
export function TutorView({ runtime }: SurfaceProps): ReactNode {
  const { api, events, sessions, controller } = runtime
  const [workspaceId, setWorkspaceId] = useState('')
  const [prepCourseId, setPrepCourseId] = useState('')

  const courses = useResource(
    workspaceId === '' ? null : `workspace/courses:${workspaceId}`,
    () => api.workspaceCourses(workspaceId),
    (payload) => rowsOf(payload, ['courses']).length === 0,
    events,
  )
  const workspaceEvents = useResource(
    workspaceId === '' ? null : `workspace/events:${workspaceId}`,
    () => api.workspaceEvents(workspaceId),
    (payload) => rowsOf(payload, ['events']).length === 0,
    events,
  )
  const prep = useResource(
    workspaceId === '' || prepCourseId === '' ? null : `prep:${workspaceId}:${prepCourseId}`,
    () => api.coursePrep(workspaceId, prepCourseId),
    () => false,
    events,
  )

  return (
    <div className={css.surface} data-surface="tutor">
      <WorkspacePicker api={api} value={workspaceId} onChange={(id) => { setWorkspaceId(id); setPrepCourseId('') }} channel={events} />

      {workspaceId !== '' && (
        <>
          <section className={css.block} data-block="courses">
            <SurfaceFrame state={courses.state} onRetry={courses.reload}>
              {(value) => (
                <ul className={css.rowList}>
                  {rowsOf(value, ['courses']).map((row, index) => {
                    const id = rowId(row, COURSE_ID_KEYS)
                    return (
                      <li className={css.row} key={id ?? index}>
                        <button
                          type="button"
                          className={css.rowLabelButton}
                          data-action="show-prep"
                          onClick={() => { if (id !== undefined) setPrepCourseId(id) }}
                        >
                          {rowLabel(row, [...COURSE_ID_KEYS])}
                        </button>
                        <SendRowButton verb="course" id={id} sessions={sessions} controller={controller} />
                      </li>
                    )
                  })}
                </ul>
              )}
            </SurfaceFrame>
          </section>

          <section className={css.block} data-block="events">
            <SurfaceFrame state={workspaceEvents.state} onRetry={workspaceEvents.reload}>
              {(value) => (
                <ul className={css.rowList}>
                  {rowsOf(value, ['events']).map((row, index) => (
                    <li className={css.row} key={rowId(row, EVENT_ID_KEYS) ?? index}>
                      <span className={css.rowLabel}>{rowLabel(row, [...EVENT_ID_KEYS])}</span>
                      <SendRowButton verb="event" id={rowId(row, EVENT_ID_KEYS)} sessions={sessions} controller={controller} />
                    </li>
                  ))}
                </ul>
              )}
            </SurfaceFrame>
          </section>

          {prepCourseId !== '' && (
            <section className={css.block} data-block="prep">
              <h3 className={css.blockTitle}>{tt('tutor.prep')} · {prepCourseId}</h3>
              <SurfaceFrame state={prep.state} onRetry={prep.reload}>
                {(value) => <ScalarLines value={value} />}
              </SurfaceFrame>
            </section>
          )}
        </>
      )}
    </div>
  )
}
