import { WakeLimiter } from './ratelimit.ts';
import { RateLimiter } from '../vendor/wakewise/client/limiter.ts';

/** Which allowance a wake spends: `normal` is the general hourly cap,
 * `direct` the separate one that keeps a mention or direct message from being
 * starved by broad traffic. */
export type Lane = 'normal' | 'direct';

/** What the router does with a batch that is ready to wake the agent. */
export type Decision = { lane: Lane } | { waitMs: number };

/** The wake policy (UNI-1097 slice 1): the one place that decides whether a
 * wake may go now, which allowance it spends and when the next one is
 * possible. The router keeps the batching, the digest and the delivery; it
 * only asks. `builtin` is today's behaviour, unchanged. */
export interface WakePolicy {
  /** Whether a wake may go now. `hasDirect` is true when the ready batches
   * hold a direct signal, so the direct lane may be used once `normal` is
   * spent. */
  decide(input: { hasDirect: boolean }): Decision;
  /** Spends one wake in `lane`. */
  record(lane: Lane): void;
  /** Milliseconds until `lane` allows a wake (0 = now, Infinity = off). */
  waitMs(lane: Lane): number;
  /** After a wake in `lane`: milliseconds until any lane allows the next one,
   * or 0 while one still does. Wakes carry it as `wakes_resume_at`. */
  afterWakeWaitMs(lane: Lane): number;
  /** Whether a reminder may wake the agent now (it spends `normal`). */
  canRemind(): boolean;
  /** Changes a lane's cap in place (live reload); 0 turns `direct` off. This
   * hour's wakes still count. */
  resize(lane: Lane, perHour: number): void;
  /** The lane's cap, 0 when off. */
  limit(lane: Lane): number;
  /** This hour's wakes in the lane, or null when it is off. */
  used(lane: Lane): number | null;
}

/** Today's two rolling-window caps behind the policy interface. */
export class BuiltinPolicy implements WakePolicy {
  readonly #normal: WakeLimiter;
  #direct: WakeLimiter | null;
  /** The direct limiter while turned off, kept so turning it back on doesn't
   * hand out a fresh hour. */
  #directOff: WakeLimiter | null = null;

  constructor(
    normalPerHour: number,
    directPerHour: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(directPerHour) || directPerHour < 0) {
      throw new Error('direct_wakes_per_hour must be a non-negative integer.');
    }
    this.#normal = new WakeLimiter(normalPerHour, now);
    this.#direct = directPerHour === 0 ? null : new WakeLimiter(directPerHour, now);
  }

  #lane(lane: Lane): WakeLimiter | null {
    return lane === 'normal' ? this.#normal : this.#direct;
  }

  decide({ hasDirect }: { hasDirect: boolean }): Decision {
    const normal = this.#normal.waitMs();
    if (normal === 0) return { lane: 'normal' };
    const direct = hasDirect ? this.waitMs('direct') : Infinity;
    if (direct === 0) return { lane: 'direct' };
    return { waitMs: Math.min(normal, direct) };
  }

  record(lane: Lane): void {
    this.#lane(lane)?.record();
  }

  waitMs(lane: Lane): number {
    return this.#lane(lane)?.waitMs() ?? Infinity;
  }

  afterWakeWaitMs(lane: Lane): number {
    const after = (l: Lane) => {
      const limiter = this.#lane(l);
      return !limiter ? Infinity : l === lane ? limiter.waitAfterNextMs() : limiter.waitMs();
    };
    const normal = after('normal');
    const direct = after('direct');
    return normal > 0 && direct > 0 ? Math.min(normal, direct) : 0;
  }

  canRemind(): boolean {
    return this.#normal.waitMs() === 0;
  }

  resize(lane: Lane, perHour: number): void {
    if (lane === 'normal') {
      this.#normal.resize(perHour);
      return;
    }
    if (perHour === 0) {
      this.#directOff = this.#direct ?? this.#directOff;
      this.#direct = null;
      return;
    }
    // Off and on again keeps this hour's direct wakes: same limiter, resized.
    this.#direct = this.#direct ?? this.#directOff ?? new WakeLimiter(perHour, this.now);
    this.#directOff = null;
    this.#direct.resize(perHour);
  }

  limit(lane: Lane): number {
    return this.#lane(lane)?.perHour ?? 0;
  }

  used(lane: Lane): number | null {
    return this.#lane(lane)?.used ?? null;
  }
}

function checkNormalPerHour(perHour: number): void {
  if (!Number.isInteger(perHour) || perHour < 1) {
    throw new Error('wakes_per_hour must be a positive integer.');
  }
}

