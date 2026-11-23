import './setup.ts';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { THREAD_MAX_BODY_BYTES, THREAD_MAX_POSTS, THREAD_MAX_TITLE_BYTES, THREAD_MAX_TOTAL_BYTES } from '../src/cli.ts';
import { buildThreadPayload } from '../src/thread-post.ts';
import { TiloriAgentClient } from '../src/client.ts';
import { saveConfig } from '../src/config.ts';
import { writeKey } from '../src/keys.ts';
import { FakeTilori } from './fake-tilori.ts';
import { allowHome } from './allow-home.ts';

const KEY = 'mcp_sk_thread_post_test_key_0123456789';
const fake = new FakeTilori();
const authSeen: Array<string | null> = [];
let http: ReturnType<typeof Bun.serve>;
let url: string;
let workdir: string;
let tiloriDir: string;
let filesDir: string;
const cli = join(import.meta.dir, '../src/cli.ts');

const uuid = (n: number) => `${n.toString(16).padStart(8, '0')}-abcd-4000-8000-000000abcdef`;

beforeAll(() => {
  http = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      authSeen.push(req.headers.get('authorization'));
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
  workdir = mkdtempSync(join(tmpdir(), 'ta-thread-post-'));
  chmodSync(workdir, 0o700);
  tiloriDir = join(workdir, 'tilori');
  filesDir = join(workdir, 'files');
  mkdirSync(filesDir, { mode: 0o700 });
  allowHome(tiloriDir);
  process.env.TILORI_HOME = tiloriDir;
  writeKey('wren', KEY);
  saveConfig({ url, default_agent: 'wren', agents: { wren: {} } });
  delete process.env.TILORI_HOME;
});

afterAll(() => {
  http.stop(true);
  rmSync(workdir, { recursive: true, force: true });
});

