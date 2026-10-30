import './setup.ts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { writeKey } from '../src/keys.ts';
import { MAX_UPLOAD_BYTES, sniffMediaType, statusLine, upload } from '../src/upload.ts';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli.ts');
const ID = '0b7c6a52-3f1e-4d6a-9c1b-2f8e5d4a7b90';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const BODY_SECRET = 'body-text-that-must-never-print';

interface Seen {
  method: string;
  path: string;
  auth: string | null;
  type: string | null;
  body: Uint8Array;
}

/** A loopback sink that records every request and answers with `reply`. */
let sink: ReturnType<typeof Bun.serve>;
let seen: Seen[] = [];
let reply: () => Response | Promise<Response> = () => Response.json({ uploaded: true });
beforeAll(() => {
  sink = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      seen.push({
        method: req.method,
        path: u.pathname,
        auth: req.headers.get('authorization'),
        type: req.headers.get('content-type'),
        body: new Uint8Array(await req.arrayBuffer()),
      });
      return reply();
    },
  });
});
afterAll(() => sink.stop(true));

let root: string;
let home: string;
let key: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tilori-upload-test-'));
  home = join(root, 'tilori');
  process.env.TILORI_HOME = home;
  delete process.env.TILORI_AGENT;
  delete process.env.TILORI_URL;
  // Not key-shaped, so only the explicit redaction can hide it.
  key = `plainkey${randomBytes(16).toString('hex')}`;
  writeKey('wren', key);
  writeConfig(`http://127.0.0.1:${sink.port}/mcp/tilori/v1`);
  seen = [];
  reply = () => Response.json({ uploaded: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.TILORI_HOME;
});

function writeConfig(url: string): void {
  writeFileSync(join(home, 'config.json'), JSON.stringify({ url, default_agent: 'wren' }), { mode: 0o600 });
}

function file(name: string, bytes: Uint8Array | string = PNG): string {
  const p = join(root, name);
  writeFileSync(p, bytes);
  return p;
}

