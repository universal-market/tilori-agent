import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { subscriptionMatches } from './config.ts';
import { redact } from './keys.ts';
import { VERSION } from './version.ts';
import { TOOLS_HASH } from './wake.ts';
import type { AgentDelivery, AgentSubscription, PollError, SubscriptionSpec } from './types.ts';

export const MAX_POLL_WAIT_MS = 25_000;
/** Most subscriptions one multiplexed poll_events call may list. */
export const MAX_POLL_SUBSCRIPTIONS = 8;
/** Upper bound on a server-suggested pause, so a bad value cannot stall us. */
export const MAX_RETRY_AFTER_MS = 60_000;

/** The server does not accept `subscription_ids` (a deployment from before
 * UNI-380); poll each subscription separately instead. */
export class MultiPollUnsupported extends Error {
  constructor() {
    super('poll_events does not accept subscription_ids on this server.');
    this.name = 'MultiPollUnsupported';
  }
}

export interface PollResult {
  delivery: AgentDelivery | null;
  /** Set when the server could not hold the long poll (over its waiter budget). */
  retryAfterMs?: number;
}

export interface MultiPollResult {
  deliveries: AgentDelivery[];
  errors: PollError[];
  retryAfterMs?: number;
}

function retryAfter(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0
    ? Math.min(Math.ceil(raw), MAX_RETRY_AFTER_MS)
    : undefined;
}

/** An old server refusing the new argument names it in an input-validation
 * message; a refusal about the subscription itself does not. */
function rejectsMultiPoll(message: string): boolean {
  return (
    /subscription_ids?/i.test(message) &&
    /invalid|unrecognized|unexpected|unknown key|required|expected/i.test(message) &&
    !/unavailable|expired|disabled|not found/i.test(message)
  );
}

/** The router only ever calls these tools; all need just tilori:read. */
export const READ_TOOLS = [
  'list_agent_subscriptions',
  'subscribe_to_events',
  'poll_events',
  'acknowledge_events',
  'get_my_profile',
] as const;
export type ReadTool = (typeof READ_TOOLS)[number];

export interface PostsLeft {
  remaining: number;
  /** Epoch ms, or null before the account's first post opens the window. */
  resetsAt: number | null;
}

/** What a wake may use from get_my_profile. Either part is null when the
 * server doesn't report it. */
export interface ProfileNotes {
  postsLeft: PostsLeft | null;
  /** The hash of the tool definitions this connection lists: 16 hex only. */
  toolsHash: string | null;
}

/** Called only through `unsubscribe` (`ensure --prune --yes`), never
 * through `call`, so the router and `watch` cannot reach it. */
export const PRUNE_TOOL = 'unsubscribe_from_events';

/** Called only through `getPost` (the `get-post` subcommand), never through
 * `call`, so the router and `watch` cannot reach it. */
export const POST_TOOL = 'get_post';

/** The server answered the tool call with an error (not found, a missing
 * scope, a refusal), as opposed to a transport failure. */
export class ToolRefused extends Error {}

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

/** The server's instance access gate refuses every agent whose owner is not
 * currently admitted, with one generic message. Say what the owner can do.
 * Matches the server's exact text (`ACCESS_DENIED` in universal_market
 * backend/convex/access.ts); if that wording changes, the hint stops showing. */
const ACCESS_GATE = 'Access is restricted on this instance';
export const ACCESS_HINT =
  "Tilori refused this agent because its owner's account is not currently admitted on this instance " +
  "(for example, the GitHub org membership check lapsed). The key itself may be fine: ask the owner to " +
  'sign in to the Tilori site again, then retry.';

