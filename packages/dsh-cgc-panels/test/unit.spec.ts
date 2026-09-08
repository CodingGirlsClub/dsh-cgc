/**
 * U8 host/protocol specs: directive discipline (RSK4), shared state mapping,
 * api wire handling (CSRF header, 401/429/envelope codes), the event channel
 * (WS primary / polling fallback / gap refetch — U7 wire), and the host
 * fail-fast extension-point check + CSRF bootstrap tap (KTD3/KTD5).
 */
import { describe, expect, it, vi } from 'vitest'
import { ApiError, PanelsApi, parseRetryAfter } from '../src/client/api.ts'
import { EventChannel, type WebSocketLike } from '../src/client/events.ts'
import { injectDirective } from '../src/client/inject.ts'
import { readBoot } from '../src/client/boot.ts'
import { PanelsController } from '../src/client/panel/controller.ts'
import { stateFromError } from '../src/client/state.ts'
import { makeBootIndexTap, PANELS_BOOT_KEY } from '../src/boot-inject.ts'
import { apply as hostApply, MIN_DSH_VERSION, missingHostExtensionPoints } from '../src/index.ts'
import {
  buildDirective,
  DIRECTIVE_VERBS,
  surfaceVisible,
  type CgcEvent,
  type CgcEventsPage,
} from '../src/protocol.ts'
import { apply as clientApply, MIN_DSH_VERSION as CLIENT_MIN_DSH_VERSION } from '../src/client/index.ts'
import { NO_SESSION, stubSessions } from './helpers.tsx'

const TICK: CgcEvent = { seq: 7, at: 1_700_000_000_000, tool: 'mcp__cgc-2046__save_course_content', ok: true, summary: 'ok' }

describe('directive discipline (RSK4 / AE5)', () => {
  it('builds verb + validated id only', () => {
    expect(buildDirective('course', '123')).toBe(`${DIRECTIVE_VERBS.course} 123`)
    const uuid = 'a94a8fe5-ccb1-42ba-9c8e-8f3b2c7a1d00'
    expect(buildDirective('event', uuid)).toBe(`${DIRECTIVE_VERBS.event} ${uuid}`)
  })

  it('refuses free text, oversized numerics, and credential-shaped payloads', () => {
    expect(buildDirective('course', '删除所有课程')).toBeUndefined()
    expect(buildDirective('course', '123 or 1=1')).toBeUndefined()
    expect(buildDirective('course', '1234567890123456')).toBeUndefined()
    expect(buildDirective('order', 'token=abc123')).toBeUndefined()
    expect(buildDirective('task', '')).toBeUndefined()
  })

  it('a directive never carries credential fields — only the verb word and the id', () => {
    const directive = buildDirective('enrollment', '42')
    expect(directive).toBe(`${DIRECTIVE_VERBS.enrollment} 42`)
    expect(directive).not.toMatch(/token|secret|password|密码|口令|凭证/i)
  })
})

describe('surface role gating (AE4)', () => {
  it('hub is always visible; role surfaces follow the active preset', () => {
    expect(surfaceVisible('hub', undefined)).toBe(true)
    expect(surfaceVisible('learning', undefined)).toBe(false)
    expect(surfaceVisible('learning', 'cgc-assistant')).toBe(true)
    expect(surfaceVisible('course', 'cgc-assistant')).toBe(true)
    expect(surfaceVisible('discover', 'cgc-assistant')).toBe(true)
    expect(surfaceVisible('discover', 'cgc-tutor')).toBe(false)
    expect(surfaceVisible('tutor', 'cgc-tutor')).toBe(true)
    expect(surfaceVisible('editor', 'cgc-tutor')).toBe(true)
    expect(surfaceVisible('tutor', 'cgc-assistant')).toBe(false)
    expect(surfaceVisible('admin', 'cgc-admin')).toBe(true)
    expect(surfaceVisible('admin', 'cgc-tutor')).toBe(false)
  })
})

describe('shared state mapping (Appendix B)', () => {
  it('maps 503/not_connected to the NotConnected state', () => {
    expect(stateFromError(new ApiError('not connected', 503, 'not_connected'))).toEqual({ kind: 'not-connected' })
    expect(stateFromError(new ApiError('bridge down', 500, 'not_connected'))).toEqual({ kind: 'not-connected' })
  })

  it('maps 401 to permission/token-invalid and 403 to permission/forbidden', () => {
    expect(stateFromError(new ApiError('bad token', 401, 'forbidden'))).toEqual({ kind: 'permission', reason: 'token-invalid', message: 'bad token' })
    expect(stateFromError(new ApiError('cross-site', 403, 'forbidden'))).toEqual({ kind: 'permission', reason: 'forbidden', message: 'cross-site' })
  })

  it('keeps the Retry-After seconds on a 429 error state', () => {
    expect(stateFromError(new ApiError('slow down', 429, undefined, 30))).toEqual({ kind: 'error', message: 'slow down', retryAfter: 30 })
  })
})

