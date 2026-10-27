/** Rolling-window wake cap per agent (default 20 per hour). Over the cap the
 * router delays and coalesces; nothing is dropped. */
export class WakeLimiter {
  readonly #times: number[] = [];

  constructor(
    readonly perHour: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(perHour) || perHour < 1) throw new Error('wakes_per_hour must be a positive integer.');
  }

  #prune(): void {
    const cutoff = this.now() - 3600_000;
    while (this.#times.length && this.#times[0] <= cutoff) this.#times.shift();
  }

  /** Milliseconds until a wake is allowed (0 = now). */
  waitMs(): number {
    this.#prune();
    if (this.#times.length < this.perHour) return 0;
    return Math.max(1, this.#times[0] + 3600_000 - this.now());
  }

  record(): void {
    this.#prune();
    this.#times.push(this.now());
  }

  get used(): number {
    this.#prune();
    return this.#times.length;
  }
}
