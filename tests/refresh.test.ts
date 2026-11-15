import './setup.ts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { saveConfig } from '../src/config.ts';
import { keyPath, readKey, writeKey, writePrivateFile } from '../src/keys.ts';
import { REFRESH_LINES, finishRefresh, oldKeyPath, refreshPath, runRefresh } from '../src/refresh.ts';
import { FakeTilori } from './fake-tilori.ts';
import { allowHome } from './allow-home.ts';

/**
 * Key refresh, tilori-agent half (UNI-938; server UNI-937, Bastion
 * ac87faf9): the current key asks, the owner approves, the new key is
 * checked and completes, the old one is revoked. No key is ever printed,
 * the current key only goes to the configured server, and `--refresh` is
 * refused while a `.old` backup shows an unfinished refresh.
 */

const OLD = 'mcp_sk_refresh_old_key_0123456789abcdef';
const NEW = 'mcp_sk_refresh_new_key_0123456789abcdef';
const TOKEN = 'claimtoken_0123456789abcdef0123456789abcdef';

type CompleteMode = 'ok' | 'nothing' | '500';
const state = {
  refreshStatus: 201,
  refreshCode: '',
  pendingPolls: 1,
  statusGone: false,
  complete: 'ok' as CompleteMode,
  profileHandle: 'keel',
  refreshAuth: [] as string[],
  completeAuth: [] as string[],
  statusCalls: 0,
  refreshes: 0,
  revoked: false,
};
const fake = new FakeTilori();
let http: ReturnType<typeof Bun.serve>;
let origin: string;
let home: string;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeAll(() => {
  http = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get('authorization') ?? '';
      if (url.pathname === '/api/v1/agents/refresh' && req.method === 'POST') {
        state.refreshes++;
        state.refreshAuth.push(auth);
        if (auth !== `Bearer ${OLD}`) return json(401, { code: 'AUTHENTICATION_REQUIRED', message: `no ${OLD}` });
        if (state.refreshStatus !== 201) return json(state.refreshStatus, { code: state.refreshCode, message: `body ${OLD}` });
        return json(201, {
          id: 'reg-r1',
          expires_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
          api_key: NEW,
          claim_url: `${origin}/claim?registration=reg-r1#claim=${TOKEN}`,
          status_url: '/api/v1/agents/status',
          complete_url: '/api/v1/agents/refresh/complete',
          poll_after_seconds: 5,
        });
      }
      if (url.pathname === '/api/v1/agents/status' && req.method === 'GET') {
        state.statusCalls++;
        if (auth !== `Bearer ${NEW}` || state.statusGone) return json(404, { code: 'NOT_FOUND' });
        if (state.statusCalls <= state.pendingPolls) return json(200, { status: 'pending', poll_after_seconds: 5 });
        return json(200, {
          status: 'claimed',
          agent_id: 'a1',
          connection_id: 'c2',
          handle: 'keel',
          urls: { tilori: `${origin}/mcp/tilori/v1`, market: `${origin}/mcp/v1` },
        });
      }
      if (url.pathname === '/api/v1/agents/refresh/complete' && req.method === 'POST') {
        state.completeAuth.push(auth);
        if (state.complete === '500') return new Response('boom', { status: 500 });
        if (state.complete === 'nothing') return json(200, { status: 'nothing_pending' });
        state.revoked = true;
        return json(200, { status: 'completed', revoked_key_id: 'k1' });
      }
      if (url.pathname === '/mcp/tilori/v1') {
        if (auth !== `Bearer ${NEW}` && auth !== `Bearer ${OLD}`) return new Response('no', { status: 401 });
        if (req.method === 'DELETE') return new Response(null, { status: 204 });
        const mcp = new Server({ name: 'fake-tilori', version: '1' }, { capabilities: { tools: {} } });
        mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
        mcp.setRequestHandler(CallToolRequestSchema, async (r) => {
          if (r.params.name === 'get_my_profile')
            fake.profile = {
              profile: { username: 'don-zheng', handle: state.profileHandle, id: 'a1', user_id: 'u1', kind: 'agent' },
              permissions: { create_posts: true, vote_on_posts: true },
            };
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
  home = mkdtempSync(join(tmpdir(), 'tilori-agent-refresh-'));
  process.env.TILORI_HOME = join(home, 'tilori');
  allowHome(process.env.TILORI_HOME);
  Object.assign(state, {
    refreshStatus: 201,
    refreshCode: '',
    pendingPolls: 1,
    statusGone: false,
    complete: 'ok',
    profileHandle: 'keel',
    refreshAuth: [],
    completeAuth: [],
    statusCalls: 0,
    refreshes: 0,
    revoked: false,
  });
  writeKey('keel', OLD);
  saveConfig({ url: `${origin}/mcp/tilori/v1`, default_agent: 'keel', agents: { keel: {} } });
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.TILORI_HOME;
});

async function refresh(handle = 'keel') {
  const out: string[] = [];
  const logs: string[] = [];
  let code: number | Error;
  try {
    code = await runRefresh({
      handle,
      noBrowser: true,
      out: (l) => void out.push(l),
      log: (m) => void logs.push(m),
      pollIntervalMs: 5,
      sleep: async () => {},
    });
  } catch (cause) {
    code = cause as Error;
  }
  const all = [...out, ...logs].join('\n');
  expect(all).not.toContain(OLD);
  expect(all).not.toContain(NEW);
  return { code, out, logs };
}
const mode = (p: string) => (statSync(p).mode & 0o777).toString(8);

describe('setup --refresh', () => {
  test('approved: switches to the checked new key, completes with it and removes the backup', async () => {
    const r = await refresh();
    expect(r.code).toBe(0);
    expect(r.out).toEqual([
      REFRESH_LINES.link('keel'),
      `${origin}/claim?registration=reg-r1#claim=${TOKEN}`,
      REFRESH_LINES.wait,
      REFRESH_LINES.done('keel'),
    ]);
    // The current key went only to the configured server's refresh route.
    expect(state.refreshAuth).toEqual([`Bearer ${OLD}`]);
    expect(state.completeAuth).toEqual([`Bearer ${NEW}`]);
    expect(readKey('keel')).toBe(NEW);
    expect(mode(keyPath('keel'))).toBe('600');
    expect(existsSync(oldKeyPath('keel'))).toBe(false);
    expect(existsSync(refreshPath('keel'))).toBe(false);
  });

  test('the pending refresh is private and a re-run resumes it without asking again', async () => {
    state.pendingPolls = 1000;
    const runs = runRefresh({
      handle: 'keel',
      noBrowser: true,
      out: () => {},
      log: () => {},
      deadlineMs: 0,
      sleep: async () => {},
    });
    expect(await runs).toBe(1);
    expect(mode(refreshPath('keel'))).toBe('600');
    expect(JSON.parse(readFileSync(refreshPath('keel'), 'utf8')).api_key).toBe(NEW);
    state.pendingPolls = 0;
    const r = await refresh();
    expect(r.code).toBe(0);
    expect(state.refreshes).toBe(1);
    expect(readKey('keel')).toBe(NEW);
  });

  test('a new key that fails its check is dropped and the old key kept', async () => {
    state.profileHandle = 'someone-else';
    const r = await refresh();
    expect(r.code).toBe(1);
    expect(r.out.at(-1)).toBe(REFRESH_LINES.kept('keel'));
    // The retry command is the plugin's form: --refresh first (Juniper a69c4f2a).
    for (const line of [REFRESH_LINES.kept('keel'), REFRESH_LINES.timeout('keel'), REFRESH_LINES.expired('keel')])
      expect(line).toContain('/universal-market:setup --refresh keel');
    expect(readKey('keel')).toBe(OLD);
    expect(existsSync(oldKeyPath('keel'))).toBe(false);
    expect(state.completeAuth).toEqual([]);
  });

  test('a failed complete keeps the backup; watch startup finishes it', async () => {
    state.complete = '500';
    const r = await refresh();
    expect(r.code).toBe(0);
    expect(r.out.at(-1)).toBe(REFRESH_LINES.doneLater('keel'));
    expect(readKey('keel')).toBe(NEW);
    expect(existsSync(oldKeyPath('keel'))).toBe(true);
    // A second refresh can't start over the backup (Bastion ac87faf9).
    const again = await refresh();
    expect(again.code).toBe(1);
    expect(again.out).toEqual([REFRESH_LINES.unfinished('keel')]);
    expect(state.refreshes).toBe(1);
    // At startup the monitor retries complete with the new key.
    state.complete = 'ok';
    expect(await finishRefresh('keel', { log: () => {} })).toBe(REFRESH_LINES.done('keel'));
    expect(state.revoked).toBe(true);
    expect(existsSync(oldKeyPath('keel'))).toBe(false);
    expect(await finishRefresh('keel', { log: () => {} })).toBeNull();
  });

  test('a backup equal to the key file (stopped before the switch) is dropped, not completed', async () => {
    writePrivateFile(oldKeyPath('keel'), OLD + '\n');
    expect(await finishRefresh('keel', { log: () => {} })).toBeNull();
    expect(existsSync(oldKeyPath('keel'))).toBe(false);
    expect(state.completeAuth).toEqual([]);
    // And a later --refresh is not refused over it.
    writePrivateFile(oldKeyPath('keel'), OLD + '\n');
    expect((await refresh()).code).toBe(0);
  });

  test('an expired refresh says the old key may still be active', async () => {
    writePrivateFile(oldKeyPath('keel'), OLD + '\n');
    writeKey('keel', NEW);
    state.complete = 'nothing';
    expect(await finishRefresh('keel', { log: () => {} })).toBe(REFRESH_LINES.oldMayLive('keel'));
    expect(existsSync(oldKeyPath('keel'))).toBe(false);
  });

  test('refusals are fixed words, and no key means no refresh', async () => {
    state.refreshStatus = 403;
    state.refreshCode = 'OPERATION_NOT_ALLOWED';
    let r = await refresh();
    expect((r.code as Error).message).toBe(REFRESH_LINES.pending('keel'));
    state.refreshStatus = 429;
    r = await refresh();
    expect((r.code as Error).message).toContain('rate-limiting');
    expect(existsSync(refreshPath('keel'))).toBe(false);
    r = await refresh('nobody');
    expect((r.code as Error).message).toBe(REFRESH_LINES.noKey('nobody'));
  });

  test('an expired approval link deletes the pending refresh', async () => {
    state.statusGone = true;
    const r = await refresh();
    expect(r.code).toBe(1);
    expect(r.out.at(-1)).toBe(REFRESH_LINES.expired('keel'));
    expect(existsSync(refreshPath('keel'))).toBe(false);
    expect(readKey('keel')).toBe(OLD);
  });
});
