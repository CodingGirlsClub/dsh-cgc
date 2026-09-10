/**
 * Shared spec scaffolding: React act harness (React 18.3 `act` + jsdom),
 * stub api/channel/sessions factories matching the panels runtime faces.
 */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PanelsApi } from '../src/client/api.ts'
import type { EventChannel } from '../src/client/events.ts'
import type { SessionsLike } from '../src/client/session.ts'
import { PanelsController } from '../src/client/panel/controller.ts'
import type { PanelsRuntime } from '../src/client/panel/surfaceProps.ts'
import type { CgcEvent } from '../src/protocol.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** A mounted tree plus its container (panels portal into document.body). */
export interface Mounted {
  readonly container: HTMLElement
  readonly root: Root
}

/** Mount a node into a fresh container attached to document.body. */
export async function mount(node: ReactNode): Promise<Mounted> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => { root.render(node) })
  return { container, root }
}

/** Unmount and detach; safe to call twice (idempotency probe). */
export async function unmount(mounted: Mounted): Promise<void> {
  await act(async () => { mounted.root.unmount() })
  mounted.container.remove()
}

/** Drain pending promise/microtask cascades inside act. */
export async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => { await Promise.resolve() })
  }
}

/** Click an element inside act and drain the resulting updates. */
export async function click(target: Element): Promise<void> {
  await act(async () => {
    ;(target as HTMLElement).click()
    await Promise.resolve()
  })
  await settle(3)
}

/** Drive a React-controlled input/textarea via the native setter + input event. */
export async function setControlValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): Promise<void> {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  if (setter === undefined) throw new Error('native value setter missing')
  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
    await Promise.resolve()
  })
  await settle(3)
}

/** Press Escape at the document level (the shell listens there). */
export async function pressEscape(): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await Promise.resolve()
  })
  await settle(2)
}

/** Query helper with a failure message naming the selector. */
export function mustQuery<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector)
  if (el === null) throw new Error(`expected element not found: ${selector}`)
  return el
}

/** A controllable EventChannel stand-in (onEvent/onGap subscription shape). */
export function stubChannel(): {
  channel: EventChannel
  emit: (event: CgcEvent) => void
  emitGap: () => void
  listenerCount: () => number
} {
  const eventFns = new Set<(event: CgcEvent) => void>()
  const gapFns = new Set<() => void>()
  const channel = {
    onEvent(fn: (event: CgcEvent) => void): () => void {
      eventFns.add(fn)
      return () => { eventFns.delete(fn) }
    },
    onGap(fn: () => void): () => void {
      gapFns.add(fn)
      return () => { gapFns.delete(fn) }
    },
  } as unknown as EventChannel
  return {
    channel,
    emit: (event) => { for (const fn of [...eventFns]) fn(event) },
    emitGap: () => { for (const fn of [...gapFns]) fn() },
    listenerCount: () => eventFns.size + gapFns.size,
  }
}

/** Sessions face with a current session on the given preset. */
export function stubSessions(preset: string): SessionsLike {
  return {
    list: {
      getSnapshot: () => ({ current: 's1', byId: { s1: { projectionValues: { agentPreset: preset } } } }),
    },
  } as unknown as SessionsLike
}

/** Sessions face with no current session open. */
export const NO_SESSION: SessionsLike = {
  list: { getSnapshot: () => ({ current: undefined, byId: {} }) },
} as unknown as SessionsLike

/** Disconnected status payload (legacy /status shape). */
export const DISCONNECTED_STATUS = {
  configured: false,
  connected: false,
  url: '',
  web_url: '',
  token_configured: false,
  activity: [],
}

/** Stub api defaults: every route resolves an empty payload. */
export function stubApi(overrides: Record<string, unknown> = {}): PanelsApi {
  const base: Record<string, unknown> = {
    canWrite: true,
    status: async () => DISCONNECTED_STATUS,
    connect: async () => ({ ...DISCONNECTED_STATUS, configured: true, connected: true }),
    disconnect: async () => DISCONNECTED_STATUS,
    activity: async () => [],
    events: async () => ({ gap: false, events: [], latestSeq: 0 }),
    myWorkspaces: async () => ({ workspaces: [] }),
    myEnrollments: async () => ({ enrollments: [] }),
    tasks: async () => ({ tasks: [] }),
    learningState: async () => ({}),
    courseContent: async () => ({}),
    coursePrep: async () => ({}),
    courseRevision: async () => ({ revision: 1 }),
    saveCourseContent: async () => ({}),
    discover: async () => ({ offerings: [] }),
    enrollmentSummary: async () => ({}),
    createEnrollment: async () => ({}),
    orderStatus: async () => ({ status: 'paid' }),
    workspaceCourses: async () => ({ courses: [] }),
    workspaceEvents: async () => ({ events: [] }),
    workspaceOrders: async () => ({ orders: [] }),
    workspaceEnrollments: async () => ({ enrollments: [] }),
    ...overrides,
  }
  return base as unknown as PanelsApi
}

/** A full panels runtime wired from stubs. */
export function stubRuntime(options: {
  api?: PanelsApi
  channel?: EventChannel
  sessions?: SessionsLike | undefined
  opened?: string[]
} = {}): { runtime: PanelsRuntime; controller: PanelsController; opened: string[] } {
  const controller = new PanelsController()
  const opened = options.opened ?? []
  const runtime: PanelsRuntime = {
    controller,
    api: options.api ?? stubApi(),
    events: options.channel ?? stubChannel().channel,
    sessions: options.sessions,
    openExternal: (url) => { opened.push(url) },
  }
  return { runtime, controller, opened }
}
