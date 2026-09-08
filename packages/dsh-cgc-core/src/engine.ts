/**
 * The CGC MCP bridge engine (KTD1): connects to the platform's /mcp endpoint
 * over Streamable HTTP with the Bearer connection token, registers the
 * server's tools as `mcp__cgc-2046__*` harness tools, and owns the
 * connection lifecycle (settings-driven rebuild, teardown on disconnect).
 *
 * Deliberately out of scope (v1): reconnect supervision (Streamable HTTP
 * retries per call against an unreachable server), tools/list_changed
 * re-sync — every connect re-lists the server's tools, so a reconnect
 * picks up platform growth by construction.
 *
 * Credential discipline: the token leaves this process only as the
 * Authorization header on /mcp requests. Error messages are redacted at the
 * bridge boundary and the header is never logged.
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { ActivityLog } from './activity.ts'
import { CGC_SERVER_NAME, type CgcErrorCode } from './protocol.ts'
import { redactText } from './redact.ts'
import { classifyBridgeError, fetchToolDefinitions, registerTools } from './tools.ts'

/** MCP client identity reported to the server (KTD1: ToolCallLog attribution). */
const CLIENT_IDENTITY = { name: 'dsh', version: '0.1.0' }

/** One connection request (both fields required to dial). */
export interface ConnectTarget {
  url: string
  token: string
}

/**
 * The bridge engine. Connect/disconnect requests are serialized on one tail
 * so settings changes can never interleave two generations.
 */
export class CgcEngine {
  /** The live generation's client; undefined while disconnected. */
  private client: Client | undefined
  /** Live tool registrations owned by this plugin. */
  private disposers = new Map<string, () => void>()
  /** Monotonic generation counter; a connect that started before a teardown is dead. */
  private generation = 0
  /** Serialization tail for sync(). */
  private syncTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly ctx: Context,
    private readonly activity: ActivityLog,
  ) {}

  /** Whether the bridge currently holds a live connection (R2's `connected`). */
  get connected(): boolean {
    return this.connectedFlag
  }

  private connectedFlag = false

  /** The currently registered public tool names (status surface / tests). */
  get toolNames(): string[] {
    return [...this.disposers.keys()]
  }

  /**
   * Drive the bridge to match the stored config: connect when url+token are
   * present, tear down otherwise. Serialized; the returned promise settles
   * when this request's generation has fully applied (connect errors are
   * already recorded into the activity ring by the failing generation — the
   * promise resolves rather than rejects).
   */
  sync(target: ConnectTarget | undefined): Promise<void> {
    const run = this.syncTail.then(() => this.applySync(target))
    // The tail must survive a failed sync; the caller owns reporting.
    this.syncTail = run.catch(() => {})
    return run
  }

  /** One serialized rebuild step. */
  private async applySync(target: ConnectTarget | undefined): Promise<void> {
    await this.teardown()
    if (target === undefined) return
    const generation = this.generation
    // The dialed token is this generation's live secret: every surfaced
    // error text is literal-stripped of it before the shape pass (RSK6).
    const secrets = [target.token]
    const client = new Client(CLIENT_IDENTITY, { capabilities: {} })
    try {
      // The SDK's StreamableHTTPClientTransport has optional callback
      // properties typed without `| undefined` (exactOptionalPropertyTypes
      // mismatch with the Transport interface); the SDK constructed the
      // object, so the cast records only that widening (mcp-client precedent).
      const transport = new StreamableHTTPClientTransport(new URL(target.url), {
        requestInit: { headers: { Authorization: `Bearer ${target.token}` } },
      }) as Transport
      await client.connect(transport)
      const definitions = await fetchToolDefinitions(client, CGC_SERVER_NAME, secrets)
      if (generation !== this.generation) {
        // Torn down mid-flight: close quietly and register nothing.
        await client.close()
        return
      }
      this.disposers = registerTools(this.ctx, definitions)
      this.client = client
      this.connectedFlag = true
    } catch (error) {
      const classified = error instanceof HarnessError
        ? error
        : classifyBridgeError(error, 'connect', secrets)
      this.activity.push({
        kind: 'error',
        at: Date.now(),
        source: 'connect',
        code: classified.code as CgcErrorCode,
        message: redactText(classified.message, secrets),
      })
      try {
        await client.close()
      } catch {
        // The transport never came up; nothing to close.
      }
    }
  }

  /**
   * Tear the bridge down: unregister the tools, close the client, clear the
   * activity ring (R9: the feed belongs to a connection generation).
   */
  async teardown(): Promise<void> {
    // Invalidate any in-flight connect before touching shared state.
    this.generation += 1
    for (const dispose of this.disposers.values()) dispose()
    this.disposers = new Map()
    this.connectedFlag = false
    const client = this.client
    this.client = undefined
    if (client !== undefined) {
      try {
        await client.close()
      } catch {
        // A half-dead transport must not wedge teardown.
      }
    }
    this.activity.clear()
  }

  /** Plugin-unload teardown (fire-and-forget safe). */
  dispose(): void {
    void this.teardown()
  }
}
