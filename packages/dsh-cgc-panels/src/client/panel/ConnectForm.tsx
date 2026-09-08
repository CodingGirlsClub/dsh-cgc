/**
 * The hub connect form: MCP URL + token, submit → POST /connect. Discipline:
 * the token field is type=password autocomplete=off and CLEARS on success
 * (RSK7 — the DOM never retains the credential); 401 renders inline
 * token-invalid copy with the platform re-issue link; 429 renders the
 * Retry-After wait copy; the form never echoes a stored token.
 */
import { useState, type FormEvent, type ReactNode } from 'react'
import { ApiError, type PanelsApi } from '../api.ts'
import type { CgcStatusBody } from '../../protocol.ts'
import { errorMessage, tt } from './helpers.ts'
import css from './panel.module.css'

export interface ConnectFormProps {
  readonly api: PanelsApi
  /** Post-connect snapshot consumer (the hub refreshes its status block). */
  readonly onStatus: (status: CgcStatusBody) => void
  /** Current status (for the stored-token hint and the re-issue link). */
  readonly status: CgcStatusBody | undefined
}

type FormError =
  | { kind: 'required' }
  | { kind: 'token-invalid' }
  | { kind: 'retry-after'; seconds: number }
  | { kind: 'generic'; message: string }

/** The connect form. */
export function ConnectForm({ api, onStatus, status }: ConnectFormProps): ReactNode {
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<FormError | undefined>(undefined)

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (busy) return
    if (url.trim() === '' && token.trim() === '') {
      setError({ kind: 'required' })
      return
    }
    setBusy(true)
    setError(undefined)
    const payload: { url?: string; token?: string } = {}
    if (url.trim() !== '') payload.url = url.trim()
    if (token.trim() !== '') payload.token = token.trim()
    api.connect(payload).then(
      (next) => {
        setBusy(false)
        setToken('') // RSK7: the credential never lingers in the DOM.
        onStatus(next)
      },
      (cause: unknown) => {
        setBusy(false)
        if (cause instanceof ApiError && cause.status === 401) {
          setError({ kind: 'token-invalid' })
        } else if (cause instanceof ApiError && cause.status === 429) {
          setError({ kind: 'retry-after', seconds: cause.retryAfter ?? 0 })
        } else {
          setError({ kind: 'generic', message: errorMessage(cause) })
        }
      },
    )
  }

  return (
    <form className={css.form} data-block="connect" onSubmit={submit}>
      <label className={css.field}>
        <span className={css.fieldLabel}>{tt('form.url')}</span>
        <input
          className={css.input}
          data-field="url"
          value={url}
          placeholder={tt('form.urlHint')}
          onChange={(event) => { setUrl(event.target.value) }}
        />
      </label>
      <label className={css.field}>
        <span className={css.fieldLabel}>{tt('form.token')}</span>
        <input
          className={css.input}
          data-field="token"
          type="password"
          autoComplete="off"
          value={token}
          placeholder={status?.token_configured === true ? tt('form.tokenStored') : tt('form.tokenHint')}
          onChange={(event) => { setToken(event.target.value) }}
        />
      </label>
      {error?.kind === 'required' && <p className={css.formError} data-error="required">{tt('form.required')}</p>}
      {error?.kind === 'token-invalid' && (
        <p className={css.formError} data-error="token-invalid">
          {tt('state.tokenInvalid')}
          {status?.web_url !== undefined && status.web_url !== '' && (
            <>
              {' '}
              <a className={css.link} data-link="reissue" href={`${status.web_url}/mcp`} target="_blank" rel="noreferrer noopener">
                {tt('state.tokenReissue')}
              </a>
            </>
          )}
        </p>
      )}
      {error?.kind === 'retry-after' && (
        <p className={css.formError} data-error="retry-after">{tt('state.retryAfter', { seconds: error.seconds })}</p>
      )}
      {error?.kind === 'generic' && (
        <p className={css.formError} data-error="generic">{tt('common.error', { message: error.message })}</p>
      )}
      <button type="submit" className={css.button} data-action="connect" disabled={busy}>
        {busy ? tt('form.connecting') : tt('form.connect')}
      </button>
    </form>
  )
}
