import './setup.ts';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { policyConfig, shadowMode, wakeEngine } from '../src/config.ts';
import {
  BuiltinPolicy,
  FailOpenWakewisePolicy,
  ShadowPolicy,
  WakewisePolicy,
  type ShadowDiff,
  type WakePolicy,
} from '../src/policy.ts';
import { DecisionRecorder } from '../src/recorder.ts';
import { liveSettings } from '../src/settings.ts';

// UNI-1097 slices 1 & 2: WakePolicy table tests (builtin vs wakewise),
// config validation, fail-open guard, and shadow mode.
const HOUR = 3600_000;

type PolicyFactory = (normal: number, direct: number, now: () => number) => WakePolicy;

const IMPLEMENTATIONS: [string, PolicyFactory][] = [
  ['builtin', (n, d, now) => new BuiltinPolicy(n, d, now)],
  ['wakewise', (n, d, now) => new WakewisePolicy(n, d, now)],
];

function makeWith(factory: PolicyFactory, normal: number, direct: number) {
  let t = 1_000_000;
  const p = factory(normal, direct, () => t);
  return { p, tick: (ms: number) => (t += ms) };
}

describe.each(IMPLEMENTATIONS)('WakePolicy (%s)', (_name, factory) => {
  test('normal lane goes first, then direct for a direct batch, else wait', () => {
    const { p } = makeWith(factory, 1, 1);
    expect(p.decide({ hasDirect: false })).toEqual({ lane: 'normal' });
    p.record('normal');
    expect(p.decide({ hasDirect: true })).toEqual({ lane: 'direct' });
    expect(p.decide({ hasDirect: false })).toEqual({ waitMs: HOUR });
    p.record('direct');
    expect(p.decide({ hasDirect: true })).toEqual({ waitMs: HOUR });
  });

  test('the wait is the shorter of the two lanes', () => {
    const { p, tick } = makeWith(factory, 1, 1);
    p.record('direct');
    tick(1000);
    p.record('normal');
    expect(p.decide({ hasDirect: true })).toEqual({ waitMs: HOUR - 1000 });
    // without a direct batch only the normal lane counts
    expect(p.decide({ hasDirect: false })).toEqual({ waitMs: HOUR });
  });

  test('direct 0 means off: never chosen, wait Infinity, usage null', () => {
    const { p } = makeWith(factory, 1, 0);
    p.record('normal');
    expect(p.waitMs('direct')).toBe(Infinity);
    expect(p.decide({ hasDirect: true })).toEqual({ waitMs: HOUR });
    expect(p.used('direct')).toBeNull();
    expect(p.limit('direct')).toBe(0);
    p.record('direct'); // a no-op, not a throw
  });

  test("turning direct off and on keeps this hour's direct wakes", () => {
    const { p } = makeWith(factory, 5, 1);
    p.record('direct');
    p.resize('direct', 0);
    expect(p.used('direct')).toBeNull();
    p.resize('direct', 1);
    expect(p.used('direct')).toBe(1);
    expect(p.waitMs('direct')).toBe(HOUR);
  });

  test('direct switched on at reload starts fresh', () => {
    const { p } = makeWith(factory, 5, 0);
    p.resize('direct', 2);
    expect(p.limit('direct')).toBe(2);
    expect(p.used('direct')).toBe(0);
  });

  test('lowering the cap keeps wakes already spent', () => {
    const { p } = makeWith(factory, 3, 1);
    p.record('normal');
    p.record('normal');
    p.resize('normal', 2);
    expect(p.canRemind()).toBe(false);
    p.resize('normal', 3);
    expect(p.canRemind()).toBe(true);
  });

  test('canRemind follows the normal lane only and is read-only', () => {
    const { p, tick } = makeWith(factory, 1, 5);
    expect(p.canRemind()).toBe(true);
    // Calling canRemind() repeatedly does not spend normal allowance.
    expect(p.canRemind()).toBe(true);
    expect(p.used('normal')).toBe(0);
    p.record('direct');
    expect(p.canRemind()).toBe(true);
    p.record('normal');
    expect(p.canRemind()).toBe(false);
    tick(HOUR + 1);
    expect(p.canRemind()).toBe(true);
  });

  test('afterWakeWaitMs: 0 while a lane still has room, else the earlier return', () => {
    const { p, tick } = makeWith(factory, 2, 1);
    expect(p.afterWakeWaitMs('normal')).toBe(0);
    p.record('normal');
    // this wake takes normal's last slot; direct still has one
    expect(p.afterWakeWaitMs('normal')).toBe(0);
    p.record('direct');
    tick(10);
    // a normal wake now would take the last of both
    expect(p.afterWakeWaitMs('normal')).toBe(HOUR - 10);
    // a direct wake would take direct's only slot while normal still has one
    expect(p.afterWakeWaitMs('direct')).toBe(0);
  });

  test('afterWakeWaitMs takes the earlier of the two lanes returning', () => {
    const { p, tick } = makeWith(factory, 1, 1);
    p.record('direct');
    tick(5000);
    p.record('normal');
    tick(10);
    // both full: a normal wake restarts normal's window, so direct returns first
    expect(p.afterWakeWaitMs('normal')).toBe(HOUR - 5010);
    // a direct wake restarts direct's window, so normal returns first, at HOUR-10
    expect(p.afterWakeWaitMs('direct')).toBe(HOUR - 10);
  });

  test('afterWakeWaitMs with direct off falls back to the normal lane', () => {
    const { p } = makeWith(factory, 1, 0);
    expect(p.afterWakeWaitMs('normal')).toBe(HOUR);
  });

  test('invalid caps are refused', () => {
    expect(() => factory(5, -1, Date.now)).toThrow();
    expect(() => factory(5, 1.5, Date.now)).toThrow();
    expect(() => factory(0, 1, Date.now)).toThrow();
  });
});

