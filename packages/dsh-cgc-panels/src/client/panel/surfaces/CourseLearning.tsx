/**
 * 课程学习 (course learning): the learner's per-course reader — pick a
 * workspace and an enrolled course, then read the learning state and the
 * published course content. Routes (Appendix A): GET /me/enrollments
 * (course picker), GET /learning_state, GET /courses/:id/content,
 * GET /courses/:id/revision. Read-only surface: no writes, no CSRF need.
 */
import { useState, type ReactNode } from 'react'
import { fieldText, isRecord, rowId, rowsOf } from '../../rows.ts'
import { SendRowButton, WorkspacePicker, WORKSPACE_ID_KEYS } from '../RowActions.tsx'
import { SurfaceFrame, useResource } from '../SurfaceFrame.tsx'
import { tt } from '../helpers.ts'
import css from '../panel.module.css'
import type { SurfaceProps } from '../surfaceProps.ts'

/** Enrollment rows carry the course reference under these spellings. */
const ENROLLMENT_COURSE_KEYS = ['course_id', 'courseId', 'id'] as const
const COURSE_ID_KEYS_LOCAL = ['id', 'course_id', 'courseId'] as const

/** Render a payload as plain-text scalar lines (no markup, no markdown). */
export function ScalarLines({ value }: { value: unknown }): ReactNode {
  if (!isRecord(value)) {
    return <p className={css.stateHint}>{typeof value === 'string' ? value : JSON.stringify(value)}</p>
  }
  const lines = Object.entries(value).filter(([, field]) =>
    typeof field === 'string' || typeof field === 'number' || typeof field === 'boolean')
  if (lines.length === 0) return <p className={css.stateHint}>{tt('state.empty')}</p>
  return (
    <dl className={css.scalarList}>
      {lines.map(([name, field]) => (
        <div className={css.scalarRow} key={name}>
          <dt className={css.scalarKey}>{name}</dt>
          <dd className={css.scalarValue}>{String(field)}</dd>
        </div>
      ))}
    </dl>
  )
}

/** The course learning surface (cgc-assistant preset). */
export function CourseLearning({ runtime }: SurfaceProps): ReactNode {
  const { api, events, sessions, controller } = runtime
  const [workspaceId, setWorkspaceId] = useState('')
  const [courseId, setCourseId] = useState('')

  const enrollments = useResource(
    'me/enrollments',
    () => api.myEnrollments(),
    (payload) => rowsOf(payload, ['enrollments']).length === 0,
    events,
  )
  const courseRows = enrollments.state.kind === 'ready' ? rowsOf(enrollments.state.value, ['enrollments']) : []

  const learningState = useResource(
    workspaceId === '' || courseId === '' ? null : `learning:${workspaceId}:${courseId}`,
    () => api.learningState(workspaceId, courseId),
    () => false,
    events,
  )
  const content = useResource(
    workspaceId === '' || courseId === '' ? null : `content:${workspaceId}:${courseId}`,
    () => api.courseContent(workspaceId, courseId),
    () => false,
    events,
  )

  return (
    <div className={css.surface} data-surface="course">
      <WorkspacePicker api={api} value={workspaceId} onChange={(id) => { setWorkspaceId(id); setCourseId('') }} channel={events} />

      <label className={css.field}>
        <span className={css.fieldLabel}>{tt('course.pick')}</span>
        <select
          className={css.select}
          data-field="course"
          value={courseId}
          onChange={(event) => { setCourseId(event.target.value) }}
        >
          {courseId === '' && <option value="">—</option>}
          {courseRows.map((row, index) => {
            const id = rowId(row, ENROLLMENT_COURSE_KEYS) ?? String(index)
            return <option key={id} value={id}>{fieldText(row, ['title', 'name']) ?? id}</option>
          })}
        </select>
      </label>

      {workspaceId !== '' && courseId !== '' && (
        <>
          <section className={css.block} data-block="learning-state">
            <SurfaceFrame state={learningState.state} onRetry={learningState.reload}>
              {(value) => <ScalarLines value={value} />}
            </SurfaceFrame>
          </section>
          <section className={css.block} data-block="course-content">
            <SurfaceFrame state={content.state} onRetry={content.reload}>
              {(value) => <ScalarLines value={value} />}
            </SurfaceFrame>
            <SendRowButton verb="course" id={courseId} sessions={sessions} controller={controller} />
          </section>
        </>
      )}
    </div>
  )
}
