/**
 * 发现 (discover): the enrollment flow — browse offerings, confirm on a
 * summary card, create the enrollment, and ride the payment-pending card:
 * the checkout_url opens externally (window.open), the order status polls
 * every 5 seconds, and a 10-minute cap exits to a reopen + manual-refresh
 * instruction. Routes (Appendix A): GET /discover, GET /enrollment_summary,
 * POST /enrollments, GET /order_status.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { fieldText, isRecord, nestedRecord, rowId, rowLabel, rowsOf } from '../../rows.ts'
import { SurfaceFrame, useResource } from '../SurfaceFrame.tsx'
import { errorMessage, tt } from '../helpers.ts'
import css from '../panel.module.css'
import { OFFERING_ID_KEYS, SendRowButton, WorkspacePicker } from '../RowActions.tsx'
import { offeringKindOf, type OfferingKind, type SurfaceProps } from '../surfaceProps.ts'

/** Order status poll cadence while a payment is pending. */
export const PAYMENT_POLL_MS = 5000
/** Hard cap on payment confirmation waiting (10 minutes). */
export const PAYMENT_TIMEOUT_MS = 10 * 60 * 1000

/** The status spellings that mean "still waiting for payment". */
const PENDING_STATUSES = ['payment_pending', 'pending', 'unpaid'] as const

interface Offering {
  readonly kind: OfferingKind
  readonly id: string
  readonly label: string
}

type DiscoverPhase =
  | { kind: 'browse' }
  | { kind: 'confirm'; offering: Offering }
  | { kind: 'enrolling'; offering: Offering }
  | { kind: 'enrolled' }
  | { kind: 'payment'; enrollmentId: string; checkoutUrl: string }
  | { kind: 'payment-timeout'; checkoutUrl: string }