test('kit boundary difference: exact t + HOUR keeps timestamp in RateLimiter used() while waitMs() is 0', () => {
  const b = makeWith(IMPLEMENTATIONS[0][1], 1, 0);
  const w = makeWith(IMPLEMENTATIONS[1][1], 1, 0);
  b.p.record('normal');
  w.p.record('normal');
  b.tick(HOUR);
  w.tick(HOUR);
  expect(b.p.waitMs('normal')).toBe(0);
  expect(w.p.waitMs('normal')).toBe(0);
  // Builtin prunes <= cutoff; wakewise kit prunes < cutoff.
  expect(b.p.used('normal')).toBe(0);
  expect(w.p.used('normal')).toBe(1);
});

describe('wake_engine and shadow local config', () => {
  test('both keys default when unset', () => {
    expect(wakeEngine(undefined)).toBe('builtin');
    expect(shadowMode(undefined)).toBe(false);
    expect(policyConfig({}, 'wren')).toEqual({});
    expect(policyConfig({ agents: { wren: {} } }, 'wren')).toEqual({});
  });

  test('typo or wrong type throws', () => {
    for (const v of ['fast', '', 1, true, null]) {
      expect(() => wakeEngine(v)).toThrow('wake_engine');
    }
    for (const v of ['true', 'yes', 1, null, {}]) {
      expect(() => shadowMode(v)).toThrow('shadow');
    }
    expect(() => policyConfig({ agents: { wren: { wake_engine: 'typo' as never } } }, 'wren')).toThrow();
    expect(() => policyConfig({ agents: { wren: { shadow: 'yes' as never } } }, 'wren')).toThrow();
  });

  test('shadow: true with wake_engine: "wakewise" throws', () => {
    expect(() =>
      policyConfig({ agents: { wren: { wake_engine: 'wakewise', shadow: true } } }, 'wren'),
    ).toThrow('shadow');
    expect(() => liveSettings({ wake_engine: 'wakewise', shadow: true })).toThrow('shadow');
  });

  test('server-shaped objects cannot set wake_engine or shadow', () => {
    const serverShaped = {
      wake_engine: 'wakewise',
      shadow: true,
      _meta: { wake_engine: 'wakewise', shadow: true },
      subscription: { wake_engine: 'wakewise', shadow: true },
      agents: {
        other: { wake_engine: 'wakewise', shadow: true },
      },
    };
    expect(policyConfig(serverShaped as never, 'wren')).toEqual({});
  });
});

