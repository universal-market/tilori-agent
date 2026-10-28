import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ACCESS_HINT, TiloriAgentClient } from '../src/client.ts';
import { desiredSubscriptions, loadConfig, saveConfig } from '../src/config.ts';
import { writeKey } from '../src/keys.ts';
import { FakeTilori, mention, until } from './fake-tilori.ts';

const KEY = 'mcp_sk_transport_test_key_0123456789';
const fake = new FakeTilori();
const auth: Array<string | null> = [];
const methods: string[] = [];
let http: ReturnType<typeof Bun.serve>;
let url: string;
let home: string;

beforeAll(() => {
  http = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      auth.push(req.headers.get('authorization'));
      methods.push(req.method);
      if (req.headers.get('authorization') !== `Bearer ${KEY}`) return new Response('no', { status: 401 });
      if (req.method === 'DELETE') return new Response(null, { status: 204 });
      const mcp = new Server({ name: 'fake-tilori', version: '1' }, { capabilities: { tools: {} } });
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
      mcp.setRequestHandler(CallToolRequestSchema, async (r) =>
        (await fake.callTool({ name: r.params.name, arguments: (r.params.arguments ?? {}) as any })) as any,
      );
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await mcp.connect(transport);
      return transport.handleRequest(req);
    },
  });
  url = `http://127.0.0.1:${http.port}/mcp/tilori/v1`;
  home = mkdtempSync(join(tmpdir(), 'ta-cli-'));
});
afterAll(() => {
  http.stop(true);
  rmSync(home, { recursive: true, force: true });
});

