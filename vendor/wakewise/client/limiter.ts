// SPDX-License-Identifier: Apache-2.0
// Maintainers: Don and Adrian <opensource@universalmarket.ai>

import { selectLane } from "./policy.ts";
import type { Lane, LaneOccurrence } from "./policy.ts";
import { scrubId, scrubKind } from "./line.ts";

export const WINDOW_SECONDS = 3600;
export const MAX_COUNT = 999999;

export interface EventRef {
  readonly id: string;
  readonly kind: string;
}

export interface LimiterLimits {
  wakesPerHour: number;
  directWakesPerHour: number;
  alwaysWakePerHour: number;
  coalesceSeconds: number;
  pauseSeconds: number;
  heldQueueMaxIds: number;
}

export interface HeldStateSnapshot {
  readonly version: 1;
  readonly heldRefs: readonly EventRef[];
  readonly heldOverflowCount: number;
}

export class LimiterStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LimiterStateError";
  }
}

export interface LimiterInitialState {
  readonly heldRefs?: readonly EventRef[];
  readonly heldOverflowCount?: number;
}

export interface LimiterConfig {
  readonly selfId?: string | null;
  readonly directLane?: boolean;
  readonly directKinds?: readonly string[];
  readonly alwaysWake?: readonly string[];
  readonly limits?: Partial<LimiterLimits>;
  readonly initialState?: LimiterInitialState;
  readonly clock?: () => number;
}

export type LimiterDecision =
  | {
      readonly decision: "wake";
      readonly lane: Lane;
      readonly refs: readonly EventRef[];
      readonly heldOverflowCount: number;
    }
  | {
      readonly decision: "hold";
      readonly lane: Lane;
      readonly heldIds: number;
      readonly heldOverflowCount: number;
    }
  | {
      readonly decision: "coalesce";
      readonly lane: Lane;
      readonly pendingCount: number;
    }
  | {
      readonly decision: "resized";
    }
  | {
      readonly decision: "noop";
    };

export const DEFAULT_LIMITS: Readonly<LimiterLimits> = {
  wakesPerHour: 12,
  directWakesPerHour: 24,
  alwaysWakePerHour: 6,
  coalesceSeconds: 15,
  pauseSeconds: 0,
  heldQueueMaxIds: 64,
};

const LIMIT_RANGES: Readonly<Record<keyof LimiterLimits, readonly [number, number]>> = {
  wakesPerHour: [0, MAX_COUNT],
  directWakesPerHour: [0, MAX_COUNT],
  alwaysWakePerHour: [0, MAX_COUNT],
  coalesceSeconds: [0, WINDOW_SECONDS],
  pauseSeconds: [0, WINDOW_SECONDS],
  heldQueueMaxIds: [1, 1024],
};

const LANE_ORDER: readonly Lane[] = ["direct", "alwaysWake", "normal"];

function assertLane(lane: unknown): asserts lane is Lane {
  if (lane !== "normal" && lane !== "direct" && lane !== "alwaysWake") {
    throw new RangeError(`lane: must be "normal", "direct" or "alwaysWake"`);
  }
}

interface PendingBuffer {
  refs: EventRef[];
  keys: Set<string>;
  overflowCount: number;
  startedAt: number | null;
}

