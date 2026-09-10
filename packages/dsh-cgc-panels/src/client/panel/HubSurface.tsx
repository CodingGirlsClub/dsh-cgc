/**
 * The hub surface: connection status block, connect form (while not
 * connected), disconnect + platform links, and the recent-activity feed.
 * Blocks degrade independently — a failed /status never blanks the activity
 * block, and vice versa.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { PanelsApi } from '../api.ts'
import type { EventChannel } from '../events.ts'
import type { CgcActivityEntry, CgcStatusBody } from '../../protocol.ts'
import { ConnectForm } from './ConnectForm.tsx'
import { errorMessage, timeOf, tt } from './helpers.ts'
import css from './panel.module.css'

export interface HubSurfaceProps {
  readonly api: PanelsApi
  readonly channel: EventChannel
}

/** One activity row (plain text; pre-redacted upstream). */
function ActivityRow({ entry }: { entry: CgcActivityEntry }): ReactNode {
  const label = entry.kind === 'error'
    ? (entry.source === 'connect' ? tt('activity.error.connect') : tt('activity.error.tool'))
    : tt('activity.write')
  return (
    <li className={css.activityRow} data-kind={entry.kind}>
      <span className={css.activityTime}>{timeOf(entry.at)}</span>
      <span className={css.activityLabel}>{label}</span>
      {entry.tool !== undefined && <span className={css.activityTool}>{entry.tool}</span>}
      {entry.message !== undefined && <span className={css.activityMessage}>{entry.message}</span>}
    </li>
  )
}


/** Hub refresh cadence while the surface is mounted (core v1 panel precedent). */
const HUB_POLL_MS = 3000
/** The hub surface (always visible; not role-gated). */
export function HubSurface({ api, channel }: HubSurfaceProps): ReactNode {
  const [status, setStatus] = useState<CgcStatusBody | undefined>(undefined)
  const [statusError, setStatusError] = useState<string | undefined>(undefined)
  const [activity, setActivity] = useState<CgcActivityEntry[] | undefined>(undefined)
  const [activityError, setActivityError] = useState<string | undefined>(undefined)

  const refreshStatus = useCallback((): void => {
    api.status().then(
      (body) => { setStatus(body); setStatusError(undefined) },
      (error: unknown) => { setStatusError(errorMessage(error)) },
    )
  }, [api])

  const refreshActivity = useCallback((): void => {
    api.activity().then(
      (entries) => { setActivity(entries); setActivityError(undefined) },
      (error: unknown) => { setActivityError(errorMessage(error)) },
    )
  }, [api])

  // Initial load + event-driven refresh + a slow poll: connect/disconnect
  // transitions (settings edits, platform restarts) emit no tool events, so
  // without polling the hub would show a stale state indefinitely (caught
  // in the live rehearsal: hub stuck on Disconnected after reconnect).
  useEffect(() => {
    refreshStatus()
    refreshActivity()
    const interval = setInterval(() => {
      refreshStatus()
      refreshActivity()
    }, HUB_POLL_MS)
    const offEvent = channel.onEvent(() => {
      refreshStatus()
      refreshActivity()
    })
    const offGap = channel.onGap(() => {
      refreshStatus()
      refreshActivity()
    })
    return () => {
      clearInterval(interval)
      offEvent()
      offGap()
    }
  }, [refreshStatus, refreshActivity, channel])

  const disconnect = (): void => {
    api.disconnect().then(
      (next) => { setStatus(next) },
      (error: unknown) => { setStatusError(errorMessage(error)) },
    )
  }

  const stateKey = status?.connected === true ? 'status.connected' : status?.configured === true ? 'status.disconnected' : 'status.notConfigured'

  return (
    <div className={css.hub} data-surface="hub">
      <div className={css.block} data-block="status">
        {statusError !== undefined && <p className={css.formError} data-error="status">{tt('common.error', { message: statusError })}</p>}
        {status !== undefined && (
          <>
            <p className={css.statusLine} data-connected={status.connected}>{tt(stateKey)}</p>
            {status.url !== '' && <p className={css.stateHint}>{tt('status.url')}: {status.url}</p>}
            {status.web_url !== '' && (
              <p className={css.stateHint}>
                <a className={css.link} href={status.web_url} target="_blank" rel="noreferrer noopener">{tt('status.web')}</a>
                {' · '}
                <a className={css.link} href={status.web_url} target="_blank" rel="noreferrer noopener">{tt('status.revoke')}</a>
              </p>
            )}
            {status.configured && (
              <button type="button" className={css.button} data-action="disconnect" onClick={disconnect}>
                {tt('form.disconnect')}
              </button>
            )}
          </>
        )}
        {status === undefined && statusError === undefined && <p className={css.stateLine}>{tt('state.loading')}</p>}
      </div>

      {status?.connected !== true && (
        <ConnectForm api={api} status={status} onStatus={setStatus} />
      )}

      <div className={css.block} data-block="activity">
        <h3 className={css.blockTitle}>{tt('activity.title')}</h3>
        {activityError !== undefined && <p className={css.formError} data-error="activity">{tt('common.error', { message: activityError })}</p>}
        {activity !== undefined && activity.length === 0 && <p className={css.stateHint}>{tt('activity.empty')}</p>}
        {activity !== undefined && activity.length > 0 && (
          <ul className={css.activityList}>
            {activity.map((entry, index) => <ActivityRow key={`${entry.at}-${index}`} entry={entry} />)}
          </ul>
        )}
      </div>
    </div>
  )
}
