import './setup.ts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { main } from '../src/cli.ts';
import { CONNECT_LINES, LAUNCHER, runConnect, shellWord, type ConnectOptions } from '../src/connect.ts';
import { HEADERS_ALLOW, loadConfig, saveConfig } from '../src/config.ts';
import { keyPath, writeKey } from '../src/keys.ts';
import { FakeTilori } from './fake-tilori.ts';
import { allowHome } from './allow-home.ts';

/**
 * UNI-818 `connect`. Bastion's conditions (6b60e223, 3a28226a): the key only
 * from stdin, never argv or a stored key file; both servers checked before
 * anything is written; no redirects with the key; errors name status and
 * host only; the key in no file but agents/<handle>.key and in no output;
 * the plugin told the two addresses only; a third origin gets nothing.
 * Juniper's copy (d58ee772, cdc55f38, 31f9eb9b).
 */

const KEY = 'mcp_sk_connect_test_key_0123456789abcdef';
const OLD_KEY = 'mcp_sk_old_public_key_fedcba9876543210';
const BODY_SECRET = 'server-said-this-in-the-body';
const state = {
  tilori: 'ok' as 'ok' | '401' | '500' | 'redirect',
  market: 'ok' as 'ok' | '401',
  hits: 0,
  /** Authorization headers the "elsewhere" path saw. */
  elsewhere: [] as string[],
};
const fake = new FakeTilori();
let http: ReturnType<typeof Bun.serve>;
let origin: string;
let tiloriUrl: string;
let marketUrl: string;
let home: string;

const mcpServer = async (req: Request, profile: boolean) => {
  if (req.method === 'DELETE') return new Response(null, { status: 204 });
  const mcp = new Server({ name: 'fake', version: '1' }, { capabilities: { tools: {} } });
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  mcp.setRequestHandler(CallToolRequestSchema, async (r) => {
    if (profile && r.params.name === 'get_my_profile') {
      fake.profile = { profile: { username: 'alice-chen', handle: 'plover', id: 'a1', user_id: 'u1', kind: 'agent' } };
    }
    return (await fake.callTool({ name: r.params.name, arguments: (r.params.arguments ?? {}) as any })) as any;
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await mcp.connect(transport);
  return transport.handleRequest(req);
};

beforeAll(() => {
  http = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/elsewhere') {
        state.elsewhere.push(req.headers.get('authorization') ?? '');
        return new Response('nope', { status: 404 });
      }
      state.hits++;
      const authed = req.headers.get('authorization') === `Bearer ${KEY}`;
      if (url.pathname === '/mcp/tilori/v1') {
        if (state.tilori === 'redirect') return Response.redirect(`${origin}/elsewhere`, 307);
        if (state.tilori === '401' || !authed) return new Response(`no ${BODY_SECRET} ${KEY}`, { status: 401 });
        if (state.tilori === '500') return new Response(`boom ${BODY_SECRET} ${KEY}`, { status: 500 });
        return mcpServer(req, true);
      }
      if (url.pathname === '/mcp/v1') {
        if (state.market === '401' || !authed) return new Response(`no ${BODY_SECRET}`, { status: 401 });
        return mcpServer(req, false);
      }
      return new Response('not found', { status: 404 });
    },
  });
  origin = `http://127.0.0.1:${http.port}`;
  tiloriUrl = `${origin}/mcp/tilori/v1`;
  marketUrl = `${origin}/mcp/v1`;
});
afterAll(() => http.stop(true));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tilori-agent-connect-'));
  process.env.TILORI_HOME = join(home, 'tilori');
  allowHome(process.env.TILORI_HOME);
  delete process.env.TILORI_AGENT;
  delete process.env.TILORI_URL;
  Object.assign(state, { tilori: 'ok', market: 'ok', hits: 0, elsewhere: [] });
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.TILORI_HOME;
});

/** Runs connect with a fake plugin; returns the exit code, output and what the plugin was told. */
async function connect(over: Partial<ConnectOptions> = {}) {
  const lines: string[] = [];
  const configured: unknown[] = [];
  const code = await runConnect({
    url: tiloriUrl,
    marketUrl,
    key: KEY,
    readPluginConfig: async () => null,
    configurePlugin: async (v) => {
      configured.push(v);
      return null;
    },
    out: (l) => lines.push(l),
    ...over,
  });
  return { code, out: lines.join('\n'), configured };
}

/** Every file under the Tilori home that contains `secret`, relative to it. */
function filesWith(secret: string): string[] {
  const root = process.env.TILORI_HOME!;
  const found: string[] = [];
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const f of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (readFileSync(p, 'utf8').includes(secret)) found.push(relative(root, p));
    }
  };
  walk(root);
  return found;
}

