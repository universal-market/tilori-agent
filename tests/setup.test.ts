import './setup.ts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { main } from '../src/cli.ts';
import { configPath, loadConfig, saveConfig } from '../src/config.ts';
import { keyPath, writeKey } from '../src/keys.ts';
import {
  LINES,
  allowedUrl,
  awaitAgentKey,
  handleFromUser,
  pendingDir,
  pendingPath,
  pollClaim,
  readPending,
  register,
  runSetup,
  setupHandle,
  setupOrigin,
  writePending,
  type PendingRegistration,
} from '../src/setup.ts';
import { FakeTilori } from './fake-tilori.ts';
import { allowHome } from './allow-home.ts';

/**
 * Plugin part D (tilori-agent half): `setup` registers and prints the claim
 * link; `watch` polls status, writes the key and config and says "You're
 * live". Bastion's must-haves (54990447): the key is never printed on any
 * path, writes go through the private-file writer, the owner is named, the
 * handle is checked, the URLs must be https. Juniper's must-fixes
 * (10a431bf): no blocking wait, fixed copy, reuse without a prompt.
 */

const KEY = 'mcp_sk_setup_test_key_0123456789abcdef';
const TOKEN = 'claimtoken_0123456789abcdef0123456789abcdef';
const BODY_SECRET = 'server-said-this-in-the-body';

type RegisterMode = 'ok' | '400' | '403' | '500' | 'garbage' | 'hang' | 'claim-elsewhere' | 'status-elsewhere';
type StatusMode = 'pending-then-claimed' | 'gone' | 'bad-urls' | 'garbage-then-claimed' | '500-then-claimed' | 'bad-handle';
const state = {
  register: 'ok' as RegisterMode,
  status: 'pending-then-claimed' as StatusMode,
  pendingPolls: 2,
  claimedHandle: 'wren',
  registers: 0,
  statusCalls: 0,
  /** Bearer values the status route saw. */
  statusAuth: [] as string[],
  profile: { username: 'don-zheng', handle: 'wren' } as { username: unknown; handle: string },
  profileCalls: 0,
};
const fake = new FakeTilori();
let http: ReturnType<typeof Bun.serve>;
let origin: string;
let home: string;

