import { randomUUID } from 'node:crypto';
import { TiloriAgentClient, type McpToolCaller } from '../src/client.ts';
import { normalizeFilter, normalizeScope } from '../src/config.ts';
import type { AgentDelivery, AgentSubscription, DeliveredEvent } from '../src/types.ts';

/** In-memory stand-in for one agent's Tilori event tools. Like the real
 * server, poll_events re-serves the same batch until it is acknowledged. */
export class FakeTilori implements McpToolCaller {
  subs: AgentSubscription[] = [];
  queues = new Map<string, DeliveredEvent[][]>();
  outstanding = new Map<string, AgentDelivery>();
  calls: string[] = [];
  unsubscribed: string[] = [];
  failUnsubscribe = new Set<string>();
  acks: string[] = [];
  failNextPolls = 0;
  /** While true, every call fails as Tilori's 401 for a refused key does
   * (UNI-761). */
  refuseKey = false;
  failAcks = 0;
  refuse = new Set<string>();
  /** Behave like a server from before UNI-380: refuse subscription_ids. */
  legacy = false;
  /** poll_events argument shapes seen, for assertions. */
  polls: Array<{ ids: string[]; multi: boolean }> = [];
  /** Each poll_events call's wait_ms, in order. */
  waits: number[] = [];
  /** Per-subscription refusals reported in a multiplexed poll's `errors`. */
  failingSubs = new Map<string, string>();
  /** Like failingSubs, but cleared when the subscription is renewed. */
  failOnce = new Map<string, string>();
  /** Ids of subscriptions renewed by subscribe_to_events. */
  renewals: string[] = [];
  /** Start times of multiplexed polls. */
  pollTimes: number[] = [];
  /** Next N waiting polls return at once with retry_after_ms. */
  overBudget = 0;
  retryAfterMs = 50;
  /** When each over-budget answer was given. */
  overBudgetAt: number[] = [];
  overBudgetIds: string[] = [];
  /** Polls currently waiting server-side, and the most seen at once. */
  waiting = 0;
  maxWaiting = 0;
  /** get_my_profile's result; unset behaves like a server without the tool. */
  profile: unknown = undefined;
  /** get_my_profile waits until the caller aborts it. */
  profileHangs = false;
  /** Posts get_post can return, by id; any other id is NOT_FOUND. */
  posts = new Map<string, unknown>();
  /** search_posts pages, served in order by cursor ("" is the first page). */
  searchPages = new Map<string, { items: unknown[]; next_cursor: string | null }>();
  /** The arguments of each search_posts call. */
  searches: Record<string, unknown>[] = [];
  /** get_post waits until the caller aborts it. */
  postHangs = false;
  /** search_posts waits until the caller aborts it. */
  searchHangs = false;

  /** Subscriptions whose next batch is marked resync_required. */
  resyncNext = new Set<string>();

  push(scopeType: string, events: DeliveredEvent[], opts: { resync?: boolean } = {}) {
    const sub = this.subs.find((s) => s.scope.type === scopeType);
    if (!sub) throw new Error(`no ${scopeType} subscription`);
    const q = this.queues.get(sub.id) ?? [];
    q.push(events);
    this.queues.set(sub.id, q);
    if (opts.resync) this.resyncNext.add(sub.id);
  }

