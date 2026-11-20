import { WakeLimiter } from './ratelimit.ts';

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