beforeAll(() => {
  http = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/api/v1/agents/register' && req.method === 'POST') {
        state.registers++;
        const json = (status: number, body: unknown) =>
          new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
        const refused = (status: number, code: string) => json(status, { error: { code, message: `${BODY_SECRET} ${KEY}` } });
        switch (state.register) {
          case '400':
            return refused(400, 'INVALID_ARGUMENT');
          case '403':
            return refused(403, 'RESERVED_NAME');
          case '500':
            return new Response(`boom ${KEY}`, { status: 500 });
          case 'garbage':
            return new Response(`{not json ${KEY}`, { status: 201 });
          case 'hang':
            await new Promise((r) => setTimeout(r, 1500));
            return json(201, {});
        }
        const body = (await req.json()) as { handle: string; display_name: string };
        const claimBase = state.register === 'claim-elsewhere' ? 'https://evil.example' : origin;
        return json(201, {
          id: 'reg-1',
          expires_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
          api_key: KEY,
          claim_url: `${claimBase}/claim?registration=reg-1#claim=${TOKEN}`,
          status_url: state.register === 'status-elsewhere' ? 'https://evil.example/api/v1/agents/status' : '/api/v1/agents/status',
          poll_after_seconds: 5,
          handle: body.handle,
        });
      }
      if (url.pathname === '/api/v1/agents/status' && req.method === 'GET') {
        state.statusCalls++;
        state.statusAuth.push(req.headers.get('authorization') ?? '');
        if (req.headers.get('authorization') !== `Bearer ${KEY}`) {
          return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Registration unavailable or expired' } }), { status: 404 });
        }
        const claimed = (urls: { tilori: string; market: string }, handle = state.claimedHandle) =>
          new Response(JSON.stringify({ status: 'claimed', agent_id: 'a1', connection_id: 'c1', handle, urls }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        const own = { tilori: `${origin}/mcp/tilori/v1`, market: `${origin}/mcp/v1` };
        const n = state.statusCalls;
        switch (state.status) {
          case 'gone':
            return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: BODY_SECRET } }), { status: 404 });
          case 'bad-urls':
            return claimed({ tilori: 'http://evil.example/mcp/tilori/v1', market: 'http://evil.example/mcp/v1' });
          case 'bad-handle':
            return claimed(own, 'x; touch /tmp/p');
          case 'garbage-then-claimed':
            if (n === 1) return new Response(`<html>${KEY}`, { status: 200 });
            return claimed(own);
          case '500-then-claimed':
            if (n === 1) return new Response(`boom ${KEY}`, { status: 500 });
            return claimed(own);
        }
        if (n <= state.pendingPolls) {
          return new Response(JSON.stringify({ status: 'pending', poll_after_seconds: 5 }), { status: 200 });
        }
        return claimed(own);
      }
      if (url.pathname === '/mcp/tilori/v1') {
        if (req.headers.get('authorization') !== `Bearer ${KEY}`) return new Response(`no ${KEY}`, { status: 401 });
        if (req.method === 'DELETE') return new Response(null, { status: 204 });
        const mcp = new Server({ name: 'fake-tilori', version: '1' }, { capabilities: { tools: {} } });
        mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
        mcp.setRequestHandler(CallToolRequestSchema, async (r) => {
          if (r.params.name === 'get_my_profile') {
            state.profileCalls++;
            fake.profile = { profile: { ...state.profile, id: 'a1', user_id: 'u1', kind: 'agent' }, permissions: { create_posts: true, vote_on_posts: true } };
          }
          return (await fake.callTool({ name: r.params.name, arguments: (r.params.arguments ?? {}) as any })) as any;
        });
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        await mcp.connect(transport);
        return transport.handleRequest(req);
      }
      return new Response('not found', { status: 404 });
    },
  });
  origin = `http://127.0.0.1:${http.port}`;
});
afterAll(() => http.stop(true));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tilori-agent-setup-'));
  process.env.TILORI_HOME = join(home, 'tilori');
  allowHome(process.env.TILORI_HOME);
  process.env.TILORI_SOCKET = join(home, 'none.sock');
  delete process.env.TILORI_AGENT;
  delete process.env.TILORI_URL;
  Object.assign(state, {
    register: 'ok',
    status: 'pending-then-claimed',
    pendingPolls: 2,
    claimedHandle: 'wren',
    registers: 0,
    statusCalls: 0,
    statusAuth: [],
    profile: { username: 'don-zheng', handle: 'wren' },
    profileCalls: 0,
  });
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.TILORI_HOME;
  delete process.env.TILORI_SOCKET;
});

/** Runs the CLI in-process, capturing everything written to stdout and stderr. */
async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const saved = { log: console.log, error: console.error, out: process.stdout.write, err: process.stderr.write };
  const capture =
    (sink: string[]) =>
    (chunk: any, enc?: any, cb?: any): boolean => {
      sink.push(String(chunk));
      const done = typeof enc === 'function' ? enc : cb;
      done?.();
      return true;
    };
  console.log = (...a: unknown[]) => out.push(a.join(' ') + '\n');
  console.error = (...a: unknown[]) => err.push(a.join(' ') + '\n');
  process.stdout.write = capture(out) as any;
  process.stderr.write = capture(err) as any;
  try {
    return { code: await main(argv), out: out.join(''), err: err.join('') };
  } finally {
    console.log = saved.log;
    console.error = saved.error;
    process.stdout.write = saved.out;
    process.stderr.write = saved.err;
  }
}

const noSecret = (...texts: string[]) => {
  for (const t of texts) {
    expect(t).not.toContain(KEY);
    expect(t).not.toContain(BODY_SECRET);
  }
};
const mode = (p: string) => (statSync(p).mode & 0o777).toString(8);

/** A poller with a fast clock and no real waits. */
async function poll(handle: string, extra: Partial<Parameters<typeof pollClaim>[0]> = {}) {
  const lines: string[] = [];
  const logs: string[] = [];
  const outcome = await pollClaim({
    handle,
    write: (l) => void lines.push(l),
    log: (m) => void logs.push(m),
    pollIntervalMs: 10,
    ...extra,
  });
  return { outcome, lines, logs };
}

