import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ACCESS_HINT, TiloriAgentClient } from '../src/client.ts';
import { desiredSubscriptions, saveConfig } from '../src/config.ts';
import { writeKey } from '../src/keys.ts';
import { FakeTilori, mention, until } from './fake-tilori.ts';

const KEY = 'mcp_sk_transport_test_key_0123456789';
const fake = new FakeTilori();
const auth: Array<string | null> = [];
let http: ReturnType<typeof Bun.serve>;
let url: string;
let home: string;

beforeAll(() => {
  http = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      auth.push(req.headers.get('authorization'));
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
    await c.close();
    expect(auth.every((a) => a === `Bearer ${KEY}`)).toBe(true);
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
    const proc = Bun.spawn(['bun', join(import.meta.dir, '../src/cli.ts'), 'watch', '--notify-lines', '--wait-ms', '50'], {
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
});
