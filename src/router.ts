import { randomUUID } from 'node:crypto';
import { clock, promptSignal, touchSignal, writeCapsSignal, writePushSignal, writeSubsSignal, type SignalKind, type SubsEntry } from './activity.ts';
import {
  ACCESS_GATE,
  KeyRejected,
  MAX_POLL_SUBSCRIPTIONS,
  MultiPollUnsupported,
  ToolRefused,
  type MultiPollResult,
  type ProfileNotes,
  type TiloriAgentClient,
} from './client.ts';
import { DEFAULT_PAUSE_SECONDS, DEFAULT_DIRECT_WAKES_PER_HOUR, DEFAULT_WAKES_PER_HOUR, type Reminder, type WakeEngine, unfilteredPostsWarning } from './config.ts';
import { PushStream, type PushOptions, type PushStatus } from './push.ts';
import { BuiltinPolicy, FailOpenWakewisePolicy, ShadowPolicy, type Lane as WakeLane, type ShadowDiff, type WakePolicy } from './policy.ts';
import type { LiveSettings } from './settings.ts';
import type {
  AgentDelivery,
  AgentSubscription,
  DeliverResult,
  EventRef,
  Injector,
  MarketOffReason,
  PollFailReason,
  SubscriptionSpec,
  Wake,
} from './types.ts';
import { KIND_RANK, MARKET_ENTITY_TYPES, MAX_DROPPED_IDS, buildWake, marketRefs, refKey, toRefs } from './wake.ts';
import {
  FILTERABLE_KINDS,
  MAX_DIGEST_ITEMS,
  MAX_FLOOR_READS,
  digestItem,
  digestRef,
  isUuid,
  loadDigest,
  runFilter,
  saveDigest,
  type DigestItem,
  type FilterEvent,
  type FilterReason,
  type WakeFilter,
} from './wake-filter.ts';
import { GATE_QUIET_CEILING, runGate } from './reminder-gate.ts';
import { DecisionRecorder } from './recorder.ts';

/** How long a delivered post or conversation is remembered. Longer than the
 * wake cap can hold a batch (one hour), so a held copy of something that went
 * out past the cap is still recognised when the cap lifts. */
/** Push mode: the least time between two polls of one agent, whatever
 * else asks for one, so a bug in the sweep logic is a slow poll, never a
 * spin against the account's rate budget (Bastion). */
export const PUSH_POLL_GAP_MS = 1_000;
/** Push mode: push down this long (and not refused) starts a long-poll
 * fallback for the agent (Don, 2026-11: after 5 min, not at the 60 s "down"
 * line). Each agent adds a random start delay of up to half of it, so a
 * gateway outage doesn't turn every agent into a poller in the same second,
 * and at most PUSH_FALLBACK_MAX agents of one router poll at once. */
export const PUSH_FALLBACK_AFTER_MS = 5 * 60_000;
export const PUSH_FALLBACK_MAX = 3;
const RECENT_MS = 2 * 3600_000;
/** Below this many posts left today, wakes say how many (UNI-393). */
const POSTS_LOW = 100;
/** How long a posts-left reading is reused before get_my_profile again. */
const POSTS_LEFT_MS = 60_000;
/** Bound on that memory, so a firehose can't grow it without limit. */
const MAX_RECENT = 5_000;
/** A batch of post events all older than this is a backlog, not news. */
export const BACKLOG_MS = 24 * 3600_000;
/** Most backlog post ids addressed to the agent that a wake line lists. */
export const BACKLOG_IDS = 10;
/** Efficient wakes §2: after a batch from a direct subscription (inbox,
 * mentions, DMs) is handed off, that subscription is not polled for this
 * long, so a follow-up (a correction, the next reply) queues on the server
 * and arrives with whatever else came in as one batch. */
const DIRECT_PAUSE_MS = 10_000;
/** While every subscription rests, `watching-` is refreshed this often, well
 * inside status's WATCHED_MS. */
const REST_SIGNAL_MS = 30_000;
/** The Market lane's one subscription (UNI-861 S2): the agent's Market inbox
 * with its transactions and executions, never its own actions. */
export const MARKET_SUBSCRIPTION: SubscriptionSpec = {
  scope: { type: 'inbox', include_transactions: true, include_executions: true },
  exclude_self: true,
};
/** How long Market polls may fail (network, timeouts) before the session is
 * told the Market wake is off. A refused key or subscription is told at once. */
const MARKET_OFF_MS = 120_000;

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
  /** Plain new posts from broad subscriptions make at most one wake per
   * this many minutes, counted from the last wake that carried any (validated
   * by postWakeMinutes; local config only). Unset or 0: only the router's
   * `plainHoldMs`. A direct batch ends the hold at once. */
  postWakeMinutes?: number;
  /** A periodic wake with the operator's own text (validated by reminderSettings). */
  reminder?: Reminder;
  /** Log once when the session has been blocked on a prompt this long with
   * wakes arriving (validated by stallMinutes; 0 or unset: off). */
  stallMinutes?: number;
  /** Tilori push via the gateway (push.ts): when set, events arrive on a
   * gateway stream and each frame triggers a zero-wait poll; there are no
   * long polls. Unset: long polls, as before. */
  push?: PushOptions;
  /** The agent's Market lane (UNI-861 S2), only when config.json records a
   * market_url: its own client for that address, with the same key. Long
   * polls only; push stays on the Tilori lane. */
  market?: { client: TiloriAgentClient };
  /** UNI-1029: the operator's wake filter (validated by wakeFilterSettings). */
  wakeFilter?: WakeFilter;
  /** Usernames or user ids whose posts the filter can never hold or drop
   * (config.json trusted_owners). */
  trustedOwners?: string[];
  /** trust_server applies: every account is trusted, so the filter can hold
   * or drop nothing (every post wakes). */
  trustAll?: boolean;
  /** UNI-1097 slice 4: record this agent's wake decisions (recorder.ts).
   * Applies only when the router also has `recordingsDir`. */
  recordDecisions?: boolean;
  /** UNI-1097 slice 2: rate-limiter engine ("builtin" | "wakewise"). */
  wakeEngine?: WakeEngine;
  /** UNI-1097 slice 2: mirror calls to wakewise in shadow alongside builtin. */
  shadow?: boolean;
}

/** This hour's wake counts for `tilori-agent config show`: counts only. */
export interface AgentUsage {
  wakes: { used: number; limit: number };
  /** Null when the direct allowance is off. */
  direct: { used: number; limit: number } | null;
  /** Events the wake cap is holding right now. */
  held: number;
  /** UNI-1029: today's wake filter counts; absent without a filter. */
  filter?: FilterDay & { digest_held: number };
}

export interface RouterOptions {
  agents: RouterAgentConfig[];
  logger?: (message: string) => void;
  /** Long-poll wait per poll_events call (default 20 s, max 25 s). */
  waitMs?: number;
  /** Push down this long starts the long-poll fallback (default 5 min). */
  pushFallbackMs?: number;
  /** Most agents of this router in the long-poll fallback at once (default 3). */
  pushFallbackMax?: number;
  random?: () => number;
  /** Base retry delay while a batch is held (no injector, busy). Busy
   * retries back off exponentially from here up to 60 s. Default 2 s. */
  retryMs?: number;
  /** Log once when one wake handoff has not been accepted after this long (default 30 s). Log only: nothing is released or retried. */
  slowDeliverMs?: number;
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
  /** Test seam: one minute of post_wake_minutes (default 60 s). */
  minuteMs?: number;
  /** How long a direct subscription rests after a hand-off (default 10 s). */
  directPauseMs?: number;
  /** How long a broad subscription rests after a hand-off, for an agent
   * without `pauseSeconds` (default 60 s). Generalises UNI-478's edit pause:
   * a burst queues on the server and arrives as one batch. */
  broadPauseMs?: number;
  /** While every subscription rests, refresh `watching-` this often (default 30 s). */
  restSignalMs?: number;
  /** The run directory for `status`'s files (attempting-, watching-, woke-),
   * or unset to write none (tests, or no private run directory). */
  signalDir?: string;
  /** Where decision recordings go (`<tilori home>/recordings`), for agents
   * with `recordDecisions`. Unset: nothing is recorded. */
  recordingsDir?: string;
  now?: () => number;
  /** Test seam: how long polls must fail before the session is told
   * (default: the agent's stall_minutes; 0 there still turns it off). */
  pollFailMs?: number;
  /** How long to wait between tries while the server refuses the agent's
   * key (default 60 s, UNI-761). Each try reads the key file again. */
  keyRetryMs?: number;
  /** Test seam: how long Market polls may fail before the session is told
   * the Market wake is off (default 2 min). */
  marketOffMs?: number;
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

export type LaneName = 'tilori' | 'market';

/** One event connection of an agent (UNI-861 S2; Pax 61007a93 1): its own
 * client, subscriptions, poll generations and failure state. The agent's
 * lanes share one `pending` map, flush loop, wake caps and injector, so a
 * wake with events from both is one wake. */
interface Lane {
  name: LaneName;
  client: TiloriAgentClient;
  subscriptions: SubscriptionSpec[];
  /** This lane's current subscriptions addressed to the agent (inbox,
   * mentions, DMs); the agent's `directSubs` is the union. */
  direct: Set<string>;
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
   * none is left and a new call until at most one is, so the lane never
   * holds more than two: the server's waiter budget is per resource and
   * user, so per lane (Pax 61007a93 1). */
  abandoned: number[];
  /** Subscriptions (by spec) re-subscribed after a per-id poll error, and
   * when. A second error within a renewal interval drops it instead. */
  resubscribed: Map<string, number>;
  /** Subscriptions (by spec) dropped after repeated poll errors, and when.
   * Kept across generations, so they stay dropped for a renewal interval. */
  dropped: Map<string, number>;
  /** Subscription ids to subscribe again at the next setup. */
  renewIds: Set<string>;
  /** Subscriptions resting after a hand-off, until when (Date.now()). */
  paused: Map<string, number>;
  /** Tilori lane: since when every poll or subscription setup has failed,
   * why (the last failure), and whether the session was told. Null while
   * polls work. */
  pollFail: null | { since: number; reason: PollFailReason; told: boolean };
  /** Tilori lane: since when the server has refused the key, or null. */
  keyRefusedSince: number | null;
  /** Market lane: since when it has failed, and whether the session was
   * told the Market wake is off. Null while it works. */
  off: null | { since: number; told: boolean };
  /** Market lane: the grant has no market:read (logged once; no line). */
  noGrant: boolean;
  /** Tilori lane, push mode only (cfg.push): `seq` counts frames and
   * reconnects, so a poller that saw `seq` knows to poll again once it moves. */
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
    /** When the current outage began (0: none; kept until `stable`), when
     * the long-poll fallback may start, and whether it is running. */
    lostAt: number;
    fallbackAt: number;
    polling: boolean;
  };
}

