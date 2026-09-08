/**
 * 管理视图 (admin view): the workspace's order list and the per-offering
 * enrollment queue. Routes (Appendix A): GET /workspace/orders,
 * GET /workspace/enrollments (kind + offering_id), with the offering picker
 * fed by GET /workspace/courses + GET /workspace/events.
 */
import { useState, type ReactNode } from 'react'
import { rowId, rowLabel, rowsOf, type PayloadRow } from '../../rows.ts'
import { COURSE_ID_KEYS, SendRowButton, WorkspacePicker } from '../RowActions.tsx'
import { SurfaceFrame, useResource } from '../SurfaceFrame.tsx'
import { tt } from '../helpers.ts'
import css from '../panel.module.css'
import type { OfferingKind, SurfaceProps } from '../surfaceProps.ts'

/** Order id spellings on order rows. */
const ORDER_ID_KEYS = ['id', 'order_id', 'orderId'] as const
const QUEUE_ID_KEYS = ['id', 'enrollment_id', 'enrollmentId'] as const
const EVENT_ID_KEYS = ['id', 'event_id', 'eventId'] as const

interface OfferingRef {
  readonly kind: OfferingKind
  readonly id: string
  readonly label: string
}

/** Offerings from the workspace course + event lists. */
function offeringsOf(courses: unknown, events: unknown): OfferingRef[] {
  const out: OfferingRef[] = []
  for (const row of rowsOf(courses, ['courses'])) {
    const id = rowId(row, COURSE_ID_KEYS)
    if (id !== undefined) out.push({ kind: 'course', id, label: rowLabel(row, [...COURSE_ID_KEYS]) })
  }
  for (const row of rowsOf(events, ['events'])) {
    const id = rowId(row, EVENT_ID_KEYS)
    if (id !== undefined) out.push({ kind: 'event', id, label: rowLabel(row, [...EVENT_ID_KEYS]) })
  }
  return out
}

/** The admin surface (cgc-admin preset). */
export function AdminView({ runtime }: SurfaceProps): ReactNode {
  const { api, events, sessions, controller } = runtime
  const [workspaceId, setWorkspaceId] = useState('')
  const [offering, setOffering] = useState('')

  const orders = useResource(
    workspaceId === '' ? null : `workspace/orders:${workspaceId}`,
    () => api.workspaceOrders(workspaceId),
    (payload) => rowsOf(payload, ['orders']).length === 0,
    events,
  )
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

  const offerings = offeringsOf(
    courses.state.kind === 'ready' ? courses.state.value : undefined,
    workspaceEvents.state.kind === 'ready' ? workspaceEvents.state.value : undefined,
  )
  const selected = offering === '' ? undefined : offerings.find((entry) => `${entry.kind}:${entry.id}` === offering)

  const queue = useResource(
    selected === undefined || workspaceId === '' ? null : `workspace/enrollments:${workspaceId}:${selected.kind}:${selected.id}`,
    () => api.workspaceEnrollments(workspaceId, selected?.kind ?? 'course', selected?.id ?? ''),
    (payload) => rowsOf(payload, ['enrollments']).length === 0,
    events,
  )

  return (
    <div className={css.surface} data-surface="admin">
      <WorkspacePicker api={api} value={workspaceId} onChange={(id) => { setWorkspaceId(id); setOffering('') }} channel={events} />

      {workspaceId !== '' && (
        <>
          <section className={css.block} data-block="orders">
            <SurfaceFrame state={orders.state} onRetry={orders.reload}>
              {(value) => (
                <ul className={css.rowList}>
                  {rowsOf(value, ['orders']).map((row: PayloadRow, index: number) => (
                    <li className={css.row} key={rowId(row, ORDER_ID_KEYS) ?? index}>
                      <span className={css.rowLabel}>{rowLabel(row, [...ORDER_ID_KEYS])}</span>
                      <SendRowButton verb="order" id={rowId(row, ORDER_ID_KEYS)} sessions={sessions} controller={controller} />
                    </li>
                  ))}
                </ul>
              )}
            </SurfaceFrame>
          </section>

          <label className={css.field}>
            <span className={css.fieldLabel}>{tt('admin.offering')}</span>
            <select
              className={css.select}
              data-field="offering"
              value={offering}
              onChange={(event) => { setOffering(event.target.value) }}
            >
              {offering === '' && <option value="">—</option>}
              {offerings.map((entry) => (
                <option key={`${entry.kind}:${entry.id}`} value={`${entry.kind}:${entry.id}`}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>

          {selected !== undefined && (
            <section className={css.block} data-block="enrollment-queue">
              <SurfaceFrame state={queue.state} onRetry={queue.reload}>
                {(value) => (
                  <ul className={css.rowList}>
                    {rowsOf(value, ['enrollments']).map((row: PayloadRow, index: number) => (
                      <li className={css.row} key={rowId(row, QUEUE_ID_KEYS) ?? index}>
                        <span className={css.rowLabel}>{rowLabel(row, [...QUEUE_ID_KEYS])}</span>
                        <SendRowButton verb="enrollment" id={rowId(row, QUEUE_ID_KEYS)} sessions={sessions} controller={controller} />
                      </li>
                    ))}
                  </ul>
                )}
              </SurfaceFrame>
            </section>
          )}
        </>
      )}
    </div>
  )
}