describe('setup: the command', () => {
  test('registers, prints the link on its own line and returns at once; the key is stored privately and never printed', async () => {
    const r = await cli('setup', 'wren', '--no-browser', '--url-origin', origin);
    expect(r.code).toBe(0);
    const lines = r.out.split('\n').filter(Boolean);
    expect(lines).toEqual([LINES.link('wren'), `${origin}/claim?registration=reg-1#claim=${TOKEN}`, LINES.wait]);
    expect(r.out).not.toContain('Creating');
    expect(r.out).not.toContain('Ctrl-C');
    noSecret(r.out, r.err);
    // The registration waits in a private file; the claim token is not in it.
    const p = pendingPath('wren');
    expect(mode(p)).toBe('600');
    expect(mode(pendingDir())).toBe('700');
    expect(mode(process.env.TILORI_HOME!)).toBe('700');
    const stored = readFileSync(p, 'utf8');
    expect(stored).toContain(KEY);
    expect(stored).not.toContain(TOKEN);
    expect(readPending('wren')).toMatchObject({ id: 'reg-1', handle: 'wren', api_key: KEY, status_url: `${origin}/api/v1/agents/status`, poll_after_seconds: 5 });
    expect(existsSync(keyPath('wren'))).toBe(false);
    expect(state.registers).toBe(1);
  });

  test('with no handle, derives one from the account name and says so before registering', async () => {
    const out: string[] = [];
    const code = await runSetup({ origin, noBrowser: true, user: 'Don Zheng', out: (l) => void out.push(l), log: () => {} });
    expect(code).toBe(0);
    expect(out[0]).toBe(LINES.creating('don-zheng'));
    expect(out[1]).toBe(LINES.link('don-zheng'));
    expect(existsSync(pendingPath('don-zheng'))).toBe(true);
  });

  test('handles from account names follow the rule or are refused', () => {
    expect(handleFromUser('Don Zheng')).toBe('don-zheng');
    expect(handleFromUser('zhaodongz2013062')).toBe('zhaodongz2013062');
    expect(handleFromUser('a')).toBeNull();
    expect(handleFromUser('')).toBeNull();
    expect(handleFromUser(undefined)).toBeNull();
    expect(handleFromUser('--_root_--')).toBe('root');
    expect(handleFromUser('x'.repeat(40))).toBe('x'.repeat(24));
  });

  test('an agent already set up here is reused with one line and no request', async () => {
    writeKey('wren', KEY);
    saveConfig({ url: `${origin}/mcp/tilori/v1`, default_agent: 'wren' });
    const named = await cli('setup', 'wren', '--no-browser', '--url-origin', origin);
    expect(named.code).toBe(0);
    expect(named.out.trim()).toBe(LINES.reuse('wren'));
    const bare = await cli('setup', '--no-browser', '--url-origin', origin);
    expect(bare.code).toBe(0);
    expect(bare.out.trim()).toBe(LINES.reuse('wren'));
    expect(state.registers).toBe(0);
    noSecret(named.out, named.err, bare.out, bare.err);
  });

  test('a 4xx is reported by status and code, never by the body (must-have 1)', async () => {
    state.register = '400';
    const r = await cli('setup', 'wren', '--no-browser', '--url-origin', origin);
    expect(r.code).toBe(1);
    expect(r.err).toContain('HTTP 400 INVALID_ARGUMENT');
    noSecret(r.out, r.err);
    expect(existsSync(pendingPath('wren'))).toBe(false);
    state.register = '403';
    const reserved = await cli('setup', 'wren', '--no-browser', '--url-origin', origin);
    expect(reserved.code).toBe(1);
    expect(reserved.err).toContain('reserved (HTTP 403 RESERVED_NAME)');
    noSecret(reserved.out, reserved.err);
  });

  test('a 5xx is reported by status, never by the body', async () => {
    state.register = '500';
    const r = await cli('setup', 'wren', '--no-browser', '--url-origin', origin);
    expect(r.code).toBe(1);
    expect(r.err).toContain('server error (HTTP 500)');
    noSecret(r.out, r.err);
    expect(existsSync(pendingPath('wren'))).toBe(false);
  });

  test('a non-JSON answer is reported without its text', async () => {
    state.register = 'garbage';
    const r = await cli('setup', 'wren', '--no-browser', '--url-origin', origin);
    expect(r.code).toBe(1);
    expect(r.err).toContain('not JSON (HTTP 201)');
    noSecret(r.out, r.err);
    expect(existsSync(pendingPath('wren'))).toBe(false);
  });

  test('no answer in time is a timeout, with nothing stored', async () => {
    state.register = 'hang';
    const out: string[] = [];
    const logs: string[] = [];
    await expect(
      runSetup({ handle: 'wren', origin, noBrowser: true, timeoutMs: 100, out: (l) => void out.push(l), log: (m) => void logs.push(m) }),
    ).rejects.toThrow(/did not answer the registration/);
    noSecret(out.join('\n'), logs.join('\n'));
    expect(existsSync(pendingPath('wren'))).toBe(false);
  });

  test('a claim link or status URL off the Tilori origin is refused', async () => {
    state.register = 'claim-elsewhere';
    const a = await cli('setup', 'wren', '--no-browser', '--url-origin', origin);
    expect(a.code).toBe(1);
    expect(a.err).toContain('claim link is not on the Tilori origin');
    expect(a.out).not.toContain('evil.example');
    state.register = 'status-elsewhere';
    const b = await cli('setup', 'wren', '--no-browser', '--url-origin', origin);
    expect(b.code).toBe(1);
    expect(b.err).toContain('status URL is not on the Tilori origin');
    expect(existsSync(pendingPath('wren'))).toBe(false);
    noSecret(a.out, a.err, b.out, b.err);
  });

  test('handles with shell metacharacters, spaces or the wrong shape exit 2 without being echoed (must-have 4)', async () => {
    for (const bad of ['x; touch /tmp/p', '$(id)', 'a b', 'wren;', '`id`', '-wren', 'wren-', 'a--b', 'a', 'w'.repeat(25), 'wren.don', 'w@ren', 'wrén']) {
      const r = await cli('setup', bad, '--no-browser', '--url-origin', origin);
      expect(r.code).toBe(2);
      expect(r.err).toContain('Agent handles are 2-24 characters');
      // A one-letter handle is bound to appear in any sentence; the rest must not.
      if (bad.length > 1) expect(r.err).not.toContain(bad);
      expect(r.out).toBe('');
    }
    expect(state.registers).toBe(0);
    expect(existsSync(pendingDir())).toBe(false);
    // Upper case folds, as on the server; nothing else does.
    expect(setupHandle('Wren')).toBe('wren');
    expect(setupHandle('  wren  ')).toBe('wren');
  });

  test('a display name is one visible line of at most 100 characters', async () => {
    for (const bad of ['', '   ', 'a\nb', 'x'.repeat(101), 'tab\there']) {
      const r = await cli('setup', 'wren', '--name', bad, '--no-browser', '--url-origin', origin);
      expect(r.code).toBe(2);
      expect(r.err).toContain('--name must be one line');
    }
    expect(state.registers).toBe(0);
  });

  test('--url-origin must be a bare https origin; http is for loopback only', () => {
    expect(setupOrigin(undefined).href).toBe('https://tilori.ai/');
    expect(setupOrigin('https://tilori.ai/').origin).toBe('https://tilori.ai');
    expect(setupOrigin(origin).origin).toBe(origin);
    for (const bad of ['http://tilori.ai', 'https://tilori.ai/path', 'https://u:p@tilori.ai', 'https://tilori.ai?x=1', 'ftp://tilori.ai', 'tilori.ai']) {
      expect(() => setupOrigin(bad)).toThrow();
    }
  });

  test('setup --help prints the usage and does nothing', async () => {
    const r = await cli('setup', '--help');
    expect(r.code).toBe(0);
    expect(r.out).toContain('tilori-agent setup [<handle>]');
    expect(state.registers).toBe(0);
  });
});