/** A held batch, stamped with the lane that delivered it, so it is
 * acknowledged through that lane's client (Pax 61007a93 3). A Market batch
 * holds only the events the lane passes on; its ack covers the whole
 * delivery. */
type Held = AgentDelivery & { lane: LaneName };

function newLane(name: LaneName, client: TiloriAgentClient, subscriptions: SubscriptionSpec[]): Lane {
  return {
    name,
    client,
    subscriptions,
    direct: new Set(),
    polled: makeKick(),
    onPolled: null,
    singleUntil: 0,
    abandoned: [],
    resubscribed: new Map(),
    dropped: new Map(),
    renewIds: new Set(),
    paused: new Map(),
    pollFail: null,
    keyRefusedSince: null,
    off: null,
    noGrant: false,
    push: null,
  };
}

interface AgentState {
  cfg: RouterAgentConfig;
  /** Opt-in decision recorder; null when off. Never throws. */
  recorder: DecisionRecorder | null;
  /** The Tilori lane always; the Market lane when config.json has a
   * market_url. */
  lanes: { tilori: Lane; market: Lane | null };
  /** Decides whether a wake may go, which allowance it spends and when the
   * next is possible: the normal cap, plus a separate direct one so broad
   * traffic never starves a mention or direct message. */
  policy: WakePolicy;
  /** Subscriptions whose batches are direct signals (inbox, mentions, DMs,
   * and the Market lane's inbox): every lane's `direct`. */
  directSubs: Set<string>;
  /** Batches (by delivery id) the wake cap has delayed, for the wake's count. */
  capHeld: Set<string>;
  /** Old post events acknowledged without a wake since the last wake. */
  backlog: { count: number; from: number; to: number; to_you?: string[]; to_you_more?: number } | null;
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
  /** Batches handed to an injector whose ack failed: ack again, never re-wake.
   * Acks are driven from `pending`, whose entries carry their lane. */
  handedOff: Set<string>;
  /** When the oldest batch now held arrived (0 when none is held). */
  heldSince: number;
  /** When a wake last carried plain posts from a broad subscription
   * (Date.now; 0 = none yet): post_wake_minutes counts from here. */
  plainWokeAt: number;
  /** When `watching-` was last refreshed for a rest (0: not yet). */
  restSignalAt: number;
  heldNotice: string;
  /** When the next reminder is due (unused without a reminder). An event
   * wake pushes it back when the reminder is only for idle agents. */
  reminderAt: number;
  /** UNI-1044: quiet gate answers in a row since a reminder last went out. */
  gateQuiet: number;
  stats: { wakes: number; events: number; delayed: number; reminders: number };
  /** UNI-1029 wake filter state (unused without a filter). */
  filter: FilterState;
  /** The last get_my_profile reading and when it was taken. */
  profile: { at: number; value: ProfileNotes; reading?: Promise<void> };
  /** The prompt the session is blocked on (by its signal's mtime), the wakes
   * accepted since, and whether the stall line was logged for it. */
  blocked: { since: number; wakes: number; logged: boolean };
}

/** UNI-1029: what the wake filter decided, held and dropped for one agent. */
interface FilterState {
  /** Batches (by delivery id) already filtered and woken, so a batch the cap
   * delays isn't filtered again. Pruned to what `pending` still holds. */
  passed: Set<string>;
  /** Posts held for the next digest wake: acknowledged already (a held batch
   * would block its subscription), kept in the run directory so a restart
   * still delivers them. */
  digest: DigestItem[];
  /** When the digest is due (Date.now; 0 = nothing held). */
  digestDue: number;
  /** Dropped since the last wake, for the next wake's line. */
  dropped: NonNullable<Wake['filter_dropped']> | null;
  /** Today's (UTC) counts for `config show`, and the dropped ids. */
  today: FilterDay;
}

export interface FilterDay {
  day: string;
  woke: number;
  held: number;
  dropped: number;
  failed: number;
  dropped_ids: string[];
}

const MAX_DAY_IDS = 50;
const newFilterDay = (): FilterDay => ({ day: new Date().toISOString().slice(0, 10), woke: 0, held: 0, dropped: 0, failed: 0, dropped_ids: [] });

/** Scopes whose events are addressed to the agent itself. */
const DIRECT_SCOPES = new Set(['inbox', 'mentions', 'direct_messages']);
const DM_KINDS = new Set(['dm.request', 'dm.message', 'dm.accepted']);
const isDirectKind = (kind: string) => kind === 'mention' || kind.startsWith('dm.');

/** UNI-1106: DM events in a set of batches as " [dm <kind> <entity id>, ...]", ids only, so a held or delivered DM shows in the log. */
function dmNote(ds: { events: { kind: string; entity_id: string }[] }[]): string {
  const dms = ds.flatMap((d) => d.events).filter((e) => e.kind.startsWith('dm.'));
  if (!dms.length) return '';
  // Only known kinds and UUID ids reach the log, so a hostile server value
  // cannot forge a log line with a newline or control character.
  const shown = dms
    .slice(0, 5)
    .map((e) => `${DM_KINDS.has(e.kind) ? e.kind : 'dm.other'} ${isUuid(e.entity_id) ? e.entity_id : 'invalid-id'}`)
    .join(', ');
  return ` [dm ${shown}${dms.length > 5 ? `, +${dms.length - 5} more` : ''}]`;
}

/** A failure's reason in fixed words, for the session's poll line. */
export function failReason(cause: unknown): PollFailReason {
  const name = cause instanceof Error ? cause.name : '';
  const text = errText(cause);
  if (text.includes(ACCESS_GATE)) return 'access';
  if (cause instanceof KeyRejected) return 'auth';
  if (/\b401\b|unauthori[sz]ed|invalid (api |agent )?key|key (was )?(revoked|refused|invalid)/i.test(text)) return 'auth';
  if (name === 'TimeoutError' || /timed? ?out|ETIMEDOUT/i.test(text)) return 'timeout';
  if (cause instanceof ToolRefused) return 'refused';
  if (/fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket|network|\b50[234]\b/i.test(text)) return 'network';
  return 'other';
}

/** Why the Market lane failed, in fixed words, or `no_grant` when the key's
 * Market grant lacks market:read: then there is no Market line at all
 * (Juniper 644de98e 5). Only the class of failure is kept, never its text. */
export function marketReason(cause: unknown, phase: 'setup' | 'poll'): MarketOffReason | 'no_grant' {
  const text = errText(cause);
  // Only a missing scope is silent (Pax a1d0373b): any other 403, such as
  // the access gate or participation turned off, is told as not authorized.
  if (/insufficient_scope|market:read/i.test(text)) return 'no_grant';
  if ((cause as { code?: unknown } | null)?.code === 403 || /\b403\b/.test(text)) return 'not_authorized';
  switch (failReason(cause)) {
    case 'auth':
    case 'access':
      return 'not_authorized';
    case 'network':
    case 'timeout':
      return 'unreachable';
    case 'refused':
      return phase === 'setup' ? 'subscription_refused' : 'other';
    default:
      return 'other';
  }
}

const errText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** A 401 whose body names the token invalid (Bastion 487eaa99): it doesn't
 * recover by itself, unlike 5xx, 429, the network, or a bare 401 from
 * something in between. Only a new key in the key file ends it (UNI-761). */
export function keyRefused(cause: unknown): boolean {
  return cause instanceof KeyRejected && /invalid_token/.test(cause.message);
}

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
 * An agent with a Market address also has a Market lane: one inbox
 * subscription on Market whose transaction and execution events join the
 * same wakes (UNI-861 S2).
 */
export class Router {
  readonly #agents = new Map<string, AgentState>();
  readonly #log: (m: string) => void;
  readonly #waitMs: number;
  readonly #fallbackMs: number;
  readonly #fallbackMax: number;
  readonly #random: () => number;
  /** Agents now in the long-poll fallback. */
  readonly #pollers = new Set<string>();
  readonly #retryMs: number;
  readonly #slowDeliverMs: number;
  readonly #renewEveryMs: number;
  readonly #coalesceMs: number;
  readonly #plainHoldMs: number;
  readonly #minuteMs: number;
  readonly #directPauseMs: number;
  readonly #broadPauseMs: number;
  readonly #restSignalMs: number;
  readonly #now: () => number;
  readonly #signalDir: string | undefined;
  readonly #recordingsDir: string | undefined;
  readonly #signalFailed = new Set<string>();
  readonly #pollFailMs: number | undefined;
  readonly #keyRetryMs: number;
  readonly #marketOffMs: number;

