/**
 * Connection config store: the `dsh-cgc-core` settings section
 * (`~/.dsh/settings.yaml`, 0600 atomic writes owned by the settings
 * service). The token field is declared `role('secret')` so every DSH
 * settings wire surface (settings UI, api proxy describe) strips it —
 * the section never hands the token back out (KTD2).
 *
 * Reads ride the resolved settings scope (`settings.register` feeds the
 * source thunk); writes go through the provider's path-addressed `mutate`
 * so a caller holding a redacted view never has to restate the secret.
 */

import z from '@deepseek-ai/schemastery'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'

/** Plugin cordis-row config / user-section input shape (all fields optional). */
export interface Config {
  /** Master switch for the plugin (routes, prompt section, bridge). */
  enabled?: boolean
  /** When true (default), a system-prompt section announces the plugin. */
  announceToAgent?: boolean
  /** MCP endpoint URL. */
  url?: string
  /** Site origin shown in the panel's website links ('' = derive from url's origin). */
  web_url?: string
  /** Connection token (role('secret') — wire-stripped). */
  token?: string
}

/** Section schema; also the plugin's cordis-row config schema. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  announceToAgent: z.boolean().default(true),
  url: z.string().default(''),
  web_url: z.string().default(''),
  token: z.string().role('secret').default(''),
})

/** The resolved section: every default applied. */
export interface ConnectionConfig {
  enabled: boolean
  announceToAgent: boolean
  /** MCP endpoint URL ('' = not configured). */
  url: string
  /** Site origin for the panel's website links ('' = derive from url's origin). */
  web_url: string
  /** Connection token ('' = not configured; never leaves the host). */
  token: string
}

/** Loopback hostnames allowed to use plain http (R1). */
const LOOPBACK_HOSTS: Record<string, true> = { 'localhost': true, '127.0.0.1': true, '[::1]': true, '::1': true }

/**
 * Validate an MCP endpoint URL; returns a human reason, or undefined when
 * usable. Rules (R1): http(s) only, no embedded credentials (userinfo),
 * non-loopback must be https, loopback may be http.
 */
export function validateMcpUrl(raw: string): string | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'url is not a valid URL'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'url scheme must be http or https'
  if (url.username !== '' || url.password !== '') return 'url must not embed credentials'
  if (LOOPBACK_HOSTS[url.hostname] !== true && url.protocol !== 'https:') {
    return 'non-loopback url must use https'
  }
  return undefined
}

/**
 * The connection store. Holds the live source thunk (fed by the settings
 * section hooks) and the provider's mutate while the service is attached;
 * pure coordination, unit-testable with fakes.
 */
export class ConnectionStore {
  /** Raw section thunk; the composition entry until a scope attaches. */
  private current: () => Config

  /** Composition-entry section, read while no settings scope is attached. */
  private readonly fallback: Config

  /**
   * Path-addressed writer into the settings provider; undefined while no
   * settings service is mounted (writes then fail loud, never silently).
   */
  private writer: ((ops: readonly SettingsPathOp[]) => Promise<void>) | undefined

  constructor(entry?: Config) {
    this.fallback = { ...entry }
    this.current = () => this.fallback
  }

  /** Hooks-facing: point reads at the resolved settings scope (or back at the entry). */
  setSource(source: () => Config): void {
    this.current = source
  }

  /** Hooks-facing teardown: point reads back at the composition entry. */
  resetSource(): void {
    this.current = () => this.fallback
  }

  /** Capture (or drop) the provider's path-mutation writer. */
  setWriter(writer: ((ops: readonly SettingsPathOp[]) => Promise<void>) | undefined): void {
    this.writer = writer
  }

  /** The section with every default applied. */
  get(): ConnectionConfig {
    const value = this.current()
    return {
      enabled: value.enabled ?? true,
      announceToAgent: value.announceToAgent ?? true,
      url: value.url ?? '',
      web_url: value.web_url ?? '',
      token: value.token ?? '',
    }
  }

  /** Local config exists (url + token both stored) — R2's `configured`. */
  configured(): boolean {
    const { url, token } = this.current()
    return url !== '' && token !== ''
  }

  /**
   * Store a connection: set url and/or token, applying the R1 invalidation
   * rule — changing the stored URL without re-submitting the token in the
   * same request drops the stored token (no token forwarding to a new
   * endpoint). One atomic mutate carries the whole edit. `web_url` rides
   * along as a plain field; '' restores origin derivation.
   */
  async connect(payload: { url?: string; web_url?: string; token?: string }): Promise<void> {
    const ops: SettingsPathOp[] = []
    const stored = this.current()
    if (payload.url !== undefined) {
      ops.push({ op: 'set', path: ['url'], value: payload.url })
      if (payload.token === undefined && stored.url !== '' && payload.url !== stored.url && stored.token !== '') {
        ops.push({ op: 'unset', path: ['token'] })
      }
    }
    if (payload.token !== undefined) ops.push({ op: 'set', path: ['token'], value: payload.token })
    if (payload.web_url !== undefined) ops.push({ op: 'set', path: ['web_url'], value: payload.web_url })
    if (ops.length === 0) return
    await this.write(ops)
  }

  /** Remove the connection config (url + web_url + token); other keys untouched. */
  async disconnect(): Promise<void> {
    const stored = this.current()
    if (stored.url === '' && stored.token === '' && (stored.web_url ?? '') === '') return
    await this.write([
      { op: 'unset', path: ['url'] },
      { op: 'unset', path: ['web_url'] },
      { op: 'unset', path: ['token'] },
    ])
  }

  /** Apply ops through the provider, or reject when writes are impossible. */
  private async write(ops: readonly SettingsPathOp[]): Promise<void> {
    if (this.writer === undefined) {
      throw new Error('settings service unavailable: cannot persist the connection')
    }
    await this.writer(ops)
  }
}
