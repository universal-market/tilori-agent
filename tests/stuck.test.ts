import './setup.ts';
import { existsSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'bun:test';
import { desiredSubscriptions } from '../src/config.ts';
import { Router } from '../src/router.ts';
import {
  MAX_ALERTS_PER_DAY,
  StuckWatch,
  appendAlert,
  runExec,
  stuckAlertOrOff,
  stuckAlertSettings,
  stuckPost,
  type StuckAlert,
  type StuckPost,
} from '../src/stuck.ts';
import { FakeTilori, until } from './fake-tilori.ts';

const PARENT = '11111111-1111-4111-8111-111111111111';
const MIN = 60_000;
let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tilori-stuck-'));
});

/** Sets a signal file's mtime (ms). */
function touch(name: string, ms: number) {
  const p = join(dir, name);
  writeFileSync(p, '');
  utimesSync(p, ms / 1000, ms / 1000);
}

const alert = (over: Partial<StuckAlert> = {}): StuckAlert => ({
  minutes: 30,
  parentPostId: PARENT,
  mention: '@don-zheng.keel',
  exec: null,
  ...over,
});

function watch(over: Partial<StuckAlert> = {}, opts: { now?: () => number; failPost?: boolean; exec?: any } = {}) {
  const posts: StuckPost[] = [];
  const logs: string[] = [];
  const w = new StuckWatch({
    handle: 'wren',
    alert: alert(over),
    dir,
    post: async (p) => {
      posts.push(p);
      if (opts.failPost) throw new Error('Rate limited');
    },
    log: (m) => logs.push(m),
    now: opts.now,
    exec: opts.exec,
  });
  return { w, posts, logs };
}

describe('stuck_alert settings', () => {
  test('off when unset; defaults to 30 minutes', () => {
    expect(stuckAlertSettings(undefined)).toBeNull();
    expect(stuckAlertSettings({})).toEqual({ minutes: 30, parentPostId: null, mention: null, exec: null });
  });

  test('refuses bad values', () => {
    const bad: unknown[] = [
      [],
      'on',
      { minutes: 4 },
      { minutes: 1441 },
      { minutes: 30.5 },
      { parent_post_id: '1111' },
      { mention: 'keel' },
      { mention: '@don-zheng.keel @someone' },
      { mention: '@a.b.c' },
      { exec: 'notify.sh' },
      { exec: ['notify.sh'] },
      { exec: [] },
      { exec: ['/bin/notify', 3] },
      { exec: ['/bin/notify', 'a\0b'] },
      { url: 'https://elsewhere' },
    ];
    for (const v of bad) expect(() => stuckAlertSettings(v)).toThrow();
  });

  test('accepts the full form', () => {
    expect(
      stuckAlertSettings({ minutes: 45, parent_post_id: PARENT, mention: '@don-zheng.keel', exec: ['/usr/local/bin/notify', '--quiet'] }),
    ).toEqual({ minutes: 45, parentPostId: PARENT, mention: '@don-zheng.keel', exec: ['/usr/local/bin/notify', '--quiet'] });
    expect(stuckAlertSettings({ mention: '@don' })?.mention).toBe('@don');
  });

  test('a bad stuck_alert is logged and turns the alert off, never throws', () => {
    const logs: string[] = [];
    expect(stuckAlertOrOff({ minutes: 1 }, (m) => logs.push(m))).toBeNull();
    expect(logs).toEqual(['stuck_alert is off: stuck_alert.minutes must be an integer from 5 to 1440.']);
  });
});

describe('stuck alert text', () => {
  test('fixed apart from handle, times and the configured mention', () => {
    const since = Date.UTC(2026, 10, 4, 2, 5);
    const p = stuckPost('wren', since, since + 31 * MIN, alert());
    expect(p).toEqual({
      parent_post_id: PARENT,
      title: 'Stuck: wren blocked on a prompt since 02:05 UTC',
      body:
        '@don-zheng.keel wren has been blocked on a prompt since 02:05 UTC (31 min) and has made no tool call since. ' +
        'Nothing else is known: the plugin never reads the prompt. Someone needs to answer it in that session. ' +
        '(tilori-agent stuck_alert)',
      idempotency_key: `stuck-wren-${since}`,
    });
    expect(stuckPost('wren', since, since + 31 * MIN, alert({ mention: null })).body.startsWith('wren has been')).toBe(true);
  });
});