  constructor(options: RouterOptions) {
    this.#log = options.logger ?? (() => {});
    this.#waitMs = options.waitMs ?? 20_000;
    this.#fallbackMs = options.pushFallbackMs ?? PUSH_FALLBACK_AFTER_MS;
    this.#fallbackMax = options.pushFallbackMax ?? PUSH_FALLBACK_MAX;
    this.#random = options.random ?? Math.random;
    this.#retryMs = options.retryMs ?? 2_000;
    this.#slowDeliverMs = options.slowDeliverMs ?? 30_000;
    this.#renewEveryMs = options.renewEveryMs ?? 6 * 3600_000;
    this.#coalesceMs = options.coalesceMs ?? 3_000;
    this.#plainHoldMs = Math.max(this.#coalesceMs, options.plainHoldMs ?? 30_000);
    this.#minuteMs = options.minuteMs ?? 60_000;
    this.#directPauseMs = options.directPauseMs ?? DIRECT_PAUSE_MS;
    this.#broadPauseMs = options.broadPauseMs ?? DEFAULT_PAUSE_SECONDS * 1000;
    this.#restSignalMs = options.restSignalMs ?? REST_SIGNAL_MS;
    this.#now = options.now ?? Date.now;
    this.#signalDir = options.signalDir;
    this.#recordingsDir = options.recordingsDir;
    this.#pollFailMs = options.pollFailMs;
    this.#keyRetryMs = options.keyRetryMs ?? 60_000;
    this.#marketOffMs = options.marketOffMs ?? MARKET_OFF_MS;
    for (const cfg of options.agents) {
      if (this.#agents.has(cfg.handle)) throw new Error(`Agent ${cfg.handle} listed twice.`);
      const broad = unfilteredPostsWarning(cfg.handle, cfg.subscriptions);
      if (broad) this.#log(broad);
      if (cfg.market && cfg.market.client === cfg.client) throw new Error(`Agent ${cfg.handle}: the Market lane needs its own client.`);
      const recorder =
        cfg.recordDecisions && this.#recordingsDir !== undefined
          ? new DecisionRecorder(this.#recordingsDir, cfg.handle, {
              now: this.#now,
              onError: (m) => this.#log(`[${cfg.handle}] ${m}`),
            })
          : null;
      const st: AgentState = {
        cfg,
        recorder,
        lanes: {
          tilori: newLane('tilori', cfg.client, cfg.subscriptions),
          market: cfg.market ? newLane('market', cfg.market.client, [MARKET_SUBSCRIPTION]) : null,
        },
        policy: this.#buildPolicy(cfg, recorder),
        directSubs: new Set(),
        capHeld: new Set(),
        recent: new Map(),
        backlog: null,
        injectors: [],
        busy: 0,
        retryAt: 0,
        kick: makeKick(),
        handedOff: new Set(),
        heldSince: 0,
        plainWokeAt: 0,
        restSignalAt: 0,
        heldNotice: '',
        reminderAt: cfg.reminder ? Date.now() + cfg.reminder.everyMs : 0,
        gateQuiet: 0,
        stats: { wakes: 0, events: 0, delayed: 0, reminders: 0 },
        filter: {
          passed: new Set(),
          digest: cfg.wakeFilter && this.#signalDir !== undefined ? loadDigest(this.#signalDir, cfg.handle) : [],
          digestDue: 0,
          dropped: null,
          today: newFilterDay(),
        },
        profile: { at: -Infinity, value: { postsLeft: null, toolsHash: null, askOwner: null } },
        blocked: { since: 0, wakes: 0, logged: false },
      };
      // A digest reloaded after a restart is due from when it was first held.
      if (st.filter.digest.length && cfg.wakeFilter)
        st.filter.digestDue = Math.min(...st.filter.digest.map((it) => it.at)) + cfg.wakeFilter.digestMs;
      this.#agents.set(cfg.handle, st);
      const t = st.lanes.tilori;
      if (cfg.push) t.push = { stream: this.#pushStream(st, cfg.push), seq: 0, kick: makeKick(), back: false, caught: 0, aliveAt: 0, polledAt: 0, lostAt: 0, fallbackAt: 0, polling: false };
    }
  }

  /** Builds the agent's WakePolicy from local config only. */
  #buildPolicy(cfg: RouterAgentConfig, recorder: DecisionRecorder | null): WakePolicy {
    const normal = cfg.wakesPerHour ?? DEFAULT_WAKES_PER_HOUR;
    const direct = cfg.directWakesPerHour ?? DEFAULT_DIRECT_WAKES_PER_HOUR;
    const engine = cfg.wakeEngine ?? 'builtin';
    if (cfg.shadow && engine === 'wakewise') {
      throw new Error(`Agent ${cfg.handle}: shadow cannot be true when wake_engine is "wakewise".`);
    }
    if (cfg.shadow) {
      let lastDiffLogAt = -Infinity;
      const onDiff = (diff: ShadowDiff) => {
        if (recorder) {
          recorder.recordShadowDiff({
            method: diff.method,
            builtin: diff.builtin,
            wakewise: diff.wakewise,
            lane: diff.lane,
          });
          return;
        }
        const now = this.#now();
        if (lastDiffLogAt === -Infinity || now - lastDiffLogAt >= 60_000) {
          lastDiffLogAt = now;
          this.#log(
            `[${cfg.handle}] wakewise shadow diff (${diff.method}): builtin=${JSON.stringify(diff.builtin)} wakewise=${JSON.stringify(diff.wakewise)}`,
          );
        }
      };
      return new ShadowPolicy(normal, direct, {
        now: this.#now,
        onDiff,
        onError: (m) => this.#log(`[${cfg.handle}] ${m}`),
      });
    }
    if (engine === 'wakewise') {
      return new FailOpenWakewisePolicy(normal, direct, {
        now: this.#now,
        onError: (m) => this.#log(`[${cfg.handle}] ${m}`),
      });
    }
    return new BuiltinPolicy(normal, direct, this.#now);
  }