describe('PanelsApi wire handling', () => {
  function fakeResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      json: async () => body,
    } as unknown as Response
  }

  it('sends the CSRF proof header on writes when bootstrapped; never on reads', async () => {
    const seen: Array<{ url: unknown; init: RequestInit | undefined }> = []
    const fetchImpl: typeof fetch = (async (url: unknown, init?: RequestInit) => {
      seen.push({ url, init })
      return fakeResponse(200, { ok: true, value: { revision: 2 } })
    }) as typeof fetch
    const api = new PanelsApi('csrf-token-1', fetchImpl)
    await api.saveCourseContent('w1', 'c1', { a: 1 }, 3)
    const write = seen[0]
    expect((write?.init?.headers as Record<string, string>)['x-cgc-csrf-token']).toBe('csrf-token-1')
    expect(String(write?.url)).toBe('/api/dsh-cgc-core/courses/c1/content')

    await api.discover()
    expect(seen[1]?.init).toBeUndefined()

    const noToken = new PanelsApi(undefined, fetchImpl)
    await noToken.saveCourseContent('w1', 'c1', { a: 1 }, 3)
    expect((seen[2]?.init?.headers as Record<string, string>)['x-cgc-csrf-token']).toBeUndefined()
  })

  it('surfaces 401 from the legacy error shape', async () => {
    const api = new PanelsApi(undefined, (async () => fakeResponse(401, { error: 'token invalid' })) as typeof fetch)
    const failure = await api.status().then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(ApiError)
    expect((failure as ApiError).status).toBe(401)
    expect((failure as ApiError).message).toBe('token invalid')
  })

  it('carries Retry-After seconds out of a 429', async () => {
    const api = new PanelsApi(undefined, (async () => fakeResponse(429, { ok: false, error: { code: 'bad_request', message: 'too fast' } }, { 'retry-after': '30' })) as typeof fetch)
    const failure = await api.events(0).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(ApiError)
    expect((failure as ApiError).status).toBe(429)
    expect((failure as ApiError).retryAfter).toBe(30)
  })

  it('unwraps the data-plane envelope and maps ok:false codes', async () => {
    const api = new PanelsApi(undefined, (async () => fakeResponse(409, { ok: false, error: { code: 'version_conflict', message: 'stale base' } })) as typeof fetch)
    const failure = await api.saveCourseContent('w', 'c', {}, 1).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(ApiError)
    expect((failure as ApiError).status).toBe(409)
    expect((failure as ApiError).code).toBe('version_conflict')
    expect((failure as ApiError).message).toBe('stale base')
  })

  it('parses only the seconds form of Retry-After', () => {
    const response = (value: string | null): Response => ({ headers: { get: () => value } }) as unknown as Response
    expect(parseRetryAfter(response('45'))).toBe(45)
    expect(parseRetryAfter(response('soon'))).toBeUndefined()
    expect(parseRetryAfter(response(null))).toBeUndefined()
  })
})

describe('composer injection (RSK4 / AE5)', () => {
  it('no-ops with a no-session reason when no session is open', () => {
    const textarea = document.createElement('textarea')
    textarea.setAttribute('data-phase', 'idle')
    document.body.appendChild(textarea)
    const outcome = injectDirective('查看课程 42', NO_SESSION)
    expect(outcome).toEqual({ ok: false, reason: 'no-session' })
    expect(textarea.value).toBe('')
    textarea.remove()
  })

  it('fills the composer draft without submitting when a session is open', () => {
    const form = document.createElement('form')
    const textarea = document.createElement('textarea')
    textarea.setAttribute('data-phase', 'idle')
    form.appendChild(textarea)
    document.body.appendChild(form)
    let submitted = 0
    form.addEventListener('submit', () => { submitted += 1 })

    const outcome = injectDirective('查看课程 42', stubSessions('cgc-assistant'))
    expect(outcome).toEqual({ ok: true })
    expect(textarea.value).toBe('查看课程 42')
    expect(submitted).toBe(0)
    expect(document.activeElement).toBe(textarea)
    form.remove()
  })

  it('reports a busy/absent composer without writing', () => {
    const sessions = stubSessions('cgc-assistant')
    expect(injectDirective('查看课程 42', sessions)).toEqual({ ok: false, reason: 'no-composer' })
    const textarea = document.createElement('textarea')
    textarea.setAttribute('data-phase', 'busy')
    textarea.disabled = true
    document.body.appendChild(textarea)
    expect(injectDirective('查看课程 42', sessions)).toEqual({ ok: false, reason: 'composer-busy' })
    textarea.remove()
  })
})

