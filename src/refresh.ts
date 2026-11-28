import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { buildMcpUrl, loadConfig } from './config.ts';
import {
  assertPrivate,
  ensurePrivateDir,
  keyPath,
  readKey,
  redact,
  tiloriHome,
  validateHandle,
  writeKey,
  writePrivateFile,
} from './keys.ts';
import {
  CLAIM_WAIT_MS,
  SETUP_HTTP_TIMEOUT_MS,
  SetupInputError,
  allowedUrl,
  checkStatus,
  errorCode,
  openBrowser,
  pendingDir,
  readOwner,
  request,
  sleep,
  transportFailure,
  type HttpOptions,
  type PendingRegistration,
} from './setup.ts';
import { hostText } from './host-text.ts';

/**
 * `tilori-agent setup <handle> --refresh` (UNI-938; server UNI-937, design
 * option A with Bastion's ac87faf9): replaces an agent's key with a new one
 * its owner approves, for a key minted before a scope the agent now needs.
 *
 *   1. POST /api/v1/agents/refresh with the current key, to the configured
 *      Tilori server's origin only. The answer is a pending key, an approval
 *      link and a status URL, as `register`'s is. They are kept in
 *      pending/<handle>.refresh.json (0600) so a re-run resumes.
 *   2. Poll status until the owner approves.
 *   3. Back the current key up to agents/<handle>.key.old, write the new
 *      key, check it with get_my_profile (restoring the old key if that
 *      fails), then POST /api/v1/agents/refresh/complete with the new key,
 *      which revokes the old one, and delete the backup.
 *
 * If step 3's complete call doesn't go through, the backup stays and `watch`
 * retries it at startup (`finishRefresh`). `--refresh` is refused while a
 * backup exists, so two refreshes never interleave. No key is ever printed.
 */

export const REFRESH_PATH = '/api/v1/agents/refresh';
export const COMPLETE_PATH = '/api/v1/agents/refresh/complete';

export interface PendingRefresh extends PendingRegistration {
  /** The approval link (it carries the claim token), for a resumed run. It
   * may be on another origin than the API (the web site: UNI-940). */
  claim_url: string;
  /** Absolute, on the registration's origin. */
  complete_url: string;
}

export function oldKeyPath(handle: string): string {
  return keyPath(handle) + '.old';
}
/** A backup equal to the key file means the switch never happened (the
 * process stopped between the backup and the new key): the backup is
 * dropped, with nothing to complete (Bastion b4c72c3f). True when it was. */
function dropStaleBackup(handle: string): boolean {
  const path = oldKeyPath(handle);
  if (!existsSync(path)) return false;
  assertPrivate(path);
  if (readFileSync(path, 'utf8').trim() !== readKey(handle)) return false;
  deleteFile(path);
  return true;
}
/** Not a handle with `.json` (`listPending` skips it: a dot is no handle). */
export function refreshPath(handle: string): string {
  return join(pendingDir(), `${validateHandle(handle)}.refresh.json`);
}

export const REFRESH_LINES = {
  noKey: (handle: string) => hostText().refreshNoKey(handle),
  unfinished: (handle: string) =>
    `An earlier key refresh for @${handle} hasn't finished. It finishes when the next session with the Tilori plugin starts; start one, then try again.`,
  /** Names the link's host: it may be the web site, not the API (Bastion aaa9f925). */
  link: (handle: string, host: string) => `Open this link on ${host} to approve a new key for @${handle}:`,
  wait: 'Waiting for your approval in the browser. Once you approve, the agent switches to the new key and revokes the old one.',
  done: (handle: string) => `@${handle} now uses its new key, and the old key is revoked.`,
  /** The new key works but the old key's revocation didn't go through yet. */
  doneLater: (handle: string) =>
    `@${handle} now uses its new key. The old key will be revoked when the next session with the Tilori plugin starts.`,
  /** The refresh expired before it completed: the old key wasn't revoked. */
  oldMayLive: (handle: string) =>
    `@${handle} now uses its new key, but the old key may still be active. Revoke it under Account → Agents.`,
  /** The new key failed its check: the old key was put back. */
  kept: (handle: string) => hostText().refreshKept(handle),
  timeout: (handle: string) => hostText().refreshTimeout(handle),
  expired: (handle: string) => hostText().refreshExpired(handle),
  pending: (handle: string) =>
    `A key refresh for @${handle} is already waiting for approval, and its link isn't on this machine. It expires within a day.`,
} as const;

