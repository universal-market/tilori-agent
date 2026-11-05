import './setup.ts';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_POLL_SUBSCRIPTIONS } from '../src/client.ts';
import { PUSH_POLL_GAP_MS } from '../src/router.ts';
import { pushChip, readPushSignal, statusLine, writePushSignal } from '../src/activity.ts';
import { desiredSubscriptions } from '../src/config.ts';
import { pushEnabled } from '../src/config.ts';
import {
  DOWN_AFTER_MS,
  MIN_LIVED_MS,
  PLANNED_JITTER_MS,
  PLANNED_MIN_MS,
  PLANNED_MS,
  PushStream,
  REFUSED_RETRY_MS,
  RETRY_MAX_MS,
  RETRY_MIN_MS,
  TICKET_HEADER,
  eventsUrl,
  type PushHooks,
  type PushStatus,
} from '../src/push.ts';
import { Router } from '../src/router.ts';
import type { DeliverResult, Injector, Wake } from '../src/types.ts';
import { sanitizeWake, wakeText } from '../src/wake.ts';
import { FakeTilori, mention, until } from './fake-tilori.ts';

const ENDPOINT = new URL('http://127.0.0.1:1/mcp/tilori/v1');
const EVENTS = 'http://127.0.0.1:2/v1/events';
const KEY = 'test-key-123456';
const TICKET = 'tst_' + 'A'.repeat(42) + 'g';

/** A controllable SSE body. */
function sseBody() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) });
  const enc = new TextEncoder();
  return {
    body,
    send: (text: string) => ctl.enqueue(enc.encode(text)),
    end: () => ctl.close(),
  };
}

type Call = { url: string; method: string; headers: Record<string, string> };

/** A fake fetch: mint answers per `mints`, opens per `opens`. */
function fakeFetch(opts: { mints?: Array<() => Response>; opens?: Array<() => Response> }) {
  const calls: Call[] = [];
  const mints = opts.mints ?? [];
  const opens = opts.opens ?? [];
  const okMint = () => Response.json({ ticket: TICKET, events_url: EVENTS, expires_at: Date.now() + 60_000 });
  const f = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ url, method: (init?.method ?? 'GET').toUpperCase(), headers });
    if (url.endsWith('/stream-ticket')) return (mints.shift() ?? okMint)();
    const next = opens.shift();
    if (!next) throw new Error('no more opens');
    return next();
  }) as typeof fetch;
  return { f, calls };
}

const stream = (b: ReturnType<typeof sseBody>) => () =>
  new Response(b.body, { status: 200, headers: { 'content-type': 'text/event-stream' } });

/** Hooks that record everything. */
function recorder() {
  const r = {
    frames: [] as string[],
    connected: [] as boolean[],
    stable: 0,
    down: [] as number[],
    alive: 0,
    statuses: [] as PushStatus[],
    logs: [] as string[],
  };
  const hooks: PushHooks = {
    frame: (id) => r.frames.push(id),
    connected: (back) => r.connected.push(back),
    stable: () => void r.stable++,
    down: (since) => r.down.push(since),
    alive: () => r.alive++,
    status: (s) => r.statuses.push(s),
    log: (m) => r.logs.push(m),
  };
  return { r, hooks };
}

/** A fake clock whose sleep advances it and records each wait. */
function fakeTime(start = 1_800_000_000_000) {
  let now = start;
  const sleeps: number[] = [];
  return {
    now: () => now,
    advance: (ms: number) => void (now += ms),
    sleeps,
    sleep: async (ms: number, signal: AbortSignal) => {
      sleeps.push(ms);
      now += ms;
      await Promise.resolve();
      if (signal.aborted) return;
    },
  };
}

