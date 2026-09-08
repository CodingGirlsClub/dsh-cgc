/**
 * U8 DOM specs: mount/unmount idempotency, role-gated tabs (AE4), the hub
 * connect form (RSK7 token discipline, 401 inline, 429 Retry-After), shared
 * state rendering (NotConnected / Permission), row-directive injection
 * (no-session notice, id-only payload, never auto-submit), the 409 editor
 * conflict flow, the discover payment card + poll cap, focus/Escape
 * accessibility, and event-push re-render.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../src/client/api.ts'
import { act } from 'react'
import type { PanelsApi } from '../src/client/api.ts'
import { ConnectForm } from '../src/client/panel/ConnectForm.tsx'
import { HubSurface } from '../src/client/panel/HubSurface.tsx'
import { tt } from '../src/client/panel/helpers.ts'
import { PanelsEntry, PanelsShell } from '../src/client/panel/PanelsShell.tsx'
import { SendRowButton } from '../src/client/panel/RowActions.tsx'
import { DiscoverView, PAYMENT_POLL_MS, PAYMENT_TIMEOUT_MS } from '../src/client/panel/surfaces/DiscoverView.tsx'
import { LearningView } from '../src/client/panel/surfaces/LearningView.tsx'
import { TutorEditor } from '../src/client/panel/surfaces/TutorEditor.tsx'
import type { CgcStatusBody } from '../src/protocol.ts'
import {
  click,
  DISCONNECTED_STATUS,
  mount,
  mustQuery,
  NO_SESSION,
  pressEscape,
  setControlValue,
  settle,
  stubApi,
  stubChannel,
  stubRuntime,
  stubSessions,
  unmount,
  type Mounted,
} from './helpers.tsx'

const mounted: Mounted[] = []

async function mountTracked(node: Parameters<typeof mount>[0]): Promise<Mounted> {
  const m = await mount(node)
  mounted.push(m)
  return m
}

afterEach(async () => {
  while (mounted.length > 0) {
    const m = mounted.pop()
    if (m !== undefined) await unmount(m)
  }
  document.body.innerHTML = ''
})

describe('mount / unmount', () => {
  it('entry mount, open, unmount, and re-mount are idempotent', async () => {
    const { runtime } = stubRuntime({ sessions: stubSessions('cgc-assistant') })
    const first = await mountTracked(<PanelsEntry wide {...runtime} />)
    const entry = mustQuery('[data-dsh-cgc-panels-entry]')
    expect(document.querySelector('[data-dsh-cgc-panels]')).toBeNull()

    await click(entry)
    expect(mustQuery('[data-dsh-cgc-panels]')).toBeTruthy()

    await unmount(first)
    mounted.length = 0
    expect(document.querySelector('[data-dsh-cgc-panels]')).toBeNull()
    expect(document.querySelector('[data-dsh-cgc-panels-entry]')).toBeNull()

    const second = await mountTracked(<PanelsEntry wide {...runtime} />)
    expect(mustQuery('[data-dsh-cgc-panels-entry]')).toBeTruthy()
    await unmount(second)
    mounted.length = 0
  })
})

describe('role-gated tabs (AE4)', () => {
  function tabIds(root: ParentNode): string[] {
    return [...root.querySelectorAll('[data-tab]')].map((el) => el.getAttribute('data-tab') ?? '').sort()
  }

  it('shows the learner surfaces for cgc-assistant and hides tutor/admin', async () => {
    const { runtime, controller } = stubRuntime({ sessions: stubSessions('cgc-assistant') })
    const m = await mountTracked(<PanelsShell runtime={runtime} />)
    controller.open()
    await settle()
    expect(tabIds(m.container)).toEqual(['course', 'discover', 'hub', 'learning'].sort())
  })

  it('shows tutor/editor for cgc-tutor and admin only for cgc-admin', async () => {
    const tutor = stubRuntime({ sessions: stubSessions('cgc-tutor') })
    const tutorMount = await mountTracked(<PanelsShell runtime={tutor.runtime} />)
    expect(tabIds(tutorMount.container)).toEqual(['editor', 'hub', 'tutor'].sort())

    const admin = stubRuntime({ sessions: stubSessions('cgc-admin') })
    const adminMount = await mountTracked(<PanelsShell runtime={admin.runtime} />)
    expect(tabIds(adminMount.container)).toEqual(['admin', 'hub'].sort())

    const none = stubRuntime({ sessions: NO_SESSION })
    const noneMount = await mountTracked(<PanelsShell runtime={none.runtime} />)
    expect(tabIds(noneMount.container)).toEqual(['hub'])
  })
})

describe('hub connect form', () => {
  it('renders the connect form while disconnected, with the token field password/autocomplete-off', async () => {
    const api = stubApi()
    const { channel } = stubChannel()
    await mountTracked(<HubSurface api={api} channel={channel} />)
    await settle()
    const form = mustQuery('[data-block="connect"]')
    const token = mustQuery<HTMLInputElement>('input[data-field="token"]', form)
    expect(token.type).toBe('password')
    expect(token.getAttribute('autocomplete')).toBe('off')
    expect(mustQuery('[data-surface="hub"]')).toBeTruthy()
  })

  it('clears the token from the DOM after a successful connect (RSK7)', async () => {
    const connected: CgcStatusBody = {
      configured: true, connected: true, url: 'http://127.0.0.1:4102/mcp',
      web_url: 'https://cgc.example', token_configured: true, activity: [],
    }
    let delivered: CgcStatusBody | undefined
    const api = stubApi({ connect: async () => connected })
    await mountTracked(<ConnectForm api={api} status={undefined} onStatus={(next) => { delivered = next }} />)

    const secret = 'cgc-test-token-9f8e7d'
    await setControlValue(mustQuery<HTMLInputElement>('input[data-field="url"]'), 'http://127.0.0.1:4102/mcp')
    await setControlValue(mustQuery<HTMLInputElement>('input[data-field="token"]'), secret)
    await click(mustQuery('[data-action="connect"]'))
    await settle()

    expect(delivered).toBe(connected)
    expect(mustQuery<HTMLInputElement>('input[data-field="token"]').value).toBe('')
    expect(document.body.innerHTML).not.toContain(secret)
  })

  it('polls status while mounted so connect transitions never go stale', async () => {
    let statusCalls = 0
    const api = stubApi({
      status: async () => { statusCalls += 1; return DISCONNECTED_STATUS },
    })
    const { channel } = stubChannel()
    vi.useFakeTimers()
    try {
      await mountTracked(<HubSurface api={api} channel={channel} />)
      await settle()
      const initial = statusCalls
      expect(initial).toBeGreaterThan(0)
      await act(async () => { vi.advanceTimersByTime(3000); await Promise.resolve() })
      await settle()
      expect(statusCalls).toBeGreaterThan(initial)
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders 401 inline token-invalid with the re-issue link', async () => {
    const api = stubApi({
      status: async () => ({ ...DISCONNECTED, web_url: 'https://cgc.example' }),
      connect: async () => { throw new ApiError('token invalid', 401) },
    })
    const { channel } = stubChannel()
    await mountTracked(<HubSurface api={api} channel={channel} />)
    await settle()
    await setControlValue(mustQuery<HTMLInputElement>('input[data-field="token"]'), 'stale-token')
    await click(mustQuery('[data-action="connect"]'))
    await settle()

    expect(mustQuery('[data-error="token-invalid"]').textContent).toContain(tt('state.tokenInvalid'))
    const link = mustQuery<HTMLAnchorElement>('a[data-link="reissue"]')
    expect(link.href).toBe('https://cgc.example/mcp')
    expect(link.target).toBe('_blank')
  })

  it('renders the 429 Retry-After wait copy', async () => {
    const api = stubApi({ connect: async () => { throw new ApiError('too fast', 429, undefined, 30) } })
    const { channel } = stubChannel()
    await mountTracked(<HubSurface api={api} channel={channel} />)
    await settle()
    await setControlValue(mustQuery<HTMLInputElement>('input[data-field="token"]'), 'tok')
    await click(mustQuery('[data-action="connect"]'))
    await settle()
    expect(mustQuery('[data-error="retry-after"]').textContent).toBe(tt('state.retryAfter', { seconds: 30 }))
  })
})

const DISCONNECTED = {
  configured: false, connected: false, url: '', web_url: '', token_configured: false, activity: [] as never[],
}

describe('shared state contract on a non-discover surface', () => {
  it('renders NotConnected when the data plane answers 503', async () => {
    const api = stubApi({
      myEnrollments: async () => { throw new ApiError('bridge not connected', 503, 'not_connected') },
    })
    const { runtime } = stubRuntime({ api, sessions: stubSessions('cgc-assistant') })
    await mountTracked(<LearningView runtime={runtime} />)
    await settle()
    expect(mustQuery('[data-state="not-connected"]').textContent).toContain(tt('state.notConnected'))
  })

  it('renders Permission on a 403 envelope', async () => {
    const api = stubApi({
      myEnrollments: async () => { throw new ApiError('fence refused', 403, 'forbidden') },
    })
    const { runtime } = stubRuntime({ api, sessions: stubSessions('cgc-assistant') })
    await mountTracked(<LearningView runtime={runtime} />)
    await settle()
    const block = mustQuery('[data-state="permission"]')
    expect(block.getAttribute('data-reason')).toBe('forbidden')
    expect(block.textContent).toContain(tt('state.permission'))
  })
})

describe('row-directive injection', () => {
  it('a click fills the composer with verb + row id only, and never submits', async () => {
    const form = document.createElement('form')
    const composer = document.createElement('textarea')
    composer.setAttribute('data-phase', 'idle')
    form.appendChild(composer)
    document.body.appendChild(form)
    let submitted = 0
    form.addEventListener('submit', () => { submitted += 1 })

    const { runtime, controller } = stubRuntime({ sessions: stubSessions('cgc-assistant') })
    await mountTracked(<SendRowButton verb="course" id="42" sessions={runtime.sessions} controller={controller} />)
    await click(mustQuery('[data-action="send-directive"]'))

    expect(composer.value).toBe('查看课程 42')
    expect(composer.value).not.toMatch(/token|secret|password|密码|口令|凭证/i)
    expect(submitted).toBe(0)
    expect(document.activeElement).toBe(composer)
    form.remove()
  })

  it('a title-only payload row yields an id-only directive refusal notice', async () => {
    const composer = document.createElement('textarea')
    composer.setAttribute('data-phase', 'idle')
    document.body.appendChild(composer)

    const { runtime, controller } = stubRuntime({ sessions: stubSessions('cgc-assistant') })
    // The row carries only free text (title) — no id field → rowId() undefined.
    await mountTracked(<SendRowButton verb="course" id={undefined} sessions={runtime.sessions} controller={controller} />)
    await click(mustQuery('[data-action="send-directive"]'))

    expect(composer.value).toBe('')
    expect(controller.getSnapshot().notice).toBe(tt('notice.invalidId'))
    composer.remove()
  })

  it('a no-session click is a no-op with a visible notice', async () => {
    const { runtime, controller } = stubRuntime({ sessions: NO_SESSION })
    await mountTracked(
      <>
        <PanelsEntry wide {...runtime} />
        <SendRowButton verb="course" id="42" sessions={runtime.sessions} controller={controller} />
      </>,
    )
    await click(mustQuery('[data-dsh-cgc-panels-entry]'))
    await click(mustQuery('[data-action="send-directive"]'))
    const notice = mustQuery('[data-notice]')
    expect(notice.textContent).toBe(tt('notice.noSession'))
    expect(notice.getAttribute('aria-live')).toBe('polite')
  })
})

describe('tutor editor 409 conflict flow', () => {
  function editorApi(save: (workspaceId: string, courseId: string, content: unknown, baseVersion: number) => Promise<unknown>): PanelsApi {
    return stubApi({
      myWorkspaces: async () => ({ workspaces: [{ id: 'w1', name: 'Alpha' }] }),
      workspaceCourses: async () => ({ courses: [{ id: 'c1', title: 'Course One' }] }),
      courseContent: async () => ({ sections: [{ id: 's1' }] }),
      courseRevision: async () => ({ revision: 3 }),
      saveCourseContent: save,
    })
  }

  it('a 409 keeps the local draft and offers reload-latest / force-submit', async () => {
    let saves = 0
    const api = editorApi(async () => {
      saves += 1
      if (saves === 1) throw new ApiError('stale base_version', 409, 'version_conflict')
      return {}
    })
    const { runtime } = stubRuntime({ api, sessions: stubSessions('cgc-tutor') })
    await mountTracked(<TutorEditor runtime={runtime} />)
    await settle()

    // Workspace auto-selects; pick the course.
    await setControlValue(mustQuery<HTMLSelectElement>('select[data-field="course"]'), 'c1')
    await settle()
    const textarea = mustQuery<HTMLTextAreaElement>('textarea[data-field="content"]')
    const draft = '{\n  "sections": [{ "id": "s1", "title": "本地草稿" }]\n}'
    await setControlValue(textarea, draft)

    await click(mustQuery('[data-action="save"]'))
    await settle()

    const card = mustQuery('[data-card="conflict"]')
    expect(card.textContent).toContain(tt('editor.conflictTitle'))
    // The local draft survives the 409.
    expect(mustQuery<HTMLTextAreaElement>('textarea[data-field="content"]').value).toBe(draft)
    // Exactly two exits.
    mustQuery('[data-action="reload-latest"]', card)
    mustQuery('[data-action="force-submit"]', card)
    expect(document.querySelector('[data-action="save"]')).toBeNull()

    // Force-submit re-reads the revision and re-submits the same draft.
    await click(mustQuery('[data-action="force-submit"]'))
    await settle()
    expect(saves).toBe(2)
    expect(mustQuery('[data-field="editor-notice"]').textContent).toBe(tt('editor.saved'))
  })
})

describe('discover enrollment + payment flow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function discoverApi(orderStatus: () => Promise<unknown>): PanelsApi {
    return stubApi({
      myWorkspaces: async () => ({ workspaces: [{ id: 'w1', name: 'Alpha' }] }),
      discover: async () => ({ offerings: [{ id: 'e9', kind: 'event', title: 'Hack Night' }] }),
      enrollmentSummary: async () => ({ price: '¥100', seats: 3 }),
      createEnrollment: async () => ({ status: 'payment_pending', checkout_url: 'https://pay.example/checkout/9', enrollment_id: 'en1' }),
      orderStatus,
    })
  }

  it('confirm card → payment card opens checkout externally, polls 5s, exits at the 10-minute cap', async () => {
    let polls = 0
    const api = discoverApi(async () => { polls += 1; return { status: 'payment_pending' } })
    const { runtime, opened } = stubRuntime({ api, sessions: stubSessions('cgc-assistant') })
    await mountTracked(<DiscoverView runtime={runtime} />)
    await settle()

    // Enrollment confirmation card with the summary.
    await click(mustQuery('[data-action="enroll"]'))
    await settle()
    const card = mustQuery('[data-card="enrollment-confirm"]')
    expect(card.textContent).toContain('Hack Night')
    expect(card.textContent).toContain('¥100')

    // Confirm → payment-pending card; checkout opens externally exactly once.
    await click(mustQuery('[data-action="confirm-enroll"]'))
    await settle()
    expect(mustQuery('[data-card="payment-pending"]')).toBeTruthy()
    expect(opened).toEqual(['https://pay.example/checkout/9'])

    // 5s cadence: one poll per interval tick.
    for (let i = 0; i < 2; i += 1) {
      await act(async () => { vi.advanceTimersByTime(PAYMENT_POLL_MS); await Promise.resolve() })
      await settle(2)
    }
    expect(polls).toBe(2)
    expect(document.querySelector('[data-card="payment-timeout"]')).toBeNull()

    // Ride out the 10-minute cap: the card exits to reopen + manual refresh.
    let ticks = 0
    while (document.querySelector('[data-card="payment-timeout"]') === null && ticks < 200) {
      await act(async () => { vi.advanceTimersByTime(PAYMENT_POLL_MS); await Promise.resolve() })
      await settle(2)
      ticks += 1
    }
    const timeout = mustQuery('[data-card="payment-timeout"]')
    expect(timeout.textContent).toContain(tt('discover.paymentTimeout'))
    expect(ticks * PAYMENT_POLL_MS).toBeGreaterThanOrEqual(PAYMENT_TIMEOUT_MS - 2 * PAYMENT_POLL_MS)

    // The exit offers a reopen affordance.
    await click(mustQuery('[data-action="reopen-checkout"]'))
    expect(opened).toEqual(['https://pay.example/checkout/9', 'https://pay.example/checkout/9'])
    const pollsAtExit = polls
    await act(async () => { vi.advanceTimersByTime(PAYMENT_TIMEOUT_MS); await Promise.resolve() })
    expect(polls).toBe(pollsAtExit)
  })

  it('a settled payment leaves the pending card', async () => {
    const api = discoverApi(async () => ({ status: 'paid' }))
    const { runtime } = stubRuntime({ api, sessions: stubSessions('cgc-assistant') })
    await mountTracked(<DiscoverView runtime={runtime} />)
    await settle()
    await click(mustQuery('[data-action="enroll"]'))
    await settle()
    await click(mustQuery('[data-action="confirm-enroll"]'))
    await settle()
    mustQuery('[data-card="payment-pending"]')
    await act(async () => { vi.advanceTimersByTime(PAYMENT_POLL_MS); await Promise.resolve() })
    await settle()
    expect(document.querySelector('[data-card="payment-pending"]')).toBeNull()
  })
})

describe('accessibility baseline', () => {
  it('focus moves into the panel on open; Escape closes and returns focus to the trigger', async () => {
    const { runtime } = stubRuntime({ sessions: stubSessions('cgc-assistant') })
    await mountTracked(<PanelsEntry wide {...runtime} />)
    const entry = mustQuery<HTMLButtonElement>('[data-dsh-cgc-panels-entry]')
    entry.focus()
    await click(entry)

    // Focus moved into the panel (the close button is first in the tab order).
    const close = mustQuery<HTMLButtonElement>('[data-action="close"]')
    expect(document.activeElement).toBe(close)

    // Every tab is a native button (tabbable, role-free).
    const tabs = [...document.querySelectorAll('[data-tab]')]
    expect(tabs.length).toBeGreaterThan(1)
    for (const tab of tabs) expect(tab.tagName).toBe('BUTTON')

    await pressEscape()
    expect(document.querySelector('[data-dsh-cgc-panels]')).toBeNull()
    expect(document.activeElement).toBe(entry)
  })
})

describe('event push re-render', () => {
  it('a gap refetches immediately; an event refetches after the debounce', async () => {
    let loads = 0
    const api = stubApi({
      myEnrollments: async () => { loads += 1; return { enrollments: [{ id: 'e1', title: `load-${loads}` }] } },
    })
    const { channel, emit, emitGap } = stubChannel()
    const { runtime } = stubRuntime({ api, channel, sessions: stubSessions('cgc-assistant') })
    await mountTracked(<LearningView runtime={runtime} />)
    await settle()
    expect(loads).toBe(1)

    // Gap → immediate full refetch.
    await act(async () => { emitGap() })
    await settle()
    expect(loads).toBe(2)

    // Event → debounced refetch (250ms window).
    vi.useFakeTimers()
    try {
      await act(async () => { emit({ seq: 8, at: 0, tool: 'mcp__cgc-2046__list_my_enrollments', ok: true, summary: 'ok' }) })
      await act(async () => { vi.advanceTimersByTime(1000); await Promise.resolve() })
      await settle()
      expect(loads).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })
})