function createPendingBuffer(): PendingBuffer {
  return {
    refs: [],
    keys: new Set<string>(),
    overflowCount: 0,
    startedAt: null,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateLimitValue(key: keyof LimiterLimits, value: unknown): number {
  const [min, max] = LIMIT_RANGES[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(
      `limits.${key}: must be an integer between ${min} and ${max}`
    );
  }
  return value;
}

function validateLimitsUpdate(base: Readonly<LimiterLimits>, raw: unknown): LimiterLimits {
  if (!isPlainObject(raw)) {
    throw new RangeError("limits: must be an object");
  }
  const next: LimiterLimits = { ...base };
  for (const key of Object.keys(raw)) {
    if (!(key in LIMIT_RANGES)) {
      throw new RangeError(`limits.${key}: unknown limit key`);
    }
    const typedKey = key as keyof LimiterLimits;
    const value = raw[key];
    if (value !== undefined) {
      next[typedKey] = validateLimitValue(typedKey, value);
    }
  }
  return next;
}

function refKey(ref: EventRef): string {
  return `${ref.kind}\0${ref.id}`;
}

function defaultMonotonicClock(): number {
  return performance.now() / 1000;
}

/**
 * Units: onEvent/flush and the constructor clock take SECONDS; the per-lane
 * methods (waitMs, waitAfterNextMs, record, used, canRemind) take and return
 * MILLISECONDS. Both share one monotonic clock.
 */
export class RateLimiter {
  private readonly selfId: string | null;
  private readonly directLane: boolean;
  private readonly directKinds: readonly string[];
  private readonly alwaysWake: readonly string[];
  private readonly clock: () => number;
  private limits: LimiterLimits;

  private readonly timestamps: Record<Lane, number[]> = {
    normal: [],
    direct: [],
    alwaysWake: [],
  };

  private heldRefs: EventRef[] = [];
  private heldKeys = new Set<string>();
  private heldOverflowCount = 0;

  private readonly pending: Record<Lane, PendingBuffer> = {
    normal: createPendingBuffer(),
    direct: createPendingBuffer(),
    alwaysWake: createPendingBuffer(),
  };

  private lastWakeAt: number | null = null;
  private lastRawNow: number | null = null;
  private monoNow = 0;

  constructor(config: LimiterConfig = {}) {
    this.selfId = config.selfId ?? null;
    this.directLane = config.directLane !== false;
    this.directKinds = [...(config.directKinds ?? ["message.direct", "mention.direct"])];
    this.alwaysWake = [...(config.alwaysWake ?? [])];
    this.clock = config.clock ?? defaultMonotonicClock;
    this.limits =
      config.limits === undefined
        ? { ...DEFAULT_LIMITS }
        : validateLimitsUpdate(DEFAULT_LIMITS, config.limits);

    if (config.initialState) {
      for (const ref of config.initialState.heldRefs ?? []) {
        this.holdRef(ref);
      }
      if (typeof config.initialState.heldOverflowCount === "number") {
        const clamped = Math.max(
          0,
          Math.min(MAX_COUNT, Math.trunc(config.initialState.heldOverflowCount))
        );
        this.heldOverflowCount = clamped;
      }
    }
  }

  getLimits(): Readonly<LimiterLimits> {
    return { ...this.limits };
  }

  private advanceClock(nowSeconds?: number): number {
    const raw = nowSeconds === undefined ? this.clock() : nowSeconds;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      throw new RangeError("nowSeconds must be a finite number");
    }
    if (this.lastRawNow === null) {
      this.lastRawNow = raw;
      this.monoNow = raw;
      return this.monoNow;
    }
    const delta = raw - this.lastRawNow;
    this.lastRawNow = raw;
    if (delta > 0) {
      this.monoNow += delta;
    }
    return this.monoNow;
  }

  private prune(lane: Lane, nowSeconds: number): void {
    const cutoff = nowSeconds - WINDOW_SECONDS;
    const list = this.timestamps[lane];
    let firstValid = 0;
    while (firstValid < list.length && list[firstValid] < cutoff) {
      firstValid += 1;
    }
    if (firstValid > 0) {
      list.splice(0, firstValid);
    }
  }

  private capForLane(lane: Lane): number {
    if (lane === "direct") {
      return this.limits.directWakesPerHour;
    }
    if (lane === "alwaysWake") {
      return this.limits.alwaysWakePerHour;
    }
    return this.limits.wakesPerHour;
  }

  private limitKeyForLane(lane: Lane): keyof LimiterLimits {
    if (lane === "direct") {
      return "directWakesPerHour";
    }
    if (lane === "alwaysWake") {
      return "alwaysWakePerHour";
    }
    return "wakesPerHour";
  }

  private isPaused(nowSeconds: number): boolean {
    return (
      this.limits.pauseSeconds > 0 &&
      this.lastWakeAt !== null &&
      nowSeconds - this.lastWakeAt < this.limits.pauseSeconds
    );
  }

  private holdRef(ref: EventRef): void {
    const key = refKey(ref);
    if (this.heldKeys.has(key)) {
      return;
    }
    if (this.heldRefs.length < this.limits.heldQueueMaxIds) {
      this.heldKeys.add(key);
      this.heldRefs.push({ id: ref.id, kind: ref.kind });
    } else if (this.heldOverflowCount < MAX_COUNT) {
      this.heldOverflowCount += 1;
    }
  }

  private bufferPendingRef(lane: Lane, ref: EventRef): void {
    const buf = this.pending[lane];
    const key = refKey(ref);
    if (buf.keys.has(key)) {
      return;
    }
    if (buf.refs.length < this.limits.heldQueueMaxIds) {
      buf.keys.add(key);
      buf.refs.push({ id: ref.id, kind: ref.kind });
    } else if (buf.overflowCount < MAX_COUNT) {
      buf.overflowCount += 1;
    }
  }

  private clearPending(lane: Lane): void {
    const buf = this.pending[lane];
    buf.refs = [];
    buf.keys.clear();
    buf.overflowCount = 0;
    buf.startedAt = null;
  }

  private emitWake(lane: Lane, extraRefs: readonly EventRef[], nowSeconds: number): LimiterDecision {
    const combined: EventRef[] = [];
    const seen = new Set<string>();
    const buf = this.pending[lane];

    for (const ref of this.heldRefs) {
      const key = refKey(ref);
      if (!seen.has(key)) {
        seen.add(key);
        combined.push(ref);
      }
    }
    for (const ref of buf.refs) {
      const key = refKey(ref);
      if (!seen.has(key)) {
        seen.add(key);
        combined.push(ref);
      }
    }
    for (const ref of extraRefs) {
      const key = refKey(ref);
      if (!seen.has(key)) {
        seen.add(key);
        combined.push({ id: ref.id, kind: ref.kind });
      }
    }

    const drainedOverflow = Math.min(MAX_COUNT, this.heldOverflowCount + buf.overflowCount);
    this.heldRefs = [];
    this.heldKeys.clear();
    this.heldOverflowCount = 0;

    this.clearPending(lane);

    this.timestamps[lane].push(nowSeconds);
    this.lastWakeAt = nowSeconds;

    return {
      decision: "wake",
      lane,
      refs: combined,
      heldOverflowCount: drainedOverflow,
    };
  }

  private flushLane(lane: Lane, nowSeconds: number): LimiterDecision {
    const buf = this.pending[lane];
    if (buf.refs.length === 0 && buf.overflowCount === 0) {
      return { decision: "noop" };
    }
    this.prune(lane, nowSeconds);

    if (this.isPaused(nowSeconds) || this.timestamps[lane].length >= this.capForLane(lane)) {
      for (const ref of buf.refs) {
        this.holdRef(ref);
      }
      this.heldOverflowCount = Math.min(MAX_COUNT, this.heldOverflowCount + buf.overflowCount);
      this.clearPending(lane);
      return {
        decision: "hold",
        lane,
        heldIds: this.heldRefs.length,
        heldOverflowCount: this.heldOverflowCount,
      };
    }

    return this.emitWake(lane, [], nowSeconds);
  }

  onEvent(
    occurrence: LaneOccurrence & { readonly id: string },
    nowSeconds?: number
  ): LimiterDecision {
    const now = this.advanceClock(nowSeconds);
    const lane = selectLane(occurrence, {
      selfId: this.selfId,
      directLane: this.directLane,
      directKinds: this.directKinds,
      alwaysWake: this.alwaysWake,
    });
    const ref: EventRef = { id: occurrence.id, kind: occurrence.kind };

    this.prune(lane, now);

    if (this.isPaused(now) || this.timestamps[lane].length >= this.capForLane(lane)) {
      this.holdRef(ref);
      return {
        decision: "hold",
        lane,
        heldIds: this.heldRefs.length,
        heldOverflowCount: this.heldOverflowCount,
      };
    }

    if (this.limits.coalesceSeconds > 0) {
      this.bufferPendingRef(lane, ref);
      const buf = this.pending[lane];
      if (buf.startedAt === null) {
        buf.startedAt = now;
      }
      if (now - buf.startedAt < this.limits.coalesceSeconds) {
        return {
          decision: "coalesce",
          lane,
          pendingCount: buf.refs.length,
        };
      }
      return this.flushLane(lane, now);
    }

    return this.emitWake(lane, [ref], now);
  }

  flush(nowSeconds?: number, lane?: Lane): LimiterDecision {
    const now = this.advanceClock(nowSeconds);
    if (lane !== undefined) {
      return this.flushLane(lane, now);
    }
    let chosen: Lane | null = null;
    let earliest = Infinity;
    for (const candidate of LANE_ORDER) {
      const buf = this.pending[candidate];
      if (buf.refs.length === 0 && buf.overflowCount === 0) {
        continue;
      }
      const started = buf.startedAt ?? now;
      if (chosen === null || started < earliest) {
        chosen = candidate;
        earliest = started;
      }
    }
    if (chosen === null) {
      return { decision: "noop" };
    }
    return this.flushLane(chosen, now);
  }

  /**
   * Live resize validates all provided limits atomically and updates caps
   * without clearing, resetting, or shortening the existing rolling-hour
   * timestamp history. Throws RangeError with no partial apply on invalid input.
   */
  resize(partial: Partial<LimiterLimits>): LimiterDecision;
  resize(lane: Lane, perHour: number): LimiterDecision;
  resize(
    laneOrPartial: Lane | Partial<LimiterLimits>,
    perHour?: number
  ): LimiterDecision {
    if (typeof laneOrPartial === "string") {
      assertLane(laneOrPartial);
      if (perHour === undefined) {
        throw new RangeError("resize(lane, perHour): perHour is required");
      }
      const key = this.limitKeyForLane(laneOrPartial);
      this.limits = validateLimitsUpdate(this.limits, { [key]: perHour });
      return { decision: "resized" };
    }
    this.limits = validateLimitsUpdate(this.limits, laneOrPartial);
    return { decision: "resized" };
  }

  /**
   * Milliseconds until `lane` can emit a wake at `nowMs`.
   * `"alwaysWake"` uses `alwaysWakePerHour`, the same cap `onEvent` enforces.
   */
  waitMs(lane: Lane, nowMs?: number): number {
    assertLane(lane);
    const nowSec = this.advanceClock(nowMs !== undefined ? nowMs / 1000 : undefined);
    this.prune(lane, nowSec);
    const pauseWaitMs = this.isPaused(nowSec)
      ? Math.max(0, Math.ceil((this.lastWakeAt! + this.limits.pauseSeconds - nowSec) * 1000))
      : 0;
    const cap = this.capForLane(lane);
    if (this.timestamps[lane].length < cap) {
      return pauseWaitMs;
    }
    if (cap === 0) {
      return Infinity;
    }
    const oldestIdx = this.timestamps[lane].length - cap;
    const oldest = this.timestamps[lane][oldestIdx];
    const capWaitMs = Math.max(
      0,
      Math.ceil((oldest + WINDOW_SECONDS - nowSec) * 1000)
    );
    return Math.max(capWaitMs, pauseWaitMs);
  }

  /**
   * Milliseconds the caller would have to wait after recording one more wake
   * on `lane` at `nowMs`. `"alwaysWake"` uses `alwaysWakePerHour`.
   */
  waitAfterNextMs(lane: Lane, nowMs?: number): number {
    assertLane(lane);
    const nowSec = this.advanceClock(nowMs !== undefined ? nowMs / 1000 : undefined);
    this.prune(lane, nowSec);
    const cap = this.capForLane(lane);
    if (cap === 0) {
      return Infinity;
    }
    const pauseAfterMs =
      this.limits.pauseSeconds > 0 ? this.limits.pauseSeconds * 1000 : 0;
    const simulatedLen = this.timestamps[lane].length + 1;
    if (simulatedLen < cap) {
      return pauseAfterMs;
    }
    const oldestIdx = simulatedLen - cap;
    const oldest =
      oldestIdx < this.timestamps[lane].length
        ? this.timestamps[lane][oldestIdx]
        : nowSec;
    const capWaitMs = Math.max(
      0,
      Math.ceil((oldest + WINDOW_SECONDS - nowSec) * 1000)
    );
    return Math.max(capWaitMs, pauseAfterMs);
  }

  /**
   * Record a wake timestamp on `lane` at `nowMs`.
   */
  record(lane: Lane, nowMs?: number): void {
    assertLane(lane);
    const nowSec = this.advanceClock(nowMs !== undefined ? nowMs / 1000 : undefined);
    this.prune(lane, nowSec);
    this.timestamps[lane].push(nowSec);
    this.lastWakeAt = nowSec;
  }

  /**
   * Number of timestamps currently in the rolling-hour window for `lane`.
   */
  used(lane: Lane, nowMs?: number): number {
    assertLane(lane);
    const nowSec = this.advanceClock(nowMs !== undefined ? nowMs / 1000 : undefined);
    this.prune(lane, nowSec);
    return this.timestamps[lane].length;
  }

  /**
   * Configured rolling-hour cap for `lane`.
   */
  perHour(lane: Lane): number {
    assertLane(lane);
    return this.capForLane(lane);
  }

  /**
   * Spend a normal-lane slot for a reminder if below cap and not paused;
   * returns false (skipped, not delayed) when at cap or paused.
   */
  canRemind(nowMs?: number): boolean {
    const nowSec = this.advanceClock(nowMs !== undefined ? nowMs / 1000 : undefined);
    this.prune("normal", nowSec);
    if (this.isPaused(nowSec) || this.timestamps.normal.length >= this.limits.wakesPerHour) {
      return false;
    }
    this.timestamps.normal.push(nowSec);
    this.lastWakeAt = nowSec;
    return true;
  }

  /**
   * Export a bounded, JSON-serialisable snapshot of the held queue (ids and kinds only).
   */
  exportHeldState(): HeldStateSnapshot {
    return {
      version: 1,
      heldRefs: this.heldRefs
        .slice(0, this.limits.heldQueueMaxIds)
        .map((r) => ({ id: r.id, kind: r.kind })),
      // Ids dropped by a shrunken heldQueueMaxIds still count as overflow.
      heldOverflowCount: Math.min(
        MAX_COUNT,
        Math.max(0, this.heldOverflowCount) +
          Math.max(0, this.heldRefs.length - this.limits.heldQueueMaxIds)
      ),
    };
  }

  /**
   * Strictly validate and import a held-queue snapshot.
   * Throws LimiterStateError without modifying any state on invalid, oversized,
   * or non-UUID/non-kind entries.
   */
  importHeldState(snapshot: unknown): void {
    if (!isPlainObject(snapshot)) {
      throw new LimiterStateError("heldState: snapshot must be a plain object");
    }
    for (const key of Object.keys(snapshot)) {
      if (key !== "version" && key !== "heldRefs" && key !== "heldOverflowCount") {
        throw new LimiterStateError(`heldState: unknown key "${key}"`);
      }
    }
    if (snapshot.version !== 1) {
      throw new LimiterStateError("heldState.version: must be 1");
    }
    if (!Array.isArray(snapshot.heldRefs)) {
      throw new LimiterStateError("heldState.heldRefs: must be an array");
    }
    if (snapshot.heldRefs.length > this.limits.heldQueueMaxIds) {
      throw new LimiterStateError(
        `heldState.heldRefs: length ${snapshot.heldRefs.length} exceeds heldQueueMaxIds (${this.limits.heldQueueMaxIds})`
      );
    }
    if (
      typeof snapshot.heldOverflowCount !== "number" ||
      !Number.isInteger(snapshot.heldOverflowCount) ||
      snapshot.heldOverflowCount < 0 ||
      snapshot.heldOverflowCount > MAX_COUNT
    ) {
      throw new LimiterStateError(
        `heldState.heldOverflowCount: must be an integer between 0 and ${MAX_COUNT}`
      );
    }

    const nextRefs: EventRef[] = [];
    const nextKeys = new Set<string>();
    for (let i = 0; i < snapshot.heldRefs.length; i += 1) {
      const entry = snapshot.heldRefs[i];
      if (!isPlainObject(entry)) {
        throw new LimiterStateError(`heldState.heldRefs[${i}]: must be an object`);
      }
      for (const k of Object.keys(entry)) {
        if (k !== "id" && k !== "kind") {
          throw new LimiterStateError(`heldState.heldRefs[${i}].${k}: unknown key`);
        }
      }
      const idRes = scrubId(entry.id);
      if (!idRes.accepted) {
        throw new LimiterStateError(
          `heldState.heldRefs[${i}].id: must be a 36-char lowercase ASCII UUID`
        );
      }
      const kindRes = scrubKind(entry.kind);
      if (!kindRes.accepted) {
        throw new LimiterStateError(
          `heldState.heldRefs[${i}].kind: must be a valid event kind`
        );
      }
      const key = `${kindRes.value}\0${idRes.value}`;
      if (nextKeys.has(key)) {
        throw new LimiterStateError(`heldState.heldRefs[${i}]: duplicate entry`);
      }
      nextKeys.add(key);
      nextRefs.push({ id: idRes.value, kind: kindRes.value });
    }

    this.heldRefs = nextRefs;
    this.heldKeys = nextKeys;
    this.heldOverflowCount = snapshot.heldOverflowCount;
  }
}
