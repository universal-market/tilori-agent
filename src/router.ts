import { randomUUID } from 'node:crypto';
import type { TiloriAgentClient } from './client.ts';
import { DEFAULT_WAKES_PER_HOUR } from './config.ts';
import { WakeLimiter } from './ratelimit.ts';
import type { AgentDelivery, AgentSubscription, DeliverResult, Injector, SubscriptionSpec } from './types.ts';
import { buildWake } from './wake.ts';

export interface RouterAgentConfig {
  handle: string;
  client: TiloriAgentClient;
  subscriptions: SubscriptionSpec[];
  wakesPerHour?: number;
}

export interface RouterOptions {
  agents: RouterAgentConfig[];
  logger?: (message: string) => void;
  /** Long-poll wait per poll_events call (default 20 s, max 25 s). */
  waitMs?: number;
  /** Retry delay while a batch is held (no injector, busy, capped). Default 2 s. */
  retryMs?: number;
  /** Re-check subscriptions this often (default 6 h); they expire after 30 days. */
  renewEveryMs?: number;
  deliverTimeoutMs?: number;
  now?: () => number;
}

function sleep(ms: number, signal?: AbortSignal, kick?: Promise<void>): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
    kick?.then(done);
  });
}

function withTimeout(p: Promise<DeliverResult>, ms: number): Promise<DeliverResult> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve('busy'), ms);
    p.then(
      (r) => {
        clearTimeout(t);
        resolve(r);
      },
      () => {
        clearTimeout(t);
        resolve('busy');
      },
    );
  });
}

interface AgentState {
  cfg: RouterAgentConfig;
  limiter: WakeLimiter;
  injector: Injector | null;
  /** Fired when there may be something to flush (new batch, new injector). */
  kick: { promise: Promise<void>; fire: () => void };
  /** Fired after held batches were acknowledged, so pollers resume at once. */
  polled: { promise: Promise<void>; fire: () => void };
  /** Batches handed to an injector whose ack failed: ack again, never re-wake. */
  handedOff: Set<string>;
  heldNotice: string;
  stats: { wakes: number; events: number; delayed: number };
}

const errText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

function makeKick() {
  let fire = () => {};
  const promise = new Promise<void>((r) => (fire = r));
  return { promise, fire };
}

/**
 * One router per person per machine. For each local agent it holds that
 * agent's subscriptions (inbox + direct messages by default), long-polls
 * poll_events, and hands each batch to the injector registered for the agent.
 * A batch is acknowledged on Tilori only after the injector reports
 * `accepted`; until then it stays pending server-side and is re-served.
 */
export class Router {
  readonly #agents = new Map<string, AgentState>();
  readonly #log: (m: string) => void;
  readonly #waitMs: number;
  readonly #retryMs: number;
  readonly #renewEveryMs: number;
  readonly #deliverTimeoutMs: number;
  readonly #now: () => number;

  constructor(options: RouterOptions) {
    this.#log = options.logger ?? (() => {});
    this.#waitMs = options.waitMs ?? 20_000;
    this.#retryMs = options.retryMs ?? 2_000;
    this.#renewEveryMs = options.renewEveryMs ?? 6 * 3600_000;
    this.#deliverTimeoutMs = options.deliverTimeoutMs ?? 30_000;
    this.#now = options.now ?? Date.now;
    for (const cfg of options.agents) {
      if (this.#agents.has(cfg.handle)) throw new Error(`Agent ${cfg.handle} listed twice.`);
      this.#agents.set(cfg.handle, {
        cfg,
        limiter: new WakeLimiter(cfg.wakesPerHour ?? DEFAULT_WAKES_PER_HOUR, this.#now),
        injector: null,
        kick: makeKick(),
        polled: makeKick(),
        handedOff: new Set(),
        heldNotice: '',
        stats: { wakes: 0, events: 0, delayed: 0 },
      });
    }
  }

  get agents(): string[] {
    return [...this.#agents.keys()];
  }

  stats(handle: string) {
    return this.#agents.get(handle)?.stats;
  }

  /** Registers the injector for an agent. The newest registration wins; the
   * returned function unregisters it (only if it is still current). */
  register(handle: string, injector: Injector): () => void {
    const st = this.#agents.get(handle);
    if (!st) throw new Error(`This router does not serve agent ${handle}.`);
    st.injector = injector;
    this.#wake(st);
    return () => {
      if (st.injector === injector) st.injector = null;
    };
  }

  #wake(st: AgentState) {
    const k = st.kick;
    st.kick = makeKick();
    k.fire();
  }

