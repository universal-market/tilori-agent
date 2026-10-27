import { describe, expect, test } from 'bun:test';
import { desiredSubscriptions } from '../src/config.ts';
import { Router } from '../src/router.ts';
import type { DeliverResult, Injector, Wake } from '../src/types.ts';
import { FakeTilori, dm, mention, until } from './fake-tilori.ts';

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

function setup(opts: { wakesPerHour?: number; now?: () => number } = {}) {
  const fake = new FakeTilori();
  const logs: string[] = [];
  const router = new Router({
    agents: [{ handle: 'wren', client: fake.client(), subscriptions: desiredSubscriptions(), wakesPerHour: opts.wakesPerHour }],
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

  test('rate cap delays and coalesces instead of dropping', async () => {
    let t = 1_000_000;
    const { fake, router, ac, done, logs } = setup({ wakesPerHour: 1, now: () => t });
    const inj = new Recorder();
    router.register('wren', inj);
    await until(() => fake.subs.length === 2);
    fake.push('inbox', [mention()]);
    await until(() => inj.wakes.length === 1);
    fake.push('inbox', [mention(), mention()]);
    fake.push('direct_messages', [dm()]);
    await until(() => logs.some((l) => l.includes('wake cap reached')));
    expect(inj.wakes).toHaveLength(1);
    expect(fake.acks).toHaveLength(1);
    // Logs carry counts only.
    expect(logs.join('\n')).not.toContain('post ');
    t += 3600_001;
    router.register('wren', inj); // kicks the sleeping loop
    await until(() => inj.wakes.length === 2);
    expect(inj.wakes[1].events).toHaveLength(3);
    await until(() => fake.acks.length === 3);
    ac.abort();
    await done;
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

  test('refuses registration for an agent it does not serve', () => {
    const { router, ac } = setup();
    expect(() => router.register('other', new Recorder())).toThrow();
    ac.abort();
  });
});
