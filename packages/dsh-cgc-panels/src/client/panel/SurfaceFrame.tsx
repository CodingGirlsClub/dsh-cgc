/**
 * Shared surface machinery: the resource hook (fetch → shared state contract
 * + event-push refetch) and the frame component rendering every state
 * identically across the seven surfaces.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { EventChannel } from '../events.ts'
import type { SurfaceState } from '../state.ts'
import { stateFromError } from '../state.ts'
import { tt } from './helpers.ts'
import css from './panel.module.css'

/** Debounce window coalescing a burst of pushed events into one refetch. */
const EVENT_REFETCH_DEBOUNCE_MS = 250

export interface Resource<T> {
  readonly state: SurfaceState<T>
  readonly reload: () => void
}

/**
 * Fetch one surface resource into the shared state contract.
 * @param key - refetch identity: changing it (workspace/course selection)
 *   reloads; `null` means idle (no selection yet — nothing is fetched and
 *   the state stays `loading`). The loader closure is always read fresh.
 * @param load - the route call.
 * @param empty - emptiness probe for the ready value.
 * @param channel - the event channel; pushed events debounce into a refetch,
 *   a gap refetches immediately (the host already told us local state fell
 *   out of the retained window).
 */
export function useResource<T>(
  key: string | null,
  load: () => Promise<T>,
  empty: (value: T) => boolean,
  channel?: EventChannel,
): Resource<T> {
  const [state, setState] = useState<SurfaceState<T>>({ kind: 'loading' })
  const loadRef = useRef(load)
  loadRef.current = load
  const emptyRef = useRef(empty)
  emptyRef.current = empty
  const generation = useRef(0)

  const reload = useCallback((): void => {
    generation.current += 1
    const ticket = generation.current
    setState({ kind: 'loading' })
    loadRef.current().then(
      (value) => {
        if (ticket !== generation.current) return
        setState(emptyRef.current(value) ? { kind: 'empty' } : { kind: 'ready', value })
      },
      (error: unknown) => {
        if (ticket !== generation.current) return
        setState(stateFromError<T>(error))
      },
    )
  }, [])

  useEffect(() => {
    if (key === null) return
    reload()
  }, [key, reload])
  // Event push → re-render (debounced); gap → immediate full refetch.
  useEffect(() => {
    if (channel === undefined) return undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const offEvent = channel.onEvent(() => {
      clearTimeout(timer)
      timer = setTimeout(reload, EVENT_REFETCH_DEBOUNCE_MS)
    })
    const offGap = channel.onGap(reload)
    return () => {
      offEvent()
      offGap()
      clearTimeout(timer)
    }
  }, [channel, reload])

  return { state, reload }
}

/** Frame props: the state plus the ready-value renderer. */
export interface SurfaceFrameProps<T> {
  readonly state: SurfaceState<T>
  /** Retry affordance for the error state. */
  readonly onRetry?: () => void
  /** Platform web origin for the token re-issue link (401 state). */
  readonly webUrl?: string | undefined
  readonly children: (value: T) => ReactNode
}

/** Render the shared state contract; ready delegates to the surface body. */
export function SurfaceFrame<T>({ state, onRetry, webUrl, children }: SurfaceFrameProps<T>): ReactNode {
  switch (state.kind) {
    case 'loading':
      return <p className={css.stateLine} data-state="loading">{tt('state.loading')}</p>
    case 'not-connected':
      return (
        <div className={css.stateBlock} data-state="not-connected">
          <p className={css.stateLine}>{tt('state.notConnected')}</p>
          <p className={css.stateHint}>{tt('state.notConnectedHint')}</p>
        </div>
      )
    case 'permission':
      return (
        <div className={css.stateBlock} data-state="permission" data-reason={state.reason}>
          <p className={css.stateLine}>
            {state.reason === 'token-invalid' ? tt('state.tokenInvalid') : tt('state.permission')}
          </p>
          {state.reason === 'token-invalid' && webUrl !== undefined && webUrl !== '' && (
            <a className={css.link} href={`${webUrl}/mcp`} target="_blank" rel="noreferrer noopener">
              {tt('state.tokenReissue')}
            </a>
          )}
        </div>
      )
    case 'error':
      return (
        <div className={css.stateBlock} data-state="error">
          <p className={css.stateLine}>{tt('state.error', { message: state.message })}</p>
          {state.retryAfter !== undefined && (
            <p className={css.stateHint}>{tt('state.retryAfter', { seconds: state.retryAfter })}</p>
          )}
          {onRetry !== undefined && (
            <button type="button" className={css.button} onClick={onRetry}>{tt('state.retry')}</button>
          )}
        </div>
      )
    case 'empty':
      return <p className={css.stateLine} data-state="empty">{tt('state.empty')}</p>
    case 'ready':
      return <>{children(state.value)}</>
  }
}