function checkDirectPerHour(perHour: number): void {
  if (!Number.isInteger(perHour) || perHour < 0) {
    throw new Error('direct_wakes_per_hour must be a non-negative integer.');
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * WakePolicy backed by the vendored wakewise RateLimiter with two lanes
 * (`normal` and `direct`).
 */
export class WakewisePolicy implements WakePolicy {
  readonly #limiter: RateLimiter;

  constructor(
    normalPerHour: number,
    directPerHour: number,
    private readonly now: () => number = Date.now,
  ) {
    checkNormalPerHour(normalPerHour);
    checkDirectPerHour(directPerHour);
    this.#limiter = new RateLimiter({
      limits: {
        wakesPerHour: normalPerHour,
        directWakesPerHour: directPerHour,
        coalesceSeconds: 0,
        pauseSeconds: 0,
      },
      clock: () => this.now() / 1000,
    });
  }

  decide({ hasDirect }: { hasDirect: boolean }): Decision {
    const normal = this.waitMs('normal');
    if (normal === 0) return { lane: 'normal' };
    const direct = hasDirect ? this.waitMs('direct') : Infinity;
    if (direct === 0) return { lane: 'direct' };
    return { waitMs: Math.min(normal, direct) };
  }

  record(lane: Lane): void {
    if (this.limit(lane) === 0) return;
    this.#limiter.record(lane, this.now());
  }

  waitMs(lane: Lane): number {
    if (this.limit(lane) === 0) return Infinity;
    return this.#limiter.waitMs(lane, this.now());
  }

  afterWakeWaitMs(lane: Lane): number {
    const now = this.now();
    const after = (l: Lane) => {
      if (this.limit(l) === 0) return Infinity;
      return l === lane ? this.#limiter.waitAfterNextMs(l, now) : this.#limiter.waitMs(l, now);
    };
    const normal = after('normal');
    const direct = after('direct');
    return normal > 0 && direct > 0 ? Math.min(normal, direct) : 0;
  }

  canRemind(): boolean {
    // WakePolicy.canRemind() is read-only; the router calls record('normal')
    // only after the reminder wake is accepted. (RateLimiter.canRemind()
    // mutates state on true, so we check waitMs instead.)
    return this.waitMs('normal') === 0;
  }

  resize(lane: Lane, perHour: number): void {
    if (lane === 'normal') checkNormalPerHour(perHour);
    else checkDirectPerHour(perHour);
    this.#limiter.resize(lane, perHour);
  }

  limit(lane: Lane): number {
    return this.#limiter.perHour(lane);
  }

  used(lane: Lane): number | null {
    return this.limit(lane) === 0 ? null : this.#limiter.used(lane, this.now());
  }
}

export interface FailOpenOptions {
  now?: () => number;
  onError?: (message: string) => void;
  makeWakewise?: () => WakePolicy;
}

/**
 * Delegates to WakewisePolicy while keeping a BuiltinPolicy in sync on every
 * `record` and `resize`. On construction failure or first runtime throw, logs
 * once and falls back to BuiltinPolicy for the rest of the run.
 */
export class FailOpenWakewisePolicy implements WakePolicy {
  readonly #builtin: BuiltinPolicy;
  #wakewise: WakePolicy | null = null;
  readonly #onError: (message: string) => void;
  #failed = false;

  constructor(normalPerHour: number, directPerHour: number, options: FailOpenOptions = {}) {
    const now = options.now ?? Date.now;
    this.#onError = options.onError ?? (() => {});
    this.#builtin = new BuiltinPolicy(normalPerHour, directPerHour, now);
    try {
      this.#wakewise = options.makeWakewise
        ? options.makeWakewise()
        : new WakewisePolicy(normalPerHour, directPerHour, now);
    } catch (err) {
      this.#fail(err);
    }
  }

  #fail(err: unknown): void {
    this.#wakewise = null;
    if (this.#failed) return;
    this.#failed = true;
    this.#onError(`wakewise policy failed: ${errMsg(err)}; using builtin`);
  }

  decide(input: { hasDirect: boolean }): Decision {
    if (this.#wakewise) {
      try {
        return this.#wakewise.decide(input);
      } catch (err) {
        this.#fail(err);
      }
    }
    return this.#builtin.decide(input);
  }

  record(lane: Lane): void {
    this.#builtin.record(lane);
    if (!this.#wakewise) return;
    try {
      this.#wakewise.record(lane);
    } catch (err) {
      this.#fail(err);
    }
  }

  waitMs(lane: Lane): number {
    if (this.#wakewise) {
      try {
        return this.#wakewise.waitMs(lane);
      } catch (err) {
        this.#fail(err);
      }
    }
    return this.#builtin.waitMs(lane);
  }