  /** The agent's lanes, Tilori first. */
  #laneList(st: AgentState): Lane[] {
    return st.lanes.market ? [st.lanes.tilori, st.lanes.market] : [st.lanes.tilori];
  }

  /** The push stream for an agent, wired to its poll loop, status file and
   * monitor lines. Push is for the Tilori lane only. */
  #pushStream(st: AgentState, options: PushOptions): PushStream {
    const handle = st.cfg.handle;
    const lane = st.lanes.tilori;
    const nudge = () => {
      const p = lane.push!;
      p.seq++;
      const k = p.kick;
      p.kick = makeKick();
      k.fire();
    };
    return new PushStream(options, {
      frame: () => nudge(),
      connected: (back) => {
        if (back && !lane.push!.back) {
          lane.push!.back = true;
          lane.push!.caught = 0;
        }
        this.#log(`[${handle}] push stream open${back ? ' again' : ''}`);
        nudge();
      },
      stable: () => {
        const p = lane.push!;
        // Push holds again: the outage and the fallback are over.
        p.lostAt = 0;
        this.#fallbackStop(handle, p);
        if (!p.back) return;
        p.back = false;
        this.#pushLine(st, { state: 'back', caught: p.caught });
      },
      down: (since) => this.#pushLine(st, { state: 'down', since }),
      alive: () => {
        // Push mode polls only on a frame, so the stream being alive is
        // what "watched" means; at most one file touch per 30 s.
        const now = Date.now();
        if (now - lane.push!.aliveAt < 30_000) return;
        lane.push!.aliveAt = now;
        this.#signal(handle, 'watching');
        // Keeps `push-` fresh for `status` while nothing changes.
        this.#pushStatus(handle, lane.push!.stream.status);
      },
      status: (s) => {
        this.#pushStatus(handle, s);
        const p = lane.push;
        // An outage starts at the first failed attempt and spans short-lived
        // streams until `stable`. A refused key isn't an outage: a poll
        // would be refused too. One extra zero-wait sweep (the nudge) wakes
        // the poller so it learns when the fallback is due.
        if (p && !p.lostAt && (s.state === 'reconnecting' || s.state === 'down')) {
          p.lostAt = Date.now();
          p.fallbackAt = p.lostAt + this.#fallbackMs + Math.round(this.#random() * (this.#fallbackMs / 2));
          nudge();
        }
      },
      log: (m) => this.#log(`[${handle}] ${m}`),
    });
  }

  /** Reads get_my_profile at most once a minute, and writes `caps-` from it.
   * A failed read leaves the last `caps-` as it was: losing ask_owner is
   * rare, and a stale `true` only lets stop-check ask once too often (Pax
   * cdcfe9b5). Never throws. */
  async #readProfile(st: AgentState, signal?: AbortSignal): Promise<void> {
    // A wake during the start-up read waits for that read, not a second one.
    if (st.profile.reading) return st.profile.reading;
    const now = this.#now();
    if (now - st.profile.at < POSTS_LEFT_MS) return;
    st.profile.at = now;
    const read = (async () => {
      try {
        st.profile.value = await st.cfg.client.profileNotes(signal);
      } catch {
        st.profile.value = { postsLeft: null, toolsHash: null, askOwner: null };
      }
      if (st.profile.value.askOwner !== null) this.#capsStatus(st.cfg.handle, st.profile.value.askOwner);
    })();
    st.profile.reading = read;
    try {
      await read;
    } finally {
      st.profile.reading = undefined;
    }
  }

  /** Writes `caps-<agent>` for stop-check (best effort, logged once). */
  #capsStatus(handle: string, askOwner: boolean) {
    if (this.#signalDir === undefined) return;
    try {
      writeCapsSignal(this.#signalDir, handle, askOwner);
      this.#signalFailed.delete(`caps-${handle}`);
    } catch (cause) {
      const key = `caps-${handle}`;
      if (this.#signalFailed.has(key)) return;
      this.#signalFailed.add(key);
      this.#log(`[${handle}] could not update caps- in the run directory: ${errText(cause)}`);
    }
  }

  /** Writes `subs-<agent>` for `status` (best effort): each desired scope as
   * followed, refused (the server's code) or failed. */
  #subsStatus(handle: string, wanted: string[], subs: AgentSubscription[], outcomes: Map<string, SubsEntry>) {
    if (this.#signalDir === undefined) return;
    const entries: SubsEntry[] = [];
    for (const scope of new Set(wanted)) {
      if (subs.some((s) => s.scope.type === scope)) entries.push({ scope, state: 'active' });
      else entries.push(outcomes.get(scope) ?? { scope, state: 'failed' });
    }
    try {
      writeSubsSignal(this.#signalDir, handle, entries);
    } catch (cause) {
      const key = `subs-${handle}`;
      if (this.#signalFailed.has(key)) return;
      this.#signalFailed.add(key);
      this.#log(`[${handle}] could not update subs- in the run directory: ${errText(cause)}`);
    }
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
    this.#monitorLine(st, { push });
  }

  /** A monitor line (push, polls or Market off) to the newest injector,
   * outside the wake caps, never acknowledged. False when no injector is
   * registered. */
  #monitorLine(st: AgentState, line: Pick<Wake, 'push' | 'polls' | 'market_off'>): boolean {
    const injector = st.injectors.at(-1);
    if (!injector) return false;
    const wake: Wake = { wake_id: randomUUID(), agent: st.cfg.handle, events: [], resync_required: false, ...line };
    void Promise.resolve()
      .then(() => injector.deliver(wake))
      .catch(() => {});
    return true;
  }

  /** A Tilori poll or subscription setup failed. Once failures have lasted
   * stall_minutes with no success between, tell the session once: nothing
   * else would, since no wake can arrive. Only fixed words reach it. */
  #pollFailed(st: AgentState, lane: Lane, cause: unknown): number | null {
    const now = Date.now();
    const f = (lane.pollFail ??= { since: now, reason: 'other', told: false });
    f.reason = failReason(cause);
    const { handle, stallMinutes } = st.cfg;
    // A refused key won't recover by itself (UNI-761): say so once, mark it
    // for `status`, and try again only slowly, reading the key file each time.
    const refused = keyRefused(cause);
    if (refused) {
      this.#signal(handle, 'rejected');
      if (lane.keyRefusedSince === null) {
        lane.keyRefusedSince = now;
        this.#log(
          `[${handle}] Tilori refused this agent's key (HTTP 401 invalid_token). Re-run tilori-agent init --agent ${handle} ` +
            `with the agent's key from Tilori; until then the key file is read again every ${Math.round(this.#keyRetryMs / 1000)} s.`,
        );
      }
    }
    const wait = refused ? this.#keyRetryMs : null;
    if (!stallMinutes || f.told) return wait;
    // The session hears at once: waiting stall_minutes wouldn't help.
    if (!refused && now - f.since < (this.#pollFailMs ?? stallMinutes * 60_000)) return wait;
    // Without an injector there is no session to tell; try at the next failure.
    const line = { state: 'failing' as const, since: f.since, reason: f.reason, ...(refused ? { key_refused: true as const } : {}) };
    if (!this.#monitorLine(st, { polls: line })) return wait;
    f.told = true;
    this.#log(`[${handle}] told the session that polls have failed since ${clock(f.since)} (${f.reason})`);
    return wait;
  }

  /** A Market lane setup or poll failed (Bastion b9dd0cb9 2 and 4): logs
   * fixed words only, never the server's text, the key or the URL, and tells
   * the session once that the Market wake is off. Failures that won't pass
   * by themselves are told at once, others once they have lasted
   * marketOffMs. A grant without market:read is no line at all, and is
   * retried only at the renewal interval. Returns how long to wait. */
  #marketFailed(st: AgentState, lane: Lane, cause: unknown, phase: 'setup' | 'poll', attempt: number, backoff: number): number {
    const { handle } = st.cfg;
    const reason = marketReason(cause, phase);
    if (reason === 'no_grant') {
      if (!lane.noGrant) this.#log(`[${handle}] Market: this key's Market grant has no market:read; no Market wakes`);
      lane.noGrant = true;
      return this.#renewEveryMs;
    }
    const wait = keyRefused(cause) ? this.#keyRetryMs : backoff;
    this.#log(`[${handle}] Market ${phase} failed (${reason}, attempt ${attempt}, retry in ${wait} ms)`);
    const now = Date.now();
    const off = (lane.off ??= { since: now, told: false });
    if (off.told) return wait;
    const lasting = reason === 'not_authorized' || reason === 'subscription_refused' || now - off.since >= this.#marketOffMs;
    if (lasting && this.#monitorLine(st, { market_off: reason })) {
      off.told = true;
      this.#log(`[${handle}] told the session that the Market wake is off (${reason})`);
    }
    return wait;
  }

  /** A failed lane setup or poll: the Tilori lane's rules or the Market
   * lane's. Returns how long to wait, logging as each lane does. */
  #laneFailed(
    st: AgentState,
    lane: Lane,
    cause: unknown,
    phase: 'setup' | 'poll',
    attempt: number,
    backoff: number,
    tiloriLine: () => string,
  ): number {
    if (lane.name === 'market') return this.#marketFailed(st, lane, cause, phase, attempt, backoff);
    const slow = this.#pollFailed(st, lane, cause);
    if (slow === null) this.#log(`[${st.cfg.handle}] ${tiloriLine()}`);
    return slow ?? backoff;
  }

  /** A poll succeeded: if the session was told polls fail, say they work
   * again. A Market lane that recovers sends no line: its events are the
   * news (Wren 4b976197). */
  #pollOk(st: AgentState, lane: Lane): void {
    if (lane.name === 'market') {
      if (lane.off) this.#log(`[${st.cfg.handle}] Market works again`);
      lane.off = null;
      return;
    }
    if (lane.keyRefusedSince !== null) {
      lane.keyRefusedSince = null;
      this.#log(`[${st.cfg.handle}] Tilori accepts the agent's key again`);
    }
    const f = lane.pollFail;
    if (!f) return;
    lane.pollFail = null;
    if (f.told && this.#monitorLine(st, { polls: { state: 'ok' } }))
      this.#log(`[${st.cfg.handle}] told the session that polls work again`);
  }

  /** Whether this agent polls instead of waiting for push: push has been out
   * for the fallback delay, isn't refused, and a poller slot is free. Says
   * "polling" once per outage when it starts. */
  #fallbackOn(st: AgentState, p: NonNullable<Lane['push']>): boolean {
    const { handle } = st.cfg;
    if (!p.lostAt || p.stream.status.state === 'refused' || Date.now() < p.fallbackAt) {
      this.#fallbackStop(handle, p);
      return false;
    }
    if (p.polling) return true;
    if (this.#pollers.size >= this.#fallbackMax) return false;
    this.#pollers.add(handle);
    p.polling = true;
    this.#log(`[${handle}] push down; polling until it holds again`);
    this.#pushLine(st, { state: 'down', since: p.lostAt, polling: true });
    return true;
  }

  #fallbackStop(handle: string, p: NonNullable<Lane['push']>) {
    if (!p.polling) return;
    p.polling = false;
    this.#pollers.delete(handle);
    this.#log(`[${handle}] push holds; long-poll fallback stopped`);
  }

  /** Push mode: waits for a frame or a reconnect, or until `untilMs` from
   * now. Real time (`Date.now()`), like the pauses that set `untilMs` and the
   * timers that end them; `this.#now` is a fakeable clock for the wake caps
   * only. */
  async #waitPush(lane: Lane, seen: number, signal: AbortSignal, untilMs = Infinity): Promise<void> {
    const p = lane.push!;
    const end = Date.now() + untilMs;
    while (p.seq === seen && !signal.aborted && Date.now() < end)
      await sleep(Math.min(this.#renewEveryMs, end - Date.now()), signal, p.kick.promise);
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
    const directUsed = st.policy.used('direct');
    return {
      wakes: { used: st.policy.used('normal')!, limit: st.policy.limit('normal') },
      direct: directUsed === null ? null : { used: directUsed, limit: st.policy.limit('direct') },
      held: st.capHeld.size ? st.stats.delayed : 0,
      ...(st.cfg.wakeFilter ? { filter: { ...this.#filterDay(st), digest_held: st.filter.digest.length } } : {}),
    };
  }

  /** Applies reloaded settings (live reload, UNI-480): the caps,
   * pause_seconds (from the next hand-off), post_wake_minutes (from the
   * next check of what's held), the reminder interval and
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
    note('wakes_per_hour', st.policy.limit('normal'), live.wakesPerHour);
    st.policy.resize('normal', live.wakesPerHour);
    note('direct_wakes_per_hour', st.policy.limit('direct'), live.directWakesPerHour);
    st.policy.resize('direct', live.directWakesPerHour);
    if (
      (live.wakeEngine !== undefined && live.wakeEngine !== (st.cfg.wakeEngine ?? 'builtin')) ||
      (live.shadow !== undefined && live.shadow !== (st.cfg.shadow ?? false))
    ) {
      this.#log(`[${handle}] wake_engine/shadow change takes effect on restart`);
    }
    note('pause_seconds', st.cfg.pauseSeconds ?? this.#broadPauseMs / 1000, live.pauseSeconds);
    note('post_wake_minutes', st.cfg.postWakeMinutes ?? 0, live.postWakeMinutes);
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
      postWakeMinutes: live.postWakeMinutes,
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
          const push = st.lanes.tilori.push;
          try {
            await Promise.all([
              this.#runAgent(st, stop.signal).finally(end),
              push ? push.stream.run(stop.signal) : Promise.resolve(),
            ]);
          } finally {
            signal?.removeEventListener('abort', end);
          }
        } finally {
          // End the MCP sessions; a cancelled long poll leaves one open.
          st.recorder?.close();
          await Promise.all(this.#laneList(st).map((lane) => lane.client.close()));
        }
      }),
    );
  }

  /** One flush loop for the agent's lifetime over the shared `pending`, and
   * each lane's own subscription generations beside it (Pax 61007a93 2): a
   * lane renewing never ends the other lane's polls or drops its held
   * batches. */
  async #runAgent(st: AgentState, signal: AbortSignal): Promise<void> {
    const pending = new Map<string, Held>();
    // One profile read at start, so stop-check's caps- exists before the
    // first wake. It never delays polling.
    void this.#readProfile(st, signal);
    await Promise.all([
      this.#flushLoop(st, pending, signal),
      ...this.#laneList(st).map((lane) => this.#runLane(st, lane, pending, signal)),
    ]);
  }

  async #runLane(st: AgentState, lane: Lane, pending: Map<string, Held>, signal: AbortSignal): Promise<void> {
    const { handle } = st.cfg;
    const tilori = lane.name === 'tilori';
    let failures = 0;
    let quickRestarts = 0;

    while (!signal.aborted) {
      let subs: AgentSubscription[];
      let skipped: Error | null = null;
      const outcomes = new Map<string, SubsEntry>();
      const now = Date.now();
      for (const [key, at] of lane.resubscribed) if (now - at > this.#renewEveryMs) lane.resubscribed.delete(key);
      for (const [key, at] of lane.dropped) if (now - at > this.#renewEveryMs) lane.dropped.delete(key);
      try {
        // Setting up counts as an attempt: a router that can't reach Tilori
        // at all must show as polling-but-failing, not as nothing running.
        // `status` is about Tilori, so only the Tilori lane touches it.
        if (tilori) this.#signal(handle, 'attempting');
        subs = await lane.client.ensureSubscriptions(lane.subscriptions, {
          signal,
          // Subscriptions that just failed a poll are subscribed again.
          renewIds: lane.renewIds,
          // The Market lane logs fixed words only (Bastion b9dd0cb9 4).
          log: tilori ? (m) => this.#log(`[${handle}] ${m}`) : () => {},
          skipped: (cause, spec) => {
            skipped = cause;
            const code = cause instanceof ToolRefused ? cause.code : undefined;
            outcomes.set(spec.scope.type, {
              scope: spec.scope.type,
              state: cause instanceof ToolRefused ? 'refused' : 'failed',
              ...(code ? { code } : {}),
            });
          },
        });
        lane.renewIds.clear();
        if (tilori) this.#subsStatus(handle, lane.subscriptions.map((s) => s.scope.type), subs, outcomes);
        failures = 0;
      } catch (cause) {
        if (signal.aborted) return;
        failures++;
        const backoff = Math.min(60_000, 1000 * 2 ** (failures - 1));
        const line = () => `could not set up subscriptions (retry in ${backoff} ms): ${errText(cause)}`;
        await sleep(this.#laneFailed(st, lane, cause, 'setup', failures, backoff, line), signal);
        continue;
      }
      if (!subs.length) {
        if (tilori) {
          this.#log(`[${handle}] no usable subscriptions; retrying in 60 s`);
          await sleep(60_000, signal);
        } else {
          failures++;
          const cause = skipped ?? new ToolRefused('subscription refused');
          await sleep(this.#marketFailed(st, lane, cause, 'setup', failures, 60_000), signal);
        }
        continue;
      }
      lane.noGrant = false;
      this.#log(`[${handle}] following ${tilori ? '' : 'Market '}${subs.map((s) => s.scope.type).join(', ')}`);
      lane.direct = new Set(subs.filter((s) => DIRECT_SCOPES.has(s.scope.type)).map((s) => s.id));
      st.directSubs = new Set(this.#laneList(st).flatMap((l) => [...l.direct]));

      // One generation runs until renewal is due or a subscription vanishes.
      const gen = new AbortController();
      const stopGen = () => gen.abort();
      signal.addEventListener('abort', stopGen, { once: true });
      const renewal = setTimeout(stopGen, this.#renewEveryMs);
      const started = Date.now();
      try {
        await this.#pollAgent(st, lane, subs, pending, gen);
      } finally {
        clearTimeout(renewal);
        signal.removeEventListener('abort', stopGen);
      }
      // This lane's held batches stay unacknowledged and are re-served next
      // generation; the other lane's stay held (Pax 61007a93 2).
      for (const [id, d] of pending) {
        if (d.lane !== lane.name) continue;
        pending.delete(id);
        st.capHeld.delete(d.delivery_id);
      }
      if (!pending.size) st.heldSince = 0;
      // A generation that ended at once (a subscription keeps vanishing) backs off.
      if (signal.aborted) return;
      quickRestarts = Date.now() - started < 5_000 ? quickRestarts + 1 : 0;
      if (quickRestarts > 1) await sleep(Math.min(60_000, 1000 * 2 ** (quickRestarts - 2)), signal);
    }
  }

  /** Takes a delivered batch into `pending`, stamped with its lane. The
   * Market lane passes on only transaction and execution events (Bastion
   * b9dd0cb9 3): a batch with nothing else is acknowledged here, before
   * `pending`, so it takes no cap slot and touches no wake memory (Pax
   * 61007a93 4). True when the batch is held for a wake. */
  async #admit(st: AgentState, lane: Lane, d: AgentDelivery, pending: Map<string, Held>, signal: AbortSignal): Promise<boolean> {
    if (!(d.events.length > 0 || d.resync_required)) return false;
    let events = d.events;
    if (lane.name === 'market') {
      events = d.events.filter((e) => MARKET_ENTITY_TYPES.has(e.entity_type));
      if (!events.length && !d.resync_required) {
        try {
          await lane.client.acknowledge(d.subscription_id, d.delivery_id);
        } catch {
          if (signal.aborted) return false;
          // Re-served by the next poll; don't spin on it meanwhile.
          this.#log(`[${st.cfg.handle}] Market acknowledge failed; it is re-served and acknowledged again`);
          await sleep(this.#retryMs * 5, signal);
        }
        return false;
      }
    }
    // Only the first held batch starts the hold, so it has a fixed end. A
    // batch arriving while others are still held (ack retry, deliver in
    // flight) joins their wake without a hold of its own.
    if (!pending.size) st.heldSince = Date.now();
    pending.set(d.subscription_id, { ...d, events, lane: lane.name });
    return true;
  }

  /** Polls all of a lane's subscriptions with one long poll at a time
   * (`subscription_ids`, UNI-380), so the lane holds one server waiter
   * instead of one per subscription. Held subscriptions are left out until
   * acknowledged. Falls back to one long poll per subscription when the
   * server predates `subscription_ids`. */
  async #pollAgent(
    st: AgentState,
    lane: Lane,
    subs: AgentSubscription[],
    pending: Map<string, Held>,
    gen: AbortController,
  ): Promise<void> {
    try {
      await this.#pollAgentLoop(st, lane, subs, pending, gen);
    } finally {
      // A generation ending frees the agent's fallback slot; the next one
      // takes it again if push is still down.
      if (lane.push) this.#fallbackStop(st.cfg.handle, lane.push);
    }
  }

  async #pollAgentLoop(
    st: AgentState,
    lane: Lane,
    subs: AgentSubscription[],
    pending: Map<string, Held>,
    gen: AbortController,
  ): Promise<void> {
    const { handle } = st.cfg;
    const { client } = lane;
    const tilori = lane.name === 'tilori';
    const signal = gen.signal;
    let failures = 0;
    // Push mode: the `seq` the last poll covered (-1: poll now; a new
    // generation sweeps once).
    let seen = -1;
    const push = lane.push;
    let wait = push ? 0 : this.#waitMs;
    while (!signal.aborted) {
      const usable = subs.filter((s) => !lane.dropped.has(specKey(s)));
      if (!push && (lane.singleUntil > Date.now() || usable.length > MAX_POLL_SUBSCRIPTIONS)) {
        await Promise.all(usable.map((sub) => this.#pollSubscription(st, lane, sub, pending, gen)));
        return;
      }
      if (!usable.length) {
        // Every subscription was dropped; wait for the next renewal.
        await sleep(this.#renewEveryMs, signal);
        return;
      }
      const idle = usable.filter((s) => !pending.has(s.id) && this.#restingMs(lane, s.id) <= 0);
      const resting = usable.map((s) => this.#restingMs(lane, s.id)).filter((ms) => ms > 0);
      if (!idle.length) {
        // Resting after a wake is still watched: keep `status` from saying
        // "not watched" during a pause longer than its window (Iris).
        if (tilori && resting.length && Date.now() - st.restSignalAt >= this.#restSignalMs) {
          st.restSignalAt = Date.now();
          this.#signal(handle, 'watching');
        }
        await sleep(Math.min(this.#retryMs, ...resting), signal, lane.polled.promise);
        continue;
      }
      // Push down for the fallback delay: long-poll like a non-push agent
      // until the stream holds again.
      const fallback = push ? this.#fallbackOn(st, push) : false;
      wait = push && !fallback ? 0 : this.#waitMs;
      if (push && push.seq === seen && !fallback) {
        // Nothing new since the last poll: wait for a frame or a reconnect.
        // While push is down, nothing polls until the fallback is due (and,
        // with every poller slot taken, re-checks every 30 s). A
        // subscription resting after a hand-off missed the sweeps during its
        // pause, so its end sweeps once more.
        const due = push.lostAt && push.stream.status.state !== 'refused' ? (push.fallbackAt > Date.now() ? push.fallbackAt - Date.now() : 30_000) : Infinity;
        await this.#waitPush(lane, seen, signal, Math.min(due, ...(resting.length ? [Math.min(...resting)] : [])));
        seen = -1;
        continue;
      }
      if (push) {
        // A hard floor between one agent's push polls, whatever `seen` says,
        // so a bug here is a slow poll, never a spin (Bastion). Frames that
        // land meanwhile are covered by the one poll after it.
        const gap = push.polledAt + PUSH_POLL_GAP_MS - Date.now();
        if (gap > 0) {
          await sleep(gap, signal);
          continue;
        }
        push.polledAt = Date.now();
      }
      // Frames that land while this poll runs move `seq` again. Until the
      // poll succeeds, the next round polls again (a failed poll is retried
      // after its backoff, not left for the next frame).
      const covered = push?.seq ?? 0;
      seen = -1;
      // Two abandoned calls (a restart, then a generation that ended
      // mid-call) may still hold waiters; a new call now would be a third.
      const open = this.#openAbandoned(lane);
      if (open.length > 1) {
        await sleep(Math.min(...open) - Date.now(), signal);
        continue;
      }

      // While some subscriptions are held, restart the long poll once they
      // are acknowledged, so their next events are not delayed. The abandoned
      // call keeps its server waiter until its deadline; at most one is
      // outstanding (a restart waits for an earlier one to expire), so the
      // lane stays within the server's two waiters.
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
          lane.abandoned.push(startedAt + wait + 1_000);
          call.abort();
        };
        lane.onPolled = () => {
          const wait = Math.max(0, ...this.#openAbandoned(lane)) - Date.now();
          if (wait <= 0) restart();
          else restartTimer = setTimeout(restart, wait);
        };
        // A resting subscription rejoins the long poll when its pause ends.
        const resting = usable.map((s) => this.#restingMs(lane, s.id)).filter((ms) => ms > 0);
        if (resting.length) pauseTimer = setTimeout(() => lane.onPolled?.(), Math.min(...resting));
      }
      try {
        if (tilori) this.#signal(handle, 'attempting');
        const res = push && !fallback
          ? await this.#pollNow(st, lane, idle, call.signal)
          : await client.pollMany(
              idle.map((s) => s.id),
              this.#waitMs,
              call.signal,
            );
        // Answered, but nothing can arrive while every polled subscription
        // errored (they are re-subscribed next): not watched yet.
        if (res.errors.length < idle.length) {
          if (tilori) this.#signal(handle, 'watching');
          this.#pollOk(st, lane);
        }
        failures = 0;
        let got = false;
        for (const d of res.deliveries) if (await this.#admit(st, lane, d, pending, signal)) got = true;
        if (got) this.#wake(st);
        if (push) {
          // A sweep covers every idle subscription (#pollNow chunks them), so
          // only a batch (maybe more behind it) polls again; otherwise wait
          // for a frame.
          seen = got ? -1 : covered;
          if (push.back) push.caught += res.deliveries.reduce((n, d) => n + d.events.length, 0);
        }
        let resubscribe = false;
        for (const e of res.errors) {
          const sub = idle.find((s) => s.id === e.subscription_id)!;
          const key = specKey(sub);
          const at = lane.resubscribed.get(key);
          if (at === undefined || Date.now() - at > this.#renewEveryMs) {
            lane.resubscribed.set(key, Date.now());
            lane.renewIds.add(sub.id);
            this.#log(`[${handle}] ${tilori ? '' : 'Market '}subscription ${e.subscription_id} could not be polled (${e.error_code}); re-subscribing`);
            resubscribe = true;
          } else {
            lane.dropped.set(key, Date.now());
            this.#log(`[${handle}] dropping ${tilori ? '' : 'Market '}subscription ${e.subscription_id} (${e.error_code}) until the next renewal`);
          }
        }
        if (resubscribe) {
          // This call's deliveries for other subscriptions are in `pending`
          // but never handed off: the flush loop may not take them before
          // #runLane clears this lane's entries. They stay unacknowledged,
          // so the server re-serves them next generation; the cost is one
          // extra round trip, not a lost or repeated wake.
          gen.abort();
          return;
        }
        if (res.retryAfterMs) {
          // Over the server's waiter budget: pause as asked.
          await sleep(res.retryAfterMs, signal);
        } else if (got) {
          // Give the handoff a moment to acknowledge, so the next long poll
          // can include these subscriptions again.
          await sleep(this.#retryMs, signal, lane.polled.promise);
        } else if (!res.errors.length && wait >= 5_000 && Date.now() - startedAt < 1_000) {
          // An older server degraded the long poll to an immediate one without
          // saying how long to wait; don't spin.
          await sleep(3_000, signal);
        }
      } catch (cause) {
        if (signal.aborted) {
          // The generation ended mid-call (renewal or stop): the call keeps
          // its server waiter until its deadline.
          if (!restarted) lane.abandoned.push(startedAt + wait + 1_000);
          return;
        }
        if (restarted) continue;
        if (cause instanceof MultiPollUnsupported) {
          lane.singleUntil = Date.now() + this.#renewEveryMs;
          this.#log(`[${handle}] ${tilori ? '' : 'Market '}server does not accept subscription_ids; polling each subscription separately`);
          continue;
        }
        const msg = errText(cause);
        if (gone(msg)) {
          this.#log(`[${handle}] a ${tilori ? '' : 'Market '}subscription is gone; re-subscribing`);
          gen.abort();
          return;
        }
        failures++;
        const backoff = Math.min(30_000, 500 * 2 ** (failures - 1));
        const line = () => `Tilori error (attempt ${failures}, retry in ${backoff} ms): ${msg}`;
        await sleep(this.#laneFailed(st, lane, cause, 'poll', failures, backoff, line), signal);
      } finally {
        lane.onPolled = null;
        clearTimeout(restartTimer);
        clearTimeout(pauseTimer);
        signal.removeEventListener('abort', stopCall);
      }
    }
  }

  /** Push mode's zero-wait sweep of every idle subscription: multiplexed
   * calls of up to MAX_POLL_SUBSCRIPTIONS ids, or one call per id on a
   * server without `subscription_ids`. Never a long poll. */
  async #pollNow(st: AgentState, lane: Lane, subs: AgentSubscription[], signal: AbortSignal): Promise<MultiPollResult> {
    const { client } = lane;
    if (lane.singleUntil <= Date.now()) {
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
        lane.singleUntil = Date.now() + this.#renewEveryMs;
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
  #restingMs(lane: Lane, id: string): number {
    const until = lane.paused.get(id);
    if (until === undefined) return 0;
    const ms = until - Date.now();
    if (ms <= 0) lane.paused.delete(id);
    return Math.max(0, ms);
  }

  /** Deadlines of a lane's abandoned calls that may still hold a server waiter. */
  #openAbandoned(lane: Lane): number[] {
    const now = Date.now();
    lane.abandoned = lane.abandoned.filter((t) => t > now);
    return lane.abandoned;
  }

  /** Long-polls one subscription: the fallback for servers without
   * `subscription_ids`. Each subscription has its own concurrent long poll,
   * so an event on any of them is seen within the server's recheck interval
   * (1-3 s). While its batch is held, it waits. */
  async #pollSubscription(
    st: AgentState,
    lane: Lane,
    sub: AgentSubscription,
    pending: Map<string, Held>,
    gen: AbortController,
  ): Promise<void> {
    const { handle } = st.cfg;
    const { client } = lane;
    const tilori = lane.name === 'tilori';
    const signal = gen.signal;
    let failures = 0;
    while (!signal.aborted) {
      if (pending.has(sub.id)) {
        await sleep(this.#retryMs, signal, lane.polled.promise);
        continue;
      }
      const resting = this.#restingMs(lane, sub.id);
      if (resting > 0) {
        await sleep(resting, signal);
        continue;
      }
      try {
        const started = Date.now();
        if (tilori) this.#signal(handle, 'attempting');
        const { delivery: d, retryAfterMs } = await client.pollOne(sub.id, this.#waitMs, signal);
        if (tilori) this.#signal(handle, 'watching');
        this.#pollOk(st, lane);
        failures = 0;
        if (d && (await this.#admit(st, lane, d, pending, signal))) {
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
          this.#log(`[${handle}] ${tilori ? '' : 'Market '}${sub.scope.type} subscription is gone; re-subscribing`);
          gen.abort();
          return;
        }
        failures++;
        const backoff = Math.min(30_000, 500 * 2 ** (failures - 1));
        const line = () => `Tilori error on ${sub.scope.type} (attempt ${failures}, retry in ${backoff} ms): ${msg}`;
        await sleep(this.#laneFailed(st, lane, cause, 'poll', failures, backoff, line), signal);
      }
    }
  }

  async #flushLoop(st: AgentState, pending: Map<string, Held>, signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      if (!pending.size) {
        const due = st.cfg.reminder ? st.reminderAt - Date.now() : Infinity;
        // UNI-1029: held posts go out as one digest wake when due.
        const digestDue = st.filter.digest.length ? st.filter.digestDue - Date.now() : Infinity;
        if (digestDue <= 0) {
          const wait = await this.#digestWake(st, signal);
          if (wait > 0) await sleep(Math.min(60_000, wait), signal, st.kick.promise);
        } else if (due <= 0) await this.#remind(st, signal);
        else await sleep(Math.min(60_000, due, digestDue), signal, st.kick.promise);
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
        // An ack's error may carry the Market server's words: fixed text then.
        const why = cause instanceof LaneAckFailed && cause.lane === 'market' ? failReason(cause.cause) : errText(cause);
        this.#log(`[${st.cfg.handle}] acknowledge failed (retry in ${waitMs} ms): ${why}`);
      }
      if (waitMs > 0) await sleep(waitMs, signal, st.kick.promise);
      else this.#firePolled(st);
    }
  }

  #firePolled(st: AgentState) {
    for (const lane of this.#laneList(st)) {
      const k = lane.polled;
      lane.polled = makeKick();
      k.fire();
      const restart = lane.onPolled;
      lane.onPolled = null;
      restart?.();
    }
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
    if (!st.policy.canRemind()) {
      this.#log(`[${handle}] reminder skipped: wake cap reached (${st.policy.limit('normal')}/hour)`);
      return;
    }
    // UNI-1044: the gate decides whether this reminder is worth a wake. It
    // runs in the flush loop, so new events stop it at once (they wake the
    // agent anyway) rather than wait behind it.
    let gate: Wake['gate'];
    if (reminder!.gate) {
      const stop = new AbortController();
      const onOuter = () => stop.abort();
      signal?.addEventListener('abort', onOuter, { once: true });
      let kicked = false;
      void st.kick.promise.then(() => {
        kicked = true;
        stop.abort();
      });
      const r = await runGate(reminder!.gate, handle, stop.signal);
      signal?.removeEventListener('abort', onOuter);
      if (signal?.aborted) return;
      if (!r.ok && r.why === 'stopped' && kicked) {
        this.#log(`[${handle}] reminder gate stopped: woken (events, a session or config)`);
        // Due again at once (Pax 48a80a6f). Events are already pending, so
        // they go first and their wake re-times an idle-only reminder; a
        // session or config kick sends no wake, so the gate runs again, and
        // the reminder goes to whichever session is newest by then.
        st.reminderAt = Date.now();
        return;
      }
      if (r.ok && !r.wake) {
        // A ceiling, so a gate that always says quiet can't silence the
        // agent for good (Bastion 717eab5e, Keel 017467ac).
        if (++st.gateQuiet < GATE_QUIET_CEILING) {
          this.#log(`[${handle}] reminder gated: quiet (${st.gateQuiet} in a row)`);
          return;
        }
        this.#log(`[${handle}] reminder gate said quiet ${GATE_QUIET_CEILING} times in a row; sending the plain reminder`);
        gate = { ceiling: GATE_QUIET_CEILING };
      } else if (r.ok) gate = { findings: r.findings };
      else {
        this.#log(`[${handle}] reminder gate failed (${r.why}); sending the plain reminder`);
        gate = { failed: r.why };
      }
    }
    const wake: Wake = { wake_id: randomUUID(), agent: handle, events: [], resync_required: false, reminder: reminder!.prompt };
    if (gate) wake.gate = gate;
    if (st.backlog) wake.backlog = structuredClone(st.backlog);
    if (st.filter.dropped) wake.filter_dropped = structuredClone(st.filter.dropped);
    this.#noteLastWake(st, wake, 'normal');
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
    // Only a reminder the session took starts the quiet count again (Pax
    // b60b6fc1): a forced one that met a busy or gone session is forced again.
    st.gateQuiet = 0;
    this.#signal(handle, 'woke');
    st.policy.record('normal');
    st.stats.wakes++;
    st.stats.reminders++;
    if (wake.backlog) st.backlog = null;
    if (wake.filter_dropped) st.filter.dropped = null;
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
  #noteLastWake(st: AgentState, wake: Wake, lane: WakeLane): void {
    const wait = st.policy.afterWakeWaitMs(lane);
    if (wait > 0) wake.wakes_resume_at = this.#now() + wait;
  }

  /** Adds the account's posts left today to a wake when it is low, and the
   * listed tools' hash for the session to compare. Reads get_my_profile at
   * most once a minute; any failure leaves the wake as it is, so a missing or
   * older server never delays or blocks one. */
  async #noteProfile(st: AgentState, wake: Wake, signal?: AbortSignal): Promise<void> {
    await this.#readProfile(st, signal);
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

  /** Today's (UTC) filter counts, started afresh at midnight. */
  #filterDay(st: AgentState): FilterDay {
    const day = new Date().toISOString().slice(0, 10);
    if (st.filter.today.day !== day) st.filter.today = newFilterDay();
    return st.filter.today;
  }

  /**
   * UNI-1029: asks the agent's wake filter about the post events of batches
   * not yet filtered, applies the router's floors, and returns `fresh` with
   * held and dropped events taken out. Held events go to the digest, dropped
   * ones to the next wake's count; a batch left empty is acknowledged with no
   * wake. Any filter failure leaves everything to wake (fail open). Market
   * batches, resyncs and non-post events never reach the filter.
   */
  async #applyFilter(st: AgentState, pending: Map<string, Held>, fresh: Held[], signal?: AbortSignal): Promise<Held[]> {
    const { handle } = st.cfg;
    const F = st.filter;
    const live = new Set([...pending.values()].map((d) => d.delivery_id));
    for (const id of F.passed) if (!live.has(id)) F.passed.delete(id);
    const todo = fresh.filter(
      (d) => d.lane === 'tilori' && !d.resync_required && !F.passed.has(d.delivery_id) && d.events.some((e) => e.entity_type === 'post'),
    );
    if (!todo.length) return fresh;
    for (const d of todo) F.passed.add(d.delivery_id);
    // Ids, kinds and labels only, as in the wake line: the filter reads
    // anything else itself, with its own access.
    const events: FilterEvent[] = [];
    const evKey = new Map<object, string>();
    const byKey = new Map<string, { ref: EventRef; parent: unknown }>();
    for (const d of todo)
      for (const e of d.events) {
        if (e.entity_type !== 'post') continue;
        const ref = toRefs([{ ...d, events: [e] }], st.directSubs)[0];
        if (!isUuid(ref.id) || !isUuid(ref.entity_id)) continue;
        const key = `event:${ref.id}`;
        evKey.set(e, key);
        if (byKey.has(key)) continue;
        const parent = e.parents?.parent_post_id;
        byKey.set(key, { ref, parent });
        events.push({
          key,
          kind: ref.kind,
          entity_type: 'post',
          entity_id: ref.entity_id,
          ...(isUuid(parent) ? { parent_post_id: parent } : {}),
          created_at: typeof e.created_at === 'string' ? e.created_at.slice(0, 40) : '',
          direct: st.directSubs.has(d.subscription_id),
          forced: !FILTERABLE_KINDS.has(ref.kind),
        });
      }
    if (!events.length) return fresh;
    const day = this.#filterDay(st);
    const result = await runFilter(st.cfg.wakeFilter!, { v: 1, agent: { handle }, wake_id: randomUUID(), events }, signal);
    if (!result.ok) {
      day.failed += events.length;
      this.#log(`[${handle}] wake filter gave no decisions (${result.why}); waking for ${events.length} event(s)`);
      return fresh;
    }
    const demoted = new Map<string, { action: 'digest' | 'drop'; reason: FilterReason }>();
    for (const ev of events) {
      const dec = result.decisions.get(ev.key);
      if (ev.forced || !dec || dec.action === 'wake') continue;
      demoted.set(ev.key, { action: dec.action, reason: dec.reason ?? 'other' });
    }
    // Floors (Bastion 10ebe17a, Keel 2fc2d4e2): a post written by a person,
    // or by an agent of a trusted owner, always wakes, whatever the filter
    // said. Decided by the author's account as get_post reports it, never by
    // text; any doubt wakes.
    const posts = [...new Set([...demoted.keys()].map((k) => byKey.get(k)!.ref.entity_id))];
    const mustWake = new Set<string>();
    if (posts.length > MAX_FLOOR_READS) for (const id of posts) mustWake.add(id);
    else for (const id of posts) if (!(await this.#mayDemote(st, id, signal))) mustWake.add(id);
    for (const [k] of demoted) if (mustWake.has(byKey.get(k)!.ref.entity_id)) demoted.delete(k);
    // Held posts are saved before any batch is acknowledged. A post that
    // can't be held (digest full, or the save failed) wakes instead, so a
    // restart can never lose a post the server already counts as delivered
    // (Bastion 63687a0d 1).
    const now = Date.now();
    const items: DigestItem[] = [];
    for (const [k, dec] of demoted) {
      if (dec.action !== 'digest') continue;
      const { ref, parent } = byKey.get(k)!;
      const item = digestItem(ref, dec.reason, parent, now);
      if (item && st.filter.digest.length + items.length < MAX_DIGEST_ITEMS) items.push(item);
      else demoted.delete(k);
    }
    if (items.length && !this.#hold(st, items, now)) {
      for (const [k, dec] of demoted) if (dec.action === 'digest') demoted.delete(k);
      items.length = 0;
    }
    if (st.recorder)
      for (const action of ['digest', 'drop'] as const) {
        const refs = [...demoted].filter(([, d]) => d.action === action).map(([k]) => byKey.get(k)!.ref);
        if (refs.length) st.recorder.record({ decision: action, lane: null, events: refs });
      }
    day.woke += events.length - demoted.size;
    if (!demoted.size) return fresh;
    const held = items.length;
    let dropped = 0;
    const out: Held[] = [];
    for (const d of fresh) {
      if (!todo.includes(d)) {
        out.push(d);
        continue;
      }
      const kept = d.events.filter((e) => {
        const key = evKey.get(e);
        const dec = key ? demoted.get(key) : undefined;
        if (!dec) return true;
        if (dec.action === 'drop') {
          this.#noteDropped(st, byKey.get(key!)!.ref, dec.reason);
          dropped++;
        }
        return false;
      });
      if (!kept.length) {
        // Nothing in it wakes: acknowledged now, like a backlog batch.
        st.handedOff.add(d.delivery_id);
        st.capHeld.delete(d.delivery_id);
        continue;
      }
      const trimmed: Held = { ...d, events: kept };
      if (pending.get(d.subscription_id)?.delivery_id === d.delivery_id) pending.set(d.subscription_id, trimmed);
      out.push(trimmed);
    }
    this.#log(`[${handle}] wake filter: ${held} held for the digest, ${dropped} dropped, ${events.length - held - dropped} to wake`);
    return out;
  }

  /** Whether a post may be held or dropped: written by an agent (not a
   * person) of an account that isn't a trusted owner. Reads the author's
   * account ids only; any failure means no. */
  async #mayDemote(st: AgentState, postId: string, signal?: AbortSignal): Promise<boolean> {
    if (st.cfg.trustAll) return false;
    try {
      const r = await st.lanes.tilori.client.getPost(postId, { signal, timeout: 5_000 });
      const p = r?.result ?? r;
      if (p?.posted_by !== 'agent') return false;
      const a = p.author;
      if (!a || typeof a.user_id !== 'string' || typeof a.username !== 'string') return false;
      const owners = st.cfg.trustedOwners ?? [];
      return !owners.some((o) => o === a.user_id || o.toLowerCase() === a.username.toLowerCase());
    } catch {
      return false;
    }
  }

  /** Adds posts to the digest and saves it. False, with the digest as it
   * was, when it can't be saved: the caller then wakes for them. Without a
   * run directory there is nowhere to save it, so nothing is held: a held
   * post is acked, and one kept only in memory would be lost on a restart
   * (Bastion f28cbabb). */
  #hold(st: AgentState, items: DigestItem[], now: number): boolean {
    const F = st.filter;
    const next = [...F.digest, ...items];
    if (this.#signalDir === undefined) {
      this.#log(`[${st.cfg.handle}] no run directory for the wake filter digest; waking for ${items.length} post(s) instead of holding them`);
      return false;
    }
    if (!saveDigest(this.#signalDir, st.cfg.handle, next)) {
      this.#log(`[${st.cfg.handle}] could not save the wake filter digest; waking for ${items.length} post(s) instead of holding them`);
      return false;
    }
    F.digest = next;
    if (!F.digestDue) F.digestDue = now + st.cfg.wakeFilter!.digestMs;
    this.#filterDay(st).held += items.length;
    return true;
  }

  #noteDropped(st: AgentState, ref: EventRef, reason: FilterReason): void {
    const f = (st.filter.dropped ??= { count: 0, reasons: {}, ids: [] });
    f.count++;
    f.reasons[reason] = (f.reasons[reason] ?? 0) + 1;
    if (!f.ids.includes(ref.entity_id)) {
      if (f.ids.length < MAX_DROPPED_IDS) f.ids.push(ref.entity_id);
      else f.more = (f.more ?? 0) + 1;
    }
    const day = this.#filterDay(st);
    day.dropped++;
    if (day.dropped_ids.length < MAX_DAY_IDS && !day.dropped_ids.includes(ref.entity_id)) day.dropped_ids.push(ref.entity_id);
  }

  #saveDigest(st: AgentState): void {
    if (this.#signalDir === undefined) return;
    if (!saveDigest(this.#signalDir, st.cfg.handle, st.filter.digest))
      this.#log(`[${st.cfg.handle}] could not save the wake filter digest after a wake; a restart may deliver those posts again`);
  }

  /** Adds the held digest and the dropped count to a wake about to go out.
   * Returns the digest items it covers, for #filterSent. Posts an earlier
   * wake (or this one) already names are covered without being repeated.
   * Grouped by thread, threads in the order they were first held (Juniper
   * f843e173 5). */
  #attachFilter(st: AgentState, wake: Wake): DigestItem[] {
    const F = st.filter;
    if (F.dropped) wake.filter_dropped = structuredClone(F.dropped);
    if (!F.digest.length) return [];
    const items = F.digest.slice();
    const have = new Set(wake.events.map(refKey));
    const order = new Map<string, number>();
    for (const it of items) if (!order.has(it.parent ?? '')) order.set(it.parent ?? '', order.size);
    const add = items
      .map((it) => ({ it, ref: digestRef(it) }))
      .filter(({ ref }) => {
        if (have.has(refKey(ref)) || this.#seen(st, ref)) return false;
        have.add(refKey(ref));
        return true;
      })
      .map((x, i) => ({ ...x, i }))
      .sort((a, b) => order.get(a.it.parent ?? '')! - order.get(b.it.parent ?? '')! || a.i - b.i);
    wake.events.push(...add.map(({ ref }) => ref));
    return items;
  }

  /** After an accepted wake: what it carried from the filter is done. */
  #filterSent(st: AgentState, items: DigestItem[], wake: Wake): void {
    const F = st.filter;
    if (wake.filter_dropped) F.dropped = null;
    if (!items.length) return;
    const sent = new Set(items);
    F.digest = F.digest.filter((it) => !sent.has(it));
    if (!F.digest.length) F.digestDue = 0;
    this.#saveDigest(st);
  }

  /** The digest wake (UNI-1029): held posts, grouped by thread, once due and
   * no batch is pending. Returns how long to wait before trying again, or 0. */
  async #digestWake(st: AgentState, signal?: AbortSignal): Promise<number> {
    const { handle } = st.cfg;
    const injector = st.injectors.at(-1);
    if (!injector) return this.#retryMs * 5;
    const cap = st.policy.waitMs('normal');
    if (cap > 0) return cap;
    const wake: Wake = { wake_id: randomUUID(), agent: handle, events: [], resync_required: false };
    const items = this.#attachFilter(st, wake);
    if (!wake.events.length) {
      // Everything held already went out in other wakes.
      this.#filterSent(st, items, { ...wake, filter_dropped: undefined });
      return 0;
    }
    if (st.backlog) wake.backlog = structuredClone(st.backlog);
    this.#noteLastWake(st, wake, 'normal');
    await this.#noteProfile(st, wake, signal);
    const result = await settle(injector.deliver(wake));
    if (result === 'gone') {
      this.#drop(st, injector);
      return st.injectors.length ? 1 : this.#retryMs;
    }
    if (result !== 'accepted') return Math.min(60_000, this.#retryMs * 4);
    this.#signal(handle, 'woke');
    st.policy.record('normal');
    st.stats.wakes++;
    st.stats.events += wake.events.length;
    if (wake.backlog) st.backlog = null;
    this.#filterSent(st, items, wake);
    const at = this.#now();
    for (const r of wake.events) {
      const prev = st.recent.get(refKey(r));
      st.recent.delete(refKey(r));
      st.recent.set(refKey(r), { at, rank: Math.max(KIND_RANK[r.kind] ?? 0, prev?.rank ?? 0), ...(prev?.revision ? { revision: prev.revision } : {}) });
    }
    while (st.recent.size > MAX_RECENT) st.recent.delete(st.recent.keys().next().value!);
    this.#log(`[${handle}] woke ${injector.kind} with a digest of ${wake.events.length} held event(s)`);
    return 0;
  }

  /** Tries to hand held batches to the agent's injector. Returns 0 when done,
   * else how long to wait before retrying. Logs counts only, never content. */
  async #flush(st: AgentState, pending: Map<string, Held>, signal?: AbortSignal): Promise<number> {
    const { handle } = st.cfg;
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
    const known = (d: Held) => {
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
    // A batch of post events all over a day old is a backlog a reused
    // subscription kept (Keel 78d3d15f): acknowledged without a wake, and
    // counted into one sentence on the next wake. DMs, Market events and
    // resyncs always wake. Wall clock, like the events' created_at.
    const cutoff = Date.now() - BACKLOG_MS;
    const old = fresh.filter(
      (d) =>
        !d.resync_required &&
        d.events.length > 0 &&
        d.events.every((e) => e.entity_type === 'post' && Date.parse(e.created_at) < cutoff),
    );
    if (old.length) {
      for (const d of old) {
        st.handedOff.add(d.delivery_id);
        st.capHeld.delete(d.delivery_id);
        for (const e of d.events) {
          const at = Date.parse(e.created_at);
          const b = (st.backlog ??= { count: 0, from: at, to: at });
          b.count++;
          b.from = Math.min(b.from, at);
          b.to = Math.max(b.to, at);
          // Posts addressed to the agent are named by id: whats_new may not
          // reach back days (Pax adad3bda).
          if (e.kind === 'mention' || st.directSubs.has(d.subscription_id)) {
            const ids = (b.to_you ??= []);
            if (ids.includes(e.entity_id)) continue;
            if (ids.length < BACKLOG_IDS) ids.push(e.entity_id);
            else b.to_you_more = (b.to_you_more ?? 0) + 1;
          }
        }
      }
      fresh = fresh.filter((d) => !old.includes(d));
      this.#log(`[${handle}] ${old.reduce((n, d) => n + d.events.length, 0)} event(s) over a day old; acknowledged without waking`);
    }
    // UNI-1029: the wake filter decides on whole batches once they have
    // gathered; what it holds or drops is acknowledged now, the rest goes on.
    if (fresh.length && st.cfg.wakeFilter) {
      const gathering = st.heldSince + this.#coalesceMs - Date.now();
      if (gathering > 0) return gathering;
      fresh = await this.#applyFilter(st, pending, fresh, signal);
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
      const digestDue = st.filter.digest.length > 0 && st.filter.digestDue <= Date.now();
      const plainOnly = !digestDue && fresh.every(
        (d) =>
          !d.resync_required &&
          !st.directSubs.has(d.subscription_id) &&
          d.events.every((e) => e.kind === 'post.created'),
      );
      // And at most one such wake per post_wake_minutes (UNI-951), counted
      // from the last wake that carried them: the first after a quiet spell
      // keeps the short hold, the rest of a busy spell waits for the window.
      const windowEnd = st.plainWokeAt + (st.cfg.postWakeMinutes ?? 0) * this.#minuteMs;
      const plainWait = Math.max(st.heldSince + this.#plainHoldMs, windowEnd) - Date.now();
      if (plainOnly && plainWait > 0) {
        if (windowEnd > st.heldSince + this.#plainHoldMs)
          notice(`holding ${count} new post event(s) until ${clock(windowEnd)} (post_wake_minutes ${st.cfg.postWakeMinutes})`);
        return plainWait;
      }
      const injector = st.injectors.at(-1);
      if (!injector) {
        notice(`holding ${count} event(s): no injector registered for this agent yet${dmNote(fresh)}`);
        return this.#retryMs * 5;
      }
      // Over the cap, direct batches (inbox, mentions, DMs, Market) still
      // wake on their own allowance; broad traffic waits and coalesces. A
      // broad batch with any mention or dm.* event goes out whole (acks are
      // per batch). A capped batch is held, never dropped: it stays
      // unacknowledged until a wake carries it.
      let send = fresh;
      const direct = fresh.filter(
        (d) => st.directSubs.has(d.subscription_id) || d.events.some((e) => isDirectKind(e.kind)),
      );
      const decision = st.policy.decide({ hasDirect: direct.length > 0 });
      const lane: WakeLane = 'lane' in decision ? decision.lane : 'normal';
      if (!('lane' in decision) || lane === 'direct') {
        const delayed = !('lane' in decision);
        if ('waitMs' in decision) {
          // Once per hold episode, not on every retry.
          const fresher = fresh.filter((d) => !st.capHeld.has(d.delivery_id));
          if (fresher.length) st.recorder?.record({ decision: 'hold', lane: null, events: toRefs(fresher) });
        }
        for (const d of fresh) if (delayed || !direct.includes(d)) st.capHeld.add(d.delivery_id);
        if ('waitMs' in decision) {
          st.stats.delayed = count;
          notice(
            `wake cap reached (${st.policy.limit('normal')}/hour); delaying ${count} event(s) for ${Math.ceil(decision.waitMs / 1000)} s${dmNote(fresh)}`,
          );
          return Math.min(decision.waitMs, 60_000);
        }
        send = direct;
      }
      // Tilori batches make the wake's events; Market batches its Market
      // part, kinds and ids only.
      const marketSend = send.filter((d) => d.lane === 'market');
      const wake = buildWake(
        handle,
        send.filter((d) => d.lane === 'tilori'),
        randomUUID(),
        st.directSubs,
      );
      const marketEvents = marketRefs(marketSend);
      if (marketEvents.length || marketSend.some((d) => d.resync_required))
        wake.market = { events: marketEvents, ...(marketSend.some((d) => d.resync_required) ? { resync: true as const } : {}) };
      // Counted from batches, not wake.events, which may be deduplicated.
      const events = (ds: Held[]) => ds.reduce((n, d) => n + d.events.length, 0);
      // Leave out posts an earlier wake already named; count the events
      // whose post is gone from this wake (not ones a mention still carries).
      wake.events = wake.events.filter((r) => !this.#seen(st, r));
      const kept = new Set(wake.events.map(refKey));
      const already = toRefs(send).filter((r) => this.#seen(st, r) && !kept.has(refKey(r))).length;
      if (already) wake.already_delivered = already;
      const attached = st.cfg.wakeFilter ? this.#attachFilter(st, wake) : [];
      if (st.backlog) wake.backlog = structuredClone(st.backlog);
      const stillHeld = events(fresh) - events(send);
      const heldBack = events(send.filter((d) => st.capHeld.has(d.delivery_id)));
      if (heldBack) wake.held_back = heldBack;
      if (stillHeld) wake.still_held = stillHeld;
      this.#noteLastWake(st, wake, lane);
      await this.#noteProfile(st, wake, signal);
      // Exactly one deliver is in flight per agent: this loop awaits it with
      // no timeout, so a slow injector (an exec run, a busy session) is never
      // invoked again for the same batch, and a late `accepted` still counts.
      // A remote injector resolves `gone` when its connection drops.
      const slow = setTimeout(
        () => this.#log(`[${handle}] injector ${injector.kind} has not accepted the wake after ${Math.round(this.#slowDeliverMs / 1000)} s; ${count} event(s) stay unacked${dmNote(send)}`),
        this.#slowDeliverMs,
      );
      slow.unref?.();
      // `new Promise` turns a synchronous throw from deliver into a busy result,
      // so the timer below is always cleared.
      const result = await settle(new Promise<DeliverResult>((r) => r(injector.deliver(wake)))).finally(() => clearTimeout(slow));
      if (result === 'gone') {
        this.#drop(st, injector);
        notice(`injector ${injector.kind} gone; ${st.injectors.length} left; holding ${count} event(s)${dmNote(send)}`);
        return st.injectors.length ? 1 : this.#retryMs;
      }
      if (result !== 'accepted') {
        st.busy++;
        const backoff = Math.min(60_000, this.#retryMs * 2 ** (st.busy - 1));
        st.retryAt = Date.now() + backoff;
        notice(`injector ${injector.kind} busy (x${st.busy}); holding ${count} event(s), retry in ${backoff} ms${dmNote(send)}`);
        return backoff;
      }
      st.busy = 0;
      st.retryAt = 0;
      const delivered = dmNote(send);
      if (delivered) this.#log(`[${handle}] delivered wake to ${injector.kind}${delivered}`);
      if (send.some((d) => d.lane === 'tilori' && !st.directSubs.has(d.subscription_id))) st.plainWokeAt = Date.now();
      this.#signal(handle, 'woke');
      st.policy.record(lane);
      st.recorder?.record({ decision: 'wake', lane, events: toRefs(send) });
      if (st.cfg.reminder?.onlyWhenIdle) st.reminderAt = Date.now() + st.cfg.reminder.everyMs;
      st.stats.wakes++;
      st.stats.events += wake.events.length + marketEvents.length;
      this.#noteBlocked(st);
      st.stats.delayed = stillHeld;
      st.heldNotice = '';
      if (wake.backlog) st.backlog = null;
      if (st.cfg.wakeFilter) this.#filterSent(st, attached, wake);
      for (const d of send) {
        st.handedOff.add(d.delivery_id);
        st.capHeld.delete(d.delivery_id);
        // Each hand-off rests its subscription, so what arrives next queues
        // on the server and comes back as one batch: at most one wake per
        // window per subscription. The pause starts at the hand-off, so a
        // busy thread can't delay a wake, and a running pause is not
        // extended.
        const lane = st.lanes[d.lane];
        if (lane && this.#restingMs(lane, d.subscription_id) <= 0) {
          const ms = st.directSubs.has(d.subscription_id)
            ? this.#directPauseMs
            : st.cfg.pauseSeconds === undefined
              ? this.#broadPauseMs
              : st.cfg.pauseSeconds * 1000;
          if (ms > 0) lane.paused.set(d.subscription_id, Date.now() + ms);
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
        `[${handle}] woke ${injector.kind} with ${wake.events.length + marketEvents.length} event(s)` +
          (lane === 'direct' ? ` past the wake cap; ${stillHeld} still held` : ''),
      );
    }

    // Acknowledge what was handed off, each through the lane that delivered
    // it (Pax 61007a93 3); batches the cap still holds wait.
    for (const d of batches.filter((b) => st.handedOff.has(b.delivery_id))) {
      const lane = st.lanes[d.lane];
      // Not tied to the stop signal: a batch already handed off is always
      // acknowledged, even while the router is stopping.
      try {
        if (lane) await lane.client.acknowledge(d.subscription_id, d.delivery_id);
      } catch (cause) {
        throw new LaneAckFailed(d.lane, cause);
      }
      st.handedOff.delete(d.delivery_id);
      // Only this delivery: a lane that renewed while the ack was in flight
      // may hold a new batch for the same subscription (kept), or the same
      // delivery re-served (removed, or it would wake again).
      if (pending.get(d.subscription_id)?.delivery_id === d.delivery_id) pending.delete(d.subscription_id);
    }
    if (!pending.size) st.heldSince = 0;
    return 0;
  }
}

/** An acknowledgement failed on one lane; retried on that lane. */
class LaneAckFailed extends Error {
  constructor(
    readonly lane: LaneName,
    override readonly cause: unknown,
  ) {
    super(errText(cause));
  }
}
