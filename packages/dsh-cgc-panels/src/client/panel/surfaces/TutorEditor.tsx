/**
 * 教研编辑 (tutor editor): the optimistic-concurrency course content draft.
 * Loads content + revision, edits JSON in a plain textarea, saves with
 * base_version. A 409 (version_conflict) KEEPS the local draft and offers
 * exactly two exits: reload-latest (discard draft) or force-submit
 * (re-read the revision, re-submit the same draft at the fresh base
 * version). Routes (Appendix A): GET /courses/:id/content,
 * GET /courses/:id/revision, POST /courses/:id/content (CSRF proof
 * required — without the bootstrap token the save stays disabled).
 */
import { useState, type ReactNode } from 'react'
import { ApiError } from '../../api.ts'
import { fieldText, isRecord, rowId, rowsOf } from '../../rows.ts'
import { COURSE_ID_KEYS, WorkspacePicker } from '../RowActions.tsx'
import { SurfaceFrame, useResource } from '../SurfaceFrame.tsx'
import { errorMessage, tt } from '../helpers.ts'
import css from '../panel.module.css'
import type { SurfaceProps } from '../surfaceProps.ts'

/** The revision number out of a get_course_revision payload. */
function revisionOf(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined
  const raw = value['revision'] ?? value['version'] ?? value['base_version']
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : undefined
}

/** Editor phase: editing, or conflict (draft kept, two choices). */
type EditorPhase = 'editing' | 'saving' | 'conflict'

/** The tutor editor surface (cgc-tutor preset). */
export function TutorEditor({ runtime }: SurfaceProps): ReactNode {
  const { api, events } = runtime
  const [workspaceId, setWorkspaceId] = useState('')
  const [courseId, setCourseId] = useState('')
  const [draft, setDraft] = useState('')
  const [baseVersion, setBaseVersion] = useState<number | undefined>(undefined)
  const [phase, setPhase] = useState<EditorPhase>('editing')
  const [notice, setNotice] = useState<string | undefined>(undefined)

  const courses = useResource(
    workspaceId === '' ? null : `workspace/courses:${workspaceId}`,
    () => api.workspaceCourses(workspaceId),
    (payload) => rowsOf(payload, ['courses']).length === 0,
    events,
  )
  const courseRows = courses.state.kind === 'ready' ? rowsOf(courses.state.value, ['courses']) : []

  const content = useResource(
    workspaceId === '' || courseId === '' ? null : `editor:${workspaceId}:${courseId}`,
    async () => {
      const [body, revision] = await Promise.all([
        api.courseContent(workspaceId, courseId),
        api.courseRevision(workspaceId, courseId),
      ])
      return { body, revision }
    },
    () => false,
    events,
  )

  // Adopt the loaded content into the draft only when the selection changes
  // (never clobber an in-progress edit on an event refetch).
  const [loadedKey, setLoadedKey] = useState('')
  if (content.state.kind === 'ready') {
    const key = `${workspaceId}:${courseId}`
    if (key !== loadedKey) {
      setLoadedKey(key)
      setDraft(JSON.stringify(content.state.value.body, null, 2))
      setBaseVersion(revisionOf(content.state.value.revision))
      setPhase('editing')
      setNotice(undefined)
    }
  }

  const save = (force: boolean): void => {
    if (phase === 'saving') return
    let parsed: unknown
    try {
      parsed = JSON.parse(draft)
    } catch {
      setNotice(tt('editor.invalidJson'))
      return
    }
    setPhase('saving')
    setNotice(undefined)
    const submit = (version: number | undefined): void => {
      api.saveCourseContent(workspaceId, courseId, parsed, version ?? 0).then(
        () => {
          setPhase('editing')
          setNotice(tt('editor.saved'))
          content.reload()
        },
        (error: unknown) => {
          if (error instanceof ApiError && error.status === 409) {
            // 409: the local draft is kept; the conflict card offers the two exits.
            setPhase('conflict')
            return
          }
          setPhase('editing')
          setNotice(tt('common.error', { message: errorMessage(error) }))
        },
      )
    }
    if (force) {
      // Force-submit: re-read the latest revision, then re-submit the SAME
      // draft at the fresh base version.
      api.courseRevision(workspaceId, courseId).then(
        (revision) => { submit(revisionOf(revision)) },
        (error: unknown) => {
          setPhase('conflict')
          setNotice(tt('common.error', { message: errorMessage(error) }))
        },
      )
      return
    }
    submit(baseVersion)
  }

  const reloadLatest = (): void => {
    // Reload-latest: discard the draft by re-keying the adoption latch.
    setLoadedKey('')
    setPhase('editing')
    setNotice(undefined)
    content.reload()
  }

  const missingCsrf = !api.canWrite

  return (
    <div className={css.surface} data-surface="editor">
      <WorkspacePicker api={api} value={workspaceId} onChange={(id) => { setWorkspaceId(id); setCourseId(''); setLoadedKey('') }} channel={events} />

      <label className={css.field}>
        <span className={css.fieldLabel}>{tt('course.pick')}</span>
        <select
          className={css.select}
          data-field="course"
          value={courseId}
          onChange={(event) => { setCourseId(event.target.value); setLoadedKey('') }}
        >
          {courseId === '' && <option value="">—</option>}
          {courseRows.map((row, index) => {
            const id = rowId(row, COURSE_ID_KEYS) ?? String(index)
            return <option key={id} value={id}>{fieldText(row, ['title', 'name']) ?? id}</option>
          })}
        </select>
      </label>

      {workspaceId !== '' && courseId !== '' && (
        <section className={css.block} data-block="editor">
          <SurfaceFrame state={content.state} onRetry={content.reload}>
            {() => (
              <>
                {baseVersion !== undefined && (
                  <p className={css.stateHint} data-field="revision">{tt('editor.revision', { version: baseVersion })}</p>
                )}
                <label className={css.field}>
                  <span className={css.fieldLabel}>{tt('editor.content')}</span>
                  <textarea
                    className={css.editor}
                    data-field="content"
                    value={draft}
                    onChange={(event) => { setDraft(event.target.value) }}
                    rows={14}
                  />
                </label>
                {missingCsrf && <p className={css.formError} data-error="no-csrf">{tt('editor.noCsrf')}</p>}
                {notice !== undefined && <p className={css.stateHint} data-field="editor-notice">{notice}</p>}
                {phase !== 'conflict' && (
                  <button
                    type="button"
                    className={css.button}
                    data-action="save"
                    disabled={phase === 'saving' || missingCsrf}
                    onClick={() => { save(false) }}
                  >
                    {phase === 'saving' ? tt('editor.saving') : tt('editor.save')}
                  </button>
                )}
                {phase === 'conflict' && (
                  <div className={css.conflictCard} data-card="conflict">
                    <p className={css.formError}>{tt('editor.conflictTitle')}</p>
                    <div className={css.rowActions}>
                      <button type="button" className={css.button} data-action="reload-latest" onClick={reloadLatest}>
                        {tt('editor.conflictReload')}
                      </button>
                      <button type="button" className={css.button} data-action="force-submit" disabled={missingCsrf} onClick={() => { save(true) }}>
                        {tt('editor.conflictForce')}
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </SurfaceFrame>
        </section>
      )}
    </div>
  )
}
