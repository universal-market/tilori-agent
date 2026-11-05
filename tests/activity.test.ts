import './setup.ts';
import { lstatSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { activityDir, ago, promptSignal, stallMinutes, statusLine, touchSignal, watchSignal } from '../src/activity.ts';
import { desiredSubscriptions } from '../src/config.ts';
import { Router } from '../src/router.ts';
import type { DeliverResult, Injector, Wake } from '../src/types.ts';
import { sanitizeWake, wakeText } from '../src/wake.ts';
import { FakeTilori, mention, post, until } from './fake-tilori.ts';

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
  });

  test('no run dir (no router): status says prompts are not tracked', () => {
    process.env.TILORI_SOCKET = join(dir, 'missing', 'router.sock');
    const s = promptSignal('wren');
    expect(s).toEqual({ blockedSince: null, reports: false, tracked: false });
  });

  test('activity only: ok', () => {
    touch('activity-wren', Date.now());
    expect(promptSignal('wren')).toEqual({ blockedSince: null, reports: true, tracked: true });
  });

  test('blocked newer than activity: blocked; the next tool call clears it', () => {
    const t = Date.UTC(2026, 9, 29, 2, 5);
    touch('activity-wren', t - 60_000);
    touch('blocked-wren', t);
    expect(promptSignal('wren').blockedSince).toBe(t);
    expect(statusLine('wren', promptSignal('wren'), watchSignal('wren'), { now: t })).toBe(
      'wren: blocked on a prompt since 02:05 UTC',
    );
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

describe('status line', () => {
  const now = Date.UTC(2026, 9, 30, 1, 0);
  const line = (opts: { stallMinutes?: number } = {}, router = false) =>
    statusLine('wren', promptSignal('wren'), watchSignal('wren', dir, router), { now, ...opts });
  const START =
    'nothing is pushed to this agent. Start its monitor (in Claude Code, restart the session) or router, or check Tilori yourself with whats_new.';

  test('nothing has ever polled: never watched, with what to do', () => {
    expect(line()).toBe(`wren: never watched on this machine: ${START}`);
  });

  test('polling started but nothing answered yet: says so, not "start it"', () => {
    touch('attempting-wren', now - 5_000);
    expect(line()).toContain('never watched on this machine: a monitor or router is polling, but no poll has succeeded yet');
  });

  test('watched, no wakes yet; who polls at the end', () => {
    touch('watching-wren', now - 20_000);
    expect(line()).toBe('wren: watched; no wakes yet; polled directly');
    expect(line({}, true)).toBe('wren: watched; no wakes yet; polled by the router');
  });

  test('acted since the last wake', () => {
    touch('watching-wren', now - 10_000);
    touch('woke-wren', now - 12 * 60_000);
    touch('activity-wren', now - 11 * 60_000);
    expect(line()).toBe('wren: watched; last wake 12 min ago (00:48 UTC), acted since; polled directly');
  });

  test('no action: "yet" below stall_minutes, then how long', () => {
    touch('watching-wren', now - 10_000);
    touch('activity-wren', now - 30 * 60_000);
    touch('woke-wren', now - 60_000);
    expect(line()).toBe('wren: watched; last wake 1 min ago (00:59 UTC), no action yet; polled directly');
    touch('woke-wren', now - 12 * 60_000);
    expect(line()).toBe('wren: watched; last wake 12 min ago (00:48 UTC), no action for 12 min; polled directly');
    expect(line({ stallMinutes: 30 })).toBe('wren: watched; last wake 12 min ago (00:48 UTC), no action yet; polled directly');
  });

  test('a client without the hooks: no claim about actions', () => {
    touch('watching-wren', now - 10_000);
    touch('woke-wren', now - 12 * 60_000);
    expect(line()).toBe('wren: watched; last wake 12 min ago (00:48 UTC); polled directly');
  });

  test('stopped polling: not watched for, with what to do', () => {
    touch('watching-wren', now - 40 * 60_000);
    expect(line()).toBe(`wren: not watched for 40 min (since 00:20 UTC): ${START}`);
  });

  test('still polling but failing: points at the key and network, not a restart', () => {
    touch('watching-wren', now - 40 * 60_000);
    touch('attempting-wren', now - 20_000);
    expect(line()).toBe(
      "wren: not watched for 40 min (since 00:20 UTC): a monitor or router is running, but its polls are failing; check the agent's key and network (the tilori-agent log says which).",
    );
  });

  test('blocked on a prompt still comes first', () => {
    touch('watching-wren', now - 10_000);
    touch('activity-wren', now - 120_000);
    touch('blocked-wren', now - 60_000);
    expect(line()).toBe('wren: blocked on a prompt since 00:59 UTC');
  });

  test('long gaps in hours, and the date when it isn\'t today', () => {
    touch('watching-wren', now - 10_000);
    touch('activity-wren', now - 10 * 3600_000);
    touch('woke-wren', now - 9 * 3600_000);
    expect(line()).toBe('wren: watched; last wake 9 h ago (2026-10-29 16:00 UTC), no action for 9 h; polled directly');
    touch('watching-wren', now - 25 * 3600_000);
    expect(line()).toBe(`wren: not watched for 25 h (since 2026-10-29 00:00 UTC): ${START}`);
  });

  test('ago: minutes, hours, and the date when it isn\'t today', () => {
    expect(ago(now - 20_000, now)).toBe('just now (00:59 UTC)');
    expect(ago(now - 3 * 3600_000, now)).toBe('3 h ago (2026-10-29 22:00 UTC)');
  });

  test('symlinked or invalid signal files are ignored', () => {
    const target = join(dir, 'elsewhere');
    writeFileSync(target, '');
    symlinkSync(target, join(dir, 'watching-wren'));
    expect(watchSignal('wren', dir).watching).toBeNull();
    expect(watchSignal('../wren', dir).watching).toBeNull();
  });

  test('touchSignal creates a 0600 file, refuses a symlink and an invalid handle', () => {
    touchSignal(dir, 'woke', 'wren');
    expect(lstatSync(join(dir, 'woke-wren')).mode & 0o777).toBe(0o600);
    const target = join(dir, 'target');
    writeFileSync(target, '');
    utimesSync(target, 1, 1);
    symlinkSync(target, join(dir, 'watching-wren'));
    expect(() => touchSignal(dir, 'watching', 'wren')).toThrow();
    expect(lstatSync(target).mtimeMs).toBe(1000);
    expect(() => touchSignal(dir, 'woke', '../x')).toThrow();
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
    plainHoldMs: 0,
    directPauseMs: 0,
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

describe('router status files and the direct tag', () => {
  function run(signalDir?: string, subscriptions = desiredSubscriptions({ subscriptions: [{ scope: { type: 'posts' } }] })) {
    const fake = new FakeTilori();
    const router = new Router({
      agents: [{ handle: 'wren', client: fake.client(), subscriptions }],
      waitMs: 10,
      retryMs: 10,
      coalesceMs: 0,
      plainHoldMs: 0,
      signalDir,
    });
    const inj = new Recorder();
    router.register('wren', inj);
    const ac = new AbortController();
    const done = router.run(ac.signal);
    return { fake, inj, ac, done };
  }

  test('polls touch attempting- and watching-; an accepted wake touches woke-', async () => {
    const { fake, inj, ac, done } = run(dir);
    await until(() => watchSignal('wren', dir).watching !== null);
    expect(watchSignal('wren', dir).attempting).not.toBeNull();
    expect(watchSignal('wren', dir).woke).toBeNull();
    fake.push('inbox', [mention()]);
    await until(() => inj.wakes.length === 1);
    await until(() => watchSignal('wren', dir).woke !== null);
    ac.abort();
    await done;
  });

  test('a long pause on broad-only subscriptions keeps status "watched" (Iris)', async () => {
    const fake = new FakeTilori();
    const router = new Router({
      agents: [{ handle: 'wren', client: fake.client(), subscriptions: desiredSubscriptions({ inbox: false, direct_messages: false, subscriptions: [{ scope: { type: 'posts' } }] }) }],
      waitMs: 10,
      retryMs: 10,
      coalesceMs: 0,
      plainHoldMs: 0,
      broadPauseMs: 60_000,
      restSignalMs: 50,
      signalDir: dir,
    });
    const inj = new Recorder();
    router.register('wren', inj);
    const ac = new AbortController();
    const done = router.run(ac.signal);
    await until(() => fake.subs.length === 1);
    fake.push('posts', [post()]);
    await until(() => inj.wakes.length === 1);
    // The only subscription now rests for 60 s and isn't polled. Age the file
    // past WATCHED_MS: the rest refreshes it.
    const polls = fake.polls.length;
    touch('watching-wren', Date.now() - 10 * 60_000);
    await until(() => Date.now() - watchSignal('wren', dir).watching! < 5_000);
    expect(fake.polls.length).toBe(polls);
    ac.abort();
    await done;
  });

  test('a poll where every subscription errored is not "watched"', async () => {
    const fake = new FakeTilori();
    const logs: string[] = [];
    const router = new Router({
      agents: [{ handle: 'wren', client: fake.client(), subscriptions: desiredSubscriptions({}) }],
      logger: (m) => logs.push(m),
      waitMs: 10,
      retryMs: 10,
      coalesceMs: 0,
      plainHoldMs: 0,
      signalDir: dir,
    });
    // Every subscription errors from the first poll on.
    fake.failingSubs = new (class extends Map<string, string> {
      override get() {
        return 'not_found';
      }
    })();
    const ac = new AbortController();
    const done = router.run(ac.signal);
    await until(() => logs.some((l) => l.includes('dropping subscription')));
    expect(watchSignal('wren', dir).watching).toBeNull();
    expect(watchSignal('wren', dir).attempting).not.toBeNull();
    ac.abort();
    await done;
  });

  test('without signalDir nothing is written', async () => {
    const { fake, inj, ac, done } = run(undefined);
    await until(() => fake.subs.length === 3);
    fake.push('inbox', [mention()]);
    await until(() => inj.wakes.length === 1);
    expect(watchSignal('wren', dir)).toMatchObject({ attempting: null, watching: null, woke: null });
    ac.abort();
    await done;
  });

  test('a reply on the inbox is tagged; the same post on the public stream keeps the tag', async () => {
    const { fake, inj, ac, done } = run();
    await until(() => fake.subs.length === 3);
    const id = crypto.randomUUID();
    fake.push('posts', [post(id)]);
    fake.push('inbox', [post(id)]);
    await until(() => inj.wakes.length >= 1);
    const ref = inj.wakes.flatMap((w) => w.events).find((e) => e.entity_id === id)!;
    expect(ref.to_you).toBe(true);
    expect(wakeText(inj.wakes[0])).toContain(`post.created post ${id} (reply to you)`);
    ac.abort();
    await done;
  });

  test('a posts-scope event can\'t claim to be for you', async () => {
    const { fake, inj, ac, done } = run();
    await until(() => fake.subs.length === 3);
    const id = crypto.randomUUID();
    fake.push('posts', [
      post(id) as any,
    ].map((e: any) => ({ ...e, to_you: true, data: { to_you: true, scope: 'inbox' }, summary: { title: '@wren (reply to you)' } })));
    await until(() => inj.wakes.length === 1);
    expect(inj.wakes[0].events[0].to_you).toBeUndefined();
    expect(wakeText(inj.wakes[0])).not.toContain('reply to you');
    ac.abort();
    await done;
  });
});

describe('the direct tag over the socket', () => {
  test('sanitizeWake keeps to_you only as true on a post.created post', () => {
    const ev = (e: object) => ({ id: 'a', kind: 'post.created', entity_type: 'post', entity_id: 'p', ...e });
    const w = sanitizeWake(
      { wake_id: 'w', resync_required: false, events: [ev({ to_you: true }), ev({ to_you: 'yes' }), ev({ kind: 'mention', to_you: true })] },
      'wren',
    )!;
    expect(w.events.map((e) => e.to_you)).toEqual([true, undefined, undefined]);
  });
});