describe('push stream', () => {
  test('mints with the key at Tilori, opens the gateway with the ticket only, and reads frames', async () => {
    const b = sseBody();
    const { f, calls } = fakeFetch({ opens: [stream(b)] });
    const { r, hooks } = recorder();
    const ac = new AbortController();
    const done = new PushStream({ endpoint: ENDPOINT, apiKey: KEY, fetch: f }, hooks).run(ac.signal);
    await until(() => r.connected.length === 1);
    b.send(': ping\n\n');
    b.send('id: s1:5\nevent: events\ndata: {"subscriptionId":"sub-1","deliveryId":"d1","events":[]}\n\n');
    // A frame split across chunks, CRLF line ends.
    b.send('event: events\r\ndata: {"subscriptionId":');
    b.send('"sub-2"}\r\n\r\n');
    // Junk is ignored: another event name, bad JSON, a bad id.
    b.send('event: message\ndata: {"subscriptionId":"x"}\n\n');
    b.send('event: events\ndata: {not json\n\n');
    b.send('event: events\ndata: {"subscriptionId":"bad id with spaces"}\n\n');
    await until(() => r.frames.length === 2);
    ac.abort();
    await done;
    expect(r.frames).toEqual(['sub-1', 'sub-2']);
    expect(r.connected).toEqual([false]);
    expect(r.alive).toBeGreaterThanOrEqual(2);
    const [mint, open] = calls;
    expect(mint.url).toBe('http://127.0.0.1:1/mcp/tilori/v1/stream-ticket');
    expect(mint.method).toBe('POST');
    expect(mint.headers.authorization).toBe(`Bearer ${KEY}`);
    // The gateway gets the ticket in its header and nothing else: no key, no query.
    expect(open.url).toBe(EVENTS);
    expect(open.headers[TICKET_HEADER]).toBe(TICKET);
    expect(open.headers.authorization).toBeUndefined();
    expect(JSON.stringify(calls.slice(1))).not.toContain(KEY);
    expect(r.statuses.at(-1)?.state).toBe('live');
  });

  test('only an https events URL (or loopback http for a loopback endpoint) gets the ticket', () => {
    const https = new URL('https://tilori.example/mcp/tilori/v1');
    expect(eventsUrl('https://gw.example/v1/events', https)?.href).toBe('https://gw.example/v1/events');
    expect(eventsUrl('http://gw.example/v1/events', https)).toBeNull();
    expect(eventsUrl('http://127.0.0.1:2/v1/events', https)).toBeNull();
    expect(eventsUrl('http://127.0.0.1:2/v1/events', ENDPOINT)?.href).toBe(EVENTS);
    expect(eventsUrl('http://gw.example/v1/events', ENDPOINT)).toBeNull();
    expect(eventsUrl('https://u:p@gw.example/v1/events', https)).toBeNull();
    expect(eventsUrl('https://gw.example/v1/events#x', https)).toBeNull();
    expect(eventsUrl('ftp://gw.example/', https)).toBeNull();
    expect(eventsUrl(42, https)).toBeNull();
  });

  test('a bad mint answer never opens the gateway', async () => {
    for (const bad of [
      { ticket: 'nope', events_url: EVENTS },
      { ticket: TICKET, events_url: 'http://elsewhere.example/v1/events' },
      { ticket: TICKET },
    ]) {
      const { f, calls } = fakeFetch({ mints: [() => Response.json(bad)] });
      const { r, hooks } = recorder();
      const t = fakeTime();
      const ac = new AbortController();
      const run = new PushStream({ endpoint: ENDPOINT, apiKey: KEY, fetch: f, now: t.now, sleep: async (ms, s) => {
        ac.abort();
        await t.sleep(ms, s);
      } }, hooks).run(ac.signal);
      await run;
      expect(calls.map((c) => c.url)).toEqual(['http://127.0.0.1:1/mcp/tilori/v1/stream-ticket']);
      expect(r.statuses.at(-1)?.state).toBe('reconnecting');
    }
  });

  test('failures back off with jitter from 5 s to 5 min, and say "down" once after a minute', async () => {
    const { f } = fakeFetch({ opens: [] }); // every open throws (network)
    const { r, hooks } = recorder();
    const t = fakeTime();
    const ac = new AbortController();
    let attempts = 0;
    await new PushStream(
      {
        endpoint: ENDPOINT,
        apiKey: KEY,
        fetch: f,
        now: t.now,
        random: () => 0.5,
        sleep: async (ms, s) => {
          if (++attempts > 14) ac.abort();
          await t.sleep(ms, s);
        },
      },
      hooks,
    ).run(ac.signal);
    // random 0.5 is the midpoint, so each delay is the base. The first
    // minute's waits are split where "down" is due.
    const total = t.sleeps.reduce((a, b) => a + b, 0);
    expect(t.sleeps[0]).toBe(RETRY_MIN_MS);
    expect(t.sleeps[1]).toBe(2 * RETRY_MIN_MS);
    expect(Math.max(...t.sleeps)).toBe(RETRY_MAX_MS);
    expect(total).toBeGreaterThan(DOWN_AFTER_MS);
    expect(r.down).toHaveLength(1);
    expect(r.statuses.some((s) => s.state === 'reconnecting')).toBe(true);
    const last = r.statuses.at(-1)!;
    expect(last.state).toBe('down');
    expect(last.next).toBeGreaterThan(last.since);
  });

  test('jitter stays within 80-120% of the base', async () => {
    for (const rnd of [0, 0.999]) {
      const { f } = fakeFetch({});
      const { hooks } = recorder();
      const t = fakeTime();
      const ac = new AbortController();
      await new PushStream(
        { endpoint: ENDPOINT, apiKey: KEY, fetch: f, now: t.now, random: () => rnd, sleep: async (ms, s) => {
          ac.abort();
          await t.sleep(ms, s);
        } },
        hooks,
      ).run(ac.signal);
      expect(t.sleeps[0]).toBeGreaterThanOrEqual(0.8 * RETRY_MIN_MS);
      expect(t.sleeps[0]).toBeLessThanOrEqual(1.2 * RETRY_MIN_MS);
    }
  });

  test('a planned close after the stream lived its lifetime reconnects at once, with no state change', async () => {
    const t = fakeTime();
    const b1 = sseBody();
    const b2 = sseBody();
    const { f } = fakeFetch({ opens: [stream(b1), stream(b2)] });
    const { r, hooks } = recorder();
    const ac = new AbortController();
    const done = new PushStream({ endpoint: ENDPOINT, apiKey: KEY, fetch: f, now: t.now, sleep: t.sleep }, hooks).run(ac.signal);
    await until(() => r.connected.length === 1);
    t.advance(PLANNED_MS + 1_000);
    b1.end();
    await until(() => r.connected.length === 2);
    ac.abort();
    await done;
    expect(r.connected).toEqual([false, false]);
    expect(r.down).toHaveLength(0);
    expect(r.statuses.map((s) => s.state)).not.toContain('reconnecting');
    expect(t.sleeps).toHaveLength(1);
    expect(t.sleeps[0]).toBeGreaterThanOrEqual(PLANNED_MIN_MS);
    expect(t.sleeps[0]).toBeLessThanOrEqual(PLANNED_MIN_MS + PLANNED_JITTER_MS);
  });

  test('a drain retry hint reconnects soon; an early close is a failure', async () => {
    const t = fakeTime();
    const b1 = sseBody();
    const b2 = sseBody();
    const b3 = sseBody();
    const { f } = fakeFetch({ opens: [stream(b1), stream(b2), stream(b3)] });
    const { r, hooks } = recorder();
    const ac = new AbortController();
    const done = new PushStream({ endpoint: ENDPOINT, apiKey: KEY, fetch: f, now: t.now, sleep: t.sleep, random: () => 0.5 }, hooks).run(ac.signal);
    await until(() => r.connected.length === 1);
    t.advance(MIN_LIVED_MS);
    b1.send('retry: 3000\n\n');
    b1.end();
    await until(() => r.connected.length === 2);
    expect(t.sleeps).toEqual([3000 + PLANNED_JITTER_MS / 2]);
    t.advance(MIN_LIVED_MS);
    b2.end(); // early, no hint
    await until(() => r.connected.length === 3);
    ac.abort();
    await done;
    expect(t.sleeps).toEqual([3000 + PLANNED_JITTER_MS / 2, RETRY_MIN_MS]);
    expect(r.statuses.map((s) => s.state)).toContain('reconnecting');
  });

  test('retry: 0 waits at least 1 s plus jitter', async () => {
    for (const [rand, want] of [[0, PLANNED_MIN_MS], [1, PLANNED_MIN_MS + PLANNED_JITTER_MS]] as const) {
      const t = fakeTime();
      const b1 = sseBody();
      const b2 = sseBody();
      const { f } = fakeFetch({ opens: [stream(b1), stream(b2)] });
      const { r, hooks } = recorder();
      const ac = new AbortController();
      const done = new PushStream({ endpoint: ENDPOINT, apiKey: KEY, fetch: f, now: t.now, sleep: t.sleep, random: () => rand }, hooks).run(ac.signal);
      await until(() => r.connected.length === 1);
      t.advance(MIN_LIVED_MS);
      b1.send('retry: 0\n\n');
      b1.end();
      await until(() => r.connected.length === 2);
      ac.abort();
      await done;
      expect(t.sleeps).toEqual([want]);
    }
  });

  test('a gateway that sends retry: 0 and closes at once is backed off, not looped', async () => {
    const t = fakeTime();
    const bodies = Array.from({ length: 6 }, () => sseBody());
    const { f, calls } = fakeFetch({ opens: bodies.map((b) => stream(b)) });
    const { r, hooks } = recorder();
    const ac = new AbortController();
    const done = new PushStream({ endpoint: ENDPOINT, apiKey: KEY, fetch: f, now: t.now, sleep: t.sleep, random: () => 0.5 }, hooks).run(ac.signal);
    for (let i = 0; i < 5; i++) {
      await until(() => r.connected.length === i + 1);
      bodies[i].send('retry: 0\n\n');
      bodies[i].end();
    }
    await until(() => r.connected.length === 6);
    ac.abort();
    await done;
    // The outage spans the brief opens: 35 s are lost after three waits, so
    // the 40 s wait is slept as 25 s (then "down", 60 s after the first
    // loss) plus 15 s.
    expect(t.sleeps).toEqual([5_000, 10_000, 20_000, 25_000, 15_000, 80_000]);
    expect(r.down).toHaveLength(1);
    // "down" is said once, and no stream ever holds, so nothing says "back".
    expect(r.stable).toBe(0);
    expect(r.connected.slice(-1)).toEqual([true]);
    expect(calls.filter((c) => c.url.endsWith('/stream-ticket'))).toHaveLength(6);
  });

  test('back after "down": the reconnect says so', async () => {
    const t = fakeTime();
    const b = sseBody();
    const fails = Array.from({ length: 6 }, () => () => new Response('no', { status: 503 }));
    const { f } = fakeFetch({ opens: [...fails, stream(b)] });
    const { r, hooks } = recorder();
    const ac = new AbortController();
    const done = new PushStream({ endpoint: ENDPOINT, apiKey: KEY, fetch: f, now: t.now, sleep: t.sleep, random: () => 0.5 }, hooks).run(ac.signal);
    await until(() => r.connected.length === 1);
    ac.abort();
    await done;
    expect(r.down).toHaveLength(1);
    expect(r.connected).toEqual([true]);
    expect(r.statuses.at(-1)?.state).toBe('live');
  });

  test('a refused key or ticket is "refused", retried every 5 min, and never says "down"', async () => {
    for (const refusal of [
      { mints: [() => new Response('no', { status: 401 })] },
      { mints: [() => new Response('no', { status: 403 })] },
      { opens: [() => Response.json({ code: 'TICKET_REFUSED' }, { status: 403 })] },
    ]) {
      const { f, calls } = fakeFetch(refusal);
      const { r, hooks } = recorder();
      const t = fakeTime();
      const ac = new AbortController();
      let n = 0;
      await new PushStream(
        { endpoint: ENDPOINT, apiKey: KEY, fetch: f, now: t.now, sleep: async (ms, s) => {
          if (++n >= 1) ac.abort();
          await t.sleep(ms, s);
        } },
        hooks,
      ).run(ac.signal);
      expect(t.sleeps).toEqual([REFUSED_RETRY_MS]);
      expect(r.statuses.at(-1)?.state).toBe('refused');
      expect(r.down).toHaveLength(0);
      if (refusal.mints) expect(calls).toHaveLength(1);
    }
  });

  test('an expired ticket or 503 is a plain retry, honouring Retry-After', async () => {
    const { f } = fakeFetch({
      opens: [
        () => Response.json({ code: 'TICKET_EXPIRED' }, { status: 403 }),
        () => new Response('full', { status: 503, headers: { 'retry-after': '30' } }),
      ],
    });
    const { r, hooks } = recorder();
    const t = fakeTime();
    const ac = new AbortController();
    let n = 0;
    await new PushStream(
      { endpoint: ENDPOINT, apiKey: KEY, fetch: f, now: t.now, random: () => 0.5, sleep: async (ms, s) => {
        if (++n >= 2) ac.abort();
        await t.sleep(ms, s);
      } },
      hooks,
    ).run(ac.signal);
    expect(t.sleeps).toEqual([RETRY_MIN_MS, 30_000]);
    expect(r.statuses.map((s) => s.state)).not.toContain('refused');
  });

  test('a huge event ends the stream', async () => {
    const t = fakeTime();
    const b = sseBody();
    const { f } = fakeFetch({ opens: [stream(b)] });
    const { r, hooks } = recorder();
    const ac = new AbortController();
    const done = new PushStream({ endpoint: ENDPOINT, apiKey: KEY, fetch: f, now: t.now, sleep: async (ms, s) => {
      ac.abort();
      await t.sleep(ms, s);
    } }, hooks).run(ac.signal);
    await until(() => r.connected.length === 1);
    b.send('event: events\ndata: ' + 'x'.repeat(300 * 1024));
    await done;
    expect(r.logs.some((m) => m.includes('stream broke'))).toBe(true);
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

describe('router in push mode', () => {
  function setupPush(extra = 0, directPauseMs = 0) {
    const fake = new FakeTilori();
    const bodies: Array<ReturnType<typeof sseBody>> = [];
    const opens: Array<() => Response> = [];
    const { f, calls } = fakeFetch({ opens });
    const openNext = () => {
      const b = sseBody();
      bodies.push(b);
      opens.push(stream(b));
      return b;
    };
    const router = new Router({
      agents: [
        {
          handle: 'wren',
          client: fake.client(),
          subscriptions: desiredSubscriptions({
            direct_messages: false,
            subscriptions: Array.from({ length: extra }, (_, i) => ({
              scope: { type: 'post' as const, post_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` },
            })),
          }),
          push: { endpoint: ENDPOINT, apiKey: KEY, fetch: f, random: () => 0.5 },
        },
      ],
      waitMs: 10,
      retryMs: 10,
      coalesceMs: 0,
      plainHoldMs: 0,
      directPauseMs,
    });
    const inj = new Recorder();
    router.register('wren', inj);
    const ac = new AbortController();
    return { fake, router, inj, ac, calls, bodies, openNext, start: () => router.run(ac.signal) };
  }

  for (const extra of [0, 1]) {
    test(`events that arrive during a pause wake when it ends, with no further frame (${extra ? 'another subscription idle' : 'only one subscription'})`, async () => {
      const s = setupPush(extra, 1_500);
      const b = s.openNext();
      const done = s.start();
      await until(() => s.fake.subs.length === 1 + extra && s.fake.waits.length >= 1);
      const inbox = s.fake.subs.find((x) => x.scope.type === 'inbox')!.id;
      const frame = (id: string) => b.send(`event: events\ndata: ${JSON.stringify({ subscriptionId: inbox, deliveryId: id, events: [] })}\n\n`);
      s.fake.push('inbox', [mention()]);
      frame('d1');
      await until(() => s.inj.wakes.length === 1, 3000);
      const t0 = Date.now();
      // Inbox now rests; this mention's frame is swept without it.
      s.fake.push('inbox', [mention()]);
      frame('d2');
      await new Promise((r) => setTimeout(r, 600));
      expect(s.inj.wakes).toHaveLength(1);
      await until(() => s.inj.wakes.length === 2, 4000);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(1_400);
      s.ac.abort();
      await done;
    }, 10_000);
  }

  test('with more subscriptions than one poll takes, a sweep reads them all once, and polls stay bounded', async () => {
    const s = setupPush(10); // inbox + 10 = 11 subscriptions, over MAX_POLL_SUBSCRIPTIONS
    const b = s.openNext();
    const done = s.start();
    await until(() => s.fake.subs.length === 11 && s.fake.polls.length >= 2);
    await new Promise((r) => setTimeout(r, 1_500));
    const ids = s.fake.subs.map((x) => x.id);
    const polled = new Set(s.fake.polls.flatMap((p) => p.ids));
    // Every subscription, the last one included, is read by the first sweep.
    expect(ids.every((id) => polled.has(id))).toBe(true);
    // One sweep, two calls (8 + 3), then nothing until a frame.
    expect(s.fake.polls.length).toBe(2);
    expect(s.fake.polls.every((p) => p.ids.length <= MAX_POLL_SUBSCRIPTIONS)).toBe(true);
    // A burst of 20 frames is coalesced: sweeps (2 calls each) at least
    // PUSH_POLL_GAP_MS apart, so at most two in the next 1.5 s, not 20.
    for (let i = 0; i < 20; i++)
      b.send(`event: events\ndata: ${JSON.stringify({ subscriptionId: ids[10], deliveryId: 'd' + i, events: [] })}\n\n`);
    await new Promise((r) => setTimeout(r, 1_500));
    s.ac.abort();
    await done;
    expect(s.fake.polls.length).toBeGreaterThanOrEqual(4);
    expect(s.fake.polls.length).toBeLessThanOrEqual(6);
    // Sweeps start PUSH_POLL_GAP_MS apart (each sweep's second call follows its first at once).
    const starts = s.fake.pollTimes.filter((_, i) => i % 2 === 0);
    for (let i = 1; i < starts.length; i++)
      expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(PUSH_POLL_GAP_MS - 20);
  });

  test('polls only with wait 0: a sweep on connect, then once per frame', async () => {
    const s = setupPush();
    const b = s.openNext();
    const done = s.start();
    await until(() => s.fake.subs.length === 1 && s.fake.waits.length >= 1);
    const sub = s.fake.subs[0].id;
    await new Promise((r) => setTimeout(r, 100));
    const quiet = s.fake.waits.length;
    // Nothing more polls without a frame.
    expect(quiet).toBeLessThanOrEqual(2);
    s.fake.push('inbox', [mention()]);
    b.send(`event: events\ndata: ${JSON.stringify({ subscriptionId: sub, deliveryId: 'd', events: [] })}\n\n`);
    await until(() => s.inj.wakes.some((w) => w.events.length === 1));
    await until(() => s.fake.acks.length === 1);
    s.ac.abort();
    await done;
    expect(s.fake.waits.every((w) => w === 0)).toBe(true);
    expect(s.fake.calls).not.toContain('subscribe_to_events_with_wait');
  });

  test('while push is down nothing polls; then a "down" line, and on reconnect one sweep and a "back" line', async () => {
    const fake = new FakeTilori();
    const t = fakeTime(Date.now());
    const b = sseBody();
    let gate!: () => void;
    const opened = new Promise<void>((r) => (gate = r));
    // Six refused opens push it past a minute ("down"); the seventh opens
    // once the test lets it.
    const fails = Array.from({ length: 6 }, () => () => new Response('no', { status: 503 }));
    const { f } = fakeFetch({ opens: [...fails, stream(b)] });
    const router = new Router({
      agents: [
        {
          handle: 'wren',
          client: fake.client(),
          subscriptions: desiredSubscriptions({ direct_messages: false }),
          push: {
            endpoint: ENDPOINT,
            apiKey: KEY,
            fetch: f,
            random: () => 0.5,
            now: t.now,
            sleep: async (ms, sig) => {
              await t.sleep(ms, sig);
              // Hold the last wait until the test has checked "down".
              if (t.sleeps.length >= 7) await opened;
            },
          },
        },
      ],
      waitMs: 10,
      retryMs: 10,
      coalesceMs: 0,
      plainHoldMs: 0,
    });
    const inj = new Recorder();
    router.register('wren', inj);
    const ac = new AbortController();
    const done = router.run(ac.signal);
    await until(() => inj.wakes.some((w) => w.push?.state === 'down'));
    const sweeps = fake.waits.length; // the generation's own sweep only
    expect(sweeps).toBeLessThanOrEqual(1);
    fake.push('inbox', [mention(), mention()]);
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.waits).toHaveLength(sweeps); // down: nothing polls
    gate();
    await until(() => inj.wakes.some((w) => w.events.length === 2));
    // Open and swept, but "back" waits until the stream has held 30 s.
    await new Promise((r) => setTimeout(r, 100));
    expect(inj.wakes.some((w) => w.push?.state === 'back')).toBe(false);
    t.advance(MIN_LIVED_MS);
    b.send(': ping\n\n');
    await until(() => inj.wakes.some((w) => w.push?.state === 'back'));
    ac.abort();
    await done;
    const back = inj.wakes.find((w) => w.push?.state === 'back')!;
    expect(back.push).toEqual({ state: 'back', caught: 2 });
    expect(back.events).toEqual([]);
    expect(inj.wakes.filter((w) => w.push?.state === 'down')).toHaveLength(1);
    expect(fake.waits.every((w) => w === 0)).toBe(true);
    // Lines are never acknowledged: only the mention batch was.
    expect(fake.acks).toHaveLength(1);
  });

  test('a "down" line and a "back" line reach the injector, outside the caps, never acknowledged', () => {
    const down: Wake = { wake_id: 'w1', agent: 'wren', events: [], resync_required: false, push: { state: 'down', since: Date.UTC(2026, 10, 4, 14, 3) } };
    expect(wakeText(down)).toBe(
      "Tilori push for agent wren is down since 14:03 UTC; wakes may be late. Call whats_new or poll_events if you're waiting on something.",
    );
    const back: Wake = { ...down, push: { state: 'back', caught: 3 } };
    expect(wakeText(back)).toBe('Tilori push for agent wren is back; caught up 3 events.');
    expect(wakeText({ ...down, push: { state: 'back', caught: 1 } })).toBe('Tilori push for agent wren is back; caught up 1 event.');
  });
});

describe('push lines over IPC', () => {
  test('sanitizeWake keeps a valid push line and drops a bad one', () => {
    const since = Date.now() - 60_000;
    expect(sanitizeWake({ wake_id: 'w', events: [], push: { state: 'down', since } }, 'wren')?.push).toEqual({ state: 'down', since });
    expect(sanitizeWake({ wake_id: 'w', events: [], push: { state: 'back', caught: 0 } }, 'wren')?.push).toEqual({ state: 'back', caught: 0 });
    for (const push of [
      { state: 'down', since: 'soon' },
      { state: 'down', since: 1 },
      { state: 'back', caught: -1 },
      { state: 'back', caught: 1.5 },
      { state: 'up' },
      'down',
    ])
      expect(sanitizeWake({ wake_id: 'w', events: [], push }, 'wren')).toBeNull();
    // A push line carries no events.
    expect(
      sanitizeWake({ wake_id: 'w', events: [{ id: 'e', kind: 'mention', entity_type: 'post', entity_id: 'p' }], push: { state: 'back', caught: 1 } }, 'wren'),
    ).toBeNull();
  });
});

describe('push settings and status', () => {
  test('push is "on" or "off" (default off); anything else is refused', () => {
    expect(pushEnabled({})).toBe(false);
    expect(pushEnabled({ push: 'off' })).toBe(false);
    expect(pushEnabled({ push: 'on' })).toBe(true);
    expect(() => pushEnabled({ push: 'yes' as any })).toThrow('push must be');
  });

  test('push- round-trips, and a stale or foreign file reads as off', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tilori-push-'));
    const now = Date.now();
    writePushSignal(dir, 'wren', { state: 'down', since: now - 120_000, next: now + 90_000 });
    const s = readPushSignal('wren', dir)!;
    expect(s.state).toBe('down');
    expect(pushChip(s, now)).toMatch(/^push down since \d\d:\d\d UTC · next try 1 min$/);
    expect(pushChip({ ...s, at: now - 8 * 60_000 }, now)).toBeNull();
    expect(readPushSignal('Bad Handle', dir)).toBeNull();
    expect(readPushSignal('lark', dir)).toBeNull();
    expect(pushChip({ state: 'live', since: now, at: now }, now)).toBe('push live');
    expect(pushChip({ state: 'refused', since: now, at: now }, now)).toBe('push refused · access');
    expect(pushChip({ state: 'reconnecting', since: now, next: now + 125_000, at: now }, now)).toBe('push reconnecting · next try 2 min');
  });

  test('status says push is down instead of "not watched"', () => {
    const now = Date.now();
    const signal = { blockedSince: null, reports: false, tracked: false } as any;
    const watch = { attempting: null, watching: now - 10 * 60_000, woke: null, activity: null, reports: false, router: true };
    const down = statusLine('wren', signal, watch, { now, push: { state: 'down', since: now - 9 * 60_000, at: now - 1_000 } });
    expect(down).toContain('wren: push down since');
    expect(down).toContain('Nothing polls meanwhile');
    const live = statusLine('wren', signal, { ...watch, watching: now - 5_000 }, { now, push: { state: 'live', since: now - 60_000, at: now - 5_000 } });
    expect(live).toBe('wren: watched; no wakes yet; push live');
    // Without push, the line is as before.
    expect(statusLine('wren', signal, { ...watch, watching: now - 5_000 }, { now })).toBe('wren: watched; no wakes yet; polled by the router');
  });
});