/** Fixed words for a refused refresh: the body is never echoed. */
export function refreshRefusal(handle: string, status: number, code = ''): string {
  if (status === 401) return hostText().refreshRefused401(handle, code);
  if (status === 403 && code.trim() === 'OPERATION_NOT_ALLOWED') return REFRESH_LINES.pending(handle);
  if (status === 429) return 'Tilori is rate-limiting key refreshes (3 an hour per agent); try again later.';
  if (status >= 500) return `Tilori had a server error (HTTP ${status}); try again in a minute.`;
  return `Tilori refused the key refresh (HTTP ${status}${code}).`;
}

function writeRefresh(p: PendingRefresh): string {
  ensurePrivateDir(tiloriHome());
  ensurePrivateDir(pendingDir());
  return writePrivateFile(refreshPath(p.handle), JSON.stringify(p) + '\n');
}
function deleteFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
  }
}

/** The pending refresh for a handle, or null. Fails closed as readPending
 * does; the URLs a key goes to must be on its origin. */
export function readRefresh(handle: string): PendingRefresh | null {
  const path = refreshPath(handle);
  if (!existsSync(path)) return null;
  assertPrivate(tiloriHome(), true);
  assertPrivate(pendingDir(), true);
  assertPrivate(path);
  const bad = () => new Error(`${path} is malformed; remove it and run the refresh again.`);
  let j: any;
  try {
    j = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw bad();
  }
  const s = (k: string) => (typeof j?.[k] === 'string' && j[k].trim() ? (j[k] as string) : null);
  const id = s('id');
  const key = s('api_key');
  if (!id || !key || /\s/.test(key) || s('handle') !== validateHandle(handle)) throw bad();
  let origin: URL;
  const urls: Record<string, URL> = {};
  try {
    origin = new URL(s('origin') ?? '');
    for (const k of ['status_url', 'complete_url', 'claim_url']) urls[k] = new URL(s(k) ?? '');
  } catch {
    throw bad();
  }
  if (!allowedUrl(origin, origin) || !allowedUrl(urls.claim_url, origin)) throw bad();
  if ([urls.status_url, urls.complete_url].some((u) => u.origin !== origin.origin || !allowedUrl(u, origin))) throw bad();
  const poll = j.poll_after_seconds;
  return {
    id,
    handle: validateHandle(handle),
    api_key: key,
    status_url: urls.status_url.href,
    complete_url: urls.complete_url.href,
    claim_url: urls.claim_url.href,
    expires_at: s('expires_at') ?? '',
    poll_after_seconds: Number.isInteger(poll) && poll >= 1 && poll <= 60 ? poll : 5,
    origin: origin.origin,
    created_at: s('created_at') ?? '',
  };
}

/** The origin of the configured Tilori server: the only place the current
 * key is sent, as `headers` releases it only to that server. */
export function refreshOrigin(): URL {
  const config = loadConfig();
  if (!config.url) throw new SetupInputError(hostText().refreshNoServer);
  const origin = new URL(buildMcpUrl(config.url).origin);
  if (!allowedUrl(origin, origin)) throw new SetupInputError('The configured Tilori server is not https.');
  return origin;
}