  async callTool(
    params: { name: string; arguments: Record<string, unknown> },
    _schema?: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<unknown> {
    const { name, arguments: a } = params;
    this.calls.push(name);
    if (this.refuseKey)
      throw Object.assign(new Error('Streamable HTTP error: Error POSTing to endpoint: {"error":"invalid_token"}'), { code: 401 });
    const ok = (result: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { result } });
    const err = (message: string) => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ message }) }] });
    switch (name) {
      case 'list_agent_subscriptions':
        return ok({ subscriptions: this.subs });
      case 'get_my_profile':
        if (this.profileHangs)
          await new Promise((_, reject) => {
            if (options?.signal?.aborted) return reject(new Error('aborted'));
            options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        if (this.profile === undefined) return err('unexpected tool get_my_profile');
        return ok(this.profile);
      case 'search_posts': {
        this.searches.push(a);
        if (this.searchHangs)
          await new Promise((_, reject) => {
            if (options?.signal?.aborted) return reject(new Error('aborted'));
            options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        const page = this.searchPages.get(String(a.cursor ?? ''));
        return page === undefined ? err('Invalid cursor') : ok(page);
      }
      case 'get_post': {
        if (this.postHangs)
          await new Promise((_, reject) => {
            if (options?.signal?.aborted) return reject(new Error('aborted'));
            options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        const post = this.posts.get(String(a.post_id));
        return post === undefined ? err('Post unavailable') : ok(post);
      }
      case 'subscribe_to_events': {
        const scope = normalizeScope(a.scope as any);
        if (this.refuse.has(scope.type)) return err(`Missing scope for ${scope.type}`);
        const exclude_self = (a.exclude_self as boolean) ?? true;
        const filter = normalizeFilter(a.filter as any);
        // Like the server, the same scope, exclude_self and filter renew one subscription.
        const same = this.subs.find(
          (s) => JSON.stringify([s.scope, s.exclude_self, s.filter]) === JSON.stringify([scope, exclude_self, filter]),
        );
        if (same) {
          this.renewals.push(same.id);
          this.failOnce.delete(same.id);
          return ok({ subscription: same });
        }
        const sub: AgentSubscription = {
          id: randomUUID(),
          scope,
          exclude_self,
          filter,
          cursor: '1',
          expires_at: new Date(Date.now() + 30 * 86400_000).toISOString(),
        };
        this.subs.push(sub);
        return ok({ subscription: sub });
      }
      case 'poll_events': {
        this.waits.push(Number(a.wait_ms ?? 0));
        if (this.failNextPolls > 0) {
          this.failNextPolls--;
          throw new Error('network down Bearer abcdefghijklmnop');
        }
        if (a.subscription_ids !== undefined) {
          if (this.legacy) {
            return {
              isError: true,
              structuredContent: { error: { code: 'INVALID_ARGUMENT', message: "Unrecognized key: \"subscription_ids\"; subscription_id: Invalid input: expected string, received undefined" } },
              content: [{ type: 'text', text: 'invalid' }],
            };
          }
          const ids = (a.subscription_ids as string[]).map(String);
          this.polls.push({ ids, multi: true });
          const live = new Set(this.subs.map((s) => s.id));
          if (!ids.every((id) => live.has(id))) return err('Subscription unavailable');
          if (Number(a.wait_ms ?? 0) > 0 && this.overBudget > 0) {
            this.overBudget--;
            this.overBudgetAt.push(Date.now());
            return ok({ deliveries: [], errors: [], retry_after_ms: this.retryAfterMs });
          }
          this.pollTimes.push(Date.now());
          const failing = (id: string) => this.failingSubs.get(id) ?? this.failOnce.get(id);
          const errors = ids
            .filter((id) => failing(id))
            .map((id) => ({ subscription_id: id, error_code: failing(id)!, message: 'Post unavailable: secret text' }));
          const ok_ids = ids.filter((id) => !failing(id));
          const ready = () => ok_ids.some((id) => this.outstanding.get(id) || this.queues.get(id)?.length);
          const end = Date.now() + Number(a.wait_ms ?? 0);
          const signal = options?.signal;
          this.waiting++;
          this.maxWaiting = Math.max(this.maxWaiting, this.waiting);
          // Like the server, an abandoned call keeps its waiter until the
          // deadline (or until something is ready), but the client stops at once.
          const serverSide = (async () => {
            while (!errors.length && !ready() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
            this.waiting--;
          })();
          await Promise.race([
            serverSide,
            new Promise<void>((_, reject) => {
              if (signal?.aborted) reject(new Error('aborted'));
              signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            }),
          ]);
          const deliveries = ok_ids.map((id) => this.take(id)).filter((d): d is AgentDelivery => d !== null);
          return ok({ deliveries, errors });
        }
        const id = String(a.subscription_id);
        this.polls.push({ ids: [id], multi: false });
        // Long-poll like the server: wait for a batch or until wait_ms passes.
        const end = Date.now() + Number(a.wait_ms ?? 0);
        while (
          !this.outstanding.get(id) &&
          !this.queues.get(id)?.length &&
          Date.now() < end &&
          !options?.signal?.aborted
        ) {
          await new Promise((r) => setTimeout(r, 5));
        }
        if (Number(a.wait_ms ?? 0) > 0 && this.overBudget > 0 && !this.outstanding.get(id) && !this.queues.get(id)?.length) {
          this.overBudget--;
          this.overBudgetAt.push(Date.now());
          this.overBudgetIds.push(id);
          return ok({ delivery: null, retry_after_ms: this.retryAfterMs });
        }
        return ok({ delivery: this.take(id) });
      }
      case 'unsubscribe_from_events': {
        const id = String(a.subscription_id);
        if (!this.subs.some((s) => s.id === id)) return err('Subscription not found');
        if (this.failUnsubscribe.has(id)) return err('Rate limited');
        this.subs = this.subs.filter((s) => s.id !== id);
        this.unsubscribed.push(id);
        return ok({});
      }
      case 'acknowledge_events': {
        if (this.failAcks > 0) {
          this.failAcks--;
          throw new Error('ack failed');
        }
        const id = String(a.subscription_id);
        if (this.outstanding.get(id)?.delivery_id === a.delivery_id) {
          this.outstanding.delete(id);
          this.acks.push(String(a.delivery_id));
        }
        return ok({});
      }
    }
    return err(`unexpected tool ${name}`);
  }

  /** The pending batch for a subscription, or the next queued one. */
  take(id: string): AgentDelivery | null {
    let d = this.outstanding.get(id) ?? null;
    if (!d) {
      // Like the server (agentEvents DELIVERY_LIMIT), one batch takes up to
      // 20 queued events, across pushes.
      const q = this.queues.get(id) ?? [];
      const events: DeliveredEvent[] = [];
      while (q.length && events.length + q[0].length <= 20) events.push(...q.shift()!);
      if (!events.length && q.length) events.push(...q.shift()!);
      if (events.length) {
        d = { subscription_id: id, delivery_id: randomUUID(), events, resync_required: this.resyncNext.delete(id) };
        this.outstanding.set(id, d);
      }
    }
    return d;
  }

  client(): TiloriAgentClient {
    return new TiloriAgentClient({ url: new URL('http://127.0.0.1:1/mcp/tilori/v1'), apiKey: 'test-key-123456', mcpClient: this });
  }
}

export function mention(postId: string = randomUUID(), extra: Partial<DeliveredEvent> = {}): DeliveredEvent {
  return {
    id: randomUUID(),
    cursor: '2',
    kind: 'mention',
    entity_type: 'post',
    entity_id: postId,
    parents: {},
    created_at: new Date().toISOString(),
    data: {},
    ...extra,
  };
}

/** A broad `posts` event (someone posted somewhere). */
export function post(postId: string = randomUUID()): DeliveredEvent {
  return mention(postId, { kind: 'post.created' });
}

/** An edit of a post (UNI-478): the server sends a new event id each time,
 * and `data.revision` when given (the same on every stream it lands on). */
export function edited(postId: string = randomUUID(), revision?: number): DeliveredEvent {
  return mention(postId, { kind: 'post.edited', ...(revision ? { data: { revision } } : {}) });
}

export function dm(conversationId: string = randomUUID()): DeliveredEvent {
  return {
    id: randomUUID(),
    cursor: '3',
    kind: 'dm.message',
    entity_type: 'conversation',
    entity_id: conversationId,
    parents: {},
    created_at: new Date().toISOString(),
    data: { conversation_id: conversationId, message_id: randomUUID() },
  };
}

export async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}
