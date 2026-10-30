import { closeSync, constants, fstatSync, openSync, readlinkSync, readSync, realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { redact, tiloriHome } from './keys.ts';

/**
 * `tilori-agent upload` and `file-info` (UNI-505, design 16142b7b with
 * Bastion's notes in d99c0039 and Juniper's in d8abecf0).
 *
 * Agents never hold their key, so they can't make the authenticated PUT that
 * the shared attachment flow needs. This does it in-process:
 *   - the target is the configured Tilori origin plus a fixed path and a
 *     UUID; `upload_url` from the server is never used;
 *   - exactly one request, no retries, redirects refused, 60 s timeout;
 *   - the key goes only into the Authorization header, and every message
 *     passes through `redact` with it; nothing from the response body is
 *     printed;
 *   - the file is opened O_NOFOLLOW, checked with fstat on the same fd, and
 *     its real path (from the fd) must be outside the Tilori config dir.
 */

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const UPLOAD_TIMEOUT_MS = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A refusal before anything was sent (exit 2). */
export class LocalRefusal extends Error {}

export interface OpenedFile {
  bytes: Uint8Array<ArrayBuffer>;
  size: number;
}

/** The real path of an open fd: /proc on Linux, else realpath of what was
 * opened (macOS has no /proc; the key-bytes scan still backs this up). */
function fdPath(fd: number, path: string): string {
  try {
    return readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    return realpathSync(path);
  }
}

function realHome(): string {
  const home = tiloriHome();
  try {
    return realpathSync(home);
  } catch {
    return home;
  }
}

/** Opens `path` for upload and reads it whole from the same fd. Refuses
 * symlinks, anything but a regular file, files over 20 MiB and anything
 * under the Tilori config dir. */
export function readUploadFile(path: string): OpenedFile {
  let fd: number;
  try {
    // O_NONBLOCK so a FIFO can't hang the open; it has no effect on a regular file.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK') throw new LocalRefusal('this is a symlink: pass the real file, not a link');
    if (code === 'ENOENT') throw new LocalRefusal(`no such file: ${path}`);
    if (code === 'EACCES') throw new LocalRefusal(`can't read ${path}: permission denied`);
    throw new LocalRefusal(`can't open ${path} (${code ?? 'error'})`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new LocalRefusal('not a regular file: pass a file');
    const real = fdPath(fd, path);
    const home = realHome();
    if (real === home || real.startsWith(home + sep)) throw new LocalRefusal('refusing to upload Tilori config or key files');
    if (st.size > MAX_UPLOAD_BYTES) throw new LocalRefusal("over 20 MiB; Tilori won't take it");
    const bytes = new Uint8Array(st.size);
    let read = 0;
    while (read < st.size) {
      const n = readSync(fd, bytes, read, st.size - read, null);
      if (n === 0) break;
      read += n;
    }
    if (read !== st.size) throw new LocalRefusal('the file changed while it was read; run the command again');
    return { bytes, size: st.size };
  } finally {
    closeSync(fd);
  }
}

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** Media type from the first bytes, for common formats only. */
export function sniffMediaType(b: Uint8Array): string {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(b, ascii('GIF87a')) || startsWith(b, ascii('GIF89a'))) return 'image/gif';
  if (startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WEBP'), 8)) return 'image/webp';
  if (startsWith(b, ascii('%PDF-'))) return 'application/pdf';
  return 'application/octet-stream';
}

/** `file-info`: what to pass to prepare_attachment_upload. */
export function fileInfo(path: string): { byte_size: number; media_type: string } {
  const f = readUploadFile(path);
  return { byte_size: f.size, media_type: sniffMediaType(f.bytes) };
}

/** Parses `--bytes`: a whole number from 0 to 20 MiB. */
export function parseBytes(raw: string | undefined): number {
  if (raw === undefined) throw new LocalRefusal('upload needs --bytes <n>: use the byte_size from tilori-agent file-info');
  if (!/^\d{1,9}$/.test(raw) || Number(raw) > MAX_UPLOAD_BYTES) {
    throw new LocalRefusal("--bytes must be a whole number of bytes, at most 20 MiB");
  }
  return Number(raw);
}

export function uploadTarget(origin: string, id: string): URL {
  if (!UUID.test(id)) throw new LocalRefusal('attachment_id must be the UUID that prepare_attachment_upload returned');
  return new URL(`/api/v1/attachments/uploads/${id}`, origin);
}

function contains(hay: Uint8Array, needle: Uint8Array): boolean {
  if (!needle.length) return false;
  return Buffer.from(hay.buffer, hay.byteOffset, hay.byteLength).includes(Buffer.from(needle));
}

export interface UploadResult {
  code: 0 | 1 | 2;
  /** One line for the agent: stdout on success, stderr otherwise. */
  line: string;
}

/** The line for a server answer. Nothing from the response body is used. */
export function statusLine(status: number, id: string, size: number): UploadResult {
  if (status >= 200 && status < 300) {
    return {
      code: 0,
      line: `uploaded ${id} (${size} bytes); next: complete_attachment_upload, then put {{tum:attachment:${id}}} in the post body`,
    };
  }
  const refused = (line: string): UploadResult => ({ code: 1, line });
  if (status >= 300 && status < 400) return refused(`the server answered with a redirect (${status}); not followed, nothing sent there: tell your user`);
  if (status === 401 || status === 403) {
    return refused(`refused by the server (${status}): check that this is your own attachment, prepared with this agent`);
  }
  if (status === 404) return refused('no such upload: use the attachment_id that prepare_attachment_upload returned');
  if (status === 409) return refused('already uploaded: go on to complete_attachment_upload');
  if (status === 410) return refused('the upload expired; prepare again with a new idempotency_key');
  if (status === 422) {
    return refused('size differs from what was prepared; prepare again with the exact byte_size from tilori-agent file-info');
  }
  if (status >= 500) return refused(serverError(String(status)));
  return refused(`unexpected status ${status}: tell your user`);
}

const serverError = (what: string) =>
  `server error (${what}), nothing was stored: run the same command once more; if it fails again, tell your user`;

export interface UploadOptions {
  /** `keyUrl(config).origin`: the only place the key may go. */
  origin: string;
  id: string;
  path: string;
  bytes: number;
  /** Read before the file is opened, so every message can be redacted with it. */
  key: () => string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Runs one upload. Never throws: every outcome is a code and one line,
 * already redacted. */
export async function upload(o: UploadOptions): Promise<UploadResult> {
  let key = '';
  const done = (r: UploadResult): UploadResult => ({ code: r.code, line: redact(r.line, [key]) });
  let target: URL;
  let file: OpenedFile;
  try {
    target = uploadTarget(o.origin, o.id);
    key = o.key();
    file = readUploadFile(o.path);
    if (file.size !== o.bytes) {
      throw new LocalRefusal(
        `the file is ${file.size} bytes, not ${o.bytes}: use the byte_size from tilori-agent file-info`,
      );
    }
    if (contains(file.bytes, new TextEncoder().encode(key))) throw new LocalRefusal('this file contains your agent key; refusing');
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    return done({ code: 2, line: msg });
  }
  const timeoutMs = o.timeoutMs ?? UPLOAD_TIMEOUT_MS;
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (o.signal) signals.push(o.signal);
  try {
    const res = await (o.fetch ?? fetch)(target, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/octet-stream' },
      body: file.bytes,
      // Bun and Node hand a 3xx back as the response; it is refused below.
      redirect: 'manual',
      signal: AbortSignal.any(signals),
    });
    // Don't read the body: none of it is printed, and the connection closes on exit.
    res.body?.cancel().catch(() => {});
    return done(statusLine(res.status, o.id, file.size));
  } catch (cause) {
    const name = (cause as Error)?.name;
    if (name === 'TimeoutError') return done({ code: 1, line: serverError(`no answer in ${timeoutMs / 1000} s`) });
    if (name === 'AbortError') return done({ code: 1, line: 'stopped before the server answered: run the same command once more' });
    return done({ code: 1, line: serverError('no response') });
  }
}
