import './setup.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createConnection } from 'node:net';
import { desiredSubscriptions } from '../src/config.ts';
import { NotifyLinesInjector } from '../src/injectors/notify-lines.ts';
import { attachToRouter, IPC_VERSION, routerAvailable, routerUsage, serveRouter } from '../src/ipc.ts';
import { Router } from '../src/router.ts';
import { FakeTilori, mention, until } from './fake-tilori.ts';

let dir: string;
beforeEach(() => {
  // Short path: Unix socket paths are limited to ~108 bytes.
  dir = mkdtempSync(join(tmpdir(), 'ta-'));
  chmodSync(dir, 0o700);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function routerWith(fake: FakeTilori) {
  return new Router({
    agents: [{ handle: 'wren', client: fake.client(), subscriptions: desiredSubscriptions() }],
    waitMs: 10,
    retryMs: 10,
    coalesceMs: 0,
  });
}

describe('router socket', () => {
  test('a usage query gets counts only, then the connection closes', async () => {
    const router = routerWith(new FakeTilori());
    const sock = join(dir, 'r.sock');
    const server = await serveRouter(router, sock);
    try {
      expect(await routerUsage('wren', sock)).toEqual({ wakes: { used: 0, limit: 20 }, direct: { used: 0, limit: 10 }, held: 0 });
      // An agent this router doesn't serve, or no router at all: null.
      expect(await routerUsage('pax', sock)).toBeNull();
      expect(await routerUsage('wren', join(dir, 'none.sock'))).toBeNull();
      // A usage query doesn't register an injector.
      expect(router.injectorCount('wren')).toBe(0);
    } finally {
      server.close();
    }
  });

  test('monitor attaches, receives one wake line, and the batch is acked after the line', async () => {
    const fake = new FakeTilori();
    const router = routerWith(fake);
    const sock = join(dir, 'r.sock');
    const server = await serveRouter(router, sock);
    expect(statSync(sock).mode & 0o777).toBe(0o600);
    expect(routerAvailable(sock)).toBe(true);
    const ac = new AbortController();
    const running = router.run(ac.signal);

    const out = new PassThrough();
    let lines = '';
    out.on('data', (c) => (lines += c));
    let registered = false;
    const attached = attachToRouter('wren', new NotifyLinesInjector(out), sock, () => (registered = true));
    await until(() => registered && fake.subs.length === 2);
    const ev = mention();
    fake.push('inbox', [ev]);
    await until(() => fake.acks.length === 1);
    expect(lines).toContain(`mention post ${ev.entity_id}`);
    expect(lines.trim().split('\n')).toHaveLength(1);

    ac.abort();
    server.close();
    await running;
    await attached.catch(() => {});
  });

  test('router refuses unknown agents and malformed registrations', async () => {
    const router = routerWith(new FakeTilori());
    const sock = join(dir, 'r.sock');
    const server = await serveRouter(router, sock);
    await expect(attachToRouter('stranger', new NotifyLinesInjector(new PassThrough()), sock)).rejects.toThrow(
      /does not serve/,
    );
    const reply = await new Promise<string>((resolve) => {
      const c = createConnection(sock);
      let buf = '';
      c.on('data', (d) => (buf += d));
      c.on('close', () => resolve(buf));
      c.on('connect', () => c.write(JSON.stringify({ op: 'register', v: IPC_VERSION + 9, agent: 'wren' }) + '\n'));
    });
    expect(reply).toContain('"op":"error"');
    server.close();
  });

  test('refuses to start twice on the same socket, and replaces a stale one', async () => {
    const sock = join(dir, 'r.sock');
    const a = await serveRouter(routerWith(new FakeTilori()), sock);
    await expect(serveRouter(routerWith(new FakeTilori()), sock)).rejects.toThrow(/already listening/);
    await new Promise<void>((r) => a.close(() => r()));
    const b = await serveRouter(routerWith(new FakeTilori()), sock);
    b.close();
  });

  test('clients refuse a socket directory other users can enter', () => {
    chmodSync(dir, 0o755);
    expect(routerAvailable(join(dir, 'r.sock'))).toBe(false);
    expect(() => attachToRouter('wren', new NotifyLinesInjector(new PassThrough()), join(dir, 'r.sock'))).toThrow();
  });
});
