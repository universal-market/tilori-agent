import { randomUUID } from 'node:crypto';
import { clock, promptSignal, touchSignal, writePushSignal, type SignalKind } from './activity.ts';
import {
  MAX_POLL_SUBSCRIPTIONS,
  MultiPollUnsupported,
  type MultiPollResult,
  type ProfileNotes,
  type TiloriAgentClient,
} from './client.ts';
import { DEFAULT_PAUSE_SECONDS, DEFAULT_DIRECT_WAKES_PER_HOUR, DEFAULT_WAKES_PER_HOUR, type Reminder, unfilteredPostsWarning } from './config.ts';
import { PushStream, type PushOptions, type PushStatus } from './push.ts';
import { WakeLimiter } from './ratelimit.ts';
import type { LiveSettings } from './settings.ts';
import type { AgentDelivery, AgentSubscription, DeliverResult, EventRef, Injector, SubscriptionSpec, Wake } from './types.ts';
import { KIND_RANK, buildWake, refKey, toRefs } from './wake.ts';

/** How long a delivered post or conversation is remembered. Longer than the
 * wake cap can hold a batch (one hour), so a held copy of something that went
 * out past the cap is still recognised when the cap lifts. */
/** Push mode: the least time between two polls of one agent, whatever
 * else asks for one, so a bug in the sweep logic is a slow poll, never a
 * spin against the account's rate budget (Bastion). */
export const PUSH_POLL_GAP_MS = 1_000;
const RECENT_MS = 2 * 3600_000;
/** Below this many posts left today, wakes say how many (UNI-393). */
const POSTS_LOW = 100;
/** How long a posts-left reading is reused before get_my_profile again. */
const POSTS_LEFT_MS = 60_000;
/** Bound on that memory, so a firehose can't grow it without limit. */
const MAX_RECENT = 5_000;
/** Efficient wakes §2: after a batch from a direct subscription (inbox,
 * mentions, DMs) is handed off, that subscription is not polled for this
 * long, so a follow-up (a correction, the next reply) queues on the server
 * and arrives with whatever else came in as one batch. */
const DIRECT_PAUSE_MS = 10_000;

export interface RouterAgentConfig {
  handle: string;
  client: TiloriAgentClient;
  subscriptions: SubscriptionSpec[];
  wakesPerHour?: number;
  /** Cap for direct wakes (mentions, DMs, inbox), separate from wakesPerHour. */
  directWakesPerHour?: number;
  /** Seconds a broad subscription rests after each hand-off (validated by
   * pauseSeconds; local config only). Unset: the router's `broadPauseMs`. */
  pauseSeconds?: number;
  /** A periodic wake with the operator's own text (validated by reminderSettings). */
  reminder?: Reminder;
  /** Log once when the session has been blocked on a prompt this long with
   * wakes arriving (validated by stallMinutes; 0 or unset: off). */
  stallMinutes?: number;
  /** Tilori push via the gateway (push.ts): when set, events arrive on a
   * gateway stream and each frame triggers a zero-wait poll; there are no
   * long polls. Unset: long polls, as before. */
  push?: PushOptions;
}

/** This hour's wake counts for `tilori-agent config show`: counts only. */
export interface AgentUsage {
  wakes: { used: number; limit: number };
  /** Null when the direct allowance is off. */
  direct: { used: number; limit: number } | null;
  /** Events the wake cap is holding right now. */
  held: number;
}

