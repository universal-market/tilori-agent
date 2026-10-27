import { describe, expect, test } from 'bun:test';
import { desiredSubscriptions } from '../src/config.ts';
import { ExecInjector } from '../src/injectors/exec.ts';
import { Router } from '../src/router.ts';
import type { DeliverResult, Injector, Wake } from '../src/types.ts';
import { FakeTilori, dm, mention, post, until } from './fake-tilori.ts';

class Recorder implements Injector {
  readonly kind = 'test';
  wakes: Wake[] = [];
  next: DeliverResult[] = [];
  async deliver(wake: Wake): Promise<DeliverResult> {
    const r = this.next.shift() ?? 'accepted';
    if (r === 'accepted') this.wakes.push(wake);
    return r;
  }
}

function setup(opts: { wakesPerHour?: number; directWakesPerHour?: number; posts?: boolean; now?: () => number } = {}) {
  const fake = new FakeTilori();
  const logs: string[] = [];
  const subscriptions = desiredSubscriptions(opts.posts ? { subscriptions: [{ scope: { type: 'posts' } }] } : {});
  const router = new Router({
    agents: [
      {
        handle: 'wren',
        client: fake.client(),
        subscriptions,
        wakesPerHour: opts.wakesPerHour,
        directWakesPerHour: opts.directWakesPerHour,
      },
    ],
    logger: (m) => logs.push(m),
    waitMs: 10,
    retryMs: 10,
    now: opts.now,
  });
  const ac = new AbortController();
  const done = router.run(ac.signal);
  return { fake, router, logs, ac, done };
}