describe('PanelsController', () => {
  it('opens, closes, toggles, and returns focus to the trigger on closeAndRefocus', () => {
    const controller = new PanelsController()
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    controller.trigger = trigger

    let notifies = 0
    const off = controller.subscribe(() => { notifies += 1 })

    controller.open()
    expect(controller.getSnapshot().panelOpen).toBe(true)
    controller.open()
    expect(notifies).toBe(1)

    controller.showNotice('n1')
    controller.showNotice('n1')
    expect(controller.getSnapshot().notice).toBe('n1')
    expect(controller.getSnapshot().noticeSeq).toBe(2)

    controller.closeAndRefocus()
    expect(controller.getSnapshot().panelOpen).toBe(false)
    expect(document.activeElement).toBe(trigger)

    controller.toggle()
    expect(controller.getSnapshot().panelOpen).toBe(true)
    off()
    trigger.remove()
  })
})

describe('event channel (U7 wire)', () => {
  class StubSocket implements WebSocketLike {
    onopen: (() => void) | null = null
    onmessage: ((event: { data: unknown }) => void) | null = null
    onclose: (() => void) | null = null
    onerror: (() => void) | null = null
    readonly url: string
    closed = false
    constructor(url: string) { this.url = url }
    close(): void { this.closed = true }
  }

  it('adopts the hello cursor, then delivers event frames', () => {
    const sockets: StubSocket[] = []
    const channel = new EventChannel({
      wsUrl: () => 'ws://localhost/api/dsh-cgc-core/events',
      fetchPage: async () => ({ gap: false, events: [], latestSeq: 0 }),
      createWs: (url) => { const socket = new StubSocket(url); sockets.push(socket); return socket },
    })
    const seen: CgcEvent[] = []
    channel.onEvent((event) => { seen.push(event) })
    channel.start()
    expect(sockets).toHaveLength(1)

    const socket = sockets[0]!
    socket.onmessage?.({ data: JSON.stringify({ type: 'hello', latestSeq: 5 }) })
    expect(channel.mode).toBe('ws')
    expect(channel.cursor).toBe(5)

    socket.onmessage?.({ data: JSON.stringify({ type: 'event', event: TICK }) })
    expect(seen).toEqual([TICK])
    expect(channel.cursor).toBe(7)
    socket.onmessage?.({ data: 'not-json' })
    expect(seen).toHaveLength(1)
    channel.stop()
    expect(socket.closed).toBe(true)
    expect(channel.mode).toBe('idle')
  })

  it('falls back to afterSeq polling and full-refetches on a gap page', async () => {
    const sockets: StubSocket[] = []
    const pages: CgcEventsPage[] = [
      { gap: false, events: [TICK], latestSeq: 7 },
      { gap: true, oldestSeq: 40, latestSeq: 50, events: [] },
    ]
    const calls: number[] = []
    const channel = new EventChannel({
      wsUrl: () => 'ws://localhost/api/dsh-cgc-core/events',
      fetchPage: async (afterSeq) => { calls.push(afterSeq); return pages.shift() ?? { gap: false, events: [], latestSeq: 50 } },
      createWs: (url) => { const socket = new StubSocket(url); sockets.push(socket); return socket },
      pollMs: 60_000,
      wsRetryMs: 60_000,
    })
    const seen: CgcEvent[] = []
    let gaps = 0
    channel.onEvent((event) => { seen.push(event) })
    channel.onGap(() => { gaps += 1 })
    channel.start()
    sockets[0]?.onclose?.()
    expect(channel.mode).toBe('poll')

    // First fallback page: incremental events, cursor advances.
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual([0])
    expect(seen).toEqual([TICK])
    expect(channel.cursor).toBe(7)

    // Gap page: drop the cursor, signal full-refetch, resume from latestSeq.
    const listener = (channel as unknown as { pollOnce(): Promise<void> })
    await listener.pollOnce()
    expect(calls).toEqual([0, 7])
    expect(gaps).toBe(1)
    expect(channel.cursor).toBe(50)
    channel.stop()
  })
})

