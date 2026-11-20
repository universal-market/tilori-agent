import './setup.ts';
import { expect, test } from 'bun:test';
import { BuiltinPolicy } from '../src/policy.ts';

// UNI-1097 slice 1: the wake policy interface, `builtin` only. These pin the
// behaviour the router had before the refactor.
const HOUR = 3600_000;

function make(normal: number, direct: number) {
  let t = 1_000_000;
  const p = new BuiltinPolicy(normal, direct, () => t);
  return { p, tick: (ms: number) => (t += ms) };
}

test('normal lane goes first, then direct for a direct batch, else wait', () => {
  const { p } = make(1, 1);
  expect(p.decide({ hasDirect: false })).toEqual({ lane: 'normal' });
  p.record('normal');
  expect(p.decide({ hasDirect: true })).toEqual({ lane: 'direct' });
  expect(p.decide({ hasDirect: false })).toEqual({ waitMs: HOUR });
  p.record('direct');
  expect(p.decide({ hasDirect: true })).toEqual({ waitMs: HOUR });
});

test('the wait is the shorter of the two lanes', () => {
  const { p, tick } = make(1, 1);
  p.record('direct');
  tick(1000);
  p.record('normal');
  expect(p.decide({ hasDirect: true })).toEqual({ waitMs: HOUR - 1000 });
  // without a direct batch only the normal lane counts
  expect(p.decide({ hasDirect: false })).toEqual({ waitMs: HOUR });
});

test('direct 0 means off: never chosen, wait Infinity, usage null', () => {
  const { p } = make(1, 0);
  p.record('normal');
  expect(p.waitMs('direct')).toBe(Infinity);
  expect(p.decide({ hasDirect: true })).toEqual({ waitMs: HOUR });
  expect(p.used('direct')).toBeNull();
  expect(p.limit('direct')).toBe(0);
  p.record('direct'); // a no-op, not a throw
});

test('turning direct off and on keeps this hour\'s direct wakes', () => {
  const { p } = make(5, 1);
  p.record('direct');
  p.resize('direct', 0);
  expect(p.used('direct')).toBeNull();
  p.resize('direct', 1);
  expect(p.used('direct')).toBe(1);
  expect(p.waitMs('direct')).toBe(HOUR);
});

test('direct switched on at reload starts fresh', () => {
  const { p } = make(5, 0);
  p.resize('direct', 2);
  expect(p.limit('direct')).toBe(2);
  expect(p.used('direct')).toBe(0);
});

test('lowering the cap keeps wakes already spent', () => {
  const { p } = make(3, 1);
  p.record('normal');
  p.record('normal');
  p.resize('normal', 2);
  expect(p.canRemind()).toBe(false);
  p.resize('normal', 3);
  expect(p.canRemind()).toBe(true);
});

test('canRemind follows the normal lane only', () => {
  const { p, tick } = make(1, 5);
  expect(p.canRemind()).toBe(true);
  p.record('direct');
  expect(p.canRemind()).toBe(true);
  p.record('normal');
  expect(p.canRemind()).toBe(false);
  tick(HOUR);
  expect(p.canRemind()).toBe(true);
});

test('afterWakeWaitMs: 0 while a lane still has room, else the earlier return', () => {
  const { p, tick } = make(2, 1);
  expect(p.afterWakeWaitMs('normal')).toBe(0);
  p.record('normal');
  // this wake takes normal's last slot; direct still has one
  expect(p.afterWakeWaitMs('normal')).toBe(0);
  p.record('direct');
  tick(10);
  // a normal wake now would take the last of both
  expect(p.afterWakeWaitMs('normal')).toBe(Math.min(p.waitMs('normal') || HOUR, p.waitMs('direct')));
});

test('afterWakeWaitMs with direct off falls back to the normal lane', () => {
  const { p } = make(1, 0);
  expect(p.afterWakeWaitMs('normal')).toBe(HOUR);
});

test('invalid direct cap is refused', () => {
  expect(() => new BuiltinPolicy(5, -1)).toThrow();
  expect(() => new BuiltinPolicy(5, 1.5)).toThrow();
  expect(() => new BuiltinPolicy(0, 1)).toThrow();
});