export interface RouterOptions {
  agents: RouterAgentConfig[];
  logger?: (message: string) => void;
  /** Long-poll wait per poll_events call (default 20 s, max 25 s). */
  waitMs?: number;
  /** Base retry delay while a batch is held (no injector, busy). Busy
   * retries back off exponentially from here up to 60 s. Default 2 s. */
  retryMs?: number;
  /** Re-check subscriptions this often (default 6 h); they expire after 30 days. */
  renewEveryMs?: number;
  /** Hold a new batch this long before waking, so the same post delivered
   * by overlapping subscriptions (all posts plus the inbox) makes one wake,
   * not one per subscription. Default 3 s, about one server recheck. */
  coalesceMs?: number;
  /** When everything held is plain post.created from broad subscriptions,
   * hold it this long (default 30 s) from the first batch's arrival, so a
   * mention or reply copy of the same post on the inbox can join it as one
   * direct wake instead of the plain copy spending a wake first (UNI-573).
   * Fixed from the first held batch, so a stream of new posts never pushes
   * it back. Any direct batch ends the hold at once. */
  plainHoldMs?: number;
  /** How long a direct subscription rests after a hand-off (default 10 s). */
  directPauseMs?: number;
  /** How long a broad subscription rests after a hand-off, for an agent
   * without `pauseSeconds` (default 60 s). Generalises UNI-478's edit pause:
   * a burst queues on the server and arrives as one batch. */
  broadPauseMs?: number;
  /** The run directory for `status`'s files (attempting-, watching-, woke-),
   * or unset to write none (tests, or no private run directory). */
  signalDir?: string;
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

/** A deliver that throws counts as busy; it never resolves early. */
async function settle(p: Promise<DeliverResult>): Promise<DeliverResult> {
  try {
    return await p;
  } catch {
    return 'busy';
  }
}

interface AgentState {
  cfg: RouterAgentConfig;
  limiter: WakeLimiter;
  /** A separate allowance for direct signals, so broad traffic that used up
   * `limiter` never starves a mention or direct message. Null when turned off. */
  directLimiter: WakeLimiter | null;
  /** The direct limiter while turned off by a reload, kept so turning it back
   * on doesn't hand out a fresh hour. */
  directOff: WakeLimiter | null;
  /** Subscriptions whose batches are direct signals (inbox, mentions, DMs). */
  directSubs: Set<string>;
  /** Batches (by delivery id) the wake cap has delayed, for the wake's count. */
  capHeld: Set<string>;
  /** Posts (by `refKey`) handed to an injector recently, oldest first, with
   * the time and the highest kind rank they went out under. Only posts: a
   * reply is a new post id, but a conversation or a Market entity gets new
   * events under the same id, which must always wake. Kept across
   * generations: a held batch is re-served after a renewal. */
  recent: Map<string, { at: number; rank: number; revision?: number }>;
  /** Live injectors, oldest first. The newest one receives wakes; when it
   * leaves, the previous one takes over. */
  injectors: Injector[];
  /** Consecutive busy results, for exponential backoff. */
  busy: number;
  /** No delivery attempt before this time (busy backoff); new batches don't shorten it. */
  retryAt: number;
  /** Fired when there may be something to flush (new batch, new injector). */
  kick: { promise: Promise<void>; fire: () => void };
  /** Fired after held batches were acknowledged, so pollers resume at once. */
  polled: { promise: Promise<void>; fire: () => void };
  /** Set while a multiplexed long poll leaves out held subscriptions: called
   * once they are acknowledged, so the poll restarts and includes them. */
  onPolled: (() => void) | null;
  /** Until this time, poll each subscription separately (the server rejected
   * `subscription_ids`); retried after a renewal interval. */
  singleUntil: number;
  /** Deadlines of abandoned long polls that may still hold a server waiter
   * (a restart, or a generation that ended mid-call). A restart waits until
   * none is left and a new call until at most one is, so the agent never
   * holds more than two. */
  abandoned: number[];
  /** Subscriptions (by spec) re-subscribed after a per-id poll error, and
   * when. A second error within a renewal interval drops it instead. */
  resubscribed: Map<string, number>;
  /** Subscriptions (by spec) dropped after repeated poll errors, and when.
   * Kept across generations, so they stay dropped for a renewal interval. */
  dropped: Map<string, number>;
  /** Subscription ids to subscribe again at the next setup. */
  renewIds: Set<string>;
  /** Batches handed to an injector whose ack failed: ack again, never re-wake. */
  handedOff: Set<string>;
  /** When the oldest batch now held arrived (0 when none is held). */
  heldSince: number;
  /** Subscriptions resting after a hand-off, until when (Date.now()). */
  paused: Map<string, number>;
  heldNotice: string;
  /** When the next reminder is due (unused without a reminder). An event
   * wake pushes it back when the reminder is only for idle agents. */
  reminderAt: number;
  stats: { wakes: number; events: number; delayed: number; reminders: number };
  /** The last get_my_profile reading and when it was taken. */
  profile: { at: number; value: ProfileNotes };
  /** The prompt the session is blocked on (by its signal's mtime), the wakes
   * accepted since, and whether the stall line was logged for it. */
  blocked: { since: number; wakes: number; logged: boolean };
  /** Push mode only (cfg.push): `seq` counts frames and reconnects, so a
   * poller that saw `seq` knows to poll again once it moves. */
  push: null | {
    stream: PushStream;
    seq: number;
    kick: { promise: Promise<void>; fire: () => void };
    /** A "back" line is owed once the stream holds (`stable`), with the
    * events the reconnect sweeps caught meanwhile. */
    back: boolean;
    caught: number;
    /** When the stream was last seen alive (heartbeat or frame). */
    aliveAt: number;
    /** When this agent last started a push poll (the 1 s floor). */
    polledAt: number;
  };
}

/** Scopes whose events are addressed to the agent itself. */
const DIRECT_SCOPES = new Set(['inbox', 'mentions', 'direct_messages']);
const isDirectKind = (kind: string) => kind === 'mention' || kind.startsWith('dm.');

function directLimiter(perHour: number | undefined, now: () => number): WakeLimiter | null {
  const n = perHour ?? DEFAULT_DIRECT_WAKES_PER_HOUR;
  if (n === 0) return null;
  if (!Number.isInteger(n) || n < 0) throw new Error('direct_wakes_per_hour must be a non-negative integer.');
  return new WakeLimiter(n, now);
}

const errText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** A subscription's identity (scope, exclude_self, filter), stable across renewals. */
const specKey = (s: AgentSubscription) => JSON.stringify([s.scope, s.exclude_self, s.filter]);

/** A refusal meaning a listed subscription no longer exists for this agent. */
const gone = (msg: string) => /subscription/i.test(msg) && /not found|expired|unknown|unavailable|no longer/i.test(msg);

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
  readonly #coalesceMs: number;
  readonly #plainHoldMs: number;
  readonly #directPauseMs: number;
  readonly #broadPauseMs: number;
  readonly #now: () => number;
  readonly #signalDir: string | undefined;
  readonly #signalFailed = new Set<string>();