describe('host half (fail-fast + bootstrap tap)', () => {
  const fullProbe = {
    webServer: {
      registerUpgrade: () => () => undefined,
      tapIndex: () => () => undefined,
    },
    get: (name: string) => (name === 'approval' ? { request: async () => 'unavailable' } : undefined),
  }

  it('names the missing extension points and the minimum DSH version', () => {
    expect(missingHostExtensionPoints({})).toEqual(['webServer.registerUpgrade', 'webServer.tapIndex', 'ctx.approval'])
    expect(missingHostExtensionPoints(fullProbe)).toEqual([])
    expect(() => hostApply({ webServer: {}, get: () => undefined } as never)).toThrowError(new RegExp(`DSH >= ${MIN_DSH_VERSION}`))
    expect(() => hostApply({ webServer: {}, get: () => undefined } as never)).toThrowError(/webServer\.registerUpgrade/)
  })

  it('mounts the bootstrap tap when every extension point is present', () => {
    let tapped: ((html: string) => string) | undefined
    const effects: string[] = []
    const ctx = {
      ...fullProbe,
      webServer: {
        registerUpgrade: () => () => undefined,
        tapIndex: (fn: (html: string) => string) => { tapped = fn; return () => undefined },
      },
      effect: (fn: unknown, label: string) => {
        effects.push(label)
        // cordis effect() runs the body immediately and keeps the disposer.
        if (typeof fn === 'function') (fn as () => unknown)()
      },
      logger: { warn: () => undefined },
    }
    expect(() => hostApply(ctx as never)).not.toThrow()
    expect(effects).toContain('dsh-cgc-panels: csrf bootstrap')
    expect(typeof tapped).toBe('function')
  })

  it('injects the bootstrap as the first head child with < escaped', () => {
    const tap = makeBootIndexTap(() => ({ csrfToken: 't<ok>n' }))
    const html = tap('<!doctype html><html><head><title>x</title></head><body></body></html>')
    const headEnd = html.indexOf('<head>') + 6
    expect(html.slice(headEnd, headEnd + 8)).toBe('<script>')
    expect(html).toContain(`window.${PANELS_BOOT_KEY} = {"csrfToken":"t\\u003cok>n"}`)
    expect(html).not.toContain('t<ok>n')
  })

  it('readBoot validates the payload and degrades on malformed input', () => {
    expect(readBoot({}).csrfToken).toBeUndefined()
    expect(readBoot({ [PANELS_BOOT_KEY]: 'nope' }).csrfToken).toBeUndefined()
    expect(readBoot({ [PANELS_BOOT_KEY]: { csrfToken: '' } }).csrfToken).toBeUndefined()
    expect(readBoot({ [PANELS_BOOT_KEY]: { csrfToken: 42 } }).csrfToken).toBeUndefined()
    expect(readBoot({ [PANELS_BOOT_KEY]: { csrfToken: 'tok-1' } }).csrfToken).toBe('tok-1')
  })
})

describe('client fail-fast slot probe (RSK1)', () => {
  function clientCtx(withSlot: boolean): { ctx: Record<string, unknown>; disposers: Array<() => void>; locales: string[] } {
    const disposers: Array<() => void> = []
    const locales: string[] = []
    const ctx: Record<string, unknown> = {
      effect: (fn: unknown) => {
        const disposer = typeof fn === 'function' ? (fn as () => unknown)() : undefined
        if (typeof disposer === 'function') disposers.push(disposer as () => void)
      },
      locale: { register: (ns: string) => { locales.push(ns); return () => undefined } },
      slots: {
        inject: (_name: string, cb: () => unknown) => {
          // A host with the slot fires the callback once the slot is declared.
          if (withSlot) cb()
          return () => undefined
        },
        spec: (name: string) => (withSlot ? { name } : undefined),
        register: () => () => undefined,
      },
      get: () => undefined,
    }
    return { ctx, disposers, locales }
  }

  it('registers dictionaries + the entry when the slot is declared; no banner', () => {
    vi.useFakeTimers()
    try {
      const { ctx, disposers, locales } = clientCtx(true)
      clientApply(ctx as never)
      expect(locales).toContain('dsh-cgc-panels')
      vi.advanceTimersByTime(10_000)
      expect(document.querySelector('[data-dsh-cgc-panels-version-error]')).toBeNull()
      for (const dispose of disposers) dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows a user-visible banner naming the minimum DSH version when the slot never lands', () => {
    vi.useFakeTimers()
    try {
      const { ctx, disposers } = clientCtx(false)
      clientApply(ctx as never)
      expect(document.querySelector('[data-dsh-cgc-panels-version-error]')).toBeNull()
      vi.advanceTimersByTime(10_000)
      const banner = document.querySelector('[data-dsh-cgc-panels-version-error]')
      expect(banner).not.toBeNull()
      expect(banner?.textContent).toContain(CLIENT_MIN_DSH_VERSION)
      expect(banner?.textContent).toContain('sidebar.footer.action')
      banner?.remove()
      for (const dispose of disposers) dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