describe('watch: polling the claim', () => {
  async function registered(handle = 'wren') {
    const r = await cli('setup', handle, '--no-browser', '--url-origin', origin);
    expect(r.code).toBe(0);
  }

  test('polls until claimed, then writes the key and config privately and says who owns the agent (must-haves 2, 3, 5)', async () => {
    await registered();
    const { outcome, lines, logs } = await poll('wren');
    expect(outcome).toEqual({ result: 'claimed', handle: 'wren' });
    expect(lines).toEqual([LINES.live('don-zheng', 'wren') + LINES.server(new URL(origin).host)]);
    expect(lines[0]).toBe(
      "You're live as @don-zheng.wren on Tilori and Universal Market. Owned by don-zheng. " +
        'Not you? Disconnect it under Account → Agents and run /tilori:setup again. Paid Market actions are off.' +
        ` Server: ${new URL(origin).host}.`,
    );
    expect(state.statusCalls).toBe(3);
    expect(state.statusAuth.every((a) => a === `Bearer ${KEY}`)).toBe(true);
    expect(state.profileCalls).toBe(1);
    noSecret(lines.join('\n'), logs.join('\n'));
    // The key file and config.json, written by the same private writer as init.
    expect(readFileSync(keyPath('wren'), 'utf8')).toBe(KEY + '\n');
    expect(mode(keyPath('wren'))).toBe('600');
    expect(mode(join(process.env.TILORI_HOME!, 'agents'))).toBe('700');
    expect(mode(configPath())).toBe('600');
    expect(loadConfig()).toEqual({
      url: `${origin}/mcp/tilori/v1`,
      market_url: `${origin}/mcp/v1`,
      default_agent: 'wren',
      agents: { wren: {} },
    });
    // Nothing is left over.
    expect(existsSync(pendingPath('wren'))).toBe(false);
    expect(existsSync(join(process.env.TILORI_HOME!, 'agents', 'wren.key.tmp'))).toBe(false);
  });

  test('transient failures (a 5xx, a non-JSON body) are retried without printing anything', async () => {
    for (const m of ['500-then-claimed', 'garbage-then-claimed'] as const) {
      state.status = m;
      state.statusCalls = 0;
      await registered();
      const { outcome, lines, logs } = await poll('wren');
      expect(outcome.result).toBe('claimed');
      expect(lines).toHaveLength(1);
      noSecret(lines.join('\n'), logs.join('\n'));
      expect(logs.some((l) => /trying again/.test(l))).toBe(true);
      rmSync(keyPath('wren'));
    }
  });

  test('a registration the server no longer has ends with the expired line and no key (expired registration)', async () => {
    state.status = 'gone';
    await registered();
    const { outcome, lines, logs } = await poll('wren');
    expect(outcome).toEqual({ result: 'expired' });
    expect(lines).toEqual([LINES.expired('wren')]);
    expect(existsSync(keyPath('wren'))).toBe(false);
    expect(existsSync(pendingPath('wren'))).toBe(false);
    expect(existsSync(configPath())).toBe(false);
    noSecret(lines.join('\n'), logs.join('\n'));
  });

  test('no approval before the deadline ends with the timeout line (timeout)', async () => {
    state.pendingPolls = 1000;
    await registered();
    const { outcome, lines, logs } = await poll('wren', { deadlineMs: 60 });
    expect(outcome).toEqual({ result: 'timeout' });
    expect(lines).toEqual(["Didn't see an approval in 15 minutes. Run /tilori:setup again."]);
    expect(existsSync(keyPath('wren'))).toBe(false);
    expect(existsSync(pendingPath('wren'))).toBe(false);
    noSecret(lines.join('\n'), logs.join('\n'));
  });

  test("a registration's own expiry caps the wait", async () => {
    state.pendingPolls = 1000;
    await registered();
    const p = readPending('wren')!;
    writePending({ ...p, expires_at: new Date(Date.now() + 50).toISOString() });
    const { outcome, lines } = await poll('wren', { deadlineMs: 60_000 });
    expect(outcome).toEqual({ result: 'timeout' });
    expect(lines).toEqual([LINES.timeout]);
    expect(state.statusCalls).toBeLessThan(20);
  });

  test('claimed URLs that are not https are refused: no key, no config (must-have 5)', async () => {
    state.status = 'bad-urls';
    await registered();
    const { outcome, lines, logs } = await poll('wren');
    expect(outcome).toEqual({ result: 'unusable' });
    expect(lines).toEqual([LINES.unusable('wren', 'its server URLs are not https')]);
    expect(lines[0]).not.toContain('evil.example');
    expect(existsSync(keyPath('wren'))).toBe(false);
    expect(existsSync(configPath())).toBe(false);
    expect(existsSync(pendingPath('wren'))).toBe(false);
    noSecret(lines.join('\n'), logs.join('\n'));
  });

  test('loopback http is allowed only when the registration itself went to loopback http', () => {
    const prod = new URL('https://tilori.ai');
    const local = new URL(origin);
    expect(allowedUrl(new URL('https://x.convex.site/mcp/v1'), prod)).toBe(true);
    expect(allowedUrl(new URL('http://127.0.0.1:9/mcp/v1'), prod)).toBe(false);
    expect(allowedUrl(new URL('http://127.0.0.1:9/mcp/v1'), local)).toBe(true);
    expect(allowedUrl(new URL('http://evil.example/mcp/v1'), local)).toBe(false);
    expect(allowedUrl(new URL('https://u:p@x.convex.site/mcp/v1'), prod)).toBe(false);
  });

  test('a handle in the claimed answer that breaks the rule is refused', async () => {
    state.status = 'bad-handle';
    await registered();
    const { outcome, lines } = await poll('wren');
    expect(outcome).toEqual({ result: 'unusable' });
    expect(lines).toEqual([LINES.unusable('wren', 'the handle in it is invalid')]);
    expect(lines[0]).not.toContain('touch');
    expect(existsSync(join(process.env.TILORI_HOME!, 'agents'))).toBe(false);
  });

  test('the claim page may rename the agent: the key and config follow the claimed handle', async () => {
    state.claimedHandle = 'wren2';
    state.profile = { username: 'don-zheng', handle: 'wren2' };
    await registered('wren');
    const { outcome, lines } = await poll('wren');
    expect(outcome).toEqual({ result: 'claimed', handle: 'wren2' });
    expect(lines).toEqual([LINES.live('don-zheng', 'wren2') + LINES.server(new URL(origin).host)]);
    expect(existsSync(keyPath('wren2'))).toBe(true);
    expect(existsSync(keyPath('wren'))).toBe(false);
    expect(loadConfig().default_agent).toBe('wren2');
    expect(existsSync(pendingPath('wren'))).toBe(false);
  });

  test('a claimed handle that already has a key keeps that key (Bastion, tilori-agent#92)', async () => {
    state.claimedHandle = 'bastion';
    state.profile = { username: 'don-zheng', handle: 'bastion' };
    writeKey('bastion', 'mcp_sk_existing-working-key');
    await registered('newagent');
    const { outcome, lines } = await poll('newagent');
    expect(outcome).toEqual({ result: 'kept-existing' });
    expect(lines).toEqual([LINES.keyExists('bastion')]);
    expect(readFileSync(keyPath('bastion'), 'utf8')).toBe('mcp_sk_existing-working-key\n');
    expect(existsSync(pendingPath('newagent'))).toBe(false);
    expect(loadConfig().agents?.bastion).toBeUndefined();
    expect(lines[0]).not.toContain(KEY);
  });

  test('when the owner cannot be read, the line says so instead of inventing one', async () => {
    await registered();
    state.profile = { username: 'Not A Username; rm -rf', handle: 'wren' };
    const a = await poll('wren');
    expect(a.lines).toEqual([LINES.connected('wren') + LINES.server(new URL(origin).host)]);
    expect(a.lines[0]).not.toContain('rm -rf');
    rmSync(keyPath('wren'));
    await registered();
    state.profile = { username: 'don-zheng', handle: 'someone-else' };
    const b = await poll('wren');
    expect(b.lines).toEqual([LINES.connected('wren') + LINES.server(new URL(origin).host)]);
    expect(existsSync(keyPath('wren'))).toBe(true);
  });

  test('a config that already names another Tilori server is left alone, and the line says so', async () => {
    saveConfig({ url: 'https://internal.example/mcp/tilori/v1', market_url: 'https://internal.example/mcp/v1', default_agent: 'sol', agents: { sol: {} } });
    await registered();
    const { outcome, lines } = await poll('wren');
    expect(outcome.result).toBe('claimed');
    expect(lines[0]).toBe(LINES.live('don-zheng', 'wren') + LINES.server(new URL(origin).host) + LINES.otherServer);
    expect(loadConfig()).toEqual({
      url: 'https://internal.example/mcp/tilori/v1',
      market_url: 'https://internal.example/mcp/v1',
      default_agent: 'sol',
      agents: { sol: {}, wren: {} },
    });
    expect(existsSync(keyPath('wren'))).toBe(true);
  });

  test('a default agent already set is kept; the new agent is added', async () => {
    writeKey('sol', 'mcp_sk_other_key_0123456789');
    saveConfig({ url: `${origin}/mcp/tilori/v1`, market_url: `${origin}/mcp/v1`, default_agent: 'sol', agents: { sol: {} } });
    await registered();
    await poll('wren');
    expect(loadConfig().default_agent).toBe('sol');
    expect(Object.keys(loadConfig().agents!)).toEqual(['sol', 'wren']);
  });

  test('a pending file removed by hand stops the poll quietly; a replaced one is followed', async () => {
    state.pendingPolls = 1000;
    await registered();
    const a = await poll('wren', {
      sleep: async () => {
        rmSync(pendingPath('wren'));
      },
    });
    expect(a.outcome).toEqual({ result: 'no-file' });
    expect(a.lines).toEqual([]);
    // Replaced: setup ran again with a new registration.
    await registered();
    let swapped = false;
    const b = await poll('wren', {
      sleep: async () => {
        if (swapped) return;
        swapped = true;
        const p = readPending('wren')!;
        writePending({ ...p, id: 'reg-2' });
        state.pendingPolls = 0;
      },
    });
    expect(b.outcome.result).toBe('claimed');
    expect(b.logs.some((l) => /replaced the one being watched/.test(l))).toBe(true);
  });

  test('a cancelled poll leaves the pending file for the next watch', async () => {
    state.pendingPolls = 1000;
    await registered();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    const { outcome, lines } = await poll('wren', { signal: ac.signal });
    expect(outcome).toEqual({ result: 'cancelled' });
    expect(lines).toEqual([]);
    expect(existsSync(pendingPath('wren'))).toBe(true);
  });
});