  constructor(options: RouterOptions) {
    this.#log = options.logger ?? (() => {});
    this.#waitMs = options.waitMs ?? 20_000;
    this.#retryMs = options.retryMs ?? 2_000;
    this.#renewEveryMs = options.renewEveryMs ?? 6 * 3600_000;
    this.#coalesceMs = options.coalesceMs ?? 3_000;
    this.#plainHoldMs = Math.max(this.#coalesceMs, options.plainHoldMs ?? 30_000);
    this.#directPauseMs = options.directPauseMs ?? DIRECT_PAUSE_MS;
    this.#broadPauseMs = options.broadPauseMs ?? DEFAULT_PAUSE_SECONDS * 1000;
    this.#now = options.now ?? Date.now;
    this.#signalDir = options.signalDir;
    for (const cfg of options.agents) {
      if (this.#agents.has(cfg.handle)) throw new Error(`Agent ${cfg.handle} listed twice.`);
      const broad = unfilteredPostsWarning(cfg.handle, cfg.subscriptions);
      if (broad) this.#log(broad);
      this.#agents.set(cfg.handle, {
        cfg,
        limiter: new WakeLimiter(cfg.wakesPerHour ?? DEFAULT_WAKES_PER_HOUR, this.#now),
        directLimiter: directLimiter(cfg.directWakesPerHour, this.#now),
        directOff: null,
        directSubs: new Set(),
        capHeld: new Set(),
        recent: new Map(),
        injectors: [],
        busy: 0,
        retryAt: 0,
        kick: makeKick(),
        polled: makeKick(),
        onPolled: null,
        singleUntil: 0,
        abandoned: [],
        resubscribed: new Map(),
        dropped: new Map(),
        renewIds: new Set(),
        handedOff: new Set(),
        heldSince: 0,
        paused: new Map(),
        heldNotice: '',
        reminderAt: cfg.reminder ? Date.now() + cfg.reminder.everyMs : 0,
        stats: { wakes: 0, events: 0, delayed: 0, reminders: 0 },
        profile: { at: -Infinity, value: { postsLeft: null, toolsHash: null } },
        blocked: { since: 0, wakes: 0, logged: false },
        push: null,
      });
      const st = this.#agents.get(cfg.handle)!;
      if (cfg.push) st.push = { stream: this.#pushStream(st, cfg.push), seq: 0, kick: makeKick(), back: false, caught: 0, aliveAt: 0, polledAt: 0 };
    }
  }

  /** The push stream for an agent, wired to its poll loop, status file and
   * monitor lines. */
  #pushStream(st: AgentState, options: PushOptions): PushStream {
    const handle = st.cfg.handle;
    const nudge = () => {
      const p = st.push!;
      p.seq++;
      const k = p.kick;
      p.kick = makeKick();
      k.fire();
    };
    return new PushStream(options, {
      frame: () => nudge(),
      connected: (back) => {
        if (back && !st.push!.back) {
          st.push!.back = true;
          st.push!.caught = 0;
        }
        this.#log(`[${handle}] push stream open${back ? ' again' : ''}`);
        nudge();
      },
      stable: () => {
        const p = st.push!;
        if (!p.back) return;
        p.back = false;
        this.#pushLine(st, { state: 'back', caught: p.caught });
      },
      down: (since) => this.#pushLine(st, { state: 'down', since }),
      alive: () => {
        // Push mode polls only on a frame, so the stream being alive is
        // what "watched" means; at most one file touch per 30 s.
        const now = Date.now();
        if (now - st.push!.aliveAt < 30_000) return;
        st.push!.aliveAt = now;
        this.#signal(handle, 'watching');
        // Keeps `push-` fresh for `status` while nothing changes.
        this.#pushStatus(handle, st.push!.stream.status);
      },
      status: (s) => this.#pushStatus(handle, s),
      log: (m) => this.#log(`[${handle}] ${m}`),
    });
  }

  /** Writes `push-<agent>` for `status` (best effort). */
  #pushStatus(handle: string, s: PushStatus) {
    if (this.#signalDir === undefined) return;
    try {
      writePushSignal(this.#signalDir, handle, s);
    } catch (cause) {
      const key = `push-${handle}`;
      if (this.#signalFailed.has(key)) return;
      this.#signalFailed.add(key);
      this.#log(`[${handle}] could not update push- in the run directory: ${errText(cause)}`);
    }
  }

  /** A push monitor line ("down", or "back" after the reconnect sweep): to
   * the newest injector, outside the wake caps, never acknowledged. */
  #pushLine(st: AgentState, push: NonNullable<Wake['push']>) {
    const injector = st.injectors.at(-1);
    const wake: Wake = { wake_id: randomUUID(), agent: st.cfg.handle, events: [], resync_required: false, push };
    if (!injector) return;
    void Promise.resolve()
      .then(() => injector.deliver(wake))
      .catch(() => {});
  }

  /** Push mode: waits until a frame or a reconnect moved `seq` past `seen`,
   * or the generation ends. */
  async #waitPush(st: AgentState, seen: number, signal: AbortSignal): Promise<void> {
    const p = st.push!;
    while (p.seq === seen && !signal.aborted) await sleep(this.#renewEveryMs, signal, p.kick.promise);
  }

  get agents(): string[] {
    return [...this.#agents.keys()];
  }

  stats(handle: string) {
    return this.#agents.get(handle)?.stats;
  }

  /** Registers an injector for an agent. The newest live registration
   * receives wakes; the returned function removes this one, and the previous
   * registration (if still live) takes over. */
  register(handle: string, injector: Injector): () => void {
    const st = this.#agents.get(handle);
    if (!st) throw new Error(`This router does not serve agent ${handle}.`);
    st.injectors = st.injectors.filter((i) => i !== injector);
    st.injectors.push(injector);
    st.busy = 0;
    st.retryAt = 0;
    this.#wake(st);
    return () => this.#drop(st, injector);
  }

  #drop(st: AgentState, injector: Injector) {
    const before = st.injectors.length;
    st.injectors = st.injectors.filter((i) => i !== injector);
    if (st.injectors.length !== before) {
      st.busy = 0;
      st.retryAt = 0;
      this.#wake(st);
    }
  }

  /** This hour's usage for one agent, or null if this router doesn't serve it. */
  usage(handle: string): AgentUsage | null {
    const st = this.#agents.get(handle);
    if (!st) return null;
    const d = st.directLimiter;
    return {
      wakes: { used: st.limiter.used, limit: st.limiter.perHour },
      direct: d ? { used: d.used, limit: d.perHour } : null,
      held: st.capHeld.size ? st.stats.delayed : 0,
    };
  }

  /** Applies reloaded settings (live reload, UNI-480): the caps,
   * pause_seconds (from the next hand-off), the reminder interval and
   * stall_minutes only. Wakes already spent this hour still
   * count. A reminder is never added or removed here, only re-timed; a
   * shorter interval brings the next one forward. Returns what changed, as
   * "key old -> new", for the log. */
  reload(handle: string, live: LiveSettings): string[] {
    const st = this.#agents.get(handle);
    if (!st) return [];
    const changed: string[] = [];
    const note = (key: string, from: number, to: number) => {
      if (from !== to) changed.push(`${key} ${from} -> ${to}`);
    };
    note('wakes_per_hour', st.limiter.perHour, live.wakesPerHour);
    st.limiter.resize(live.wakesPerHour);
    note('direct_wakes_per_hour', st.directLimiter?.perHour ?? 0, live.directWakesPerHour);
    if (live.directWakesPerHour === 0) {
      st.directOff = st.directLimiter ?? st.directOff;
      st.directLimiter = null;
    } else {
      // Off and on again keeps this hour's direct wakes: same limiter, resized.
      st.directLimiter = st.directLimiter ?? st.directOff ?? new WakeLimiter(live.directWakesPerHour, this.#now);
      st.directOff = null;
      st.directLimiter.resize(live.directWakesPerHour);
    }
    note('pause_seconds', st.cfg.pauseSeconds ?? this.#broadPauseMs / 1000, live.pauseSeconds);
    note('stall_minutes', st.cfg.stallMinutes ?? 0, live.stallMinutes);
    let reminder = st.cfg.reminder;
    if (reminder && live.reminderEveryMs !== undefined && live.reminderEveryMs !== reminder.everyMs) {
      note('reminder.every_minutes', reminder.everyMs / 60_000, live.reminderEveryMs / 60_000);
      reminder = { ...reminder, everyMs: live.reminderEveryMs };
      st.reminderAt = Math.min(st.reminderAt, Date.now() + live.reminderEveryMs);
    }
    st.cfg = {
      ...st.cfg,
      wakesPerHour: live.wakesPerHour,
      directWakesPerHour: live.directWakesPerHour,
      pauseSeconds: live.pauseSeconds,
      stallMinutes: live.stallMinutes,
      reminder,
    };
    // A raised cap may let a held batch out now.
    if (changed.length) this.#wake(st);
    return changed;
  }

  /** Number of live injectors for an agent (for tests and status). */
  injectorCount(handle: string): number {
    return this.#agents.get(handle)?.injectors.length ?? 0;
  }

  #wake(st: AgentState) {
    const k = st.kick;
    st.kick = makeKick();
    k.fire();
  }

  async run(signal?: AbortSignal): Promise<void> {
    await Promise.all(
      [...this.#agents.values()].map(async (st) => {
        try {
          const stop = new AbortController();
          const end = () => stop.abort();
          signal?.addEventListener('abort', end, { once: true });
          try {
            await Promise.all([
              this.#runAgent(st, signal).finally(end),
              st.push ? st.push.stream.run(stop.signal) : Promise.resolve(),
            ]);
          } finally {
            signal?.removeEventListener('abort', end);
          }
        } finally {
          // End the MCP session; a cancelled long poll leaves it open.
          await st.cfg.client.close();
        }
      }),
    );
  }

  async #runAgent(st: AgentState, signal?: AbortSignal): Promise<void> {
    const { client, handle } = st.cfg;
    const pending = new Map<string, AgentDelivery>();
    let failures = 0;
    let quickRestarts = 0;

    while (!signal?.aborted) {
      let subs: AgentSubscription[];
      const now = Date.now();
      for (const [key, at] of st.resubscribed) if (now - at > this.#renewEveryMs) st.resubscribed.delete(key);
      for (const [key, at] of st.dropped) if (now - at > this.#renewEveryMs) st.dropped.delete(key);
      try {
        // Setting up counts as an attempt: a router that can't reach Tilori
        // at all must show as polling-but-failing, not as nothing running.
        this.#signal(handle, 'attempting');
        subs = await client.ensureSubscriptions(st.cfg.subscriptions, {
          signal,
          // Subscriptions that just failed a poll are subscribed again.
          renewIds: st.renewIds,
          log: (m) => this.#log(`[${handle}] ${m}`),
        });
        st.renewIds.clear();
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
      st.directSubs = new Set(subs.filter((s) => DIRECT_SCOPES.has(s.scope.type)).map((s) => s.id));

      // One generation runs until renewal is due or a subscription vanishes.
      const gen = new AbortController();
      const stopGen = () => gen.abort();
      signal?.addEventListener('abort', stopGen, { once: true });
      const renewal = setTimeout(stopGen, this.#renewEveryMs);
      const started = Date.now();
      try {
        await Promise.all([this.#pollAgent(st, subs, pending, gen), this.#flushLoop(st, pending, gen.signal)]);
      } finally {
        clearTimeout(renewal);
        signal?.removeEventListener('abort', stopGen);
      }
      // Held batches stay unacknowledged on Tilori and are re-served next generation.
      pending.clear();
      st.heldSince = 0;
      st.capHeld.clear();
      // A generation that ended at once (a subscription keeps vanishing) backs off.
      if (signal?.aborted) return;
      quickRestarts = Date.now() - started < 5_000 ? quickRestarts + 1 : 0;
      if (quickRestarts > 1) await sleep(Math.min(60_000, 1000 * 2 ** (quickRestarts - 2)), signal);
    }
  }

  /** Polls all of an agent's subscriptions with one long poll at a time
   * (`subscription_ids`, UNI-380), so an agent holds one server waiter
   * instead of one per subscription. Held subscriptions are left out until
   * acknowledged. Falls back to one long poll per subscription when the
   * server predates `subscription_ids`. */
  async #pollAgent(
    st: AgentState,
    subs: AgentSubscription[],
    pending: Map<string, AgentDelivery>,
    gen: AbortController,
  ): Promise<void> {
    const { client, handle } = st.cfg;
    const signal = gen.signal;
    let failures = 0;
    // Push mode: the `seq` the last poll covered (-1: poll now; a new
    // generation sweeps once).
    let seen = -1;
    const wait = st.push ? 0 : this.#waitMs;
    while (!signal.aborted) {
      const usable = subs.filter((s) => !st.dropped.has(specKey(s)));
      if (!st.push && (st.singleUntil > Date.now() || usable.length > MAX_POLL_SUBSCRIPTIONS)) {
        await Promise.all(usable.map((sub) => this.#pollSubscription(st, sub, pending, gen)));
        return;
      }
      if (!usable.length) {
        // Every subscription was dropped; wait for the next renewal.
        await sleep(this.#renewEveryMs, signal);
        return;
      }
      const idle = usable.filter((s) => !pending.has(s.id) && this.#restingMs(st, s.id) <= 0);
      if (!idle.length) {
        const resting = usable.map((s) => this.#restingMs(st, s.id)).filter((ms) => ms > 0);
        await sleep(Math.min(this.#retryMs, ...resting), signal, st.polled.promise);
        continue;
      }
      if (st.push && st.push.seq === seen) {
        // Nothing new since the last poll: wait for a frame or a reconnect.
        // While push is down nothing polls (no long-poll fallback).
        await this.#waitPush(st, seen, signal);
        seen = -1;
        continue;
      }
      if (st.push) {
        // A hard floor between one agent's push polls, whatever `seen` says,
        // so a bug here is a slow poll, never a spin (Bastion). Frames that
        // land meanwhile are covered by the one poll after it.
        const gap = st.push.polledAt + PUSH_POLL_GAP_MS - Date.now();
        if (gap > 0) {
          await sleep(gap, signal);
          continue;
        }
        st.push.polledAt = Date.now();
      }
      // Frames that land while this poll runs move `seq` again. Until the
      // poll succeeds, the next round polls again (a failed poll is retried
      // after its backoff, not left for the next frame).
      const covered = st.push?.seq ?? 0;
      seen = -1;
      // Two abandoned calls (a restart, then a generation that ended
      // mid-call) may still hold waiters; a new call now would be a third.
      const open = this.#openAbandoned(st);
      if (open.length > 1) {
        await sleep(Math.min(...open) - Date.now(), signal);
        continue;
      }

      // While some subscriptions are held, restart the long poll once they
      // are acknowledged, so their next events are not delayed. The abandoned
      // call keeps its server waiter until its deadline; at most one is
      // outstanding (a restart waits for an earlier one to expire), so the
      // agent stays within the server's two waiters per agent.
      const call = new AbortController();
      const stopCall = () => call.abort();
      signal.addEventListener('abort', stopCall, { once: true });
      const startedAt = Date.now();
      let restarted = false;
      let restartTimer: ReturnType<typeof setTimeout> | undefined;
      let pauseTimer: ReturnType<typeof setTimeout> | undefined;
      if (idle.length < usable.length) {
        const restart = () => {
          if (call.signal.aborted) return;
          restarted = true;
          st.abandoned.push(startedAt + wait + 1_000);
          call.abort();
        };
        st.onPolled = () => {
          const wait = Math.max(0, ...this.#openAbandoned(st)) - Date.now();
          if (wait <= 0) restart();
          else restartTimer = setTimeout(restart, wait);
        };
        // A resting subscription rejoins the long poll when its pause ends.
        const resting = usable.map((s) => this.#restingMs(st, s.id)).filter((ms) => ms > 0);
        if (resting.length) pauseTimer = setTimeout(() => st.onPolled?.(), Math.min(...resting));
      }
      try {
        this.#signal(handle, 'attempting');
        const res = st.push
          ? await this.#pollNow(st, idle, call.signal)
          : await client.pollMany(
              idle.map((s) => s.id),
              this.#waitMs,
              call.signal,
            );
        // Answered, but nothing can arrive while every polled subscription
        // errored (they are re-subscribed next): not watched yet.
        if (res.errors.length < idle.length) this.#signal(handle, 'watching');
        failures = 0;
        let got = false;
        for (const d of res.deliveries) {
          if (d.events.length > 0 || d.resync_required) {
            // Only the first held batch starts the hold, so it has a fixed end.
            // A batch arriving while others are still held (ack retry, deliver
            // in flight) joins their wake without a hold of its own.
            if (!pending.size) st.heldSince = Date.now();
            pending.set(d.subscription_id, d);
            got = true;
          }
        }
        if (got) this.#wake(st);
        if (st.push) {
          // A sweep covers every idle subscription (#pollNow chunks them), so
          // only a batch (maybe more behind it) polls again; otherwise wait
          // for a frame.
          seen = got ? -1 : covered;
          if (st.push.back) st.push.caught += res.deliveries.reduce((n, d) => n + d.events.length, 0);
        }
        let resubscribe = false;
        for (const e of res.errors) {
          const sub = idle.find((s) => s.id === e.subscription_id)!;
          const key = specKey(sub);
          const at = st.resubscribed.get(key);
          if (at === undefined || Date.now() - at > this.#renewEveryMs) {
            st.resubscribed.set(key, Date.now());
            st.renewIds.add(sub.id);
            this.#log(`[${handle}] subscription ${e.subscription_id} could not be polled (${e.error_code}); re-subscribing`);
            resubscribe = true;
          } else {
            st.dropped.set(key, Date.now());
            this.#log(`[${handle}] dropping subscription ${e.subscription_id} (${e.error_code}) until the next renewal`);
          }
        }
        if (resubscribe) {
          // This call's deliveries for other subscriptions are in `pending`
          // but never handed off: the flush loop ends with the generation
          // before it can take them, and #runAgent then clears `pending`.
          // They stay unacknowledged, so the server re-serves them next
          // generation; the cost is one extra round trip, not a lost or
          // repeated wake.
          gen.abort();
          return;
        }
        if (res.retryAfterMs) {
          // Over the server's waiter budget: pause as asked.
          await sleep(res.retryAfterMs, signal);
        } else if (got) {
          // Give the handoff a moment to acknowledge, so the next long poll
          // can include these subscriptions again.
          await sleep(this.#retryMs, signal, st.polled.promise);
        } else if (!res.errors.length && wait >= 5_000 && Date.now() - startedAt < 1_000) {
          // An older server degraded the long poll to an immediate one without
          // saying how long to wait; don't spin.
          await sleep(3_000, signal);
        }
      } catch (cause) {
        if (signal.aborted) {
          // The generation ended mid-call (renewal or stop): the call keeps
          // its server waiter until its deadline.
          if (!restarted) st.abandoned.push(startedAt + wait + 1_000);
          return;
        }
        if (restarted) continue;
        if (cause instanceof MultiPollUnsupported) {
          st.singleUntil = Date.now() + this.#renewEveryMs;
          this.#log(`[${handle}] server does not accept subscription_ids; polling each subscription separately`);
          continue;
        }
        const msg = errText(cause);
        if (gone(msg)) {
          this.#log(`[${handle}] a subscription is gone; re-subscribing`);
          gen.abort();
          return;
        }
        failures++;
        const backoff = Math.min(30_000, 500 * 2 ** (failures - 1));
        this.#log(`[${handle}] Tilori error (attempt ${failures}, retry in ${backoff} ms): ${msg}`);
        await sleep(backoff, signal);
      } finally {
        st.onPolled = null;
        clearTimeout(restartTimer);
        clearTimeout(pauseTimer);
        signal.removeEventListener('abort', stopCall);
      }
    }
  }

  /** Push mode's zero-wait sweep of every idle subscription: multiplexed
   * calls of up to MAX_POLL_SUBSCRIPTIONS ids, or one call per id on a
   * server without `subscription_ids`. Never a long poll. */
  async #pollNow(st: AgentState, subs: AgentSubscription[], signal: AbortSignal): Promise<MultiPollResult> {
    const { client } = st.cfg;
    if (st.singleUntil <= Date.now()) {
      try {
        // Every idle subscription, MAX_POLL_SUBSCRIPTIONS ids per call, so
        // one sweep reads them all and a sweep never repeats itself.
        const out: MultiPollResult = { deliveries: [], errors: [] };
        for (let i = 0; i < subs.length; i += MAX_POLL_SUBSCRIPTIONS) {
          const r = await client.pollMany(
            subs.slice(i, i + MAX_POLL_SUBSCRIPTIONS).map((s) => s.id),
            0,
            signal,
          );
          out.deliveries.push(...r.deliveries);
          out.errors.push(...r.errors);
          if (r.retryAfterMs) {
            // Rate limited: the rest waits for the retry.
            out.retryAfterMs = Math.max(out.retryAfterMs ?? 0, r.retryAfterMs);
            break;
          }
        }
        return out;
      } catch (cause) {
        if (!(cause instanceof MultiPollUnsupported)) throw cause;
        st.singleUntil = Date.now() + this.#renewEveryMs;
        this.#log(`[${st.cfg.handle}] server does not accept subscription_ids; polling each subscription separately`);
      }
    }
    const out: MultiPollResult = { deliveries: [], errors: [] };
    for (const sub of subs) {
      const r = await client.pollOne(sub.id, 0, signal);
      if (r.delivery) out.deliveries.push(r.delivery);
      if (r.retryAfterMs) out.retryAfterMs = Math.max(out.retryAfterMs ?? 0, r.retryAfterMs);
    }
    return out;
  }

  /** How long a subscription still rests after a hand-off (0 when not). */
  #restingMs(st: AgentState, id: string): number {
    const until = st.paused.get(id);
    if (until === undefined) return 0;
    const ms = until - Date.now();
    if (ms <= 0) st.paused.delete(id);
    return Math.max(0, ms);
  }

  /** Deadlines of abandoned calls that may still hold a server waiter. */
  #openAbandoned(st: AgentState): number[] {
    const now = Date.now();
    st.abandoned = st.abandoned.filter((t) => t > now);
    return st.abandoned;
  }

  /** Long-polls one subscription: the fallback for servers without
   * `subscription_ids`. Each subscription has its own concurrent long poll,
   * so an event on any of them is seen within the server's recheck interval
   * (1-3 s). While its batch is held, it waits. */
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
      const resting = this.#restingMs(st, sub.id);
      if (resting > 0) {
        await sleep(resting, signal);
        continue;
      }
      try {
        const started = Date.now();
        this.#signal(handle, 'attempting');
        const { delivery: d, retryAfterMs } = await client.pollOne(sub.id, this.#waitMs, signal);
        this.#signal(handle, 'watching');
        failures = 0;
        if (d && (d.events.length > 0 || d.resync_required)) {
          // Only the first held batch starts the hold (see #pollAgent).
          if (!pending.size) st.heldSince = Date.now();
          pending.set(sub.id, d);
          this.#wake(st);
        } else if (retryAfterMs) {
          await sleep(retryAfterMs, signal);
        } else if (this.#waitMs >= 5_000 && Date.now() - started < 1_000) {
          // The server degraded this long-poll to an immediate poll (too many
          // waiters on the account); don't spin.
          await sleep(3_000, signal);
        }
      } catch (cause) {
        if (signal.aborted) return;
        const msg = errText(cause);
        if (gone(msg)) {
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
        const due = st.cfg.reminder ? st.reminderAt - Date.now() : Infinity;
        if (due <= 0) await this.#remind(st, signal);
        else await sleep(Math.min(60_000, due), signal, st.kick.promise);
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
    const restart = st.onPolled;
    st.onPolled = null;
    restart?.();
  }

  /** Sends a due reminder. It runs in the flush loop, so it is never in
   * flight alongside an event wake, and only while no batch is held (an event
   * wake is on its way then). A reminder is skipped, not queued, when there is
   * no injector, the wake cap is used up or the session is busy: each means
   * the agent isn't idle or can't take it, and the next one comes an interval
   * later. */
  async #remind(st: AgentState, signal?: AbortSignal): Promise<void> {
    const { handle, reminder } = st.cfg;
    const injector = st.injectors.at(-1);
    st.reminderAt = Date.now() + reminder!.everyMs;
    if (!injector) {
      this.#log(`[${handle}] reminder skipped: no injector registered`);
      return;
    }
    if (st.limiter.waitMs() > 0) {
      this.#log(`[${handle}] reminder skipped: wake cap reached (${st.limiter.perHour}/hour)`);
      return;
    }
    const wake: Wake = { wake_id: randomUUID(), agent: handle, events: [], resync_required: false, reminder: reminder!.prompt };
    this.#noteLastWake(st, wake, st.limiter);
    await this.#noteProfile(st, wake, signal);
    const result = await settle(injector.deliver(wake));
    if (result === 'gone') {
      this.#drop(st, injector);
      // Try the previous injector, if any, at once.
      st.reminderAt = Date.now();
      return;
    }
    if (result !== 'accepted') {
      this.#log(`[${handle}] reminder skipped: injector ${injector.kind} busy`);
      return;
    }
    this.#signal(handle, 'woke');
    st.limiter.record();
    st.stats.wakes++;
    st.stats.reminders++;
    this.#log(`[${handle}] woke ${injector.kind} with a reminder`);
  }

  /** Touches one of `status`'s files, best effort: a failure is logged once
   * per file and never stops polling or a wake. */
  #signal(handle: string, kind: SignalKind): void {
    if (this.#signalDir === undefined) return;
    try {
      touchSignal(this.#signalDir, kind, handle);
      this.#signalFailed.delete(`${kind}-${handle}`);
    } catch (cause) {
      const key = `${kind}-${handle}`;
      if (this.#signalFailed.has(key)) return;
      this.#signalFailed.add(key);
      this.#log(`[${handle}] could not update ${kind}- in the run directory: ${errText(cause)}`);
    }
  }

  /** After an accepted wake: if the session's host reports it blocked on a
   * prompt for `stallMinutes`, log that once per prompt, with the wakes
   * accepted since (the injector took them, but the session can't act). Only
   * the handle, a time and a count are logged. */
  #noteBlocked(st: AgentState): void {
    const { handle, stallMinutes } = st.cfg;
    if (!stallMinutes) return;
    const { blockedSince } = promptSignal(handle);
    const b = st.blocked;
    if (blockedSince === null) {
      if (b.logged) this.#log(`[${handle}] no longer blocked on a prompt`);
      st.blocked = { since: 0, wakes: 0, logged: false };
      return;
    }
    if (b.since !== blockedSince) st.blocked = { since: blockedSince, wakes: 0, logged: false };
    st.blocked.wakes++;
    // Wall clock, like the file mtime (not the injectable #now used for caps).
    if (!st.blocked.logged && Date.now() - blockedSince >= stallMinutes * 60_000) {
      st.blocked.logged = true;
      const n = st.blocked.wakes;
      this.#log(`[${handle}] blocked on a prompt since ${clock(blockedSince)}, ${n} wake${n === 1 ? '' : 's'} pending`);
    }
  }

  /** Mentions use the general allowance first and the direct one only after
   * it. If this wake (spending `limiter`) takes the last slot of both, say
   * when the next one is possible: until then even a mention waits silently. */
  #noteLastWake(st: AgentState, wake: Wake, limiter: WakeLimiter): void {
    const afterThis = (l: WakeLimiter | null) => (!l ? Infinity : l === limiter ? l.waitAfterNextMs() : l.waitMs());
    const general = afterThis(st.limiter);
    const direct = afterThis(st.directLimiter);
    if (general > 0 && direct > 0) wake.wakes_resume_at = this.#now() + Math.min(general, direct);
  }

  /** Adds the account's posts left today to a wake when it is low, and the
   * listed tools' hash for the session to compare. Reads get_my_profile at
   * most once a minute; any failure leaves the wake as it is, so a missing or
   * older server never delays or blocks one. */
  async #noteProfile(st: AgentState, wake: Wake, signal?: AbortSignal): Promise<void> {
    const now = this.#now();
    if (now - st.profile.at >= POSTS_LEFT_MS) {
      st.profile.at = now;
      try {
        st.profile.value = await st.cfg.client.profileNotes(signal);
      } catch {
        st.profile.value = { postsLeft: null, toolsHash: null };
      }
    }
    const { postsLeft: left, toolsHash } = st.profile.value;
    if (toolsHash) wake.tools_hash = toolsHash;
    if (!left || left.remaining >= POSTS_LOW) return;
    wake.posts_left = left.remaining;
    if (left.resetsAt !== null) wake.posts_reset_at = left.resetsAt;
  }

  /** A post an earlier wake already named under this kind or a more specific
   * one. A mention after a plain post.created still wakes. An edit wakes
   * unless an earlier wake already carried that revision or a newer one: the
   * same edit arrives on the public stream and in the parent author's inbox
   * (um#364's eventPost), and only the first copy wakes. An edit with no
   * revision always wakes. */
  #seen(st: AgentState, r: EventRef): boolean {
    if (r.entity_type !== 'post') return false;
    const prev = st.recent.get(refKey(r));
    if (prev === undefined) return false;
    if (r.kind === 'post.edited')
      return r.revision !== undefined && prev.revision !== undefined && r.revision <= prev.revision;
    return (KIND_RANK[r.kind] ?? 0) <= prev.rank;
  }

  /** Tries to hand held batches to the agent's injector. Returns 0 when done,
   * else how long to wait before retrying. Logs counts only, never content. */
  async #flush(st: AgentState, pending: Map<string, AgentDelivery>, signal?: AbortSignal): Promise<number> {
    const { client, handle } = st.cfg;
    const batches = [...pending.values()];
    const count = batches.reduce((n, d) => n + d.events.length, 0);

    // Re-ack batches already handed off whose ack failed earlier.
    let fresh = batches.filter((d) => !st.handedOff.has(d.delivery_id));
    // A batch naming only posts and conversations an earlier wake already
    // named (a mention sent past the cap, then the same post held on the
    // all-posts subscription) costs no wake: those refs reached an injector,
    // so it is acknowledged without one, even over the cap.
    const now = this.#now();
    for (const [key, { at }] of st.recent) {
      if (now - at <= RECENT_MS) break;
      st.recent.delete(key);
    }
    const known = (d: AgentDelivery) => {
      const refs = toRefs([d]);
      return !d.resync_required && refs.length > 0 && refs.every((r) => this.#seen(st, r));
    };
    const stale = fresh.filter(known);
    if (stale.length) {
      for (const d of stale) {
        st.handedOff.add(d.delivery_id);
        st.capHeld.delete(d.delivery_id);
      }
      fresh = fresh.filter((d) => !stale.includes(d));
      this.#log(`[${handle}] ${stale.reduce((n, d) => n + d.events.length, 0)} event(s) already in an earlier wake; acknowledged without waking`);
    }
    if (fresh.length) {
      const notice = (s: string) => {
        if (st.heldNotice !== s) this.#log(`[${handle}] ${s}`);
        st.heldNotice = s;
      };
      const backingOff = st.retryAt - Date.now();
      if (backingOff > 0) return backingOff;
      const gathering = st.heldSince + this.#coalesceMs - Date.now();
      if (gathering > 0) return gathering;
      // Only plain new posts from broad subscriptions held: wait a little
      // longer for an inbox copy of the same post (UNI-573). They stay
      // unacknowledged meanwhile, so a restart re-serves them.
      const plainOnly = fresh.every(
        (d) =>
          !d.resync_required &&
          !st.directSubs.has(d.subscription_id) &&
          d.events.every((e) => e.kind === 'post.created'),
      );
      const plainWait = st.heldSince + this.#plainHoldMs - Date.now();
      if (plainOnly && plainWait > 0) return plainWait;
      const injector = st.injectors.at(-1);
      if (!injector) {
        notice(`holding ${count} event(s): no injector registered for this agent yet`);
        return this.#retryMs * 5;
      }
      // Over the cap, direct batches (inbox, mentions, DMs) still wake on
      // their own allowance; broad traffic waits and coalesces. A broad batch
      // with any mention or dm.* event goes out whole (acks are per batch).
      let send = fresh;
      let limiter = st.limiter;
      const capWait = st.limiter.waitMs();
      if (capWait > 0) {
        const direct = fresh.filter(
          (d) => st.directSubs.has(d.subscription_id) || d.events.some((e) => isDirectKind(e.kind)),
        );
        const directWait = direct.length && st.directLimiter ? st.directLimiter.waitMs() : Infinity;
        for (const d of fresh) if (directWait > 0 || !direct.includes(d)) st.capHeld.add(d.delivery_id);
        if (directWait > 0) {
          st.stats.delayed = count;
          notice(
            `wake cap reached (${st.limiter.perHour}/hour); delaying ${count} event(s) for ${Math.ceil(Math.min(capWait, directWait) / 1000)} s`,
          );
          return Math.min(capWait, directWait, 60_000);
        }
        send = direct;
        limiter = st.directLimiter!;
      }
      const wake = buildWake(handle, send, randomUUID(), st.directSubs);
      // Counted from batches, not wake.events, which may be deduplicated.
      const events = (ds: AgentDelivery[]) => ds.reduce((n, d) => n + d.events.length, 0);
      // Leave out posts an earlier wake already named; count the events
      // whose post is gone from this wake (not ones a mention still carries).
      wake.events = wake.events.filter((r) => !this.#seen(st, r));
      const kept = new Set(wake.events.map(refKey));
      const already = toRefs(send).filter((r) => this.#seen(st, r) && !kept.has(refKey(r))).length;
      if (already) wake.already_delivered = already;
      const stillHeld = events(fresh) - events(send);
      const heldBack = events(send.filter((d) => st.capHeld.has(d.delivery_id)));
      if (heldBack) wake.held_back = heldBack;
      if (stillHeld) wake.still_held = stillHeld;
      this.#noteLastWake(st, wake, limiter);
      await this.#noteProfile(st, wake, signal);
      // Exactly one deliver is in flight per agent: this loop awaits it with
      // no timeout, so a slow injector (an exec run, a busy session) is never
      // invoked again for the same batch, and a late `accepted` still counts.
      // A remote injector resolves `gone` when its connection drops.
      const result = await settle(injector.deliver(wake));
      if (result === 'gone') {
        this.#drop(st, injector);
        notice(`injector ${injector.kind} gone; ${st.injectors.length} left; holding ${count} event(s)`);
        return st.injectors.length ? 1 : this.#retryMs;
      }
      if (result !== 'accepted') {
        st.busy++;
        const backoff = Math.min(60_000, this.#retryMs * 2 ** (st.busy - 1));
        st.retryAt = Date.now() + backoff;
        notice(`injector ${injector.kind} busy (x${st.busy}); holding ${count} event(s), retry in ${backoff} ms`);
        return backoff;
      }
      st.busy = 0;
      st.retryAt = 0;
      this.#signal(handle, 'woke');
      limiter.record();
      if (st.cfg.reminder?.onlyWhenIdle) st.reminderAt = Date.now() + st.cfg.reminder.everyMs;
      st.stats.wakes++;
      st.stats.events += wake.events.length;
      this.#noteBlocked(st);
      st.stats.delayed = stillHeld;
      st.heldNotice = '';
      for (const d of send) {
        st.handedOff.add(d.delivery_id);
        st.capHeld.delete(d.delivery_id);
        // Each hand-off rests its subscription, so what arrives next queues
        // on the server and comes back as one batch: at most one wake per
        // window per subscription. The pause starts at the hand-off, so a
        // busy thread can't delay a wake, and a running pause is not
        // extended.
        if (this.#restingMs(st, d.subscription_id) <= 0) {
          const ms = st.directSubs.has(d.subscription_id)
            ? this.#directPauseMs
            : st.cfg.pauseSeconds === undefined
              ? this.#broadPauseMs
              : st.cfg.pauseSeconds * 1000;
          if (ms > 0) st.paused.set(d.subscription_id, Date.now() + ms);
        }
      }
      // Remembered only once accepted, so a busy or gone attempt never
      // hides a ref from the next wake.
      const at = this.#now();
      for (const r of wake.events) {
        if (r.entity_type !== 'post') continue;
        const prev = st.recent.get(refKey(r));
        const rank = Math.max(KIND_RANK[r.kind] ?? 0, prev?.rank ?? 0);
        const revision = Math.max(r.revision ?? 0, prev?.revision ?? 0) || undefined;
        st.recent.delete(refKey(r));
        st.recent.set(refKey(r), { at, rank, ...(revision ? { revision } : {}) });
      }
      while (st.recent.size > MAX_RECENT) st.recent.delete(st.recent.keys().next().value!);
      this.#log(
        `[${handle}] woke ${injector.kind} with ${wake.events.length} event(s)` +
          (limiter === st.directLimiter ? ` past the wake cap; ${stillHeld} still held` : ''),
      );
    }

    // Acknowledge what was handed off; batches the cap still holds wait.
    for (const d of batches.filter((b) => st.handedOff.has(b.delivery_id))) {
      // Not tied to the stop signal: a batch already handed off is always
      // acknowledged, even while the router is stopping.
      await client.acknowledge(d.subscription_id, d.delivery_id);
      st.handedOff.delete(d.delivery_id);
      pending.delete(d.subscription_id);
    }
    if (!pending.size) st.heldSince = 0;
    return 0;
  }
}
