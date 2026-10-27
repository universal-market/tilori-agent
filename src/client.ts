import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { subscriptionMatches } from './config.ts';
import { redact } from './keys.ts';
import type { AgentDelivery, AgentSubscription, SubscriptionSpec } from './types.ts';

export const MAX_POLL_WAIT_MS = 25_000;
const VERSION = '0.1.3';

/** The router only ever calls these tools; all need just tilori:read. */
export const READ_TOOLS = [
  'list_agent_subscriptions',
  'subscribe_to_events',
  'poll_events',
  'acknowledge_events',
] as const;
export type ReadTool = (typeof READ_TOOLS)[number];

export interface McpToolCaller {
  callTool(
    params: { name: string; arguments: Record<string, unknown> },
    resultSchema?: unknown,
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<unknown>;
  close?(): Promise<void>;
}

export interface TiloriClientOptions {
  url: URL;
  apiKey: string;
  fetch?: typeof fetch;
  /** Test seam: a pre-connected tool caller. */
  mcpClient?: McpToolCaller;
  logger?: (message: string) => void;
}

function unwrap(raw: any, secret: string): any {
  if (!raw || typeof raw !== 'object') throw new Error('Empty response from Tilori MCP server.');
  if (raw.isError) {
    let message = 'Tilori MCP tool call failed.';
    const err = raw.structuredContent?.error;
    if (typeof err?.message === 'string') message = err.message;
    else if (Array.isArray(raw.content)) {
      const text = raw.content.find((c: any) => c?.type === 'text')?.text;
      if (typeof text === 'string') {
        try {
          const parsed = JSON.parse(text);
          message = typeof parsed?.message === 'string' ? parsed.message : text;
        } catch {
          message = text;
        }
      }
    }
    throw new Error(redact(message, [secret]));
  }
  if (raw.structuredContent !== undefined) {
    const sc = raw.structuredContent;
    return sc && typeof sc === 'object' && 'result' in sc ? sc.result : sc;
  }
  if (Array.isArray(raw.content)) {
    const text = raw.content.find((c: any) => c?.type === 'text')?.text;
    if (typeof text === 'string') return JSON.parse(text);
  }
  return raw;
}

/** A Tilori MCP client for one agent key, restricted to the event tools. */
export class TiloriAgentClient {
  readonly endpoint: URL;
  readonly #apiKey: string;
  readonly #fetch?: typeof fetch;
  #mcp: McpToolCaller | null;
  #transport: StreamableHTTPClientTransport | null = null;
  readonly log: (message: string) => void;

  constructor(options: TiloriClientOptions) {
    if (!options.apiKey) throw new Error('A Tilori agent key is required.');
    this.endpoint = options.url;
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch;
    this.#mcp = options.mcpClient ?? null;
    const logger = options.logger;
    this.log = (m) => logger?.(redact(m, [this.#apiKey]));
  }

  toJSON() {
    return { endpoint: this.endpoint.href, apiKey: '[REDACTED]' };
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return `TiloriAgentClient(${this.endpoint.href}, apiKey=[REDACTED])`;
  }

  #clean(cause: unknown): Error {
    const msg = cause instanceof Error ? cause.message : String(cause ?? 'Unknown error');
    return new Error(redact(msg, [this.#apiKey]));
  }

  #connecting: Promise<void> | null = null;

  /** Connects once; concurrent callers (one long-poll per subscription) share
   * the same in-flight connection attempt. */
  connect(): Promise<void> {
    if (this.#mcp) return Promise.resolve();
    this.#connecting ??= this.#doConnect().finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  async #doConnect(): Promise<void> {
    try {
      const client = new Client({ name: 'tilori-agent', version: VERSION });
      const transport = new StreamableHTTPClientTransport(this.endpoint, {
        fetch: this.#fetch,
        requestInit: { headers: { Authorization: `Bearer ${this.#apiKey}` } },
      });
      await client.connect(transport);
      this.#mcp = client;
      this.#transport = transport;
    } catch (cause) {
      throw this.#clean(cause);
    }
  }

  async close(): Promise<void> {
    try {
      await this.#transport?.terminateSession().catch(() => {});
      await this.#mcp?.close?.();
    } catch {
      // closing is best effort
    } finally {
      this.#mcp = null;
      this.#transport = null;
    }
  }

  async call<T = any>(
    name: ReadTool,
    args: Record<string, unknown> = {},
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<T> {
    if (!(READ_TOOLS as readonly string[]).includes(name)) {
      throw new Error(`tilori-agent never calls ${name}.`);
    }
    await this.connect();
    let raw: unknown;
    try {
      raw = await this.#mcp!.callTool({ name, arguments: args }, undefined, {
        signal: options?.signal,
        timeout: options?.timeout ?? 35_000,
      });
    } catch (cause) {
      // Transport failure: drop the session so the next call reconnects.
      if (this.#transport) await this.close();
      throw this.#clean(cause);
    }
    return unwrap(raw, this.#apiKey) as T;
  }

  async listSubscriptions(signal?: AbortSignal): Promise<AgentSubscription[]> {
    const res = await this.call<{ subscriptions: AgentSubscription[] }>('list_agent_subscriptions', {}, { signal });
    return res?.subscriptions ?? [];
  }

  async subscribe(spec: SubscriptionSpec, signal?: AbortSignal): Promise<AgentSubscription> {
    const args: Record<string, unknown> = { scope: spec.scope, exclude_self: spec.exclude_self ?? true };
    if (spec.filter) args.filter = spec.filter;
    const res = await this.call<{ subscription: AgentSubscription }>('subscribe_to_events', args, { signal });
    return res.subscription;
  }

  /** Ensures each desired subscription exists, renewing ones that expire
   * within `renewWithinMs`. A spec the agent may not hold (for example
   * direct_messages without tilori:messages) is logged and skipped. Returns
   * only the subscriptions matching `desired`. */
  async ensureSubscriptions(
    desired: SubscriptionSpec[],
    options: { signal?: AbortSignal; renewWithinMs?: number; log?: (m: string) => void } = {},
  ): Promise<AgentSubscription[]> {
    const existing = await this.listSubscriptions(options.signal);
    const renewBy = Date.now() + (options.renewWithinMs ?? 24 * 3600_000);
    const out: AgentSubscription[] = [];
    for (const spec of desired) {
      const found = existing.find((s) => subscriptionMatches(s, spec) && Date.parse(s.expires_at) > renewBy);
      if (found) {
        out.push(found);
        continue;
      }
      try {
        out.push(await this.subscribe(spec, options.signal));
      } catch (cause) {
        (options.log ?? this.log)(`Skipping ${spec.scope.type} subscription: ${this.#clean(cause).message}`);
      }
    }
    return out;
  }

  async poll(subscriptionId: string, waitMs = 0, signal?: AbortSignal): Promise<AgentDelivery | null> {
    const wait = Math.min(Math.max(0, Math.floor(waitMs)), MAX_POLL_WAIT_MS);
    const res = await this.call<{ delivery: AgentDelivery | null }>(
      'poll_events',
      { subscription_id: subscriptionId, wait_ms: wait },
      { signal, timeout: wait + 15_000 },
    );
    return res?.delivery ?? null;
  }

  async acknowledge(subscriptionId: string, deliveryId: string, signal?: AbortSignal): Promise<void> {
    await this.call('acknowledge_events', { subscription_id: subscriptionId, delivery_id: deliveryId }, { signal });
  }
}
