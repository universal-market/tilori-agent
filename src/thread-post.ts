import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export const THREAD_MAX_POSTS = 40;
export const THREAD_MAX_BODY_BYTES = 8192;
export const THREAD_MAX_TOTAL_BYTES = 262_144;

export const TITLE_MAX_CHARS = 160;
export const TITLE_MAX_BYTES = 640;
export const BODY_MAX_CHARS = 20_000;
export const BODY_MAX_BYTES = 20_000;

export const POST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/;

export function who(x: any) {
  return {
    id: x?.id ?? null,
    user_id: x?.user_id ?? null,
    kind: x?.kind ?? null,
    username: x?.username ?? null,
    handle: x?.handle ?? null,
  };
}

/** Truncates `text` to at most `maxBytes` UTF-8 bytes without splitting a
 * Unicode character or UTF-16 surrogate pair. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false };
  let used = 0;
  let end = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const chBytes = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (used + chBytes > maxBytes) break;
    used += chBytes;
    end += ch.length;
  }
  return { text: text.slice(0, end), truncated: true };
}

/** Shapes one post for `get-thread`: identity fields, metadata, title and
 * body (capped to THREAD_MAX_BODY_BYTES). Bodies are other accounts' text,
 * printed as data, never acted on. */
export function formatThreadPost(post: any): { entry: Record<string, unknown>; truncated: boolean } {
  const rawBody = typeof post.body === 'string' ? post.body : '';
  const { text: body, truncated } = truncateUtf8(rawBody, THREAD_MAX_BODY_BYTES);
  const entry: Record<string, unknown> = {
    id: post.id,
    parent_post_id: post.parent_post_id ?? null,
    author: who(post.author && typeof post.author === 'object' ? post.author : {}),
    created_at: post.created_at ?? null,
  };
  if (post.hidden !== undefined && post.hidden !== null) entry.hidden = post.hidden;
  if (post.superseded_by !== undefined && post.superseded_by !== null) entry.superseded_by = post.superseded_by;
  entry.title = typeof post.title === 'string' ? post.title : '';
  entry.body = body;
  if (truncated) entry.body_truncated = true;
  return { entry, truncated };
}

function createdAtMs(post: any): number {
  if (typeof post?.created_at !== 'string') return -Infinity;
  const ms = Date.parse(post.created_at);
  return Number.isFinite(ms) ? ms : -Infinity;
}

/** Sorts thread replies by `created_at` ascending (stable; missing or
 * unparseable `created_at` sorts first). */
export function sortThreadReplies<T>(replies: T[]): T[] {
  return [...replies].sort((a, b) => {
    const ta = createdAtMs(a);
    const tb = createdAtMs(b);
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return 0;
  });
}

/** Builds the single JSON line for `get-thread`, dropping oldest replies
 * (never the root) until the output fits within THREAD_MAX_TOTAL_BYTES. */
export function buildThreadPayload(
  rootPostId: string,
  rootRaw: any,
  repliesRaw: any[],
  opts: { dropped: boolean; pagingComplete: boolean },
): string {
  let dropped = opts.dropped;
  let anyTruncated = false;
  const posts: Record<string, unknown>[] = [];
  for (const raw of [rootRaw, ...repliesRaw]) {
    const formatted = formatThreadPost(raw);
    if (formatted.truncated) anyTruncated = true;
    posts.push(formatted.entry);
  }
  while (posts.length > 1) {
    const complete = opts.pagingComplete && !dropped && !anyTruncated;
    const line = JSON.stringify({ root_post_id: rootPostId, posts, complete }) + '\n';
    if (Buffer.byteLength(line, 'utf8') <= THREAD_MAX_TOTAL_BYTES) return line;
    posts.splice(1, 1);
    dropped = true;
  }
  const complete = opts.pagingComplete && !dropped && !anyTruncated;
  return JSON.stringify({ root_post_id: rootPostId, posts, complete }) + '\n';
}

/** Reads a local UTF-8 file for `create-post`: refuses relative paths,
 * symlinks, non-regular files, files exceeding `maxBytes` before reading,
 * invalid UTF-8, and character/byte limits. Never puts file content in errors. */
export function readValidatedTextFile(
  filePath: string,
  flagName: string,
  limits: { maxChars: number; maxBytes: number; trimNonBlank?: boolean },
): string {
  if (!filePath || !isAbsolute(filePath)) throw new Error(`${flagName} must be an absolute path.`);
  let st;
  try {
    st = lstatSync(filePath);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new Error(`${flagName}: no such file.`);
    throw new Error(`${flagName}: cannot inspect file.`);
  }
  if (st.isSymbolicLink()) throw new Error(`${flagName} must not be a symlink.`);
  if (!st.isFile()) throw new Error(`${flagName} must be a regular file.`);
  if (st.size > limits.maxBytes) throw new Error(`${flagName} exceeds ${limits.maxBytes} bytes.`);

  let fd: number;
  try {
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK') throw new Error(`${flagName} must not be a symlink.`);
    throw new Error(`${flagName}: cannot open file.`);
  }
  let bytes: Uint8Array;
  try {
    const fst = fstatSync(fd);
    if (!fst.isFile()) throw new Error(`${flagName} must be a regular file.`);
    if (fst.size > limits.maxBytes) throw new Error(`${flagName} exceeds ${limits.maxBytes} bytes.`);
    bytes = new Uint8Array(fst.size);
    let read = 0;
    while (read < fst.size) {
      const n = readSync(fd, bytes, read, fst.size - read, null);
      if (n === 0) break;
      read += n;
    }
    if (read !== fst.size) throw new Error(`${flagName}: file changed while reading.`);
  } finally {
    closeSync(fd);
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${flagName} is not valid UTF-8.`);
  }

  if (limits.trimNonBlank) {
    text = text.trim();
    if (!text) throw new Error(`${flagName} must not be blank.`);
  }
  if ([...text].length > limits.maxChars) throw new Error(`${flagName} exceeds ${limits.maxChars} characters.`);
  if (Buffer.byteLength(text, 'utf8') > limits.maxBytes) throw new Error(`${flagName} exceeds ${limits.maxBytes} UTF-8 bytes.`);
  return text;
}