describe('StuckWatch', () => {
  test('alerts once per blocked episode, after the configured minutes', async () => {
    const since = Date.now() - 10 * MIN;
    touch('blocked-wren', since);
    let now = since + 29 * MIN;
    const { w, posts, logs } = watch({}, { now: () => now });
    expect(await w.check()).toBe(false);
    now = since + 30 * MIN;
    expect(await w.check()).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0].idempotency_key).toBe(`stuck-wren-${since}`);
    expect(await w.check()).toBe(false);
    now += 60 * MIN;
    expect(await w.check()).toBe(false);
    expect(posts).toHaveLength(1);
    // The fallback line is always written, 0600.
    const log = readFileSync(join(dir, 'alerts.log'), 'utf8');
    expect(log).toMatch(/^\S+ wren blocked on a prompt since \S+ \(30 min\)\n$/);
    expect(statSync(join(dir, 'alerts.log')).mode & 0o777).toBe(0o600);
    expect(logs.some((l) => l.includes('stuck alert posted on Tilori'))).toBe(true);
  });

  test('no alert once a tool call follows the prompt; a new prompt is a new episode', async () => {
    const since = Date.now() - 60 * MIN;
    touch('blocked-wren', since);
    touch('activity-wren', since + MIN);
    const { w, posts } = watch();
    expect(await w.check()).toBe(false);
    const again = since + 2 * MIN;
    touch('blocked-wren', again);
    expect(await w.check()).toBe(true);
    expect(posts.map((p) => p.idempotency_key)).toEqual([`stuck-wren-${again}`]);
  });

  test('no signal files (a host without the hooks): never alerts', async () => {
    const { w, posts } = watch();
    expect(await w.check()).toBe(false);
    expect(posts).toHaveLength(0);
    expect(existsSync(join(dir, 'alerts.log'))).toBe(false);
  });

  test(`at most ${MAX_ALERTS_PER_DAY} alerts per agent per rolling day`, async () => {
    let now = Date.now();
    const { w, posts, logs } = watch({}, { now: () => now });
    for (let i = 0; i < MAX_ALERTS_PER_DAY + 2; i++) {
      touch('blocked-wren', now - 31 * MIN - i * 1000);
      await w.check();
      now += MIN;
    }
    expect(posts).toHaveLength(MAX_ALERTS_PER_DAY);
    expect(logs.filter((l) => l.includes('not alerting'))).toHaveLength(2);
    now += 24 * 60 * MIN;
    touch('blocked-wren', now - 31 * MIN);
    expect(await w.check()).toBe(true);
  });

  test('a failed post is logged once and not retried; the fallback is still written', async () => {
    touch('blocked-wren', Date.now() - 31 * MIN);
    const { w, posts, logs } = watch({}, { failPost: true });
    expect(await w.check()).toBe(true);
    expect(await w.check()).toBe(false);
    expect(posts).toHaveLength(1);
    expect(logs.filter((l) => l.includes('not posted on Tilori (not retried): Rate limited'))).toHaveLength(1);
    expect(readFileSync(join(dir, 'alerts.log'), 'utf8')).toContain('wren blocked on a prompt');
  });

  test('no parent_post_id: fallback only, nothing posted', async () => {
    touch('blocked-wren', Date.now() - 31 * MIN);
    const { w, posts } = watch({ parentPostId: null });
    expect(await w.check()).toBe(true);
    expect(posts).toHaveLength(0);
    expect(existsSync(join(dir, 'alerts.log'))).toBe(true);
  });

  test('alerts.log through a symlink is refused; the victim is untouched', async () => {
    const victim = join(dir, 'victim');
    writeFileSync(victim, 'victim');
    symlinkSync(victim, join(dir, 'alerts.log'));
    expect(() => appendAlert(dir, 'x')).toThrow();
    touch('blocked-wren', Date.now() - 31 * MIN);
    const { w, posts, logs } = watch();
    expect(await w.check()).toBe(true);
    expect(readFileSync(victim, 'utf8')).toBe('victim');
    expect(logs.some((l) => l.includes('could not write alerts.log'))).toBe(true);
    expect(posts).toHaveLength(1);
  });

  test('exec gets argv and only the three TILORI_STUCK_* variables', async () => {
    const calls: Array<{ argv: string[]; env: Record<string, string>; timeout: number }> = [];
    touch('blocked-wren', Date.now() - 31 * MIN);
    const { w } = watch({ exec: ['/usr/local/bin/notify', '--quiet'] }, {
      exec: async (argv: string[], env: Record<string, string>, timeout: number) => void calls.push({ argv, env, timeout }),
    });
    await w.check();
    expect(calls).toHaveLength(1);
    expect(calls[0].argv).toEqual(['/usr/local/bin/notify', '--quiet']);
    expect(Object.keys(calls[0].env).sort()).toEqual(['TILORI_STUCK_AGENT', 'TILORI_STUCK_MINUTES', 'TILORI_STUCK_SINCE']);
    expect(calls[0].env.TILORI_STUCK_AGENT).toBe('wren');
    expect(calls[0].env.TILORI_STUCK_MINUTES).toBe('31');
    expect(calls[0].timeout).toBe(10_000);
  });

  test('runExec: no shell, nothing inherited from the router, killed on timeout', async () => {
    process.env.TILORI_STUCK_TEST_SECRET = 'must-not-leak';
    const out = join(dir, 'env');
    try {
      await runExec(['/bin/sh', '-c', 'env > "$0"', out], { TILORI_STUCK_AGENT: 'wren', TILORI_STUCK_SINCE: 's', TILORI_STUCK_MINUTES: '31' }, 5000);
    } finally {
      delete process.env.TILORI_STUCK_TEST_SECRET;
    }
    const env = readFileSync(out, 'utf8');
    expect(env).toContain('TILORI_STUCK_AGENT=wren');
    expect(env).not.toContain('must-not-leak');
    expect(env).not.toContain('HOME=');
    expect(env).not.toContain('TILORI_AGENT=');
    // A literal argument is not interpreted by a shell.
    await runExec(['/bin/sh', '-c', 'printf "%s" "$1" > "$0"', out, '$(touch ' + join(dir, 'pwned') + ')'], {}, 5000);
    expect(existsSync(join(dir, 'pwned'))).toBe(false);
    const started = Date.now();
    await expect(runExec(['/bin/sleep', '5'], {}, 200)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test('a failing exec is logged and the post still goes out', async () => {
    touch('blocked-wren', Date.now() - 31 * MIN);
    const { w, posts, logs } = watch({ exec: ['/bin/false'] }, { exec: runExec });
    expect(await w.check()).toBe(true);
    expect(logs.some((l) => l.includes('stuck_alert.exec failed'))).toBe(true);
    expect(posts).toHaveLength(1);
  });
});

describe('Router stuck alert', () => {
  test('posts one reply as the agent on a timer, without any wake', async () => {
    const fake = new FakeTilori();
    const logs: string[] = [];
    const since = Date.now() - 31 * MIN;
    touch('blocked-wren', since);
    const router = new Router({
      agents: [{ handle: 'wren', client: fake.client(), subscriptions: desiredSubscriptions(), stuckAlert: alert() }],
      logger: (m) => logs.push(m),
      waitMs: 10,
      retryMs: 10,
      coalesceMs: 0,
      plainHoldMs: 0,
      stuckCheckMs: 20,
      stuckDir: dir,
    });
    const ac = new AbortController();
    const done = router.run(ac.signal);
    await until(() => fake.created.length === 1);
    await new Promise((r) => setTimeout(r, 100));
    ac.abort();
    await done;
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]).toEqual({
      parent_post_id: PARENT,
      title: expect.stringMatching(/^Stuck: wren blocked on a prompt since \d\d:\d\d UTC$/),
      body: expect.stringContaining('@don-zheng.keel wren has been blocked on a prompt'),
      idempotency_key: `stuck-wren-${since}`,
    });
    expect(logs.some((l) => l === '[wren] stuck alert after 30 min, on Tilori')).toBe(true);
  });

  test('no stuckAlert: no timer, nothing posted', async () => {
    const fake = new FakeTilori();
    touch('blocked-wren', Date.now() - 31 * MIN);
    const router = new Router({
      agents: [{ handle: 'wren', client: fake.client(), subscriptions: desiredSubscriptions() }],
      waitMs: 10,
      retryMs: 10,
      stuckCheckMs: 10,
      stuckDir: dir,
    });
    const ac = new AbortController();
    const done = router.run(ac.signal);
    await until(() => fake.subs.length === 2);
    await new Promise((r) => setTimeout(r, 80));
    ac.abort();
    await done;
    expect(fake.created).toHaveLength(0);
  });
});