describe('over real MCP HTTP transport', () => {
  test('client sends the key only as a bearer header and round-trips event tools', async () => {
    const c = new TiloriAgentClient({ url: new URL(url), apiKey: KEY });
    const subs = await c.ensureSubscriptions(desiredSubscriptions());
    expect(subs).toHaveLength(2);
    expect(await c.poll(subs[0].id, 0)).toBeNull();
    expect(await c.pollMany(subs.map((s) => s.id), 0)).toEqual({ deliveries: [], errors: [], retryAfterMs: undefined });
    await c.close();
    expect(auth.every((a) => a === `Bearer ${KEY}`)).toBe(true);
    // No GET push stream is opened: the router only polls.
    expect(methods).not.toContain('GET');
  });

  test('an access-gate 403 explains what the owner can do and never echoes the key', async () => {
    const refuse = async () =>
      Response.json({ code: 'PERMISSION_DENIED', message: 'Access is restricted on this instance' }, { status: 403 });
    const c = new TiloriAgentClient({ url: new URL(url), apiKey: KEY, fetch: refuse as unknown as typeof fetch });
    const err = await c.listSubscriptions().catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('Access is restricted on this instance');
    expect((err as Error).message).toContain(ACCESS_HINT);
    expect((err as Error).message).not.toContain(KEY);
    await c.close();
  });

  test('an access-gate tool error gets the same hint', async () => {
    const refused = {
      async callTool() {
        return { isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED', message: 'Access is restricted on this instance' } } };
      },
    };
    const c = new TiloriAgentClient({ url: new URL(url), apiKey: KEY, mcpClient: refused });
    const err = await c.listSubscriptions().catch((e: Error) => e);
    expect((err as Error).message).toBe(`Access is restricted on this instance ${ACCESS_HINT}`);
  });

  test('CLI watch --notify-lines prints one wake line on stdout and acks after it', async () => {
    const env = { ...process.env, TILORI_HOME: join(home, 'tilori'), TILORI_SOCKET: join(home, 'none.sock'), TILORI_AGENT: '' };
    process.env.TILORI_HOME = env.TILORI_HOME;
    writeKey('wren', KEY);
    saveConfig({ url, default_agent: 'wren' });
    delete process.env.TILORI_HOME;

    const acksBefore = fake.acks.length;
    // The plugin's monitor passes its own version and the host's install record.
    const manifest = join(home, 'installed_plugins.json');
    writeFileSync(manifest, JSON.stringify({ plugins: { 'tilori@tilori-claude': [{ scope: 'user', version: '0.1.15' }] } }));
    const update = ['--running-version', '0.1.14', '--installed-manifest', manifest, '--installed-key', 'tilori@tilori-claude'];
    const cli = join(import.meta.dir, '../src/cli.ts');
    const proc = Bun.spawn(['bun', cli, 'watch', '--notify-lines', '--wait-ms', '50', ...update], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    let out = '';
    let err = '';
    const reader = proc.stdout.getReader();
    const errReader = proc.stderr.getReader();
    (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        out += new TextDecoder().decode(value);
      }
    })();
    (async () => {
      for (;;) {
        const { value, done } = await errReader.read();
        if (done) break;
        err += new TextDecoder().decode(value);
      }
    })();
    await until(() => err.includes('watching Tilori directly'), 8000);
    await until(() => fake.subs.some((s) => s.scope.type === 'inbox'), 8000);
    const ev = mention();
    fake.push('inbox', [ev]);
    await until(() => out.includes('\n') && fake.acks.length > acksBefore, 8000);
    proc.kill();
    await proc.exited;
    expect(out.trim().split('\n')).toEqual([expect.stringContaining(`mention post ${ev.entity_id}`)]);
    expect(out).toContain('Tilori plugin 0.1.15 is installed; this session runs 0.1.14.');
    expect(out + err).not.toContain(manifest);
    expect(out + err).not.toContain(KEY);
  }, 15000);

  test('CLI watch in direct mode switches to a router that appears later', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'ta-sw-'));
    chmodSync(runDir, 0o700);
    const sock = join(runDir, 'r.sock');
    const env = {
      ...process.env,
      TILORI_HOME: join(home, 'tilori'),
      TILORI_SOCKET: sock,
      TILORI_AGENT: 'wren',
      TILORI_ROUTER_CHECK_MS: '200',
    };
    const cli = join(import.meta.dir, '../src/cli.ts');
    const watch = Bun.spawn(['bun', cli, 'watch', '--notify-lines', '--wait-ms', '50'], { env, stdout: 'pipe', stderr: 'pipe' });
    let err = '';
    (async () => {
      const r = watch.stderr.getReader();
      for (;;) {
        const { value, done } = await r.read();
        if (done) break;
        err += new TextDecoder().decode(value);
      }
    })();
    await until(() => err.includes('watching Tilori directly'), 8000);
    const router = Bun.spawn(['bun', cli, 'router', '--wait-ms', '50'], { env, stdout: 'ignore', stderr: 'pipe' });
    await until(() => err.includes('switching to it') && err.includes('attached to router'), 8000);
    watch.kill();
    router.kill();
    await Promise.all([watch.exited, router.exited]);
    rmSync(runDir, { recursive: true, force: true });
  }, 20000);

  test('CLI ensure lists unmanaged subscriptions, and removes them only with --prune', async () => {
    const env = { ...process.env, TILORI_HOME: join(home, 'tilori'), TILORI_AGENT: 'wren' };
    process.env.TILORI_HOME = env.TILORI_HOME;
    writeKey('wren', KEY);
    saveConfig({ url, default_agent: 'wren' });
    delete process.env.TILORI_HOME;
    const cli = join(import.meta.dir, '../src/cli.ts');
    // Async: the CLI talks to this process's server, which spawnSync would block.
    const run = async (...args: string[]) => {
      const p = Bun.spawn(['bun', cli, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { stdout, stderr, exitCode };
    };
    // Left over from an older config, or made by a session: not in config.
    const extra = [
      { scope: { type: 'posts' as const }, exclude_self: true },
      { scope: { type: 'mentions' as const }, exclude_self: true },
    ];
    const c = new TiloriAgentClient({ url: new URL(url), apiKey: KEY });
    // The router's path (call) stays read-only: only unsubscribe() can prune.
    await expect(c.call('unsubscribe_from_events' as any, { subscription_id: 'x' })).rejects.toThrow('never calls');
    const made = await Promise.all(extra.map((spec) => c.subscribe(spec)));
    await c.close();
    const ids = made.map((s) => s.id).sort();

    const list = await run('ensure');
    expect(list.exitCode).toBe(0);
    const listed = JSON.parse(list.stdout);
    expect(listed.unmanaged.map((s: any) => s.id).sort()).toEqual(ids);
    expect(listed.pruned).toBeUndefined();
    expect(list.stderr).toContain('2 unmanaged subscription(s) listed; run with --prune --yes');
    const managed = listed.subscriptions.map((s: any) => s.id);

    // --prune without --yes lists, removes nothing and exits 2.
    const unconfirmed = await run('ensure', '--prune');
    expect(unconfirmed.exitCode).toBe(2);
    expect(JSON.parse(unconfirmed.stdout).unmanaged.map((s: any) => s.id).sort()).toEqual(ids);
    expect(unconfirmed.stderr).toContain('nothing removed. Re-run with --prune --yes');
    expect(fake.unsubscribed).toHaveLength(0);

    // One unsubscribe fails: the other is still removed, both are reported, exit 1.
    fake.failUnsubscribe.add(ids[0]);
    const partial = await run('ensure', '--prune', '--yes');
    expect(partial.exitCode).toBe(1);
    const part = JSON.parse(partial.stdout);
    expect(part.pruned).toEqual([ids[1]]);
    expect(part.failed.map((f: any) => f.id)).toEqual([ids[0]]);
    expect(partial.stderr).toContain(`could not unsubscribe ${ids[0]}`);
    fake.failUnsubscribe.clear();

    // Confirmed: removes exactly what is listed, never a managed subscription.
    const prune = await run('ensure', '--prune', '--yes');
    expect(prune.exitCode).toBe(0);
    const pruned = JSON.parse(prune.stdout);
    expect(pruned.unmanaged.map((s: any) => s.id)).toEqual([ids[0]]);
    expect(pruned.pruned).toEqual([ids[0]]);
    expect(pruned.failed).toEqual([]);
    expect([...fake.unsubscribed].sort()).toEqual(ids);
    expect(fake.subs.map((s) => s.id).sort()).toEqual([...managed].sort());
    for (const r of [list, unconfirmed, partial, prune]) expect(r.stderr).not.toContain(KEY);

    // Nothing left: --prune alone now exits 0.
    const again = await run('ensure', '--prune');
    expect(again.exitCode).toBe(0);
    expect(JSON.parse(again.stdout).unmanaged).toEqual([]);
  }, 30000);

  test('CLI headers prints the bearer header, and fails closed on a wide key file', async () => {
    const env = { ...process.env, TILORI_HOME: join(home, 'tilori'), TILORI_AGENT: 'wren', CLAUDE_CODE_MCP_SERVER_URL: url };
    const cli = join(import.meta.dir, '../src/cli.ts');
    const ok = Bun.spawnSync(['bun', cli, 'headers'], { env });
    expect(JSON.parse(ok.stdout.toString())).toEqual({ Authorization: `Bearer ${KEY}` });
    // Another server, or no server URL at all: nothing is released.
    for (const other of [
      { ...env, CLAUDE_CODE_MCP_SERVER_URL: 'https://evil.example/mcp/tilori/v1' },
      { ...env, CLAUDE_CODE_MCP_SERVER_URL: url.replace('/mcp/tilori/v1', '/other') },
      { ...env, CLAUDE_CODE_MCP_SERVER_URL: '' },
    ]) {
      const r = Bun.spawnSync(['bun', cli, 'headers'], { env: other });
      expect(r.exitCode).toBe(1);
      expect(r.stdout.toString()).toBe('');
      expect(r.stderr.toString()).not.toContain(KEY);
    }
    chmodSync(join(home, 'tilori', 'agents', 'wren.key'), 0o640);
    const bad = Bun.spawnSync(['bun', cli, 'headers'], { env });
    expect(bad.exitCode).toBe(1);
    expect(bad.stdout.toString()).toBe('');
    expect(bad.stderr.toString()).not.toContain(KEY);
    chmodSync(join(home, 'tilori', 'agents', 'wren.key'), 0o600);
  });

  describe('keys go only to config.url', () => {
    // A second server that must never see a request.
    let evil: ReturnType<typeof Bun.serve>;
    let evilUrl: string;
    const evilHits: string[] = [];
    beforeAll(() => {
      evil = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch(req) {
          evilHits.push(req.headers.get('authorization') ?? '');
          return new Response('no', { status: 401 });
        },
      });
      evilUrl = `http://127.0.0.1:${evil.port}/mcp/tilori/v1`;
    });
    afterAll(() => evil.stop(true));

    const cli = join(import.meta.dir, '../src/cli.ts');
    const fresh = () => {
      const dir = mkdtempSync(join(tmpdir(), 'ta-keyurl-'));
      chmodSync(dir, 0o700);
      return { dir, env: { ...process.env, TILORI_HOME: join(dir, 'tilori'), TILORI_SOCKET: join(dir, 'none.sock'), TILORI_AGENT: 'wren' } };
    };
    const configIn = (dir: string) => {
      process.env.TILORI_HOME = join(dir, 'tilori');
      try {
        return loadConfig();
      } finally {
        delete process.env.TILORI_HOME;
      }
    };

    test('a first init ignores $TILORI_URL and verifies against --url only', async () => {
      const { dir, env } = fresh();
      // Async: init verifies against the fake server in this process.
      const proc = Bun.spawn(['bun', cli, 'init', '--agent', 'wren', '--url', url], {
        env: { ...env, TILORI_URL: evilUrl },
        stdin: new TextEncoder().encode(KEY + '\n'),
        stderr: 'pipe',
      });
      expect(await proc.exited).toBe(0);
      expect(configIn(dir).url).toBe(url);
      expect(evilHits).toEqual([]);
      rmSync(dir, { recursive: true, force: true });
    }, 15000);

    test('init without --url never falls back to $TILORI_URL', () => {
      const { dir, env } = fresh();
      const r = Bun.spawnSync(['bun', cli, 'init', '--agent', 'wren', '--no-verify'], {
        env: { ...env, TILORI_URL: evilUrl },
        stdin: new TextEncoder().encode(KEY + '\n'),
      });
      expect(r.exitCode).toBe(1);
      expect(r.stderr.toString()).toContain('init --url');
      expect(r.stderr.toString()).not.toContain(KEY);
      rmSync(dir, { recursive: true, force: true });
    });

    test('init --url replacing a configured url says old and new', () => {
      const { dir, env } = fresh();
      process.env.TILORI_HOME = env.TILORI_HOME;
      saveConfig({ url: 'https://old.example/mcp/tilori/v1' });
      delete process.env.TILORI_HOME;
      const r = Bun.spawnSync(['bun', cli, 'init', '--agent', 'wren', '--url', url, '--no-verify'], {
        env,
        stdin: new TextEncoder().encode(KEY + '\n'),
      });
      expect(r.exitCode).toBe(0);
      expect(r.stderr.toString()).toContain(`replacing url in config.json: https://old.example/mcp/tilori/v1 -> ${url}`);
      expect(configIn(dir).url).toBe(url);
      rmSync(dir, { recursive: true, force: true });
    });

    test('a redirect from the configured server is refused, not followed', async () => {
      // The SDK already refuses cross-origin redirects; a same-origin one to
      // another path would still carry the key there without redirect: 'error'.
      const seen: string[] = [];
      const redirector = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch(req) {
          const path = new URL(req.url).pathname;
          seen.push(`${path} ${req.headers.get('authorization') ? 'key' : '-'}`);
          return path === '/mcp/tilori/v1'
            ? new Response(null, { status: 307, headers: { location: '/elsewhere' } })
            : new Response('no', { status: 401 });
        },
      });
      const c = new TiloriAgentClient({ url: new URL(`http://127.0.0.1:${redirector.port}/mcp/tilori/v1`), apiKey: KEY });
      const err = await c.listSubscriptions().catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toContain(KEY);
      await c.close();
      redirector.stop(true);
      expect(seen.filter((s) => s.startsWith('/elsewhere'))).toEqual([]);
    });

    test('ensure, watch and router refuse a mismatched url before reading any key', () => {
      const { dir, env } = fresh();
      process.env.TILORI_HOME = env.TILORI_HOME;
      saveConfig({ url, default_agent: 'wren' });
      writeKey('wren', KEY);
      delete process.env.TILORI_HOME;
      // An unreadable key file would fail on read, so a refusal message
      // (not a key error) shows the URL check came first.
      chmodSync(join(dir, 'tilori', 'agents', 'wren.key'), 0o000);
      const cases: [string[], Record<string, string>][] = [
        [['ensure'], { TILORI_URL: evilUrl }],
        [['ensure', '--url', evilUrl], {}],
        [['watch', '--notify-lines', '--wait-ms', '50'], { TILORI_URL: evilUrl }],
        [['watch', '--exec', 'true'], { TILORI_URL: evilUrl }],
        [['router'], { TILORI_URL: evilUrl }],
      ];
      for (const [args, extra] of cases) {
        const r = Bun.spawnSync(['bun', cli, ...args], { env: { ...env, ...extra }, timeout: 8000 });
        const err = r.stderr.toString();
        expect(r.exitCode).toBe(1);
        expect(err).toMatch(/Refusing: (--url|TILORI_URL) does not match "url" in config.json/);
        expect(err).not.toContain(KEY);
      }
      expect(evilHits).toEqual([]);
      chmodSync(join(dir, 'tilori', 'agents', 'wren.key'), 0o600);
      expect(readFileSync(join(dir, 'tilori', 'agents', 'wren.key'), 'utf8').trim()).toBe(KEY);
      rmSync(dir, { recursive: true, force: true });
    }, 30000);
  });
});