/** POST refresh with the current key. Throws fixed-text errors. */
export async function startRefresh(o: HttpOptions & { handle: string; origin: URL; key: string; now?: () => number }): Promise<PendingRefresh> {
  let res: Awaited<ReturnType<typeof request>>;
  try {
    res = await request(new URL(REFRESH_PATH, o.origin), { method: 'POST', headers: { authorization: `Bearer ${o.key}`, accept: 'application/json' } }, o);
  } catch (cause) {
    throw transportFailure(cause, 'the key refresh', o.origin.host, o.timeoutMs ?? SETUP_HTTP_TIMEOUT_MS);
  }
  if (res.status < 200 || res.status >= 300) throw new Error(refreshRefusal(o.handle, res.status, errorCode(res.json)));
  const unusable = (why: string) => new Error(`Tilori's key refresh answer could not be used (${why}); try again.`);
  if (!res.parsed) throw unusable('not JSON');
  const j = res.json as any;
  const key = j?.api_key;
  if (typeof key !== 'string' || !key.trim() || /\s/.test(key.trim()) || key.length > 200) throw unusable('no usable api_key');
  const parse = (raw: unknown, fallback?: string) => {
    try {
      return new URL(typeof raw === 'string' ? raw : (fallback ?? ''), o.origin);
    } catch {
      return null;
    }
  };
  // Where the keys go: the status and complete URLs carry the pending and
  // new key, so they stay on the origin the current key went to.
  const on = (raw: unknown, fallback?: string) => {
    const u = parse(raw, fallback);
    return u && u.origin === o.origin.origin && allowedUrl(u, o.origin) ? u : null;
  };
  // The approval link is only shown and opened in a browser, never sent a
  // key. Tilori builds it on its web site, which need not be the API's
  // origin (Internal's config.url is the Convex site: UNI-940). It must
  // still be https (http only for loopback, as the origin is) and carry no
  // credentials.
  const shown = typeof j?.claim_url === 'string' ? parse(j.claim_url) : null;
  const claim = shown && allowedUrl(shown, o.origin) ? shown : null;
  const status = on(j?.status_url, '/api/v1/agents/status');
  const complete = on(j?.complete_url, COMPLETE_PATH);
  if (!claim) throw unusable('the approval link is not https');
  if (!status || !complete) throw unusable('its URLs are not on the Tilori origin');
  const id = typeof j?.id === 'string' && j.id.trim() && j.id.length <= 64 ? j.id : null;
  if (!id) throw unusable('no id');
  const now = o.now?.() ?? Date.now();
  const expires = typeof j?.expires_at === 'string' ? Date.parse(j.expires_at) : NaN;
  const poll = j?.poll_after_seconds;
  return {
    id,
    handle: o.handle,
    api_key: key.trim(),
    status_url: status.href,
    complete_url: complete.href,
    claim_url: claim.href,
    expires_at: new Date(Number.isFinite(expires) ? expires : now + 24 * 3600_000).toISOString(),
    poll_after_seconds: Number.isInteger(poll) && poll >= 1 && poll <= 60 ? poll : 5,
    origin: o.origin.origin,
    created_at: new Date(now).toISOString(),
  };
}

/** POST complete with the new key: `completed` (the old key is revoked),
 * `nothing_pending` (no open refresh: it expired before completing, so the
 * old key may still be live), or null when it didn't go through. Never
 * throws. */
export async function completeRefresh(
  url: string,
  key: string,
  o: HttpOptions & { log: (m: string) => void },
): Promise<'completed' | 'nothing_pending' | null> {
  try {
    const res = await request(new URL(url), { method: 'POST', headers: { authorization: `Bearer ${key}`, accept: 'application/json' } }, o);
    const status = (res.json as any)?.status;
    if (res.status === 200 && (status === 'completed' || status === 'nothing_pending')) return status;
    o.log(`the key refresh's completion was refused (HTTP ${res.status}${errorCode(res.json)})`);
  } catch (cause) {
    o.log(`could not reach Tilori to complete the key refresh (${(cause as Error)?.name ?? 'error'})`);
  }
  return null;
}

export interface RefreshOptions extends HttpOptions {
  handle: string;
  noBrowser?: boolean;
  out: (line: string) => void;
  log: (m: string) => void;
  platform?: NodeJS.Platform;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  pollIntervalMs?: number;
  deadlineMs?: number;
  ownerTimeoutMs?: number;
}

/** `tilori-agent setup <handle> --refresh`. Exit 0 once the new key is in
 * use, 1 when it isn't (each with one fixed line), 2 for bad input. */
