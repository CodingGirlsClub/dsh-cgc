/**
 * Store tests: settings-backed persistence, role('secret') wire stripping,
 * URL validation, and the R1 URL-change token invalidation.
 */

import { describe, expect, it } from 'vitest'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { ConnectionStore, validateMcpUrl } from '../src/store.ts'
import { Config } from '../src/store.ts'
import { mountSettings } from './helpers.ts'

const NS = settingsNamespace('dsh-cgc-core')

/** A store wired to a real (in-memory) settings provider, like index.ts does. */
async function setup(doc?: Record<string, unknown>) {
  const { ctx, provider } = await mountSettings(doc)
  const store = new ConnectionStore()
  installSettingsSection(ctx, NS, Config, {}, {
    setSource: (source) => { store.setSource(source) },
    onChange: () => {},
  })
  store.setWriter(ops => provider.mutate(NS, ops))
  return { ctx, provider, store }
}

describe('ConnectionStore', () => {
  it('starts unconfigured with defaults', async () => {
    const { store } = await setup()
    expect(store.configured()).toBe(false)
    expect(store.get()).toEqual({ enabled: true, announceToAgent: true, url: '', token: '' })
  })

  it('connect persists url+token and reports configured', async () => {
    const { store, provider } = await setup()
    await store.connect({ url: 'http://localhost:4102/mcp', token: 'cgc_test-token' })
    expect(store.get().url).toBe('http://localhost:4102/mcp')
    expect(store.get().token).toBe('cgc_test-token')
    expect(store.configured()).toBe(true)
    expect(provider.doc['dsh-cgc-core']).toEqual({ url: 'http://localhost:4102/mcp', token: 'cgc_test-token' })
  })

  it('strips the token from redacted wire describes only', async () => {
    const { store, provider } = await setup()
    await store.connect({ url: 'http://localhost:4102/mcp', token: 'cgc_test-token' })
    // Bare describe returns secrets verbatim — this is why no route/panel
    // surface of this plugin ever calls describe() on the section.
    const bare = provider.describe().find(d => String(d.ns) === 'dsh-cgc-core')
    expect((bare?.value as Record<string, unknown>)['token']).toBe('cgc_test-token')
    const redacted = provider.describe({ redactSecrets: true }).find(d => String(d.ns) === 'dsh-cgc-core')
    const value = redacted?.value as Record<string, unknown>
    expect('token' in value).toBe(false)
    expect(value['url']).toBe('http://localhost:4102/mcp')
    expect(redacted?.secrets).toContainEqual({ path: ['token'], set: true })
  })

  it('invalidates the stored token when the URL changes without a token re-submit (R1)', async () => {
    const { store } = await setup()
    await store.connect({ url: 'http://localhost:4102/mcp', token: 'cgc_test-token' })
    await store.connect({ url: 'https://cgc.example.com/mcp' })
    expect(store.get().url).toBe('https://cgc.example.com/mcp')
    expect(store.get().token).toBe('')
    expect(store.configured()).toBe(false)
  })

  it('keeps the token when the URL is re-submitted unchanged or with a new token', async () => {
    const { store } = await setup()
    await store.connect({ url: 'http://localhost:4102/mcp', token: 'cgc_test-token' })
    await store.connect({ url: 'http://localhost:4102/mcp' })
    expect(store.get().token).toBe('cgc_test-token')
    await store.connect({ url: 'https://cgc.example.com/mcp', token: 'cgc_new-token' })
    expect(store.get().token).toBe('cgc_new-token')
    expect(store.configured()).toBe(true)
  })

  it('token-only writes keep the stored url', async () => {
    const { store } = await setup()
    await store.connect({ url: 'http://localhost:4102/mcp', token: 'cgc_test-token' })
    await store.connect({ token: 'cgc_rotated' })
    expect(store.get()).toMatchObject({ url: 'http://localhost:4102/mcp', token: 'cgc_rotated' })
  })

  it('disconnect clears url+token and nothing else', async () => {
    const { store, provider } = await setup({ 'dsh-cgc-core': { enabled: false } })
    await store.connect({ url: 'http://localhost:4102/mcp', token: 'cgc_test-token' })
    await store.disconnect()
    expect(store.configured()).toBe(false)
    expect(store.get().url).toBe('')
    expect(store.get().token).toBe('')
    // The user-layer enabled override survives the disconnect.
    expect(provider.doc['dsh-cgc-core']).toEqual({ enabled: false })
  })

  it('writes fail loud without a settings provider', async () => {
    const store = new ConnectionStore()
    await expect(store.connect({ url: 'http://localhost:4102/mcp' })).rejects.toThrow('settings service unavailable')
  })
})

describe('validateMcpUrl', () => {
  it('accepts loopback http and any https', () => {
    expect(validateMcpUrl('http://localhost:4102/mcp')).toBeUndefined()
    expect(validateMcpUrl('http://127.0.0.1:4102/mcp')).toBeUndefined()
    expect(validateMcpUrl('http://[::1]:4102/mcp')).toBeUndefined()
    expect(validateMcpUrl('https://cgc.example.com/mcp')).toBeUndefined()
  })

  it('rejects non-loopback http', () => {
    expect(validateMcpUrl('http://cgc.example.com/mcp')).toMatch('https')
  })

  it('rejects embedded credentials and non-http(s) schemes', () => {
    expect(validateMcpUrl('https://user:pass@cgc.example.com/mcp')).toMatch('credentials')
    expect(validateMcpUrl('ftp://localhost/x')).toMatch('scheme')
    expect(validateMcpUrl('not a url')).toBeDefined()
  })
})