describe('watch: waiting for a key', () => {
  test('with neither a key nor a registration it waits; setup makes it go live without a restart', async () => {
    const lines: string[] = [];
    const logs: string[] = [];
    let ticks = 0;
    const agent = awaitAgentKey({
      write: (l) => void lines.push(l),
      log: (m) => void logs.push(m),
      pollIntervalMs: 10,
      waitMs: 10,
      sleep: async (ms) => {
        ticks++;
        if (ticks === 3) {
          const r = await cli('setup', 'wren', '--no-browser', '--url-origin', origin);
          expect(r.code).toBe(0);
        }
        await new Promise((r) => setTimeout(r, ms));
      },
    });
    expect(await agent).toBe('wren');
    expect(lines).toEqual([LINES.live('don-zheng', 'wren') + LINES.server(new URL(origin).host)]);
    expect(logs.filter((l) => /waiting for tilori-agent setup/.test(l))).toHaveLength(1);
    noSecret(lines.join('\n'), logs.join('\n'));
  });

  test('an explicit agent with a key is returned at once; one without waits for its own registration', async () => {
    writeKey('sol', 'mcp_sk_other_key_0123456789');
    expect(await awaitAgentKey({ explicit: 'sol', write: () => {}, log: () => {} })).toBe('sol');
    // A pending registration for another handle is not this session's.
    const r = await cli('setup', 'wren', '--no-browser', '--url-origin', origin);
    expect(r.code).toBe(0);
    const ac = new AbortController();
    let ticks = 0;
    const agent = await awaitAgentKey({
      explicit: 'juniper',
      write: () => {},
      log: () => {},
      signal: ac.signal,
      sleep: async () => {
        if (++ticks >= 2) ac.abort();
      },
    });
    expect(agent).toBeNull();
    expect(state.statusCalls).toBe(0);
    expect(existsSync(pendingPath('wren'))).toBe(true);
  });

  test('after a timeout it keeps waiting for the next setup', async () => {
    state.pendingPolls = 1000;
    const r = await cli('setup', 'wren', '--no-browser', '--url-origin', origin);
    expect(r.code).toBe(0);
    const lines: string[] = [];
    const ac = new AbortController();
    let ticks = 0;
    const agent = await awaitAgentKey({
      write: (l) => void lines.push(l),
      log: () => {},
      pollIntervalMs: 5,
      deadlineMs: 20,
      signal: ac.signal,
      sleep: async (ms) => {
        // The poller's own sleeps and the wait-for-setup sleeps share this.
        if (ms >= 10_000) {
          if (++ticks >= 2) ac.abort();
          return;
        }
        await new Promise((r) => setTimeout(r, ms));
      },
    });
    expect(agent).toBeNull();
    expect(lines).toEqual([LINES.timeout]);
    expect(existsSync(pendingPath('wren'))).toBe(false);
  });

  test('the monitor process prints the live line first, then watches, with no key on stderr', async () => {
    const r = await cli('setup', 'wren', '--no-browser', '--url-origin', origin);
    expect(r.code).toBe(0);
    state.pendingPolls = 0;
    const cliPath = join(import.meta.dir, '../src/cli.ts');
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    delete env.TILORI_AGENT;
    const p = Bun.spawn(['bun', cliPath, 'watch', '--notify-lines', '--wait-ms', '50'], { env, stdout: 'pipe', stderr: 'pipe' });
    const reader = p.stdout.getReader();
    let got = '';
    const deadline = Date.now() + 15_000;
    while (!got.includes('\n') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      got += new TextDecoder().decode(value);
    }
    p.kill();
    await p.exited;
    const err = await new Response(p.stderr).text();
    expect(got.split('\n')[0]).toBe(LINES.live('don-zheng', 'wren') + LINES.server(new URL(origin).host));
    noSecret(got, err);
    expect(readFileSync(keyPath('wren'), 'utf8')).toBe(KEY + '\n');
    expect(err).toContain('watching Tilori directly for wren');
  });
});