/** The enrollment summary rendered as plain-text scalar lines. */
function SummaryLines({ value }: { value: unknown }): ReactNode {
  if (!isRecord(value)) return <p className={css.stateHint}>{tt('state.empty')}</p>
  const lines = Object.entries(value).filter(([, field]) =>
    typeof field === 'string' || typeof field === 'number' || typeof field === 'boolean')
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

/**
 * Interpret the create-enrollment response: payment-pending with a checkout
 * URL, or plain success. Field spellings follow the platform tool payloads
 * (status / checkout_url / enrollment_id, with a nested `enrollment` arm).
 */
function paymentOf(value: unknown): { enrollmentId: string; checkoutUrl: string } | undefined {
  const record = isRecord(value) ? value : undefined
  if (record === undefined) return undefined
  const nested = nestedRecord(record, 'enrollment') ?? nestedRecord(record, 'order')
  const status = fieldText(record, ['status', 'state']) ?? (nested !== undefined ? fieldText(nested, ['status', 'state']) : undefined)
  if (status === undefined || !(PENDING_STATUSES as readonly string[]).includes(status)) return undefined
  const checkoutUrl = fieldText(record, ['checkout_url', 'checkoutUrl']) ?? (nested !== undefined ? fieldText(nested, ['checkout_url', 'checkoutUrl']) : undefined)
  const enrollmentId = fieldText(record, ['enrollment_id', 'enrollmentId', 'id']) ?? (nested !== undefined ? fieldText(nested, ['enrollment_id', 'enrollmentId', 'id']) : undefined)
  if (checkoutUrl === undefined || enrollmentId === undefined) return undefined
  return { enrollmentId, checkoutUrl }
}

/** Whether an order-status payload still reads as payment-pending. */
function stillPending(value: unknown): boolean {
  const status = isRecord(value) ? fieldText(value, ['status', 'state']) : undefined
  return status !== undefined && (PENDING_STATUSES as readonly string[]).includes(status)
}

/** The discover surface (cgc-assistant preset). */
export function DiscoverView({ runtime }: SurfaceProps): ReactNode {
  const { api, events, sessions, controller, openExternal } = runtime
  const [workspaceId, setWorkspaceId] = useState('')
  const [phase, setPhase] = useState<DiscoverPhase>({ kind: 'browse' })
  const [summary, setSummary] = useState<unknown>(undefined)
  const [flowError, setFlowError] = useState<string | undefined>(undefined)

  const offerings = useResource(
    'discover',
    () => api.discover(),
    (payload) => rowsOf(payload, ['offerings', 'items']).length === 0,
    events,
  )

  // Payment-pending card: open checkout externally once, poll every 5s,
  // cap at 10 minutes then exit to the reopen + manual-refresh instruction.
  const pollState = useRef<{ stopped: boolean }>({ stopped: false })
  useEffect(() => {
    if (phase.kind !== 'payment') return undefined
    const startedAt = Date.now()
    pollState.current.stopped = false
    openExternal(phase.checkoutUrl)
    const timer = setInterval(() => {
      if (pollState.current.stopped) return
      if (Date.now() - startedAt >= PAYMENT_TIMEOUT_MS) {
        pollState.current.stopped = true
        clearInterval(timer)
        setPhase({ kind: 'payment-timeout', checkoutUrl: phase.checkoutUrl })
        return
      }
      if (workspaceId === '') return
      api.orderStatus(workspaceId, phase.enrollmentId).then(
        (value) => {
          if (pollState.current.stopped) return
          if (!stillPending(value)) {
            pollState.current.stopped = true
            clearInterval(timer)
            setPhase({ kind: 'enrolled' })
          }
        },
        () => { /* a failed poll keeps waiting; the cap bounds the loop */ },
      )
    }, PAYMENT_POLL_MS)
    return () => {
      pollState.current.stopped = true
      clearInterval(timer)
    }
  }, [phase, api, workspaceId, openExternal])

  const beginConfirm = (offering: Offering): void => {
    if (workspaceId === '') return
    setFlowError(undefined)
    setSummary(undefined)
    setPhase({ kind: 'confirm', offering })
    api.enrollmentSummary(workspaceId, offering.kind, offering.id).then(
      (value) => { setSummary(value) },
      (error: unknown) => { setFlowError(errorMessage(error)) },
    )
  }

  const confirmEnroll = (offering: Offering): void => {
    if (workspaceId === '') return
    setFlowError(undefined)
    setPhase({ kind: 'enrolling', offering })
    api.createEnrollment(workspaceId, offering.kind, offering.id).then(
      (value) => {
        const payment = paymentOf(value)
        setPhase(payment === undefined ? { kind: 'enrolled' } : { kind: 'payment', enrollmentId: payment.enrollmentId, checkoutUrl: payment.checkoutUrl })
      },
      (error: unknown) => {
        setFlowError(errorMessage(error))
        setPhase({ kind: 'confirm', offering })
      },
    )
  }

  return (
    <div className={css.surface} data-surface="discover">
      <WorkspacePicker api={api} value={workspaceId} onChange={setWorkspaceId} channel={events} />

      <section className={css.block} data-block="offerings">
        <SurfaceFrame state={offerings.state} onRetry={offerings.reload}>
          {(value) => (
            <ul className={css.rowList}>
              {rowsOf(value, ['offerings', 'items']).map((row, index) => {
                const id = rowId(row, OFFERING_ID_KEYS)
                const kind = offeringKindOf(fieldText(row, ['kind', 'type']))
                return (
                  <li className={css.row} key={id ?? index}>
                    <span className={css.rowLabel}>{rowLabel(row, [...OFFERING_ID_KEYS])}</span>
                    <button
                      type="button"
                      className={css.rowAction}
                      data-action="enroll"
                      disabled={id === undefined || kind === undefined || workspaceId === ''}
                      onClick={() => { if (id !== undefined && kind !== undefined) beginConfirm({ kind, id, label: rowLabel(row, [...OFFERING_ID_KEYS]) }) }}
                    >
                      {tt('discover.enroll')}
                    </button>
                    <SendRowButton verb={kind === 'event' ? 'event' : 'course'} id={id} sessions={sessions} controller={controller} />
                  </li>
                )
              })}
            </ul>
          )}
        </SurfaceFrame>
      </section>

      {phase.kind === 'confirm' && (
        <section className={css.block} data-card="enrollment-confirm">
          <h3 className={css.blockTitle}>{tt('discover.confirmTitle')}</h3>
          <p className={css.rowLabel}>{phase.offering.label}</p>
          {summary !== undefined && <SummaryLines value={summary} />}
          {flowError !== undefined && <p className={css.formError} data-error="flow">{tt('common.error', { message: flowError })}</p>}
          <div className={css.rowActions}>
            <button type="button" className={css.button} data-action="confirm-enroll" onClick={() => { confirmEnroll(phase.offering) }}>
              {tt('discover.confirm')}
            </button>
            <button type="button" className={css.button} data-action="cancel-enroll" onClick={() => { setPhase({ kind: 'browse' }) }}>
              {tt('discover.cancel')}
            </button>
          </div>
        </section>
      )}

      {phase.kind === 'enrolling' && <p className={css.stateLine} data-state="loading">{tt('state.loading')}</p>}

      {phase.kind === 'payment' && (
        <section className={css.block} data-card="payment-pending">
          <h3 className={css.blockTitle}>{tt('discover.paymentTitle')}</h3>
          <p className={css.stateHint}>{tt('discover.paymentWaiting')}</p>
          <button type="button" className={css.button} data-action="reopen-checkout" onClick={() => { openExternal(phase.checkoutUrl) }}>
            {tt('discover.paymentOpen')}
          </button>
        </section>
      )}

      {phase.kind === 'payment-timeout' && (
        <section className={css.block} data-card="payment-timeout">
          <p className={css.stateLine}>{tt('discover.paymentTimeout')}</p>
          <button type="button" className={css.button} data-action="reopen-checkout" onClick={() => { openExternal(phase.checkoutUrl) }}>
            {tt('discover.paymentOpen')}
          </button>
        </section>
      )}
    </div>
  )
}