describe('FailOpenWakewisePolicy', () => {
  test('falls back to builtin on runtime throw, logs once, and preserves counts', () => {
    let t = 1_000_000;
    const logs: string[] = [];
    const inner = new WakewisePolicy(2, 1, () => t);
    let shouldThrow = false;
    const fakeWakewise: WakePolicy = {
      decide: (input) => {
        if (shouldThrow) throw new Error('boom');
        return inner.decide(input);
      },
      record: (lane) => inner.record(lane),
      waitMs: (lane) => inner.waitMs(lane),
      afterWakeWaitMs: (lane) => inner.afterWakeWaitMs(lane),
      canRemind: () => inner.canRemind(),
      resize: (lane, n) => inner.resize(lane, n),
      limit: (lane) => inner.limit(lane),
      used: (lane) => inner.used(lane),
    };

    const p = new FailOpenWakewisePolicy(2, 1, {
      now: () => t,
      onError: (m) => logs.push(m),
      makeWakewise: () => fakeWakewise,
    });

    p.record('normal');
    expect(p.used('normal')).toBe(1);
    shouldThrow = true;
    // First throw triggers fallback to builtin, which already has the 1 recorded wake.
    expect(p.decide({ hasDirect: false })).toEqual({ lane: 'normal' });
    expect(logs).toEqual(['wakewise policy failed: boom; using builtin']);
    expect(p.used('normal')).toBe(1);
    p.record('normal');
    expect(p.used('normal')).toBe(2);
    expect(p.decide({ hasDirect: false })).toEqual({ waitMs: HOUR });
    // Subsequent calls never log again.
    expect(logs).toHaveLength(1);
  });

  test('falls back to builtin if wakewise cannot be constructed', () => {
    const logs: string[] = [];
    const p = new FailOpenWakewisePolicy(2, 1, {
      onError: (m) => logs.push(m),
      makeWakewise: () => {
        throw new Error('init failed');
      },
    });
    expect(logs).toEqual(['wakewise policy failed: init failed; using builtin']);
    expect(p.decide({ hasDirect: false })).toEqual({ lane: 'normal' });
    p.record('normal');
    expect(p.used('normal')).toBe(1);
  });
});

describe('ShadowPolicy', () => {
  test('always returns builtin result and reports forced diff with metadata only', () => {
    const t = Date.UTC(2026, 10, 20);
    const diffs: ShadowDiff[] = [];
    const fakeWakewise: WakePolicy = {
      decide: () => ({ lane: 'direct' }),
      record: () => {},
      waitMs: () => 0,
      afterWakeWaitMs: () => 0,
      canRemind: () => true,
      resize: () => {},
      limit: () => 1,
      used: () => 0,
    };

    const p = new ShadowPolicy(2, 1, {
      now: () => t,
      onDiff: (d) => diffs.push(d),
      makeWakewise: () => fakeWakewise,
    });

    const res = p.decide({ hasDirect: true });
    expect(res).toEqual({ lane: 'normal' });
    expect(diffs).toEqual([
      {
        at: '2026-11-20T00:00:00.000Z',
        method: 'decide',
        builtin: { lane: 'normal' },
        wakewise: { lane: 'direct' },
        lane: 'normal',
      },
    ]);
  });

  test('DecisionRecorder records shadow_diff with 0600 mode and no content fields', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'tilori-shadow-rec-')), 'rec');
    const rec = new DecisionRecorder(dir, 'wren', { now: () => Date.UTC(2026, 10, 20) });
    rec.recordShadowDiff({
      method: 'decide',
      builtin: { lane: 'normal' },
      wakewise: { waitMs: 5000 },
      lane: 'normal',
    });
    const lines = readFileSync(rec.path, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toEqual([
      {
        at: '2026-11-20T00:00:00.000Z',
        recipient: 'wren',
        type: 'shadow_diff',
        method: 'decide',
        builtin: { lane: 'normal' },
        wakewise: { waitMs: 5000 },
        lane: 'normal',
      },
    ]);
    expect(statSync(rec.path).mode & 0o777).toBe(0o600);
    rec.close();
  });

  test('wakewise throw in shadow logs once, stops mirroring, and never alters builtin', () => {
    const logs: string[] = [];
    const diffs: ShadowDiff[] = [];
    let calls = 0;
    const fakeWakewise: WakePolicy = {
      decide: () => {
        calls++;
        throw new Error('shadow boom');
      },
      record: () => {
        calls++;
        throw new Error('should not be called after stop');
      },
      waitMs: () => 0,
      afterWakeWaitMs: () => 0,
      canRemind: () => true,
      resize: () => {},
      limit: () => 1,
      used: () => 0,
    };

    const p = new ShadowPolicy(2, 1, {
      onDiff: (d) => diffs.push(d),
      onError: (m) => logs.push(m),
      makeWakewise: () => fakeWakewise,
    });

    expect(p.decide({ hasDirect: false })).toEqual({ lane: 'normal' });
    expect(logs).toEqual(['wakewise shadow failed: shadow boom; stopping shadow']);
    expect(diffs).toEqual([]);
    p.record('normal');
    expect(p.decide({ hasDirect: false })).toEqual({ lane: 'normal' });
    // Only the initial decide() hit wakewise; mirroring stopped afterwards.
    expect(calls).toBe(1);
    expect(logs).toHaveLength(1);
  });
});