describe('connect', () => {
  test('stores the key at 0600, records both addresses, tells the plugin only the addresses, says what to do next', async () => {
    const r = await connect();
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      [CONNECT_LINES.connected('@alice-chen.plover', `127.0.0.1:${http.port}`), ...CONNECT_LINES.restart].join('\n'),
    );
    expect(r.out).toContain('unset TILORI_API_KEY');
    expect(r.out).not.toContain(KEY);
    expect(readFileSync(keyPath('plover'), 'utf8').trim()).toBe(KEY);
    expect(statSync(keyPath('plover')).mode & 0o777).toBe(0o600);
    const config = loadConfig();
    expect(config.url).toBe(tiloriUrl);
    expect(config.market_url).toBe(marketUrl);
    expect(config.default_agent).toBe('plover');
    expect(r.configured).toEqual([{ tilori_url: tiloriUrl, market_url: marketUrl }]);
    expect(JSON.stringify(r.configured)).not.toContain(KEY);
    // The key is in exactly one file.
    expect(filesWith(KEY)).toEqual(['agents/plover.key']);
  });

  test('a third origin is not in headers.allow, so the header helper releases the key only to the two addresses', async () => {
    expect((await connect()).code).toBe(0);
    const allow = readFileSync(join(process.env.TILORI_HOME!, HEADERS_ALLOW), 'utf8');
    expect(allow).toContain(tiloriUrl);
    expect(allow).toContain(marketUrl);
    expect(allow).not.toContain('evil.example');
    const out: string[] = [];
    const saved = process.stdout.write;
    process.stdout.write = ((c: any) => (out.push(String(c)), true)) as any;
    try {
      const code = await main(['headers', '--agent', 'plover', '--server-url', 'https://evil.example/mcp/tilori/v1']);
      expect(code).not.toBe(0);
    } finally {
      process.stdout.write = saved;
    }
    expect(out.join('')).not.toContain(KEY);
  });

  test('no key on stdin: says to export it, sends nothing, writes nothing', async () => {
    const r = await connect({ key: '  \n' });
    expect(r.code).toBe(2);
    expect(r.out).toBe(CONNECT_LINES.noKey);
    expect(state.hits).toBe(0);
    expect(existsSync(join(process.env.TILORI_HOME!, 'config.json'))).toBe(false);
  });

  test('--replace with no key on stdin refuses and sends nothing, even with a key stored here (Bastion 3a28226a)', async () => {
    writeKey('wren', OLD_KEY);
    saveConfig({ url: 'https://tilori.example/mcp/tilori/v1', default_agent: 'wren' });
    const r = await connect({ key: '', replace: true });
    expect(r.code).toBe(2);
    expect(state.hits).toBe(0);
    expect(state.elsewhere).toEqual([]);
    expect(readFileSync(keyPath('wren'), 'utf8').trim()).toBe(OLD_KEY);
    expect(loadConfig().url).toBe('https://tilori.example/mcp/tilori/v1');
  });

  test('Market from the plugin when it is set and not the production default; else says where the configure line is', async () => {
    const prod = 'https://prod.example/mcp/v1';
    let r = await connect({ marketUrl: undefined, readPluginConfig: async () => ({ market_url: prod, market_default: prod }) });
    expect(r.code).toBe(2);
    expect(r.out).toBe(CONNECT_LINES.noMarket);
    expect(r.out).toContain("workspace's Connect panel");
    r = await connect({ marketUrl: undefined, readPluginConfig: async () => null });
    expect(r.out).toBe(CONNECT_LINES.noMarket);
    expect(state.hits).toBe(0);
    r = await connect({ marketUrl: undefined, readPluginConfig: async () => ({ market_url: marketUrl, market_default: prod }) });
    expect(r.code).toBe(0);
    expect(loadConfig().market_url).toBe(marketUrl);
  });

  test('plain HTTP to a non-loopback host is refused before anything is sent', async () => {
    const r = await connect({ url: 'http://tilori.example/mcp/tilori/v1' });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/HTTPS/);
    const m = await connect({ marketUrl: 'http://market.example/mcp/v1' });
    expect(m.code).toBe(2);
    expect(state.hits).toBe(0);
  });

  test('a refused key: names the host, echoes no body, writes nothing', async () => {
    state.tilori = '401';
    const r = await connect();
    expect(r.code).toBe(1);
    expect(r.out).toBe(`127.0.0.1:${http.port} refused this key (HTTP 401); nothing was saved. Check that you copied the whole key for this agent.`);
    expect(r.out).not.toContain(BODY_SECRET);
    expect(existsSync(join(process.env.TILORI_HOME!, 'config.json'))).toBe(false);
    expect(r.configured).toEqual([]);
  });

  test('a server error: status and host only, writes nothing', async () => {
    state.tilori = '500';
    const r = await connect();
    expect(r.code).toBe(1);
    expect(r.out).toBe(`Couldn't check the key with 127.0.0.1:${http.port}; nothing was saved.`);
    expect(r.out).not.toContain(BODY_SECRET);
    expect(r.out).not.toContain(KEY);
    expect(filesWith(KEY)).toEqual([]);
  });

  test('Market refusing the key stops it too, after Tilori passed: nothing written', async () => {
    state.market = '401';
    const r = await connect();
    expect(r.code).toBe(1);
    expect(r.out).toContain('refused this key');
    expect(filesWith(KEY)).toEqual([]);
    expect(existsSync(join(process.env.TILORI_HOME!, 'config.json'))).toBe(false);
  });

  test('a redirect is not followed with the key', async () => {
    state.tilori = 'redirect';
    const r = await connect();
    expect(r.code).toBe(1);
    expect(state.elsewhere).toEqual([]);
    expect(filesWith(KEY)).toEqual([]);
  });

  test('a home set up for another deployment is refused, names what is lost and the terminal command, and sends nothing', async () => {
    writeKey('wren', OLD_KEY);
    saveConfig({ url: 'https://tilori.example/mcp/tilori/v1', default_agent: 'wren' });
    const r = await connect();
    expect(r.code).toBe(1);
    expect(r.out).toBe(
      `This computer is set up for tilori.example. To switch it to 127.0.0.1:${http.port}, run this in a terminal: ` +
        `${LAUNCHER} connect --url ${tiloriUrl} --market-url ${marketUrl} --replace. @wren will stop getting events here.`,
    );
    expect(state.hits).toBe(0);
    expect(existsSync(keyPath('plover'))).toBe(false);
    expect(loadConfig().url).toBe('https://tilori.example/mcp/tilori/v1');
  });

  test('the same Tilori address with another Market address is a switch too: refused without --replace, sends nothing (Bastion e10827a7)', async () => {
    writeKey('wren', OLD_KEY);
    saveConfig({ url: tiloriUrl, market_url: 'https://market.example/mcp/v1', default_agent: 'wren', agents: { wren: {} } });
    const r = await connect();
    expect(r.code).toBe(1);
    expect(r.out).toBe(
      `This computer is set up for 127.0.0.1:${http.port} with Market at market.example. To switch it to Market at 127.0.0.1:${http.port}, run this in a terminal: ` +
        `${LAUNCHER} connect --url ${tiloriUrl} --market-url ${marketUrl} --replace. @wren will stop getting events here.`,
    );
    expect(state.hits).toBe(0);
    expect(loadConfig().market_url).toBe('https://market.example/mcp/v1');
    expect(readFileSync(join(process.env.TILORI_HOME!, HEADERS_ALLOW), 'utf8')).not.toContain(marketUrl);
    // A home with no Market yet: adding one is a switch as well.
    saveConfig({ url: tiloriUrl, default_agent: 'wren', agents: { wren: {} } });
    const none = await connect();
    expect(none.code).toBe(1);
    expect(none.out).toContain('with no Market. To switch it to Market at');
    expect(state.hits).toBe(0);
    // With --replace, the old key is moved aside before the new Market gets anything.
    const moved = await connect({ replace: true, now: () => Date.parse('2026-11-09T21:30:00Z') });
    expect(moved.code).toBe(0);
    expect(filesWith(OLD_KEY)).toEqual(['agents/wren.key.replaced-2026-11-09T21-30-00-000Z']);
    expect(loadConfig().market_url).toBe(marketUrl);
  });

  test('--replace moves the other agents\' keys aside (not deleted), so nothing sends them to the new host', async () => {
    writeKey('wren', OLD_KEY);
    saveConfig({ url: 'https://tilori.example/mcp/tilori/v1', default_agent: 'wren', agents: { wren: {} } });
    const r = await connect({ replace: true, now: () => Date.parse('2026-11-09T21:30:00Z') });
    expect(r.code).toBe(0);
    const agents = readdirSync(join(process.env.TILORI_HOME!, 'agents')).sort();
    expect(agents).toEqual(['plover.key', 'wren.key.replaced-2026-11-09T21-30-00-000Z']);
    expect(filesWith(OLD_KEY)).toEqual(['agents/wren.key.replaced-2026-11-09T21-30-00-000Z']);
    const config = loadConfig();
    expect(config.url).toBe(tiloriUrl);
    expect(config.default_agent).toBe('plover');
    expect(Object.keys(config.agents ?? {})).toEqual(['plover']);
    expect(readFileSync(join(process.env.TILORI_HOME!, HEADERS_ALLOW), 'utf8')).not.toContain('wren');
  });

  test('a switch says which trusted owners were carried over (Bastion a14a227d); a first connect says nothing', async () => {
    expect((await connect()).out).not.toContain('Trusted owners');
    rmSync(process.env.TILORI_HOME!, { recursive: true, force: true });
    writeKey('wren', OLD_KEY);
    saveConfig({ url: 'https://tilori.example/mcp/tilori/v1', default_agent: 'wren', agents: { wren: {} }, trusted_owners: ['adrian', 'sam-lee'] });
    const r = await connect({ replace: true });
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      `Trusted owners carried over: adrian, sam-lee. They may be different people on 127.0.0.1:${http.port}; edit trusted_owners in ${join(process.env.TILORI_HOME!, 'config.json')} if not.`,
    );
    expect(loadConfig().trusted_owners).toEqual(['adrian', 'sam-lee']);
  });

  test("the printed shell lines stay one word per address, even with a ' in it (Pax 79689db1)", async () => {
    expect(shellWord('https://x.example/mcp/tilori/v1')).toBe('https://x.example/mcp/tilori/v1');
    expect(shellWord("https://x.example/a'b")).toBe(`'https://x.example/a'\\''b'`);
    const odd = `${tiloriUrl}#a'b c`;
    writeKey('wren', OLD_KEY);
    saveConfig({ url: 'https://tilori.example/mcp/tilori/v1', default_agent: 'wren' });
    const r = await connect({ url: odd });
    expect(r.code).toBe(1);
    // The words after the launcher (whose ~ the shell would expand).
    const line = r.out.slice(r.out.indexOf(LAUNCHER) + LAUNCHER.length + 1);
    const argv = Bun.spawnSync(['sh', '-c', `set -- ${line.replace(/\. @wren.*$/, '')}; printf '%s\\n' "$@"`]).stdout.toString().trim().split('\n');
    expect(argv).toEqual(['connect', '--url', new URL(odd).href, '--market-url', marketUrl, '--replace']);
  });

  test('the same deployment again needs no --replace (a new key for the agent)', async () => {
    expect((await connect()).code).toBe(0);
    const r = await connect();
    expect(r.code).toBe(0);
    expect(filesWith(KEY)).toEqual(['agents/plover.key']);
  });

  test("when the plugin can't be configured, it says the exact line to run, with the addresses only", async () => {
    const r = await connect({ configurePlugin: async () => 'failed' });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`echo '{"tilori_url":"${tiloriUrl}","market_url":"${marketUrl}"}' | claude plugin configure tilori@tilori-claude --values-stdin`);
    expect(r.out).not.toContain(KEY);
  });
});