export async function runRefresh(o: RefreshOptions): Promise<number> {
  const handle = validateHandle(o.handle);
  if (!existsSync(keyPath(handle))) throw new SetupInputError(REFRESH_LINES.noKey(handle));
  // Bastion ac87faf9: never start one refresh over another's backup.
  if (!dropStaleBackup(handle) && existsSync(oldKeyPath(handle))) {
    o.out(REFRESH_LINES.unfinished(handle));
    return 1;
  }
  const origin = refreshOrigin();
  const current = readKey(handle);
  const secrets = [current];
  const log = (m: string) => o.log(redact(m, secrets));
  const now = o.now ?? Date.now;
  // Resume a pending refresh on the same server; otherwise start one.
  let p: PendingRefresh | null = null;
  try {
    p = readRefresh(handle);
  } catch (cause) {
    log(cause instanceof Error ? cause.message : String(cause));
  }
  if (p && (p.origin !== origin.origin || Date.parse(p.expires_at) <= now())) {
    deleteFile(refreshPath(handle));
    p = null;
  }
  if (!p) {
    p = await startRefresh({ ...o, handle, origin, key: current, now });
    writeRefresh(p);
  }
  secrets.push(p.api_key);
  o.out(REFRESH_LINES.link(handle, new URL(p.claim_url).host));
  o.out(p.claim_url);
  if (!o.noBrowser) openBrowser(p.claim_url, log, o.platform);
  o.out(REFRESH_LINES.wait);
  const wait = o.sleep ?? sleep;
  const deadline = Math.min(now() + (o.deadlineMs ?? CLAIM_WAIT_MS), Date.parse(p.expires_at) || Infinity);
  let intervalMs = o.pollIntervalMs ?? p.poll_after_seconds * 1000;
  while (!o.signal?.aborted) {
    const ans = await checkStatus(p, o);
    if (ans.kind === 'claimed') {
      if (ans.handle !== handle) {
        o.out(REFRESH_LINES.kept(handle));
        return 1;
      }
      return swapKey(handle, current, p, ans.tilori, { ...o, log });
    }
    if (ans.kind === 'gone' || ans.kind === 'unusable') {
      deleteFile(refreshPath(handle));
      o.out(REFRESH_LINES.expired(handle));
      return 1;
    }
    if (ans.kind === 'retry') log(`status check for @${handle}'s key refresh failed (${ans.why}); trying again`);
    if (ans.pollAfterMs && o.pollIntervalMs === undefined) intervalMs = ans.pollAfterMs;
    if (now() >= deadline) {
      o.out(REFRESH_LINES.timeout(handle));
      return 1;
    }
    await wait(Math.max(0, Math.min(intervalMs, deadline - now())), o.signal);
  }
  return 1;
}

/** Approved: back up, switch, check, complete. */
async function swapKey(
  handle: string,
  current: string,
  p: PendingRefresh,
  tilori: URL,
  o: RefreshOptions,
): Promise<number> {
  writePrivateFile(oldKeyPath(handle), current + '\n');
  writeKey(handle, p.api_key);
  const owner = await readOwner(tilori, p.api_key, handle, o);
  if (!owner) {
    // The old key still works (complete was never called): put it back.
    writeKey(handle, current);
    deleteFile(oldKeyPath(handle));
    o.out(REFRESH_LINES.kept(handle));
    return 1;
  }
  const done = await completeRefresh(p.complete_url, p.api_key, o);
  if (done) {
    deleteFile(oldKeyPath(handle));
    deleteFile(refreshPath(handle));
  }
  o.out(done === 'completed' ? REFRESH_LINES.done(handle) : done ? REFRESH_LINES.oldMayLive(handle) : REFRESH_LINES.doneLater(handle));
  return 0;
}

/** At `watch` startup: finishes a refresh whose complete call didn't go
 * through, while the backup shows one is open. Returns the one line for
 * the session, or null (nothing open, or still not through; logged). Never
 * throws. */
export async function finishRefresh(handle: string, o: HttpOptions & { log: (m: string) => void }): Promise<string | null> {
  try {
    if (!existsSync(oldKeyPath(handle)) || dropStaleBackup(handle)) return null;
    const key = readKey(handle);
    const log = (m: string) => o.log(redact(m, [key]));
    let url: string;
    try {
      url = readRefresh(handle)?.complete_url ?? new URL(COMPLETE_PATH, refreshOrigin()).href;
    } catch {
      url = new URL(COMPLETE_PATH, refreshOrigin()).href;
    }
    const done = await completeRefresh(url, key, { ...o, log });
    if (!done) return null;
    deleteFile(oldKeyPath(handle));
    deleteFile(refreshPath(handle));
    return done === 'completed' ? REFRESH_LINES.done(handle) : REFRESH_LINES.oldMayLive(handle);
  } catch (cause) {
    o.log(redact(`could not finish @${handle}'s key refresh: ${cause instanceof Error ? cause.message : String(cause)}`));
    return null;
  }
}