describe('private writes', () => {
  test('a symlinked key, pending or config target is refused (must-have 2)', async () => {
    const tilori = process.env.TILORI_HOME!;
    mkdirSync(join(tilori, 'agents'), { recursive: true, mode: 0o700 });
    mkdirSync(pendingDir(), { recursive: true, mode: 0o700 });
    const elsewhere = join(home, 'elsewhere');
    writeFileSync(elsewhere, 'untouched\n');
    symlinkSync(elsewhere, keyPath('wren'));
    expect(() => writeKey('wren', KEY)).toThrow(/must not be a symlink/);
    symlinkSync(elsewhere, pendingPath('wren'));
    const p: PendingRegistration = {
      id: 'reg-1',
      handle: 'wren',
      api_key: KEY,
      status_url: `${origin}/api/v1/agents/status`,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      poll_after_seconds: 5,
      origin,
      created_at: new Date().toISOString(),
    };
    expect(() => writePending(p)).toThrow(/must not be a symlink/);
    symlinkSync(elsewhere, configPath());
    expect(() => saveConfig({ url: `${origin}/mcp/tilori/v1` })).toThrow(/must not be a symlink/);
    // A dangling link is a link too.
    rmSync(keyPath('wren'));
    symlinkSync(join(home, 'missing'), keyPath('wren'));
    expect(() => writeKey('wren', KEY)).toThrow(/must not be a symlink/);
    expect(readFileSync(elsewhere, 'utf8')).toBe('untouched\n');
    expect(lstatSync(keyPath('wren')).isSymbolicLink()).toBe(true);
    // And a symlinked pending file is never read.
    rmSync(pendingPath('wren'));
    symlinkSync(elsewhere, pendingPath('wren'));
    expect(() => readPending('wren')).toThrow(/must not be a symlink/);
  });

  test('a pending file with a status URL off its origin, or readable by others, is refused', async () => {
    const r = await cli('setup', 'wren', '--no-browser', '--url-origin', origin);
    expect(r.code).toBe(0);
    const p = readPending('wren')!;
    writeFileSync(pendingPath('wren'), JSON.stringify({ ...p, status_url: 'https://evil.example/api/v1/agents/status' }), { mode: 0o600 });
    expect(() => readPending('wren')).toThrow(/off its origin/);
    const { outcome, lines, logs } = await poll('wren');
    expect(outcome).toEqual({ result: 'no-file' });
    expect(lines).toEqual([]);
    expect(state.statusCalls).toBe(0);
    noSecret(logs.join('\n'));
    writeFileSync(pendingPath('wren'), JSON.stringify(p));
    chmodSync(pendingPath('wren'), 0o644);
    expect(() => readPending('wren')).toThrow(/readable by other users/);
  });

  test('register itself never throws the body', async () => {
    state.register = '500';
    const logs: string[] = [];
    await expect(register({ origin: new URL(origin), handle: 'wren', displayName: 'Wren' })).rejects.toThrow(/HTTP 500/);
    noSecret(logs.join('\n'));
  });
});
