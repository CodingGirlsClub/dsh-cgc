/**
 * The CGC connection panel: a header, the connection status block, the
 * connect form (MCP URL + token), and the recent-activity feed the host
 * hook records. The tree stays mounted while the panel is hidden (CSS
 * takeover); polling runs only while the panel is open.
 */
import { useEffect, useState } from 'react'
import type { CgcActivityEntry, CgcStatusBody } from '../../protocol.ts'
import { DEFAULT_MCP_URL } from '../../protocol.ts'
import type { CgcApi } from '../api.ts'
import type { PanelController } from './controller.ts'
import { errorMessage, timeOf, tt } from './helpers.ts'
import css from './panel.module.css'

/** Panel props. */
export interface CgcPanelProps {
  /** The panel state owner (open/close/toggle). */
  controller: PanelController
  /** The CGC API client the panel operates through. */
  api: CgcApi
}

/** Poll cadence while the panel is open. */
const POLL_MS = 3000

/** One activity row. */
function ActivityRow({ entry }: { entry: CgcActivityEntry }) {
  if (entry.kind === 'error') {
    const label = entry.source === 'connect' ? tt('activity.error.connect') : tt('activity.error.tool')
    return (
      <li className={css.activityRow} data-kind="error">
        <span className={css.activityTime}>{timeOf(entry.at)}</span>
        <span className={css.activityBody}>
          <span className={css.activityKind}>{label}</span>
          {entry.tool !== undefined && <code className={css.activityTool}>{entry.tool}</code>}
          {entry.message !== undefined && <span className={css.activityMessage}>{entry.message}</span>}
        </span>
      </li>
    )
  }
  return (
    <li className={css.activityRow} data-kind="write">
      <span className={css.activityTime}>{timeOf(entry.at)}</span>
      <span className={css.activityBody}>
        <span className={css.activityKind}>{tt('activity.write')}</span>
        {entry.tool !== undefined && <code className={css.activityTool}>{entry.tool}</code>}
        {entry.workspaceId !== undefined && <span className={css.activityMessage}>workspace: {entry.workspaceId}</span>}
      </span>
    </li>
  )
}

/** The CGC connection panel. */
export function CgcPanel({ controller, api }: CgcPanelProps) {
  const [status, setStatus] = useState<CgcStatusBody | undefined>(undefined)
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(controller.getSnapshot().panelOpen)

  useEffect(() => controller.subscribe(() => {
    setOpen(controller.getSnapshot().panelOpen)
  }), [controller])

  // Poll status while the panel is open; first fetch fires on open.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    const tick = async (): Promise<void> => {
      try {
        const next = await api.status()
        if (cancelled) return
        setStatus(next)
        setUrl(prev => prev !== '' ? prev : (next.url !== '' ? next.url : DEFAULT_MCP_URL))
        setError('')
      } catch (failure) {
        if (!cancelled) setError(errorMessage(failure))
      }
    }
    void tick()
    const timer = setInterval(() => { void tick() }, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [open, api])

  const connect = async (): Promise<void> => {
    if (url.trim() === '' || (token === '' && status?.token_configured !== true)) {
      setError(tt('form.required'))
      return
    }
    setBusy(true)
    try {
      const next = await api.connect({ url: url.trim(), ...(token !== '' ? { token } : {}) })
      setStatus(next)
      setToken('')
      setError('')
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async (): Promise<void> => {
    setBusy(true)
    try {
      const next = await api.disconnect()
      setStatus(next)
      setError('')
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  const stateKey = status?.connected === true ? 'status.connected' : status?.configured === true ? 'status.disconnected' : 'status.notConfigured'
  const stateClass = status?.connected === true ? 'connected' : status?.configured === true ? 'disconnected' : 'unconfigured'

  return (
    <div className={css.panel}>
      <div className={css.panelHeader}>
        <h2 className={css.panelTitle}>{tt('panel.title')}</h2>
        <button type="button" className={css.iconButton} title={tt('common.close')} aria-label={tt('common.close')} onClick={() => { controller.close() }}>x</button>
      </div>
      <div className={css.panelContent}>
        <section className={css.statusBlock} data-testid="cgc-status">
          <span className={css.statusBadge} data-state={stateClass}>{tt(stateKey)}</span>
          {status !== undefined && status.url !== '' && (
            <div className={css.statusRow}>
              <span className={css.statusLabel}>{tt('status.url')}</span>
              <code className={css.statusValue}>{status.url}</code>
            </div>
          )}
        </section>

        {status?.connected === true ? (
        <section className={css.formBlock} data-testid="cgc-connected">
          <div className={css.connectedState}>
            <span className={css.connectedDot} aria-hidden="true" />
            {tt('status.connected')}
          </div>
          <div className={css.formActions}>
            <button
              type="button"
              className={css.dangerButton}
              disabled={busy}
              onClick={() => { void disconnect() }}
            >
              {tt('form.disconnect')}
            </button>
          </div>
        </section>
      ) : (
      <section className={css.formBlock}>
          <label className={css.formField}>
            <span className={css.formLabel}>{tt('form.url')}</span>
            <input
              className={css.formInput}
              type="text"
              value={url}
              placeholder={DEFAULT_MCP_URL}
              onChange={event => { setUrl(event.target.value) }}
            />
            <span className={css.formHint}>{tt('form.urlHint')}</span>
          </label>
          <label className={css.formField}>
            <span className={css.formLabel}>{tt('form.token')}</span>
            <input
              className={css.formInput}
              type="password"
              value={token}
              autoComplete="off"
              onChange={event => { setToken(event.target.value) }}
            />
            <span className={css.formHint}>
              {status?.token_configured === true ? tt('form.tokenStored') : tt('form.tokenHint')}
            </span>
          </label>
          <div className={css.formActions}>
            <button type="button" className={css.primaryButton} disabled={busy} onClick={() => { void connect() }}>
              {busy ? tt('form.connecting') : tt('form.connect')}
            </button>
            {status?.configured === true && (
              <button type="button" className={css.dangerButton} disabled={busy} onClick={() => { void disconnect() }}>
                {tt('form.disconnect')}
              </button>
            )}
          </div>
          {error !== '' && <p className={css.errorText} role="alert">{tt('common.error', { error })}</p>}
        </section>
      )}

        <section className={css.activityBlock}>
          <h3 className={css.activityTitle}>{tt('activity.title')}</h3>
          {status === undefined || status.activity.length === 0 ? (
            <p className={css.activityEmpty}>{tt('activity.empty')}</p>
          ) : (
            <ul className={css.activityList}>
              {status.activity.map((entry, index) => <ActivityRow key={`${entry.at}:${index}`} entry={entry} />)}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