describe('connect from the command line', () => {
  test('reads the key from stdin only: a key in argv is an error, and nothing prints the key', async () => {
    const bin = join(import.meta.dir, '..', 'bin', 'tilori-agent');
    const env = {
      HOME: process.env.HOME!,
      TILORI_HOME: process.env.TILORI_HOME!,
      // No claude here, so the plugin step fails and prints the line by hand.
      PATH: `${join(process.execPath, '..')}:/usr/bin:/bin`,
    };
    // Async, so this process's fake server can answer the child.
    const run = async (args: string[], stdin: string) => {
      const p = Bun.spawn([bin, ...args], { env, stdin: new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe' });
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      return { code: await p.exited, out: out + err };
    };
    const bad = await run(['connect', '--url', tiloriUrl, '--market-url', marketUrl, KEY], '');
    expect(bad.code).not.toBe(0);
    expect(bad.out).not.toContain(KEY);
    expect(existsSync(keyPath('plover'))).toBe(false);
    const ok = await run(['connect', '--url', tiloriUrl, '--market-url', marketUrl], KEY + '\n');
    expect(ok.out).toContain('✓ Connected @alice-chen.plover');
    expect(ok.out).toContain('claude plugin configure tilori@tilori-claude --values-stdin');
    expect(ok.out).not.toContain(KEY);
    expect(ok.code).toBe(0);
    expect(readFileSync(keyPath('plover'), 'utf8').trim()).toBe(KEY);
  }, 30_000);
});