export function explainAccess(message: string): string {
  return message.includes(ACCESS_GATE) && !message.includes(ACCESS_HINT) ? `${message} ${ACCESS_HINT}` : message;
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
    throw new ToolRefused(explainAccess(redact(message, [secret])));
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
    return new Error(explainAccess(redact(msg, [this.#apiKey])));
  }

  #connecting: Promise<void> | null = null;

  /** Connects once; concurrent callers (the long poll and acknowledgements) share
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
      const base = this.#fetch ?? fetch;
      const transport = new StreamableHTTPClientTransport(this.endpoint, {
        // The SDK opens a GET push stream after initialize. On Convex that
        // stream holds an HTTP-action slot and one of the account's 4
        // streams, and the router never reads it, so answer it locally
        // with 405 ("no stream offered"), which the SDK accepts quietly.
        // Redirects are refused, so a redirect can't carry the key to a URL
        // other than the configured one.
        fetch: ((input: any, init?: RequestInit) =>
          (init?.method ?? 'GET').toUpperCase() === 'GET'
            ? Promise.resolve(new Response(null, { status: 405 }))
            : base(input, { ...init, redirect: 'error' })) as typeof fetch,
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
    // An injected caller (tests) has no session of ours to end.
    if (!this.#transport) return;
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
    return this.#invoke<T>(name, args, options);
  }

  async #invoke<T>(
    name: ReadTool | typeof PRUNE_TOOL | typeof POST_TOOL,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<T> {
    await this.connect();
    let raw: unknown;
    try {
      raw = await this.#mcp!.callTool({ name, arguments: args }, undefined, {
        signal: options?.signal,
        timeout: options?.timeout ?? 35_000,
      });
    } catch (cause) {
      // Transport failure: drop the session so the next call reconnects. A
      // call the caller cancelled is not a failure; other calls keep the session.
      if (this.#transport && !options?.signal?.aborted) await this.close();
      throw this.#clean(cause);
    }
    return unwrap(raw, this.#apiKey) as T;
  }

  /** What is left of the account's daily post limit and the hash of the
   * listed tools, from get_my_profile (which spends no budget). */
  async profileNotes(signal?: AbortSignal): Promise<ProfileNotes> {
    const res = await this.call<any>('get_my_profile', {}, { signal, timeout: 5_000 });
    const hash = res?.tools_hash;
    const toolsHash = typeof hash === 'string' && TOOLS_HASH.test(hash) ? hash : null;
    const remaining = res?.posts_remaining_today;
    if (!Number.isInteger(remaining) || remaining < 0) return { postsLeft: null, toolsHash };
    const at = typeof res.resets_at === 'string' ? Date.parse(res.resets_at) : NaN;
    return { postsLeft: { remaining, resetsAt: Number.isFinite(at) ? at : null }, toolsHash };
  }

  async listSubscriptions(signal?: AbortSignal): Promise<AgentSubscription[]> {
    const res = await this.call<{ subscriptions: AgentSubscription[] }>('list_agent_subscriptions', {}, { signal });
    return res?.subscriptions ?? [];
  }

  /** This agent's subscriptions that match none of `desired`: left over from
   * an older config, or made by a session with subscribe_to_events. Nothing
   * polls them, so they only hold slots and a backlog until they expire.
   * The server lists only the calling agent key's own subscriptions. */
  async unmanagedSubscriptions(desired: SubscriptionSpec[], signal?: AbortSignal): Promise<AgentSubscription[]> {
    const existing = await this.listSubscriptions(signal);
    return existing.filter((s) => !desired.some((d) => subscriptionMatches(s, d)));
  }

  /** One post as `get_post` returns it. Read-only. */
  async getPost(postId: string, options?: { signal?: AbortSignal; timeout?: number }): Promise<any> {
    return this.#invoke(POST_TOOL, { post_id: postId }, options);
  }

  async unsubscribe(subscriptionId: string, signal?: AbortSignal): Promise<void> {
    await this.#invoke(PRUNE_TOOL, { subscription_id: subscriptionId }, { signal });
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
    options: {
      signal?: AbortSignal;
      renewWithinMs?: number;
      /** Subscription ids to subscribe again even if they look live. */
      renewIds?: ReadonlySet<string>;
      log?: (m: string) => void;
    } = {},
  ): Promise<AgentSubscription[]> {
    const existing = await this.listSubscriptions(options.signal);
    const renewBy = Date.now() + (options.renewWithinMs ?? 24 * 3600_000);
    const out: AgentSubscription[] = [];
    for (const spec of desired) {
      const found = existing.find(
        (s) => subscriptionMatches(s, spec) && Date.parse(s.expires_at) > renewBy && !options.renewIds?.has(s.id),
      );
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
    return (await this.pollOne(subscriptionId, waitMs, signal)).delivery;
  }

  /** Single-id poll_events, with the server's `retry_after_ms`. */
  async pollOne(subscriptionId: string, waitMs = 0, signal?: AbortSignal): Promise<PollResult> {
    const wait = Math.min(Math.max(0, Math.floor(waitMs)), MAX_POLL_WAIT_MS);
    const res = await this.call<{ delivery?: AgentDelivery | null; retry_after_ms?: unknown }>(
      'poll_events',
      { subscription_id: subscriptionId, wait_ms: wait },
      { signal, timeout: wait + 15_000 },
    );
    return { delivery: res?.delivery ?? null, retryAfterMs: retryAfter(res?.retry_after_ms) };
  }

  /** One poll_events call over several of the agent's subscriptions (UNI-380).
   * Throws MultiPollUnsupported when the server predates `subscription_ids`. */
  async pollMany(subscriptionIds: string[], waitMs = 0, signal?: AbortSignal): Promise<MultiPollResult> {
    const ids = [...new Set(subscriptionIds)];
    if (ids.length < 1 || ids.length > MAX_POLL_SUBSCRIPTIONS) {
      throw new Error(`pollMany takes 1-${MAX_POLL_SUBSCRIPTIONS} subscription ids.`);
    }
    const wait = Math.min(Math.max(0, Math.floor(waitMs)), MAX_POLL_WAIT_MS);
    let res: any;
    try {
      res = await this.call('poll_events', { subscription_ids: ids, wait_ms: wait }, { signal, timeout: wait + 15_000 });
    } catch (cause) {
      if (!signal?.aborted && rejectsMultiPoll(cause instanceof Error ? cause.message : String(cause))) {
        throw new MultiPollUnsupported();
      }
      throw cause;
    }
    // A server that ignored the field answers in the single-id shape.
    if (!res || typeof res !== 'object' || !Array.isArray(res.deliveries)) throw new MultiPollUnsupported();
    const listed = new Set(ids);
    const deliveries = (res.deliveries as AgentDelivery[]).filter((d) => listed.has(d?.subscription_id));
    const errors: PollError[] = Array.isArray(res.errors)
      ? res.errors
          .filter((e: any) => typeof e?.subscription_id === 'string' && listed.has(e.subscription_id))
          .map((e: any) => ({
            subscription_id: e.subscription_id,
            // Codes are server constants; anything else is collapsed so logs never carry free text.
            error_code: typeof e.error_code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(e.error_code) ? e.error_code : 'ERROR',
          }))
      : [];
    return { deliveries, errors, retryAfterMs: retryAfter(res.retry_after_ms) };
  }

  async acknowledge(subscriptionId: string, deliveryId: string, signal?: AbortSignal): Promise<void> {
    await this.call('acknowledge_events', { subscription_id: subscriptionId, delivery_id: deliveryId }, { signal });
  }
}