/** Runs the real CLI as its own process, as an agent's shell would. */
async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn([process.execPath, CLI, ...argv], {
    env: { HOME: root, TILORI_HOME: home, PATH: process.env.PATH ?? '' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  // Bastion 6: the key never reaches stdout or stderr, on any path.
  expect(out).not.toContain(key);
  expect(err).not.toContain(key);
  return { code, out, err };
}

describe('upload: what is sent', () => {
  test('a good run sends one PUT to the configured origin, with the key and octet-stream, and says the next step', async () => {
    const p = file('pic.png');
    const r = await cli('upload', ID, p, '--bytes', String(PNG.length));
    expect(r).toEqual({
      code: 0,
      out: `uploaded ${ID} (12 bytes); next: complete_attachment_upload, then put {{tum:attachment:${ID}}} in the post body\n`,
      err: '',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      method: 'PUT',
      path: `/api/v1/attachments/uploads/${ID}`,
      auth: `Bearer ${key}`,
      type: 'application/octet-stream',
      body: PNG,
    });
  });

  test('a redirect is refused and not followed: the sink sees one request', async () => {
    reply = () => new Response(null, { status: 302, headers: { Location: `http://127.0.0.1:${sink.port}/elsewhere` } });
    const r = await cli('upload', ID, file('a.png'), '--bytes', '12');
    expect(r.code).toBe(1);
    expect(r.err).toContain('redirect (302); not followed');
    expect(seen.map((s) => s.path)).toEqual([`/api/v1/attachments/uploads/${ID}`]);
  });

  test('a 403 prints its fixed line and nothing from the body', async () => {
    reply = () => Response.json({ code: 'PERMISSION_DENIED', message: BODY_SECRET }, { status: 403 });
    const r = await cli('upload', ID, file('a.png'), '--bytes', '12');
    expect(r).toEqual({
      code: 1,
      out: '',
      err: "tilori-agent: this id isn't open for upload (403): if you already ran upload for it, call complete_attachment_upload; otherwise prepare again with a new idempotency_key and upload the new id\n",
    });
  });

  test('every server status gets its own line, exit 1, and no body text', async () => {
    const lines: Record<number, string> = {
      401: 'refused by the server (401): check that this is your own attachment, prepared with this agent',
      404: 'no such upload: use the attachment_id that prepare_attachment_upload returned',
      409: 'already uploaded: go on to complete_attachment_upload',
      410: "this id isn't open for upload (410): if you already ran upload for it, call complete_attachment_upload; otherwise prepare again with a new idempotency_key and upload the new id",
      422: 'size differs from what was prepared; prepare again with the exact byte_size from tilori-agent file-info',
      500: 'the upload may not have finished (500): call complete_attachment_upload; if it says ATTACHMENT_NOT_READY, prepare again with a new idempotency_key and upload the new id',
      503: 'the upload may not have finished (503): call complete_attachment_upload; if it says ATTACHMENT_NOT_READY, prepare again with a new idempotency_key and upload the new id',
      418: 'unexpected status 418: tell your user',
    };
    for (const [status, line] of Object.entries(lines)) {
      seen = [];
      reply = () => new Response(BODY_SECRET, { status: Number(status) });
      const r = await cli('upload', ID, file('a.png'), '--bytes', '12');
      expect(r).toEqual({ code: 1, out: '', err: `tilori-agent: ${line}\n` });
      expect(seen).toHaveLength(1);
    }
  });

  test('no server at the origin: one line, exit 1', async () => {
    const closed = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
    const port = closed.port;
    closed.stop(true);
    writeConfig(`http://127.0.0.1:${port}/mcp/tilori/v1`);
    const r = await cli('upload', ID, file('a.png'), '--bytes', '12');
    expect(r.code).toBe(1);
    expect(r.err).toBe(
      'tilori-agent: the upload may not have finished (no response): call complete_attachment_upload; if it says ATTACHMENT_NOT_READY, prepare again with a new idempotency_key and upload the new id\n',
    );
  });

  test('a server that never answers is given up on at the timeout', async () => {
    let release!: () => void;
    reply = () => new Promise<Response>((r) => (release = () => r(new Response())));
    const r = await upload({
      origin: `http://127.0.0.1:${sink.port}`,
      id: ID,
      path: file('a.png'),
      bytes: 12,
      key: () => key,
      timeoutMs: 200,
    });
    release?.();
    expect(r).toEqual({
      code: 1,
      line: 'the upload may not have finished (no answer in 0.2 s): call complete_attachment_upload; if it says ATTACHMENT_NOT_READY, prepare again with a new idempotency_key and upload the new id',
    });
  });
});

describe('upload: refused locally, nothing sent (exit 2)', () => {
  async function refused(argv: string[], line: string): Promise<void> {
    const r = await cli(...argv);
    expect(r).toEqual({ code: 2, out: '', err: `tilori-agent: ${line}\n` });
    expect(seen).toHaveLength(0);
  }

  test('a symlink to the file', async () => {
    const link = join(root, 'link.png');
    symlinkSync(file('real.png'), link);
    await refused(['upload', ID, link, '--bytes', '12'], 'this is a symlink: pass the real file, not a link');
  });

  test('over 20 MiB', async () => {
    const p = file('big.bin', '');
    truncateSync(p, MAX_UPLOAD_BYTES + 1);
    await refused(['upload', ID, p, '--bytes', String(MAX_UPLOAD_BYTES)], "over 20 MiB; Tilori won't take it");
  });

  test('a size other than --bytes', async () => {
    await refused(
      ['upload', ID, file('a.png'), '--bytes', '13'],
      'the file is 12 bytes, not 13: use the byte_size from tilori-agent file-info',
    );
  });

  test('anything under the Tilori config dir, including through a symlinked parent', async () => {
    const msg = 'refusing to upload Tilori config or key files';
    await refused(['upload', ID, join(home, 'config.json'), '--bytes', '1'], msg);
    // O_NOFOLLOW covers only the last component: the real path comes from the fd.
    const dir = join(root, 'innocent');
    symlinkSync(join(home, 'agents'), dir);
    await refused(['upload', ID, join(dir, 'wren.key'), '--bytes', String(key.length + 1)], msg);
  });

  test('a copy of the key file outside the config dir', async () => {
    const p = file('notes.txt', `see ${key} here\n`);
    await refused(['upload', ID, p, '--bytes', String(key.length + 10)], 'this file contains your agent key; refusing');
  });

  test('a path that holds the key is redacted in the message', async () => {
    await refused(['upload', ID, join(root, key), '--bytes', '12'], `no such file: ${join(root, '[REDACTED]')}`);
  });

  test('a directory or a FIFO', async () => {
    await refused(['upload', ID, root, '--bytes', '0'], 'not a regular file: pass a file');
    const fifo = join(root, 'pipe');
    expect(Bun.spawnSync(['mkfifo', fifo]).exitCode).toBe(0);
    await refused(['upload', ID, fifo, '--bytes', '0'], 'not a regular file: pass a file');
  });

  test('a bad attachment id, a bad --bytes, or no --bytes', async () => {
    const p = file('a.png');
    await refused(['upload', 'not-a-uuid', p, '--bytes', '12'], 'attachment_id must be the UUID that prepare_attachment_upload returned');
    await refused(['upload', ID, p, '--bytes', '12.0'], '--bytes must be a whole number of bytes, at most 20 MiB');
    await refused(['upload', ID, p, '--bytes', String(MAX_UPLOAD_BYTES + 1)], "over 20 MiB; Tilori won't take it");
    await refused(['upload', ID, p], 'upload needs --bytes <n>: use the byte_size from tilori-agent file-info');
    await refused(['upload', ID, '--bytes', '12'], 'usage: tilori-agent upload <attachment_id> <file> --bytes <n>');
  });

  test('a config url that is http on a non-loopback host', async () => {
    writeConfig('http://example.com/mcp/tilori/v1');
    await refused(['upload', ID, file('a.png'), '--bytes', '12'], 'Tilori URL must use HTTPS (HTTP only for localhost).');
  });

  test('a wide key file fails closed before anything is sent', async () => {
    chmodSync(join(home, 'agents', 'wren.key'), 0o644);
    const r = await cli('upload', ID, file('a.png'), '--bytes', '12');
    expect(r.code).toBe(2);
    expect(r.err).toContain('is readable by other users');
    expect(seen).toHaveLength(0);
  });
});

describe('file-info', () => {
  test('prints byte_size and a media_type from the first bytes', async () => {
    expect(await cli('file-info', file('pic.png'))).toEqual({
      code: 0,
      out: '{"byte_size":12,"media_type":"image/png"}\n',
      err: '',
    });
    expect((await cli('file-info', file('empty', ''))).out).toBe('{"byte_size":0,"media_type":"application/octet-stream"}\n');
  });

  test('refuses what upload refuses about the file', async () => {
    const link = join(root, 'link');
    symlinkSync(file('x.png'), link);
    expect(await cli('file-info', link)).toEqual({
      code: 2,
      out: '',
      err: 'tilori-agent: this is a symlink: pass the real file, not a link\n',
    });
    expect((await cli('file-info', join(home, 'agents', 'wren.key'))).err).toBe(
      'tilori-agent: refusing to upload Tilori config or key files\n',
    );
  });

  test('sniffs common formats only', () => {
    const b = (...xs: (number | string)[]) =>
      new Uint8Array(xs.flatMap((x) => (typeof x === 'string' ? [...x].map((c) => c.charCodeAt(0)) : [x])));
    expect(sniffMediaType(b(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(sniffMediaType(b('GIF89a'))).toBe('image/gif');
    expect(sniffMediaType(b('RIFF', 0, 0, 0, 0, 'WEBP'))).toBe('image/webp');
    expect(sniffMediaType(b('RIFF', 0, 0, 0, 0, 'WAVE'))).toBe('application/octet-stream');
    expect(sniffMediaType(b('%PDF-1.7'))).toBe('application/pdf');
    expect(sniffMediaType(b('<svg'))).toBe('application/octet-stream');
  });
});

describe('statusLine', () => {
  test('any 2xx is success; any 3xx is refused', () => {
    expect(statusLine(204, ID, 3).code).toBe(0);
    expect(statusLine(307, ID, 3)).toEqual({
      code: 1,
      line: 'the server answered with a redirect (307); not followed, nothing sent there: tell your user',
    });
  });
});