async function runCli(args: string[], extraEnv: Record<string, string | undefined> = {}) {
  const env = { ...process.env, TILORI_HOME: tiloriDir, TILORI_AGENT: 'wren', ...extraEnv };
  const p = Bun.spawn(['bun', cli, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { stdout, stderr, exitCode };
}

function resetFake() {
  fake.calls.length = 0;
  fake.posts.clear();
  fake.searchPages.clear();
  fake.threadPages.clear();
  fake.searches.length = 0;
  fake.createdPosts.length = 0;
  fake.createPostResult = undefined;
  fake.createPostError = null;
  fake.toolErrors.clear();
  fake.postHangs = false;
  fake.searchHangs = false;
  fake.createPostHangs = false;
}

describe('get-thread', () => {
  test('reads root and paged replies, keeps only allowed fields, includes hidden/superseded_by', async () => {
    resetFake();
    const rootId = uuid(1);
    const r1 = uuid(2);
    const r2 = uuid(3);
    fake.posts.set(rootId, {
      id: rootId,
      parent_post_id: null,
      author: {
        id: 'a-wren',
        user_id: 'u1',
        kind: 'agent',
        username: 'don',
        handle: 'wren',
        email: 'secret@example.com',
        display_name: 'Wren',
        reputation: 99,
      },
      created_at: '2026-11-20T00:00:00.000Z',
      title: 'Root thread',
      body: 'Root body',
      workspace_id: 'ws-secret',
      attachment_urls: ['https://secret.example/att'],
      profile: { bio: 'secret' },
      revision: 2,
    });
    fake.posts.set(r1, {
      id: r1,
      parent_post_id: rootId,
      author: { id: 'a-pax', user_id: 'u2', kind: 'agent', username: 'don', handle: 'pax' },
      created_at: '2026-11-20T00:01:00.000Z',
      title: 'Reply 1',
      body: 'Full body 1',
      hidden: true,
    });
    fake.posts.set(r2, {
      id: r2,
      parent_post_id: rootId,
      author: { kind: 'human', username: 'don', handle: 'don' },
      created_at: '2026-11-20T00:02:00.000Z',
      title: 'Reply 2',
      body: 'Full body 2',
      superseded_by: uuid(99),
    });

    const pages = new Map<string, { items: unknown[]; next_cursor: string | null }>();
    // Server returns newest first across pages.
    pages.set('', {
      items: [
        { post: { id: r2, body_summary: 'summary 2' } },
        { post: { id: rootId, body_summary: 'summary' } }, // root in search results is deduplicated
      ],
      next_cursor: 'p2',
    });
    pages.set('p2', {
      items: [{ post: { id: r1, body_summary: 'summary 1' } }],
      next_cursor: null,
    });
    fake.threadPages.set(rootId, pages);

    const r = await runCli(['get-thread', rootId, '--json', '--agent', 'wren']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.split('\n').filter(Boolean)).toHaveLength(1);
    const out = JSON.parse(r.stdout);
    expect(out).toEqual({
      root_post_id: rootId,
      complete: true,
      posts: [
        {
          id: rootId,
          parent_post_id: null,
          author: { id: 'a-wren', user_id: 'u1', kind: 'agent', username: 'don', handle: 'wren' },
          created_at: '2026-11-20T00:00:00.000Z',
          title: 'Root thread',
          body: 'Root body',
        },
        {
          id: r1,
          parent_post_id: rootId,
          author: { id: 'a-pax', user_id: 'u2', kind: 'agent', username: 'don', handle: 'pax' },
          created_at: '2026-11-20T00:01:00.000Z',
          hidden: true,
          title: 'Reply 1',
          body: 'Full body 1',
        },
        {
          id: r2,
          parent_post_id: rootId,
          author: { id: null, user_id: null, kind: 'human', username: 'don', handle: 'don' },
          created_at: '2026-11-20T00:02:00.000Z',
          superseded_by: uuid(99),
          title: 'Reply 2',
          body: 'Full body 2',
        },
      ],
    });
    expect(fake.searches).toEqual([
      { root_post_id: rootId, max_depth: null, sort: 'created_at', limit: 100 },
      { root_post_id: rootId, max_depth: null, sort: 'created_at', limit: 100, cursor: 'p2' },
    ]);
    for (const forbidden of ['secret@example.com', 'ws-secret', 'attachment_urls', 'reputation', 'profile', 'display_name', 'revision', KEY]) {
      expect(r.stdout).not.toContain(forbidden);
    }
    expect(r.stderr).not.toContain(KEY);
  });

  test('45 replies over two pages newest first: keeps root + 39 newest in ascending order, complete=false, stops before page 2', async () => {
    resetFake();
    const rootId = uuid(100);
    fake.posts.set(rootId, { id: rootId, title: 'root', body: 'root', author: {}, created_at: '2026-11-20T00:00:00Z' });
    const page1: unknown[] = [];
    const page2: unknown[] = [];
    for (let i = 45; i >= 1; i--) {
      const id = uuid(100 + i);
      fake.posts.set(id, { id, parent_post_id: rootId, title: `t${i}`, body: `b${i}`, author: {}, created_at: `2026-11-20T00:${String(i).padStart(2, '0')}:00Z` });
      if (i >= 6) page1.push({ post: { id } });
      else page2.push({ post: { id } });
    }
    fake.threadPages.set(
      rootId,
      new Map([
        ['', { items: page1, next_cursor: 'p2' }],
        ['p2', { items: page2, next_cursor: null }],
      ]),
    );

    const r = await runCli(['get-thread', rootId, '--json', '--agent', 'wren']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.complete).toBe(false);
    expect(out.posts).toHaveLength(THREAD_MAX_POSTS);
    expect(out.posts[0].id).toBe(rootId);
    // Replies 1..6 dropped; newest 39 (7..45) kept in ascending created_at order.
    expect(out.posts.slice(1).map((p: any) => p.id)).toEqual(Array.from({ length: 39 }, (_, k) => uuid(107 + k)));
    // Second page must not be requested once >= 39 reply ids are collected.
    expect(fake.searches).toEqual([{ root_post_id: rootId, max_depth: null, sort: 'created_at', limit: 100 }]);
    // get_post called once for root + 39 times for kept replies = 40 total.
    expect(fake.calls.filter((c) => c === 'get_post')).toHaveLength(THREAD_MAX_POSTS);
  });

  test('10 replies on one page with no next_cursor: all kept in ascending order, complete=true', async () => {
    resetFake();
    const rootId = uuid(150);
    fake.posts.set(rootId, { id: rootId, title: 'root', body: 'root', author: {}, created_at: '2026-11-20T00:00:00Z' });
    const items: unknown[] = [];
    for (let i = 10; i >= 1; i--) {
      const id = uuid(150 + i);
      items.push({ post: { id } });
      fake.posts.set(id, { id, parent_post_id: rootId, title: `t${i}`, body: `b${i}`, author: {}, created_at: `2026-11-20T00:${String(i).padStart(2, '0')}:00Z` });
    }
    fake.threadPages.set(rootId, new Map([['', { items, next_cursor: null }]]));

    const r = await runCli(['get-thread', rootId, '--json', '--agent', 'wren']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.complete).toBe(true);
    expect(out.posts).toHaveLength(11);
    expect(out.posts[0].id).toBe(rootId);
    expect(out.posts.slice(1).map((p: any) => p.id)).toEqual(Array.from({ length: 10 }, (_, k) => uuid(151 + k)));
  });

  test('missing or unparseable created_at sorts first stably; exactly 39 on page 1 with next_cursor sets complete=false without fetching page 2', async () => {
    resetFake();
    const rootId = uuid(170);
    const bad1 = uuid(171);
    const bad2 = uuid(172);
    const oldReply = uuid(173);
    const newReply = uuid(174);
    fake.posts.set(rootId, { id: rootId, title: 'root', body: 'root', author: {}, created_at: '2026-11-20T00:00:00Z' });
    fake.posts.set(newReply, { id: newReply, parent_post_id: rootId, title: 'new', body: 'new', author: {}, created_at: '2026-11-20T00:05:00Z' });
    fake.posts.set(bad1, { id: bad1, parent_post_id: rootId, title: 'bad1', body: 'bad1', author: {}, created_at: 'not-a-date' });
    fake.posts.set(oldReply, { id: oldReply, parent_post_id: rootId, title: 'old', body: 'old', author: {}, created_at: '2026-11-20T00:01:00Z' });
    fake.posts.set(bad2, { id: bad2, parent_post_id: rootId, title: 'bad2', body: 'bad2', author: {} });
    fake.threadPages.set(
      rootId,
      new Map([['', { items: [{ post: { id: newReply } }, { post: { id: bad1 } }, { post: { id: oldReply } }, { post: { id: bad2 } }], next_cursor: null }]]),
    );

    const sorted = await runCli(['get-thread', rootId, '--json', '--agent', 'wren']);
    expect(sorted.exitCode).toBe(0);
    const sortedOut = JSON.parse(sorted.stdout);
    expect(sortedOut.complete).toBe(true);
    expect(sortedOut.posts.map((p: any) => p.id)).toEqual([rootId, bad1, bad2, oldReply, newReply]);

    resetFake();
    const root39 = uuid(180);
    fake.posts.set(root39, { id: root39, title: 'root', body: 'root', author: {}, created_at: '2026-11-20T00:00:00Z' });
    const page1: unknown[] = [];
    for (let i = 39; i >= 1; i--) {
      const id = uuid(180 + i);
      page1.push({ post: { id } });
      fake.posts.set(id, { id, parent_post_id: root39, title: `t${i}`, body: `b${i}`, author: {}, created_at: `2026-11-20T00:${String(i).padStart(2, '0')}:00Z` });
    }
    fake.threadPages.set(
      root39,
      new Map([
        ['', { items: page1, next_cursor: 'p2' }],
        ['p2', { items: [{ post: { id: uuid(230) } }], next_cursor: null }],
      ]),
    );
    const exact = await runCli(['get-thread', root39, '--json', '--agent', 'wren']);
    expect(exact.exitCode).toBe(0);
    const exactOut = JSON.parse(exact.stdout);
    expect(exactOut.complete).toBe(false);
    expect(exactOut.posts).toHaveLength(THREAD_MAX_POSTS);
    expect(fake.searches).toHaveLength(1);
  });

  test('body exceeding THREAD_MAX_BODY_BYTES is truncated on a UTF-8 char boundary and marked body_truncated', async () => {
    resetFake();
    const rootId = uuid(200);
    // 4-byte emoji repeated 2049 times = 8196 bytes > 8192 -> truncates to 2048 emoji = 8192 bytes, no broken surrogates.
    const emojiBody = '😀'.repeat(2049);
    // 3-byte char after 1 ASCII byte -> 8191 bytes + 3-byte char = 8194 bytes -> truncates to 8191 bytes.
    const replyId = uuid(201);
    const oddBody = 'a' + '中'.repeat(2731); // 1 + 8193 = 8194 bytes -> max 2730 CJK chars + 'a' = 8191 bytes
    fake.posts.set(rootId, { id: rootId, title: 'root', body: emojiBody, author: {}, created_at: '2026-11-20T00:00:00Z' });
    fake.posts.set(replyId, { id: replyId, parent_post_id: rootId, title: 'r', body: oddBody, author: {}, created_at: '2026-11-20T00:01:00Z' });
    fake.threadPages.set(rootId, new Map([['', { items: [{ post: { id: replyId } }], next_cursor: null }]]));

    const r = await runCli(['get-thread', rootId, '--json', '--agent', 'wren']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.complete).toBe(false);
    expect(out.posts[0].body_truncated).toBe(true);
    expect(Buffer.byteLength(out.posts[0].body, 'utf8')).toBe(THREAD_MAX_BODY_BYTES);
    expect(out.posts[0].body).toBe('😀'.repeat(2048));
    expect(out.posts[0].body).not.toContain('\uFFFD');

    expect(out.posts[1].body_truncated).toBe(true);
    expect(Buffer.byteLength(out.posts[1].body, 'utf8')).toBe(8191);
    expect(out.posts[1].body).toBe('a' + '中'.repeat(2730));
    expect(out.posts[1].body).not.toContain('\uFFFD');
  });

  test('total stdout exceeding THREAD_MAX_TOTAL_BYTES drops oldest replies (never root) and sets complete=false', async () => {
    resetFake();
    const rootId = uuid(300);
    fake.posts.set(rootId, { id: rootId, title: 'root', body: 'r'.repeat(8000), author: {}, created_at: '2026-11-20T00:00:00Z' });
    const items: unknown[] = [];
    for (let i = 39; i >= 1; i--) {
      const id = uuid(300 + i);
      items.push({ post: { id } });
      fake.posts.set(id, { id, parent_post_id: rootId, title: `t${i}`, body: 'x'.repeat(8000), author: {}, created_at: `2026-11-20T00:${String(i).padStart(2, '0')}:00Z` });
    }
    fake.threadPages.set(rootId, new Map([['', { items, next_cursor: null }]]));

    const r = await runCli(['get-thread', rootId, '--json', '--agent', 'wren']);
    expect(r.exitCode).toBe(0);
    expect(Buffer.byteLength(r.stdout, 'utf8')).toBeLessThanOrEqual(THREAD_MAX_TOTAL_BYTES);
    const out = JSON.parse(r.stdout);
    expect(out.complete).toBe(false);
    expect(out.posts[0].id).toBe(rootId);
    expect(out.posts.length).toBeLessThan(40);
    // Oldest reply (301) was dropped first; newest (339) stays last.
    expect(out.posts.some((p: any) => p.id === uuid(301))).toBe(false);
    expect(out.posts.at(-1).id).toBe(uuid(339));
  });

  test('repeated cursor stops paging with complete=false; refusals exit 2 with code only; bad inputs exit 1', async () => {
    resetFake();
    const rootId = uuid(400);
    fake.posts.set(rootId, { id: rootId, title: 'root', body: 'ok', author: {}, created_at: '2026-11-20T00:00:00Z' });
    fake.threadPages.set(
      rootId,
      new Map([
        ['', { items: [], next_cursor: 'c1' }],
        ['c1', { items: [], next_cursor: 'c1' }],
      ]),
    );
    const loop = await runCli(['get-thread', rootId, '--json', '--agent', 'wren']);
    expect(loop.exitCode).toBe(0);
    expect(JSON.parse(loop.stdout).complete).toBe(false);

    // Refused (missing root): exit 2, prints code only, not server message text.
    fake.toolErrors.set('get_post', { code: 'PERMISSION_DENIED', message: `secret server text ${KEY}` });
    const refused = await runCli(['get-thread', rootId, '--json', '--agent', 'wren']);
    expect(refused.exitCode).toBe(2);
    expect(refused.stdout).toBe('');
    expect(refused.stderr).toContain('PERMISSION_DENIED');
    expect(refused.stderr).not.toContain('secret server text');
    expect(refused.stderr).not.toContain(KEY);
    fake.toolErrors.clear();

    // Bad input exits 1 and sends nothing.
    process.env.TILORI_HOME = tiloriDir;
    writeKey('ghost-thread', KEY);
    delete process.env.TILORI_HOME;
    fake.calls.length = 0;
    const cases: Array<{ args: string[]; env?: Record<string, string | undefined>; expect: string }> = [
      { args: ['get-thread'], expect: 'get-thread needs a full post UUID.' },
      { args: ['get-thread', 'short', '--agent', 'wren'], expect: 'get-thread needs a full post UUID.' },
      { args: ['get-thread', rootId.toUpperCase(), '--agent', 'wren'], expect: 'get-thread needs a full post UUID.' },
      { args: ['get-thread', rootId, 'extra', '--agent', 'wren'], expect: 'Unexpected argument: extra' },
      { args: ['get-thread', rootId, '--url', url, '--agent', 'wren'], expect: 'get-thread: does not take --url.' },
      { args: ['get-thread', rootId, '--unknown', '--agent', 'wren'], expect: 'get-thread: does not take --unknown.' },
      // Missing --agent (even with TILORI_AGENT + default_agent set), empty --agent=, unknown / unconfigured --agent
      { args: ['get-thread', rootId, '--json'], env: { TILORI_AGENT: 'wren' }, expect: 'get-thread needs --agent <handle>.' },
      { args: ['get-thread', rootId, '--json', '--agent='], expect: 'get-thread needs --agent <handle>.' },
      { args: ['get-thread', rootId, '--json', '--agent', 'unknown'], expect: 'No agent "unknown" in config.json.' },
      { args: ['get-thread', rootId, '--json', '--agent', 'ghost-thread'], expect: 'No agent "ghost-thread" in config.json.' },
    ];
    for (const c of cases) {
      const bad = await runCli(c.args, c.env);
      expect({ args: c.args, code: bad.exitCode }).toEqual({ args: c.args, code: 1 });
      expect(bad.stdout).toBe('');
      expect(bad.stderr).toContain(c.expect);
      expect(bad.stderr).not.toContain(KEY);
    }
    expect(fake.calls).toEqual([]);
  });

  test('one refused reply is skipped and sets complete=false while keeping other replies', async () => {
    resetFake();
    const rootId = uuid(405);
    fake.posts.set(rootId, { id: rootId, title: 'root', body: 'root body', author: {}, created_at: '2026-11-20T00:00:00Z' });
    const replyIds: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const id = uuid(405 + i);
      replyIds.push(id);
      if (i !== 3) {
        fake.posts.set(id, {
          id,
          parent_post_id: rootId,
          title: `r${i}`,
          body: `body ${i}`,
          author: {},
          created_at: `2026-11-20T00:0${i}:00Z`,
        });
      }
    }
    // Reply 3 is missing from fake.posts so get_post returns NOT_FOUND (ToolRefused).
    fake.threadPages.set(
      rootId,
      new Map([['', { items: [...replyIds].reverse().map((id) => ({ post: { id } })), next_cursor: null }]]),
    );

    const r = await runCli(['get-thread', rootId, '--json', '--agent', 'wren']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.complete).toBe(false);
    expect(out.posts.map((p: any) => p.id)).toEqual([rootId, replyIds[0], replyIds[1], replyIds[3], replyIds[4]]);
    expect(out.posts.slice(1)).toHaveLength(4);
  });

  test('root caps: huge title, non-UUID superseded_by dropped, and root-only payload shrinks root body to fit', async () => {
    resetFake();
    const rootId = uuid(410);
    const badSupReplyId = uuid(411);
    const objSupReplyId = uuid(412);
    // 3-byte CJK chars: 341 * 3 = 1023 bytes <= 1024; 342 * 3 = 1026 > 1024.
    const hugeTitle = '中'.repeat(400);
    const hugeBody = 'b'.repeat(20_000);
    fake.posts.set(rootId, {
      id: rootId,
      title: hugeTitle,
      body: hugeBody,
      author: {},
      created_at: '2026-11-20T00:00:00Z',
      superseded_by: 'not-a-uuid',
    });
    fake.posts.set(badSupReplyId, {
      id: badSupReplyId,
      parent_post_id: rootId,
      title: 'r1',
      body: 'ok',
      author: {},
      created_at: '2026-11-20T00:01:00Z',
      superseded_by: uuid(99).toUpperCase(),
    });
    fake.posts.set(objSupReplyId, {
      id: objSupReplyId,
      parent_post_id: rootId,
      title: 'r2',
      body: 'ok',
      author: {},
      created_at: '2026-11-20T00:02:00Z',
      superseded_by: { id: uuid(99), title: 'newer' },
    });
    fake.threadPages.set(
      rootId,
      new Map([['', { items: [{ post: { id: badSupReplyId } }, { post: { id: objSupReplyId } }], next_cursor: null }]]),
    );

    const r = await runCli(['get-thread', rootId, '--json', '--agent', 'wren']);
    expect(r.exitCode).toBe(0);
    expect(Buffer.byteLength(r.stdout, 'utf8')).toBeLessThanOrEqual(THREAD_MAX_TOTAL_BYTES);
    const out = JSON.parse(r.stdout);
    expect(out.complete).toBe(false);
    expect(out.posts[0].title_truncated).toBe(true);
    expect(Buffer.byteLength(out.posts[0].title, 'utf8')).toBe(1023);
    expect(out.posts[0].title).toBe('中'.repeat(341));
    expect(out.posts[0].title).not.toContain('\uFFFD');
    expect(out.posts[0].body_truncated).toBe(true);
    expect(Buffer.byteLength(out.posts[0].body, 'utf8')).toBe(THREAD_MAX_BODY_BYTES);
    for (const p of out.posts) expect(p.superseded_by).toBeUndefined();

    // Even when root-only metadata + body exceeds THREAD_MAX_TOTAL_BYTES, root body is truncated further until it fits.
    resetFake();
    const oversizedRootId = uuid(415);
    fake.posts.set(oversizedRootId, {
      id: oversizedRootId,
      title: '中'.repeat(400),
      body: 'z'.repeat(12_000),
      author: { username: 'u'.repeat(258_000), handle: 'wren' },
      created_at: '2026-11-20T00:00:00Z',
    });
    fake.threadPages.set(oversizedRootId, new Map([['', { items: [], next_cursor: null }]]));
    const r2 = await runCli(['get-thread', oversizedRootId, '--json', '--agent', 'wren']);
    expect(r2.exitCode).toBe(0);
    expect(Buffer.byteLength(r2.stdout, 'utf8')).toBeLessThanOrEqual(THREAD_MAX_TOTAL_BYTES);
    const out2 = JSON.parse(r2.stdout);
    expect(out2.complete).toBe(false);
    expect(out2.posts[0].title_truncated).toBe(true);
    expect(Buffer.byteLength(out2.posts[0].title, 'utf8')).toBeLessThanOrEqual(THREAD_MAX_TITLE_BYTES);
    expect(out2.posts[0].body_truncated).toBe(true);
    expect(out2.posts[0].body.length).toBeLessThan(THREAD_MAX_BODY_BYTES);

    // Direct unit check with a tight maxTotalBytes.
    const compact = buildThreadPayload(
      oversizedRootId,
      { id: oversizedRootId, title: 'a'.repeat(2000), body: '中'.repeat(3000), author: {}, created_at: '2026-11-20T00:00:00Z' },
      [],
      { dropped: false, pagingComplete: true, maxTotalBytes: 1600 },
    );
    expect(Buffer.byteLength(compact, 'utf8')).toBeLessThanOrEqual(1600);
    const parsedCompact = JSON.parse(compact);
    expect(parsedCompact.complete).toBe(false);
    expect(parsedCompact.title_truncated).toBeUndefined();
    expect(parsedCompact.posts[0].title_truncated).toBe(true);
    expect(parsedCompact.posts[0].body_truncated).toBe(true);

    // Small maxTotalBytes with huge author username: cuts body, title, and author strings to fit, with complete: false.
    const hugeAuthor = buildThreadPayload(
      oversizedRootId,
      {
        id: oversizedRootId,
        title: 'short title',
        body: 'short body',
        author: { id: 'a1', user_id: 'u1', kind: 'agent', username: 'u'.repeat(2000), handle: 'wren' },
        created_at: '2026-11-20T00:00:00Z',
      },
      [],
      { dropped: false, pagingComplete: true, maxTotalBytes: 600 },
    );
    expect(Buffer.byteLength(hugeAuthor, 'utf8')).toBeLessThanOrEqual(600);
    const parsedHugeAuthor = JSON.parse(hugeAuthor);
    expect(parsedHugeAuthor.complete).toBe(false);
    expect(parsedHugeAuthor.posts[0].body_truncated).toBe(true);
    expect(parsedHugeAuthor.posts[0].title_truncated).toBe(true);
    expect(parsedHugeAuthor.posts[0].author.username).toBeNull();

    // Empty body already, but root-only payload still exceeds maxTotalBytes: complete must be false.
    const emptyBodyOverCap = buildThreadPayload(
      oversizedRootId,
      { id: oversizedRootId, title: 'a'.repeat(500), body: '', author: {}, created_at: '2026-11-20T00:00:00Z' },
      [],
      { dropped: false, pagingComplete: true, maxTotalBytes: 400 },
    );
    expect(Buffer.byteLength(emptyBodyOverCap, 'utf8')).toBeLessThanOrEqual(400);
    const parsedEmptyBody = JSON.parse(emptyBodyOverCap);
    expect(parsedEmptyBody.complete).toBe(false);
    expect(parsedEmptyBody.posts[0].title_truncated).toBe(true);
    expect(parsedEmptyBody.posts[0].body_truncated).toBeUndefined();
  });

  test('escapes DEL, C1 controls, bidi controls, and U+2028/U+2029 in JSON stdout while round-tripping', async () => {
    resetFake();
    const rootId = uuid(420);
    const tricky = 'safe\u007f\u0080\u009f\u061c\u200e\u200f\u2028\u2029\u202a\u202e\u2066\u2069end';
    fake.posts.set(rootId, {
      id: rootId,
      title: 'title\u202e',
      body: tricky,
      author: {},
      created_at: '2026-11-20T00:00:00Z',
    });
    fake.threadPages.set(rootId, new Map([['', { items: [], next_cursor: null }]]));

    const r = await runCli(['get-thread', rootId, '--json', '--agent', 'wren']);
    expect(r.exitCode).toBe(0);
    for (const seq of ['\\u007f', '\\u0080', '\\u009f', '\\u061c', '\\u200e', '\\u200f', '\\u2028', '\\u2029', '\\u202a', '\\u202e', '\\u2066', '\\u2069']) {
      expect(r.stdout).toContain(seq);
    }
    for (const ch of ['\u007f', '\u0080', '\u009f', '\u061c', '\u200e', '\u200f', '\u2028', '\u2029', '\u202a', '\u202e', '\u2066', '\u2069']) {
      expect(r.stdout).not.toContain(ch);
    }
    const out = JSON.parse(r.stdout);
    expect(out.posts[0].title).toBe('title\u202e');
    expect(out.posts[0].body).toBe(tricky);
  });
});

describe('create-post', () => {
  function writeInputFiles(titleText: string | Buffer, bodyText: string | Buffer, suffix = '') {
    const titlePath = join(filesDir, `title${suffix}.txt`);
    const bodyPath = join(filesDir, `body${suffix}.txt`);
    writeFileSync(titlePath, titleText);
    writeFileSync(bodyPath, bodyText);
    return { titlePath, bodyPath };
  }

  test('happy path sends exactly one create_post call with exact 4 args and prints {"id": "..."}', async () => {
    resetFake();
    const parentId = uuid(500);
    const createdId = uuid(501);
    fake.createPostResult = { id: createdId };
    const { titlePath, bodyPath } = writeInputFiles('  My Reply Title \n', '  Secret body content\nwith two lines  \n', '-ok');

    const r = await runCli([
      'create-post',
      '--parent',
      parentId,
      '--title-file',
      titlePath,
      '--body-file',
      bodyPath,
      '--idempotency-key',
      'wake_run-1:post.0',
      '--agent',
      'wren',
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.split('\n').filter(Boolean)).toHaveLength(1);
    expect(JSON.parse(r.stdout)).toEqual({ id: createdId });
    expect(fake.createdPosts).toEqual([
      {
        parent_post_id: parentId,
        title: 'My Reply Title',
        body: '  Secret body content\nwith two lines  \n',
        idempotency_key: 'wake_run-1:post.0',
      },
    ]);
    expect(Object.keys(fake.createdPosts[0]).sort()).toEqual(['body', 'idempotency_key', 'parent_post_id', 'title']);
    expect(r.stdout + r.stderr).not.toContain('My Reply Title');
    expect(r.stdout + r.stderr).not.toContain('Secret body content');
    expect(r.stdout + r.stderr).not.toContain(KEY);
  });

  test('router/call path cannot reach create_post', async () => {
    const c = new TiloriAgentClient({ url: new URL(url), apiKey: KEY });
    await expect(c.call('create_post' as any, { parent_post_id: uuid(1), title: 't', body: 'b', idempotency_key: '12345678' })).rejects.toThrow(
      'never calls',
    );
    await expect(c.call('search_posts' as any, { root_post_id: uuid(1) })).rejects.toThrow('never calls');
    await c.close();
  });

  test('needs_confirmation or missing id exits 2; ToolRefused exits 2 with code only', async () => {
    resetFake();
    const { titlePath, bodyPath } = writeInputFiles('Title', 'Body', '-refuse');
    const baseArgs = [
      'create-post',
      '--parent',
      uuid(510),
      '--title-file',
      titlePath,
      '--body-file',
      bodyPath,
      '--idempotency-key',
      'idem-key-1234',
      '--agent',
      'wren',
    ];

    fake.createPostResult = { status: 'needs_confirmation' };
    const nc = await runCli(baseArgs);
    expect(nc.exitCode).toBe(2);
    expect(nc.stdout).toBe('');
    expect(nc.stderr).toContain('create-post: Tilori did not create the post (needs_confirmation)');
    expect(nc.stderr).not.toContain(KEY);

    fake.createPostResult = { code: 'DUPLICATE_REQUEST' };
    const noId = await runCli(baseArgs);
    expect(noId.exitCode).toBe(2);
    expect(noId.stdout).toBe('');
    expect(noId.stderr).toContain('create-post: Tilori did not create the post (DUPLICATE_REQUEST)');

    fake.createPostResult = undefined;
    fake.createPostError = { code: 'RATE_LIMITED', message: `Too many posts secret ${KEY}` };
    const refused = await runCli(baseArgs);
    expect(refused.exitCode).toBe(2);
    expect(refused.stdout).toBe('');
    expect(refused.stderr).toContain('RATE_LIMITED');
    expect(refused.stderr).not.toContain('Too many posts');
    expect(refused.stderr).not.toContain(KEY);
  });

  test('refuses all bad inputs with exit 1 and sends nothing', async () => {
    resetFake();
    const parentId = uuid(600);
    const { titlePath: okTitle, bodyPath: okBody } = writeInputFiles('Valid title', 'Valid body', '-valid');
    // An agent with a key file on disk that is NOT listed in config.json must still be refused.
    process.env.TILORI_HOME = tiloriDir;
    writeKey('ghost', KEY);
    delete process.env.TILORI_HOME;

    const titleSymlink = join(filesDir, 'title-link.txt');
    const bodySymlink = join(filesDir, 'body-link.txt');
    symlinkSync(okTitle, titleSymlink);
    symlinkSync(okBody, bodySymlink);

    const fifoPath = join(filesDir, 'pipe.fifo');
    const mk = spawnSync('mkfifo', [fifoPath]);
    expect(mk.status).toBe(0);

    const dirPath = join(filesDir, 'adir');
    mkdirSync(dirPath);

    const bigTitle = join(filesDir, 'big-title.txt');
    writeFileSync(bigTitle, 'a'.repeat(641));
    const longCharTitle = join(filesDir, 'long-char-title.txt');
    writeFileSync(longCharTitle, 'a'.repeat(161));
    const blankTitle = join(filesDir, 'blank-title.txt');
    writeFileSync(blankTitle, '  \n\t  ');
    const badUtf8 = join(filesDir, 'bad-utf8.txt');
    writeFileSync(badUtf8, Buffer.from([0xff, 0xfe, 0xfd]));

    const bigBody = join(filesDir, 'big-body.txt');
    writeFileSync(bigBody, 'b'.repeat(20_001));
    // Multi-byte body: 7000 CJK chars (< 20000 chars, 21000 UTF-8 bytes > 20000 bytes).
    const multiByteBody = join(filesDir, 'multibyte-body.txt');
    writeFileSync(multiByteBody, '中'.repeat(7000));
    const emptyBody = join(filesDir, 'empty-body.txt');
    writeFileSync(emptyBody, '');
    const blankBody = join(filesDir, 'blank-body.txt');
    writeFileSync(blankBody, '  \n\t  ');

    const validKey = 'idem-key-1234';
    const cases: Array<{ args: string[]; env?: Record<string, string | undefined>; expect: string }> = [
      // Missing / bad parent UUID
      {
        args: ['create-post', '--title-file', okTitle, '--body-file', okBody, '--idempotency-key', validKey, '--agent', 'wren'],
        expect: 'needs a full --parent UUID',
      },
      {
        args: ['create-post', '--parent', 'bad', '--title-file', okTitle, '--body-file', okBody, '--idempotency-key', validKey, '--agent', 'wren'],
        expect: 'needs a full --parent UUID',
      },
      {
        args: ['create-post', '--parent', parentId.toUpperCase(), '--title-file', okTitle, '--body-file', okBody, '--idempotency-key', validKey, '--agent', 'wren'],
        expect: 'needs a full --parent UUID',
      },
      // Missing / short / long / bad-char idempotency key
      {
        args: ['create-post', '--parent', parentId, '--title-file', okTitle, '--body-file', okBody, '--agent', 'wren'],
        expect: 'needs --idempotency-key',
      },
      {
        args: ['create-post', '--parent', parentId, '--title-file', okTitle, '--body-file', okBody, '--idempotency-key', 'short7', '--agent', 'wren'],
        expect: 'needs --idempotency-key',
      },
      {
        args: ['create-post', '--parent', parentId, '--title-file', okTitle, '--body-file', okBody, '--idempotency-key', 'x'.repeat(201), '--agent', 'wren'],
        expect: 'needs --idempotency-key',
      },
      {
        args: ['create-post', '--parent', parentId, '--title-file', okTitle, '--body-file', okBody, '--idempotency-key', 'bad key!', '--agent', 'wren'],
        expect: 'needs --idempotency-key',
      },
      // Missing --agent (even with TILORI_AGENT + default_agent set), empty --agent=, and unknown --agent
      {
        args: ['create-post', '--parent', parentId, '--title-file', okTitle, '--body-file', okBody, '--idempotency-key', validKey],
        env: { TILORI_AGENT: 'wren' },
        expect: 'create-post needs --agent <handle>.',
      },
      {
        args: ['create-post', '--parent', parentId, '--title-file', okTitle, '--body-file', okBody, '--idempotency-key', validKey, '--agent='],
        expect: 'create-post needs --agent <handle>.',
      },
      {
        args: ['create-post', '--parent', parentId, '--title-file', okTitle, '--body-file', okBody, '--idempotency-key', validKey, '--agent', 'unknown'],
        expect: 'No agent "unknown" in config.json.',
      },
      {
        args: ['create-post', '--parent', parentId, '--title-file', okTitle, '--body-file', okBody, '--idempotency-key', validKey, '--agent', 'ghost'],
        expect: 'No agent "ghost" in config.json.',
      },
      // Relative path, symlinks, FIFO, directory
      {
        args: ['create-post', '--parent', parentId, '--title-file', 'relative.txt', '--body-file', okBody, '--idempotency-key', validKey, '--agent', 'wren'],
        expect: '--title-file must be an absolute path.',
      },
      {
        args: ['create-post', '--parent', parentId, '--title-file', titleSymlink, '--body-file', okBody, '--idempotency-key', validKey, '--agent', 'wren'],
        expect: '--title-file must not be a symlink.',
      },
      {
        args: ['create-post', '--parent', parentId, '--title-file', okTitle, '--body-file', bodySymlink, '--idempotency-key', validKey, '--agent', 'wren'],
        expect: '--body-file must not be a symlink.',
      },
      {
        args: ['create-post', '--parent', parentId, '--title-file', fifoPath, '--body-file', okBody, '--idempotency-key', validKey, '--agent', 'wren'],
        expect: '--title-file must be a regular file.',
      },
      {
        args: ['create-post', '--parent', parentId, '--title-file', okTitle, '--body-file', dirPath, '--idempotency-key', validKey, '--agent', 'wren'],
        expect: '--body-file must be a regular file.',
      },
      // Oversize, char limit, multi-byte > 20000 bytes, blank title/body, invalid UTF-8
      {
        args: ['create-post', '--parent', parentId, '--title-file', bigTitle, '--body-file', okBody, '--idempotency-key', validKey, '--agent', 'wren'],
        expect: '--title-file exceeds 640 bytes.',
      },
      {
        args: ['create-post', '--parent', parentId, '--title-file', longCharTitle, '--body-file', okBody, '--idempotency-key', validKey, '--agent', 'wren'],
        expect: '--title-file exceeds 160 characters.',
      },
      {
        args: ['create-post', '--parent', parentId, '--title-file', blankTitle, '--body-file', okBody, '--idempotency-key', validKey, '--agent', 'wren'],
        expect: '--title-file must not be blank.',
      },
      {
        args: ['create-post', '--parent', parentId, '--title-file', badUtf8, '--body-file', okBody, '--idempotency-key', validKey, '--agent', 'wren'],
        expect: '--title-file is not valid UTF-8.',
      },
      {
        args: ['create-post', '--parent', parentId, '--title-file', okTitle, '--body-file', bigBody, '--idempotency-key', validKey, '--agent', 'wren'],
        expect: '--body-file exceeds 20000 bytes.',
      },
      {
        args: ['create-post', '--parent', parentId, '--title-file', okTitle, '--body-file', multiByteBody, '--idempotency-key', validKey, '--agent', 'wren'],
        expect: '--body-file exceeds 20000 bytes.',
      },
      {
        args: ['create-post', '--parent', parentId, '--title-file', okTitle, '--body-file', emptyBody, '--idempotency-key', validKey, '--agent', 'wren'],
        expect: '--body-file must not be blank.',
      },
      {
        args: ['create-post', '--parent', parentId, '--title-file', okTitle, '--body-file', blankBody, '--idempotency-key', validKey, '--agent', 'wren'],
        expect: '--body-file must not be blank.',
      },
      {
        args: ['create-post', '--parent', parentId, '--title-file', okTitle, '--body-file', badUtf8, '--idempotency-key', validKey, '--agent', 'wren'],
        expect: '--body-file is not valid UTF-8.',
      },
      // Disallowed flags and positional args
      {
        args: ['create-post', '--parent', parentId, '--title-file', okTitle, '--body-file', okBody, '--idempotency-key', validKey, '--agent', 'wren', '--url', url],
        expect: 'create-post: does not take --url.',
      },
      {
        args: ['create-post', '--parent', parentId, '--title-file', okTitle, '--body-file', okBody, '--idempotency-key', validKey, '--agent', 'wren', '--host', 'x'],
        expect: 'Unexpected argument: x',
      },
      {
        args: ['create-post', '--parent', parentId, '--title-file', okTitle, '--body-file', okBody, '--idempotency-key', validKey, '--agent', 'wren', '--host=x'],
        expect: 'create-post: does not take --host.',
      },
      {
        args: ['create-post', '--parent', parentId, '--title-file', okTitle, '--body-file', okBody, '--idempotency-key', validKey, '--agent', 'wren', '--unknown'],
        expect: 'create-post: does not take --unknown.',
      },
      {
        args: ['create-post', 'extra', '--parent', parentId, '--title-file', okTitle, '--body-file', okBody, '--idempotency-key', validKey, '--agent', 'wren'],
        expect: 'Unexpected argument: extra',
      },
    ];

    for (const c of cases) {
      const r = await runCli(c.args, c.env);
      expect({ args: c.args, code: r.exitCode }).toEqual({ args: c.args, code: 1 });
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain(c.expect);
      expect(r.stderr).not.toContain(KEY);
    }
    expect(fake.createdPosts).toEqual([]);
  }, 60_000);

  test('refuses files under Tilori home and symlink-free files outside home containing the agent key', async () => {
    resetFake();
    const parentId = uuid(610);
    const { titlePath: okTitle, bodyPath: okBody } = writeInputFiles('Safe title', 'Safe body', '-keyguard');

    const homeFile = join(tiloriDir, 'inside.txt');
    writeFileSync(homeFile, 'harmless text inside tilori home');
    const configInHome = join(tiloriDir, 'config.json');
    const keyInHome = join(tiloriDir, 'agents', 'wren.key');

    for (const [flag, badPath] of [
      ['--title-file', homeFile],
      ['--body-file', homeFile],
      ['--title-file', configInHome],
      ['--body-file', keyInHome],
    ] as const) {
      const r = await runCli([
        'create-post',
        '--parent',
        parentId,
        '--title-file',
        flag === '--title-file' ? badPath : okTitle,
        '--body-file',
        flag === '--body-file' ? badPath : okBody,
        '--idempotency-key',
        'idem-home-guard-1',
        '--agent',
        'wren',
      ]);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain(`${flag}: refusing to read Tilori config or key files.`);
      expect(r.stderr).not.toContain(KEY);
    }

    const titleWithKey = join(filesDir, 'title-with-key.txt');
    const bodyWithKey = join(filesDir, 'body-with-key.txt');
    writeFileSync(titleWithKey, `hello ${KEY} world`);
    writeFileSync(bodyWithKey, `body\n${KEY}\nend`);

    for (const [flag, badPath] of [
      ['--title-file', titleWithKey],
      ['--body-file', bodyWithKey],
    ] as const) {
      const r = await runCli([
        'create-post',
        '--parent',
        parentId,
        '--title-file',
        flag === '--title-file' ? badPath : okTitle,
        '--body-file',
        flag === '--body-file' ? badPath : okBody,
        '--idempotency-key',
        'idem-key-guard-1',
        '--agent',
        'wren',
      ]);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain(`${flag} contains the agent key; refusing.`);
      expect(r.stdout + r.stderr).not.toContain(KEY);
    }

    expect(fake.createdPosts).toEqual([]);
  });
});

describe('both commands never print the key, Authorization header, or server body on transport errors', () => {
  test('transport error prints only status (or generic reachability) and never leaks key or server body', async () => {
    const leakHome = mkdtempSync(join(tmpdir(), 'ta-leak-'));
    chmodSync(leakHome, 0o700);
    const leakTilori = join(leakHome, 'tilori');
    allowHome(leakTilori);
    const bodyMarker = 'SERVER_BODY_TEXT_MUST_NOT_PRINT_12345';
    let replyStatus = 401;
    let jsonRpcErrorCode: number | null = null;
    const leakServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const auth = req.headers.get('authorization') ?? '';
        if (jsonRpcErrorCode !== null) {
          let reqId: unknown = 1;
          try {
            const parsed = (await req.json()) as { id?: unknown };
            if (parsed?.id !== undefined) reqId = parsed.id;
          } catch {}
          return new Response(
            JSON.stringify({ jsonrpc: '2.0', id: reqId, error: { code: jsonRpcErrorCode, message: bodyMarker } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ error: bodyMarker, echoed: auth, key: KEY }), { status: replyStatus });
      },
    });
    const leakUrl = `http://127.0.0.1:${leakServer.port}/mcp/tilori/v1`;
    process.env.TILORI_HOME = leakTilori;
    writeKey('wren', KEY);
    saveConfig({ url: leakUrl, default_agent: 'wren', agents: { wren: {} } });
    delete process.env.TILORI_HOME;

    const titlePath = join(leakHome, 't.txt');
    const bodyPath = join(leakHome, 'b.txt');
    writeFileSync(titlePath, 'Hello');
    writeFileSync(bodyPath, 'World');
    const cpArgs = [
      'create-post',
      '--parent',
      uuid(900),
      '--title-file',
      titlePath,
      '--body-file',
      bodyPath,
      '--idempotency-key',
      'idem-key-1234',
      '--agent',
      'wren',
    ];
    try {
      for (const status of [401, 502]) {
        replyStatus = status;
        const gt = await runCli(['get-thread', uuid(900), '--json', '--agent', 'wren'], { TILORI_HOME: leakTilori });
        expect(gt.exitCode).toBe(1);
        expect(gt.stdout).toBe('');
        expect(gt.stderr).toContain(`get-thread: could not reach Tilori (HTTP ${status}).`);
        expect(gt.stdout + gt.stderr).not.toContain(bodyMarker);
        expect(gt.stdout + gt.stderr).not.toContain(KEY);
        expect(gt.stdout + gt.stderr).not.toContain('mcp_sk_');
        expect(gt.stdout + gt.stderr).not.toContain('Bearer ');

        const cp = await runCli(cpArgs, { TILORI_HOME: leakTilori });
        expect(cp.exitCode).toBe(1);
        expect(cp.stdout).toBe('');
        expect(cp.stderr).toContain(`create-post: could not reach Tilori (HTTP ${status}).`);
        expect(cp.stdout + cp.stderr).not.toContain(bodyMarker);
        expect(cp.stdout + cp.stderr).not.toContain(KEY);
        expect(cp.stdout + cp.stderr).not.toContain('mcp_sk_');
        expect(cp.stdout + cp.stderr).not.toContain('Bearer ');
      }

      // Non-HTTP status (e.g. JSON-RPC -32001): prints plain reachability message with no number.
      jsonRpcErrorCode = -32001;
      const gtRpc = await runCli(['get-thread', uuid(900), '--json', '--agent', 'wren'], { TILORI_HOME: leakTilori });
      expect(gtRpc.exitCode).toBe(1);
      expect(gtRpc.stdout).toBe('');
      expect(gtRpc.stderr).toContain('get-thread: could not reach Tilori.');
      expect(gtRpc.stderr).not.toContain('HTTP ');
      expect(gtRpc.stderr).not.toContain('-32001');
      jsonRpcErrorCode = null;

      // Network failure (no HTTP status): prints generic reachability message only.
      leakServer.stop(true);
      const gtDown = await runCli(['get-thread', uuid(900), '--json', '--agent', 'wren'], { TILORI_HOME: leakTilori });
      expect(gtDown.exitCode).toBe(1);
      expect(gtDown.stdout).toBe('');
      expect(gtDown.stderr).toContain('get-thread: could not reach Tilori.');
      expect(gtDown.stderr).not.toContain('HTTP ');
      expect(gtDown.stdout + gtDown.stderr).not.toContain(KEY);

      const cpDown = await runCli(cpArgs, { TILORI_HOME: leakTilori });
      expect(cpDown.exitCode).toBe(1);
      expect(cpDown.stdout).toBe('');
      expect(cpDown.stderr).toContain('create-post: could not reach Tilori.');
      expect(cpDown.stderr).not.toContain('HTTP ');
      expect(cpDown.stdout + cpDown.stderr).not.toContain(KEY);
    } finally {
      leakServer.stop(true);
      rmSync(leakHome, { recursive: true, force: true });
    }
  });
});
