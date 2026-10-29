import './setup.ts';
import { mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { activityDir, promptSignal, stallMinutes, statusLine } from '../src/activity.ts';
import { desiredSubscriptions } from '../src/config.ts';
import { Router } from '../src/router.ts';
import type { DeliverResult, Injector, Wake } from '../src/types.ts';
import { FakeTilori, mention, until } from './fake-tilori.ts';

let dir = '';
const saved = process.env.TILORI_SOCKET;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tilori-activity-'));
  process.env.TILORI_SOCKET = join(dir, 'router.sock');
});
afterEach(() => {
  if (saved === undefined) delete process.env.TILORI_SOCKET;
  else process.env.TILORI_SOCKET = saved;
});

/** Creates or updates a signal file with the given mtime (ms). */
function touch(name: string, ms: number) {
  const p = join(dir, name);
  writeFileSync(p, '');
  utimesSync(p, ms / 1000, ms / 1000);
}

describe('prompt signal', () => {
  test('the run directory is the socket\'s', () => {
    expect(activityDir()).toBe(dir);
  });

  test('no files: never flagged, and status says the client can\'t report prompts', () => {
    const s = promptSignal('wren');
    expect(s).toEqual({ blockedSince: null, reports: false, tracked: true });
    expect(statusLine('wren', s)).toBe("wren: ok (this client can't report prompts)");
  });

  test('no run dir (no router): status says prompts are not tracked', () => {
    process.env.TILORI_SOCKET = join(dir, 'missing', 'router.sock');
    const s = promptSignal('wren');
    expect(s).toEqual({ blockedSince: null, reports: false, tracked: false });
    expect(statusLine('wren', s)).toBe('wren: ok (prompts not tracked: no router running)');
  });

  test('activity only: ok', () => {
    touch('activity-wren', Date.now());
    expect(statusLine('wren', promptSignal('wren'))).toBe('wren: ok');
  });

  test('blocked newer than activity: blocked; the next tool call clears it', () => {
    const t = Date.UTC(2026, 9, 29, 2, 5);
    touch('activity-wren', t - 60_000);
    touch('blocked-wren', t);
    expect(promptSignal('wren').blockedSince).toBe(t);
    expect(statusLine('wren', promptSignal('wren'))).toBe('wren: blocked on a prompt since 02:05 UTC');
    touch('activity-wren', t + 1000);
    expect(promptSignal('wren')).toEqual({ blockedSince: null, reports: true, tracked: true });
  });

  test('a denied prompt fires no tool call, so it stays blocked until the next one', () => {
    const t = Date.now() - 30 * 60_000;
    touch('blocked-wren', t);
    expect(promptSignal('wren').blockedSince).toBe(t);
  });

  test('another agent\'s files, symlinks and invalid handles are ignored', () => {
    touch('blocked-pax', Date.now());
    expect(promptSignal('wren').blockedSince).toBeNull();
    const target = join(dir, 'elsewhere');
    writeFileSync(target, '');
    symlinkSync(target, join(dir, 'blocked-wren'));
    expect(promptSignal('wren')).toEqual({ blockedSince: null, reports: false, tracked: true });
    touch('blocked-..', Date.now());
    expect(promptSignal('..').blockedSince).toBeNull();
    expect(promptSignal('../wren').blockedSince).toBeNull();
  });

  test('stall_minutes: default 10, 0 turns it off, bad values throw', () => {
    expect(stallMinutes(undefined)).toBe(10);
    expect(stallMinutes(0)).toBe(0);
    expect(stallMinutes(1440)).toBe(1440);
    for (const bad of [-1, 1.5, '10', 1441, null]) expect(() => stallMinutes(bad)).toThrow();
  });
});

class Recorder implements Injector {
  readonly kind = 'test';
  wakes: Wake[] = [];
  async deliver(wake: Wake): Promise<DeliverResult> {
    this.wakes.push(wake);
    return 'accepted';
  }
}

function routerWith(stall: number) {
  const fake = new FakeTilori();
  const logs: string[] = [];
  const router = new Router({
    agents: [{ handle: 'wren', client: fake.client(), subscriptions: desiredSubscriptions({}), stallMinutes: stall }],
    logger: (m) => logs.push(m),
    waitMs: 10,
    retryMs: 10,
    coalesceMs: 0,
  });
  const inj = new Recorder();
  router.register('wren', inj);
  const ac = new AbortController();
  const done = router.run(ac.signal);
  return { fake, logs, inj, ac, done };
}

describe('router stall line', () => {
  test('logs once after stall_minutes with the wakes accepted since, then clears', async () => {
    const since = Date.now() - 11 * 60_000;
    touch('activity-wren', since - 1000);
    touch('blocked-wren', since);
    const { fake, logs, inj, ac, done } = routerWith(10);
    await until(() => fake.subs.length === 2);
    for (let i = 1; i <= 3; i++) {
      fake.push('inbox', [mention()]);
      await until(() => inj.wakes.length === i);
    }
    const blocked = logs.filter((l) => l.includes('blocked on a prompt'));
    expect(blocked).toEqual([`[wren] blocked on a prompt since ${new Date(since).toISOString().slice(11, 16)} UTC, 1 wake pending`]);
    touch('activity-wren', Date.now());
    fake.push('inbox', [mention()]);
    await until(() => inj.wakes.length === 4);
    expect(logs.filter((l) => l.includes('no longer blocked'))).toEqual(['[wren] no longer blocked on a prompt']);
    // Only the handle, a time and a count: no ids or text.
    for (const l of logs.filter((l) => l.includes('prompt'))) expect(l).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    ac.abort();
    await done;
  });

  test('not before stall_minutes, and never with stall_minutes 0', async () => {
    touch('blocked-wren', Date.now() - 5 * 60_000);
    for (const stall of [10, 0]) {
      const { fake, logs, inj, ac, done } = routerWith(stall);
      await until(() => fake.subs.length === 2);
      fake.push('inbox', [mention()]);
      await until(() => inj.wakes.length === 1);
      if (stall === 0) touch('blocked-wren', Date.now() - 60 * 60_000);
      fake.push('inbox', [mention()]);
      await until(() => inj.wakes.length === 2);
      expect(logs.filter((l) => l.includes('prompt'))).toEqual([]);
      ac.abort();
      await done;
    }
  });
});