describe('router', () => {
  test('creates inbox + direct_messages subscriptions and only calls read tools', async () => {
    const { fake, ac, done } = setup();
    await until(() => fake.subs.length === 2);
    expect(fake.subs.map((s) => s.scope.type).sort()).toEqual(['direct_messages', 'inbox']);
    ac.abort();
    await done;
    expect(new Set(fake.calls)).toEqual(
      new Set(['list_agent_subscriptions', 'subscribe_to_events', 'poll_events']),
    );
  });

  test('acks only after the injector accepts; holds while none is registered', async () => {
    const { fake, router, ac, done, logs } = setup();
    await until(() => fake.subs.length === 2);
    fake.push('inbox', [mention()]);
    await until(() => logs.some((l) => l.includes('no injector')));
    expect(fake.acks).toHaveLength(0);
    const inj = new Recorder();
    router.register('wren', inj);
    await until(() => fake.acks.length === 1);
    expect(inj.wakes).toHaveLength(1);
    expect(inj.wakes[0].events[0].kind).toBe('mention');
    ac.abort();
    await done;
  });

  test('busy injector: batch is retried, not acked, then acked once accepted', async () => {
    const { fake, router, ac, done } = setup();
    const inj = new Recorder();
    inj.next = ['busy', 'busy'];
    router.register('wren', inj);
    await until(() => fake.subs.length === 2);
    fake.push('direct_messages', [dm()]);
    await until(() => fake.acks.length === 1);
    expect(inj.wakes).toHaveLength(1);
    ac.abort();
    await done;
  });

  test('gone injector is dropped until a new one registers', async () => {
    const { fake, router, ac, done } = setup();
    const first = new Recorder();
    first.next = ['gone'];
    router.register('wren', first);
    await until(() => fake.subs.length === 2);
    fake.push('inbox', [mention()]);
    await new Promise((r) => setTimeout(r, 80));
    expect(fake.acks).toHaveLength(0);
    const second = new Recorder();
    router.register('wren', second);
    await until(() => fake.acks.length === 1);
    expect(second.wakes).toHaveLength(1);
    ac.abort();
    await done;
  });

  test('a failed ack re-acks without waking twice', async () => {
    const { fake, router, ac, done } = setup();
    const inj = new Recorder();
    router.register('wren', inj);
    await until(() => fake.subs.length === 2);
    fake.failAcks = 1;
    fake.push('inbox', [mention()]);
    await until(() => fake.acks.length === 1);
    expect(inj.wakes).toHaveLength(1);
    ac.abort();
    await done;
  });

  test('rate cap delays and coalesces broad traffic instead of dropping', async () => {
    let t = 1_000_000;
    const { fake, router, ac, done, logs } = setup({ wakesPerHour: 1, posts: true, now: () => t });
    const inj = new Recorder();
    router.register('wren', inj);
    await until(() => fake.subs.length === 3);
    fake.push('posts', [post()]);
    await until(() => inj.wakes.length === 1);
    expect(inj.wakes[0].held_back).toBeUndefined();
    fake.push('posts', [post(), post()]);
    await until(() => logs.some((l) => l.includes('wake cap reached')));
    expect(inj.wakes).toHaveLength(1);
    expect(fake.acks).toHaveLength(1);
    // Logs carry counts only.
    expect(logs.join('\n')).not.toContain('post ');
    t += 3600_001;
    router.register('wren', inj); // kicks the sleeping loop
    await until(() => inj.wakes.length === 2);
    expect(inj.wakes[1].events).toHaveLength(2);
    expect(inj.wakes[1].held_back).toBe(2);
    await until(() => fake.acks.length === 2);
    ac.abort();
    await done;
  });

  test('mentions and DMs wake past the cap on their own allowance; broad traffic stays held', async () => {
    let t = 1_000_000;
    const { fake, router, ac, done } = setup({ wakesPerHour: 1, posts: true, now: () => t });
    const inj = new Recorder();
    router.register('wren', inj);
    await until(() => fake.subs.length === 3);
    fake.push('posts', [post()]);
    await until(() => inj.wakes.length === 1);
    // The cap is used up: broad traffic is held, a mention still wakes.
    fake.push('posts', [post(), post()]);
    await until(() => router.stats('wren')!.delayed === 2);
    fake.push('inbox', [mention()]);
    await until(() => inj.wakes.length === 2);
    expect(inj.wakes[1].events.map((e) => e.kind)).toEqual(['mention']);
    expect(inj.wakes[1].still_held).toBe(2);
    fake.push('direct_messages', [dm()]);
    await until(() => inj.wakes.length === 3);
    expect(inj.wakes[2].events.map((e) => e.kind)).toEqual(['dm.message']);
    // Only the direct batches were acknowledged; the posts batch waits.
    await until(() => fake.acks.length === 3);
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.acks).toHaveLength(3);
    t += 3600_001;
    router.register('wren', inj);
    await until(() => inj.wakes.length === 4);
    expect(inj.wakes[3].events.map((e) => e.kind)).toEqual(['post.created', 'post.created']);
    expect(inj.wakes[3].held_back).toBe(2);
    await until(() => fake.acks.length === 4);
    ac.abort();
    await done;
  });

  test('direct wakes have their own cap too', async () => {
    let t = 1_000_000;
    const { fake, router, ac, done, logs } = setup({ wakesPerHour: 1, directWakesPerHour: 1, now: () => t });
    const inj = new Recorder();
    router.register('wren', inj);
    await until(() => fake.subs.length === 2);
    fake.push('inbox', [mention()]);
    await until(() => inj.wakes.length === 1);
    fake.push('inbox', [mention()]);
    await until(() => inj.wakes.length === 2);
    fake.push('direct_messages', [dm()]);
    await until(() => logs.some((l) => l.includes('wake cap reached')));
    expect(inj.wakes).toHaveLength(2);
    t += 3600_001;
    router.register('wren', inj);
    await until(() => inj.wakes.length === 3);
    expect(inj.wakes[2].held_back).toBe(1);
    ac.abort();
    await done;
  });

  test('direct_wakes_per_hour 0 turns the direct lane off', async () => {
    let t = 1_000_000;
    const { fake, router, ac, done, logs } = setup({ wakesPerHour: 1, directWakesPerHour: 0, now: () => t });
    const inj = new Recorder();
    router.register('wren', inj);
    await until(() => fake.subs.length === 2);
    fake.push('inbox', [mention()]);
    await until(() => inj.wakes.length === 1);
    fake.push('inbox', [mention()]);
    await until(() => logs.some((l) => l.includes('wake cap reached')));
    expect(inj.wakes).toHaveLength(1);
    t += 3600_001;
    router.register('wren', inj);
    await until(() => inj.wakes.length === 2);
    expect(inj.wakes[1].held_back).toBe(1);
    ac.abort();
    await done;
    const fake2 = new FakeTilori();
    expect(
      () =>
        new Router({
          agents: [{ handle: 'wren', client: fake2.client(), subscriptions: desiredSubscriptions(), directWakesPerHour: -1 }],
        }),
    ).toThrow();
  });

  test('skips a subscription the agent may not hold and keeps going', async () => {
    const fake = new FakeTilori();
    fake.refuse.add('direct_messages');
    const logs: string[] = [];
    const router = new Router({
      agents: [{ handle: 'wren', client: fake.client(), subscriptions: desiredSubscriptions() }],
      logger: (m) => logs.push(m),
      waitMs: 10,
      retryMs: 10,
    });
    const inj = new Recorder();
    router.register('wren', inj);
    const ac = new AbortController();
    const done = router.run(ac.signal);
    await until(() => fake.subs.length === 1);
    fake.push('inbox', [mention()]);
    await until(() => inj.wakes.length === 1);
    expect(logs.some((l) => l.includes('Skipping direct_messages'))).toBe(true);
    ac.abort();
    await done;
  });

  test('poll errors back off and redact credentials from logs', async () => {
    const { fake, router, ac, done, logs } = setup();
    router.register('wren', new Recorder());
    await until(() => fake.subs.length === 2);
    fake.failNextPolls = 1;
    await until(() => logs.some((l) => l.includes('Tilori error')));
    expect(logs.join('\n')).not.toContain('abcdefghijklmnop');
    ac.abort();
    await done;
  });

  test('long-polls every subscription at once: a DM is not stuck behind an inbox long-poll', async () => {
    const fake = new FakeTilori();
    const router = new Router({
      agents: [{ handle: 'wren', client: fake.client(), subscriptions: desiredSubscriptions() }],
      waitMs: 20_000,
      retryMs: 10,
    });
    const inj = new Recorder();
    router.register('wren', inj);
    const ac = new AbortController();
    const done = router.run(ac.signal);
    await until(() => fake.subs.length === 2);
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    fake.push('direct_messages', [dm()]);
    await until(() => inj.wakes.length === 1, 1000);
    expect(Date.now() - t0).toBeLessThan(500);
    fake.push('inbox', [mention()]);
    await until(() => inj.wakes.length === 2, 1000);
    ac.abort();
    await done;
  });

  test('slow deliver: invoked once, late accepted is acked and counted (no timeout re-invokes)', async () => {
    const fake = new FakeTilori();
    // deliverTimeoutMs was the old option that turned slow delivers into busy
    // and re-invoked them; it must have no effect now.
    const router = new Router({
      agents: [{ handle: 'wren', client: fake.client(), subscriptions: desiredSubscriptions() }],
      waitMs: 10,
      retryMs: 10,
      deliverTimeoutMs: 20,
    } as any);
    const ac = new AbortController();
    const done = router.run(ac.signal);
    let calls = 0;
    const slow: Injector = {
      kind: 'exec',
      deliver: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 300));
        return 'accepted';
      },
    };
    router.register('wren', slow);
    await until(() => fake.subs.length === 2);
    fake.push('inbox', [mention()]);
    await until(() => fake.acks.length === 1, 2000);
    expect(calls).toBe(1);
    expect(router.stats('wren')?.wakes).toBe(1);
    ac.abort();
    await done;
  });

  test('stopping during an exec run kills it, does not ack, and redelivers on restart', async () => {
    const fake = new FakeTilori();
    const mk = () =>
      new Router({ agents: [{ handle: 'wren', client: fake.client(), subscriptions: desiredSubscriptions() }], waitMs: 10, retryMs: 10 });
    const ac = new AbortController();
    const router = mk();
    const done = router.run(ac.signal);
    let started = false;
    const slow = new ExecInjector('sleep 10', () => {}, { signal: ac.signal, killGraceMs: 100 });
    router.register('wren', {
      kind: 'exec',
      deliver: (w) => {
        started = true;
        return slow.deliver(w);
      },
    });
    await until(() => fake.subs.length === 2);
    fake.push('inbox', [mention()]);
    await until(() => started, 2000);
    const t0 = Date.now();
    ac.abort();
    await done;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(fake.acks).toEqual([]);
    expect(router.stats('wren')?.wakes).toBe(0);

    // Next start: the same batch is served again and acked once handed off.
    const ac2 = new AbortController();
    const router2 = mk();
    const done2 = router2.run(ac2.signal);
    router2.register('wren', new ExecInjector('true', () => {}, { signal: ac2.signal }));
    await until(() => fake.acks.length === 1, 2000);
    ac2.abort();
    await done2;
  });

  test('when the newest injector leaves, the previous live one takes over', async () => {
    const { fake, router, ac, done } = setup();
    const older = new Recorder();
    const newer = new Recorder();
    router.register('wren', older);
    const dropNewer = router.register('wren', newer);
    await until(() => fake.subs.length === 2);
    fake.push('inbox', [mention()]);
    await until(() => newer.wakes.length === 1);
    dropNewer();
    expect(router.injectorCount('wren')).toBe(1);
    fake.push('inbox', [mention()]);
    await until(() => older.wakes.length === 1);
    expect(fake.acks).toHaveLength(2);
    ac.abort();
    await done;
  });

  test('a gone injector falls back to the previous one at once', async () => {
    const { fake, router, ac, done } = setup();
    const older = new Recorder();
    const newer = new Recorder();
    newer.next = ['gone'];
    router.register('wren', older);
    router.register('wren', newer);
    await until(() => fake.subs.length === 2);
    fake.push('inbox', [mention()]);
    await until(() => older.wakes.length === 1);
    expect(router.injectorCount('wren')).toBe(1);
    ac.abort();
    await done;
  });

  test('busy retries back off exponentially and new batches do not shorten the backoff', async () => {
    const { fake, router, ac, done } = setup();
    let calls = 0;
    const busy: Injector = { kind: 'test', deliver: async () => (calls++, 'busy') };
    router.register('wren', busy);
    await until(() => fake.subs.length === 2);
    fake.push('inbox', [mention()]);
    await new Promise((r) => setTimeout(r, 100));
    fake.push('direct_messages', [dm()]);
    await new Promise((r) => setTimeout(r, 250));
    // retryMs 10 → waits of 10, 20, 40, 80, 160 ms: at most ~6 attempts in 350 ms
    // (a fixed 10 ms retry would be ~35).
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(calls).toBeLessThanOrEqual(7);
    expect(fake.acks).toHaveLength(0);
    ac.abort();
    await done;
  });

  test('one multiplexed long poll per agent, listing every idle subscription', async () => {
    const { fake, router, ac, done } = setup();
    const inj = new Recorder();
    router.register('wren', inj);
    await until(() => fake.subs.length === 2);
    await until(() => fake.polls.length >= 3);
    expect(fake.polls.every((p) => p.multi)).toBe(true);
    expect(fake.polls[0].ids.sort()).toEqual(fake.subs.map((s) => s.id).sort());
    expect(fake.maxWaiting).toBe(1);
    fake.push('direct_messages', [dm()]);
    fake.push('inbox', [mention()]);
    await until(() => fake.acks.length === 2);
    expect(inj.wakes.flatMap((w) => w.events)).toHaveLength(2);
    ac.abort();
    await done;
  });

  test('a held subscription is left out, and the long poll restarts to include it once acked', async () => {
    const fake = new FakeTilori();
    const router = new Router({
      agents: [{ handle: 'wren', client: fake.client(), subscriptions: desiredSubscriptions() }],
      waitMs: 20_000,
      retryMs: 10,
    });
    let calls = 0;
    const slow: Injector = {
      kind: 'test',
      deliver: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 200));
        return 'accepted';
      },
    };
    router.register('wren', slow);
    const ac = new AbortController();
    const done = router.run(ac.signal);
    await until(() => fake.subs.length === 2);
    const inbox = fake.subs.find((s) => s.scope.type === 'inbox')!.id;
    fake.push('inbox', [mention()]);
    // While the inbox batch is held, the poll lists only direct_messages.
    await until(() => fake.polls.some((p) => p.ids.length === 1 && !p.ids.includes(inbox)), 1000);
    await until(() => fake.acks.length === 1, 1000);
    const t0 = Date.now();
    fake.push('inbox', [mention()]);
    await until(() => fake.acks.length === 2, 1000);
    expect(Date.now() - t0).toBeLessThan(800);
    expect(calls).toBe(2);
    // The abandoned call plus its replacement: within the server's 2 per agent.
    expect(fake.maxWaiting).toBeLessThanOrEqual(2);
    ac.abort();
    await done;
  });

  test('falls back to one poll per subscription when the server rejects subscription_ids', async () => {
    const { fake, router, ac, done, logs } = setup();
    fake.legacy = true;
    const inj = new Recorder();
    router.register('wren', inj);
    await until(() => fake.subs.length === 2);
    await until(() => logs.some((l) => l.includes('does not accept subscription_ids')));
    fake.push('direct_messages', [dm()]);
    await until(() => fake.acks.length === 1);
    expect(inj.wakes).toHaveLength(1);
    expect(fake.polls.length).toBeGreaterThan(0);
    expect(fake.polls.every((p) => !p.multi)).toBe(true);
    expect(logs.filter((l) => l.includes('does not accept'))).toHaveLength(1);
    ac.abort();
    await done;
  });

  test('a per-id poll error re-subscribes it once; the others keep being served', async () => {
    const { fake, router, ac, done, logs } = setup();
    const inj = new Recorder();
    router.register('wren', inj);
    await until(() => fake.subs.length === 2);
    const inbox = fake.subs.find((s) => s.scope.type === 'inbox')!.id;
    fake.failOnce.set(inbox, 'SUBSCRIPTION_DISABLED');
    await until(() => fake.renewals.includes(inbox));
    fake.push('inbox', [mention()]);
    await until(() => fake.acks.length === 1);
    const line = logs.find((l) => l.includes('re-subscribing'))!;
    expect(line).toContain(inbox);
    expect(line).toContain('SUBSCRIPTION_DISABLED');
    expect(logs.join('\n')).not.toContain('secret text');
    expect(logs.some((l) => l.includes('dropping'))).toBe(false);
    ac.abort();
    await done;
  });

  test('a subscription that keeps failing is dropped (id logged only) and the rest still wake', async () => {
    const { fake, router, ac, done, logs } = setup();
    const inj = new Recorder();
    router.register('wren', inj);
    await until(() => fake.subs.length === 2);
    const inbox = fake.subs.find((s) => s.scope.type === 'inbox')!.id;
    fake.failingSubs.set(inbox, 'POST_UNAVAILABLE');
    await until(() => logs.some((l) => l.includes('dropping')));
    const before = fake.polls.length;
    fake.push('direct_messages', [dm()]);
    await until(() => fake.acks.length === 1);
    expect(fake.polls.slice(before).every((p) => !p.ids.includes(inbox))).toBe(true);
    expect(fake.renewals.filter((id) => id === inbox)).toHaveLength(1);
    expect(logs.find((l) => l.includes('dropping'))).toBe(
      `[wren] dropping subscription ${inbox} (POST_UNAVAILABLE) until the next renewal`,
    );
    expect(logs.join('\n')).not.toContain('secret text');
    ac.abort();
    await done;
  });

  test('a vanished subscription refuses the whole call and is re-created', async () => {
    const { fake, router, ac, done } = setup();
    router.register('wren', new Recorder());
    await until(() => fake.subs.length === 2);
    const inbox = fake.subs.find((s) => s.scope.type === 'inbox')!.id;
    fake.subs = fake.subs.filter((s) => s.id !== inbox);
    await until(() => fake.subs.length === 2);
    fake.push('inbox', [mention()]);
    await until(() => fake.acks.length === 1);
    ac.abort();
    await done;
  });

  test('honours retry_after_ms when over the server waiter budget', async () => {
    const { fake, router, ac, done } = setup();
    router.register('wren', new Recorder());
    await until(() => fake.subs.length === 2);
    fake.retryAfterMs = 300;
    fake.overBudget = 1;
    await until(() => fake.overBudgetAt.length === 1);
    const at = fake.overBudgetAt[0];
    await until(() => fake.pollTimes.some((t) => t > at));
    expect(fake.pollTimes.find((t) => t > at)! - at).toBeGreaterThanOrEqual(280);
    ac.abort();
    await done;
  });

  test('honours retry_after_ms in the single-id fallback too', async () => {
    const { fake, router, ac, done, logs } = setup();
    fake.legacy = true;
    router.register('wren', new Recorder());
    await until(() => logs.some((l) => l.includes('does not accept')));
    fake.retryAfterMs = 300;
    fake.overBudget = 1;
    await until(() => fake.overBudgetAt.length === 1);
    const [at, id] = [fake.overBudgetAt[0], fake.overBudgetIds[0]];
    const n = fake.polls.length;
    await new Promise((r) => setTimeout(r, 150));
    // That subscription paused; the other kept polling every ~10 ms.
    const later = fake.polls.slice(n);
    expect(later.length).toBeGreaterThan(3);
    expect(later.some((p) => p.ids[0] === id)).toBe(false);
    await until(() => fake.polls.slice(n).some((p) => p.ids[0] === id));
    expect(Date.now() - at).toBeGreaterThanOrEqual(280);
    ac.abort();
    await done;
  });

  test('refuses registration for an agent it does not serve', () => {
    const { router, ac } = setup();
    expect(() => router.register('other', new Recorder())).toThrow();
    ac.abort();
  });
});