  async run(signal?: AbortSignal): Promise<void> {
    await Promise.all([...this.#agents.values()].map((st) => this.#runAgent(st, signal)));
  }

  async #runAgent(st: AgentState, signal?: AbortSignal): Promise<void> {
    const { client, handle } = st.cfg;
    const pending = new Map<string, AgentDelivery>();
    let failures = 0;

    while (!signal?.aborted) {
      let subs: AgentSubscription[];
      try {
        subs = await client.ensureSubscriptions(st.cfg.subscriptions, {
          signal,
          log: (m) => this.#log(`[${handle}] ${m}`),
        });
        failures = 0;
      } catch (cause) {
        if (signal?.aborted) return;
        failures++;
        const backoff = Math.min(60_000, 1000 * 2 ** (failures - 1));
        this.#log(`[${handle}] could not set up subscriptions (retry in ${backoff} ms): ${errText(cause)}`);
        await sleep(backoff, signal);
        continue;
      }
      if (!subs.length) {
        this.#log(`[${handle}] no usable subscriptions; retrying in 60 s`);
        await sleep(60_000, signal);
        continue;
      }
      this.#log(`[${handle}] following ${subs.map((s) => s.scope.type).join(', ')}`);

      // One generation runs until renewal is due or a subscription vanishes.
      const gen = new AbortController();
      const stopGen = () => gen.abort();
      signal?.addEventListener('abort', stopGen, { once: true });
      const renewal = setTimeout(stopGen, this.#renewEveryMs);
      try {
        await Promise.all([
          ...subs.map((sub) => this.#pollSubscription(st, sub, pending, gen)),
          this.#flushLoop(st, pending, gen.signal),
        ]);
      } finally {
        clearTimeout(renewal);
        signal?.removeEventListener('abort', stopGen);
      }
      // Held batches stay unacknowledged on Tilori and are re-served next generation.
      pending.clear();
    }
  }

  /** Long-polls one subscription. Each subscription has its own concurrent
   * long-poll, so an event on any of them is seen within the server's
   * recheck interval (1-3 s). While its batch is held, it waits. */
  async #pollSubscription(
    st: AgentState,
    sub: AgentSubscription,
    pending: Map<string, AgentDelivery>,
    gen: AbortController,
  ): Promise<void> {
    const { client, handle } = st.cfg;
    const signal = gen.signal;
    let failures = 0;
    while (!signal.aborted) {
      if (pending.has(sub.id)) {
        await sleep(this.#retryMs, signal, st.polled.promise);
        continue;
      }
      try {
        const started = Date.now();
        const d = await client.poll(sub.id, this.#waitMs, signal);
        failures = 0;
        if (d && (d.events.length > 0 || d.resync_required)) {
          pending.set(sub.id, d);
          this.#wake(st);
        } else if (this.#waitMs >= 5_000 && Date.now() - started < 1_000) {
          // The server degraded this long-poll to an immediate poll (too many
          // waiters on the account); don't spin.
          await sleep(3_000, signal);
        }
      } catch (cause) {
        if (signal.aborted) return;
        const msg = errText(cause);
        if (/subscription/i.test(msg) && /not found|expired|unknown|no longer/i.test(msg)) {
          this.#log(`[${handle}] ${sub.scope.type} subscription is gone; re-subscribing`);
          gen.abort();
          return;
        }
        failures++;
        const backoff = Math.min(30_000, 500 * 2 ** (failures - 1));
        this.#log(`[${handle}] Tilori error on ${sub.scope.type} (attempt ${failures}, retry in ${backoff} ms): ${msg}`);
        await sleep(backoff, signal);
      }
    }
  }

  async #flushLoop(st: AgentState, pending: Map<string, AgentDelivery>, signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      if (!pending.size) {
        await sleep(60_000, signal, st.kick.promise);
        continue;
      }
      let waitMs: number;
      try {
        waitMs = await this.#flush(st, pending, signal);
        failures = 0;
      } catch (cause) {
        if (signal.aborted) return;
        failures++;
        waitMs = Math.min(30_000, 500 * 2 ** (failures - 1));
        this.#log(`[${st.cfg.handle}] acknowledge failed (retry in ${waitMs} ms): ${errText(cause)}`);
      }
      if (waitMs > 0) await sleep(waitMs, signal, st.kick.promise);
      else this.#firePolled(st);
    }
  }

  #firePolled(st: AgentState) {
    const k = st.polled;
    st.polled = makeKick();
    k.fire();
  }

  /** Tries to hand held batches to the agent's injector. Returns 0 when done,
   * else how long to wait before retrying. Logs counts only, never content. */
  async #flush(st: AgentState, pending: Map<string, AgentDelivery>, signal?: AbortSignal): Promise<number> {
    const { client, handle } = st.cfg;
    const batches = [...pending.values()];
    const count = batches.reduce((n, d) => n + d.events.length, 0);

    // Re-ack batches already handed off whose ack failed earlier.
    const fresh = batches.filter((d) => !st.handedOff.has(d.delivery_id));
    if (fresh.length) {
      const notice = (s: string) => {
        if (st.heldNotice !== s) this.#log(`[${handle}] ${s}`);
        st.heldNotice = s;
      };
      if (!st.injector) {
        notice(`holding ${count} event(s): no injector registered for this agent yet`);
        return this.#retryMs * 5;
      }
      const capWait = st.limiter.waitMs();
      if (capWait > 0) {
        st.stats.delayed = count;
        notice(
          `wake cap reached (${st.limiter.perHour}/hour); delaying ${count} event(s) for ${Math.ceil(capWait / 1000)} s`,
        );
        return Math.min(capWait, 60_000);
      }
      const injector = st.injector;
      const wake = buildWake(handle, fresh, randomUUID());
      const result = await withTimeout(injector.deliver(wake), this.#deliverTimeoutMs);
      if (result !== 'accepted') {
        if (result === 'gone' && st.injector === injector) st.injector = null;
        notice(`injector ${injector.kind} ${result}; holding ${count} event(s)`);
        return this.#retryMs;
      }
      st.limiter.record();
      st.stats.wakes++;
      st.stats.events += wake.events.length;
      st.stats.delayed = 0;
      st.heldNotice = '';
      for (const d of fresh) st.handedOff.add(d.delivery_id);
      this.#log(`[${handle}] woke ${injector.kind} with ${wake.events.length} event(s)`);
    }

    for (const d of batches) {
      await client.acknowledge(d.subscription_id, d.delivery_id, signal);
      st.handedOff.delete(d.delivery_id);
      pending.delete(d.subscription_id);
    }
    return 0;
  }
}