  afterWakeWaitMs(lane: Lane): number {
    if (this.#wakewise) {
      try {
        return this.#wakewise.afterWakeWaitMs(lane);
      } catch (err) {
        this.#fail(err);
      }
    }
    return this.#builtin.afterWakeWaitMs(lane);
  }

  canRemind(): boolean {
    if (this.#wakewise) {
      try {
        return this.#wakewise.canRemind();
      } catch (err) {
        this.#fail(err);
      }
    }
    return this.#builtin.canRemind();
  }

  resize(lane: Lane, perHour: number): void {
    this.#builtin.resize(lane, perHour);
    if (!this.#wakewise) return;
    try {
      this.#wakewise.resize(lane, perHour);
    } catch (err) {
      this.#fail(err);
    }
  }

  limit(lane: Lane): number {
    if (this.#wakewise) {
      try {
        return this.#wakewise.limit(lane);
      } catch (err) {
        this.#fail(err);
      }
    }
    return this.#builtin.limit(lane);
  }

  used(lane: Lane): number | null {
    if (this.#wakewise) {
      try {
        return this.#wakewise.used(lane);
      } catch (err) {
        this.#fail(err);
      }
    }
    return this.#builtin.used(lane);
  }
}

export interface ShadowDiff {
  at: string;
  method: 'decide';
  builtin: Decision;
  wakewise: Decision;
  lane: Lane | null;
}

export interface ShadowOptions {
  now?: () => number;
  onDiff?: (diff: ShadowDiff) => void;
  onError?: (message: string) => void;
  makeWakewise?: () => WakePolicy;
}

export function decisionsDiffer(a: Decision, b: Decision): boolean {
  if ('lane' in a && 'lane' in b) return a.lane !== b.lane;
  if ('waitMs' in a && 'waitMs' in b) {
    if (a.waitMs === b.waitMs) return false;
    return Math.abs(a.waitMs - b.waitMs) > 1000;
  }
  return true;
}

/**
 * Runs BuiltinPolicy as the source of truth and mirrors calls to
 * WakewisePolicy, reporting `decide` diffs via `onDiff`. A wakewise throw logs
 * once and stops mirroring without affecting the builtin result.
 */
export class ShadowPolicy implements WakePolicy {
  readonly #builtin: BuiltinPolicy;
  #wakewise: WakePolicy | null = null;
  readonly #now: () => number;
  readonly #onDiff: (diff: ShadowDiff) => void;
  readonly #onError: (message: string) => void;
  #stopped = false;

  constructor(normalPerHour: number, directPerHour: number, options: ShadowOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#onDiff = options.onDiff ?? (() => {});
    this.#onError = options.onError ?? (() => {});
    this.#builtin = new BuiltinPolicy(normalPerHour, directPerHour, this.#now);
    try {
      this.#wakewise = options.makeWakewise
        ? options.makeWakewise()
        : new WakewisePolicy(normalPerHour, directPerHour, this.#now);
    } catch (err) {
      this.#stop(err);
    }
  }

  #stop(err: unknown): void {
    this.#wakewise = null;
    if (this.#stopped) return;
    this.#stopped = true;
    this.#onError(`wakewise shadow failed: ${errMsg(err)}; stopping shadow`);
  }

  decide(input: { hasDirect: boolean }): Decision {
    const res = this.#builtin.decide(input);
    if (this.#wakewise) {
      try {
        const ww = this.#wakewise.decide(input);
        if (decisionsDiffer(res, ww)) {
          this.#onDiff({
            at: new Date(this.#now()).toISOString(),
            method: 'decide',
            builtin: res,
            wakewise: ww,
            lane: 'lane' in res ? res.lane : null,
          });
        }
      } catch (err) {
        this.#stop(err);
      }
    }
    return res;
  }

  record(lane: Lane): void {
    this.#builtin.record(lane);
    if (!this.#wakewise) return;
    try {
      this.#wakewise.record(lane);
    } catch (err) {
      this.#stop(err);
    }
  }

  waitMs(lane: Lane): number {
    return this.#builtin.waitMs(lane);
  }

  afterWakeWaitMs(lane: Lane): number {
    return this.#builtin.afterWakeWaitMs(lane);
  }

  canRemind(): boolean {
    return this.#builtin.canRemind();
  }

  resize(lane: Lane, perHour: number): void {
    this.#builtin.resize(lane, perHour);
    if (!this.#wakewise) return;
    try {
      this.#wakewise.resize(lane, perHour);
    } catch (err) {
      this.#stop(err);
    }
  }

  limit(lane: Lane): number {
    return this.#builtin.limit(lane);
  }

  used(lane: Lane): number | null {
    return this.#builtin.used(lane);
  }
}
