import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { TiloriAgentClient } from './client.ts';
import {
  buildMarketUrl,
  buildMcpUrl,
  loadConfig,
  sameEndpoint,
  saveConfig,
} from './config.ts';
import {
  assertPrivate,
  ensurePrivateDir,
  keyPath,
  redact,
  tiloriHome,
  validateHandle,
  writeKey,
  writePrivateFile,
} from './keys.ts';

/**
 * `tilori-agent setup [handle]` and the claim poller behind it (plugin part
 * D, Wren's design a2b4704f with Juniper's 10a431bf and Bastion's 54990447):
 * the public register → claim → status flow of `docs/public-api.md`.
 *
 *   setup   POSTs register, stores the registration (its api_key and
 *           status_url) as a private pending file, prints the claim link on
 *           its own line, opens the browser best-effort, and returns at once.
 *   watch   finds the pending file, polls status until claimed (at most 15
 *           minutes or the registration's expiry), writes the key and
 *           config.json, reads the owner with get_my_profile and emits one
 *           fixed wake line. The pending file is deleted on every outcome.
 *
 * The api_key goes from the register response into the pending file and the
 * key file, nowhere else. No response body is ever printed: every message
 * here is fixed text plus, at most, an HTTP status and a server error code
 * that matches CODE_RE. The claim link is the one thing from the server that
 * is shown, because the user has to open it.
 */

export const DEFAULT_ORIGIN = 'https://tilori.ai';
export const REGISTER_PATH = '/api/v1/agents/register';
export const STATUS_PATH = '/api/v1/agents/status';
/** How long watch polls a registration before giving up. */
export const CLAIM_WAIT_MS = 15 * 60_000;
/** One HTTP call to register or status. */
export const SETUP_HTTP_TIMEOUT_MS = 20_000;
/** get_my_profile with the new key, after the claim. */
export const OWNER_TIMEOUT_MS = 10_000;
/** How often watch looks for a key or a pending registration when it has neither. */
export const WAIT_FOR_SETUP_MS = 10_000;
const DEFAULT_POLL_S = 5;
const MAX_POLL_S = 60;
const MAX_BODY = 64 * 1024;

/** Bad input (exit 2), as opposed to a server or network failure (exit 1). */
export class SetupInputError extends Error {}

/** Tilori's agent handle rule (universal_market shared/handles.ts, UNI-302):
 * 2–24 of a–z, 0–9 and single hyphens, starting and ending with a letter or
 * digit. Stricter than the key-file rule in keys.ts, which it also passes. */
const SETUP_HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const HANDLE_RULE =
  'Agent handles are 2-24 characters: a-z, 0-9 and single hyphens, starting and ending with a letter or digit.';
/** Tilori usernames (3–20, same shape); only such a value may go into the wake line. */
const USERNAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A server error code: a constant, never free text. */
const CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** The handle argument comes from the model (Bastion's must-have 4): it is
 * checked here before any use, and it is only ever a JSON field and a file
 * name, never part of a shell command or a URL. The message never repeats it. */
export function setupHandle(raw: string): string {
  // Like the server: only ASCII spaces trimmed and only A–Z lowercased, so a
  // look-alike character fails the shape check instead of folding.
  const h = raw.replace(/^ +| +$/g, '').replace(/[A-Z]/g, (c) => c.toLowerCase());
  if (h.length < 2 || h.length > 24 || !SETUP_HANDLE.test(h)) throw new SetupInputError(HANDLE_RULE);
  return validateHandle(h);
}

/** A handle from the account name ($USER), or null when nothing usable is left. */
export function handleFromUser(user: string | undefined): string | null {
  const base = (user ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/, '');
  try {
    return setupHandle(base);
  } catch {
    return null;
  }
}

/** `--name`: one line of visible text, at most 100 characters. Only a JSON field. */
export function setupDisplayName(raw: string): string {
  const name = raw.trim();
  if (!name || name.length > 100 || CONTROL.test(name)) {
    throw new SetupInputError('--name must be one line of at most 100 characters.');
  }
  return name;
}

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
const isLoopback = (u: URL) => LOOPBACK.includes(u.hostname);

/** `--url-origin`: a bare https origin (`https://tilori.ai`). `http://` is
 * accepted for a loopback host only, which is how the tests run a fake
 * server; that choice also decides what the claimed URLs may be. */
export function setupOrigin(raw: string | undefined): URL {
  let url: URL;
  try {
    url = new URL((raw ?? DEFAULT_ORIGIN).trim());
  } catch {
    throw new SetupInputError('--url-origin must be an https origin such as https://tilori.ai.');
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new SetupInputError('--url-origin must be a bare origin: no path, query, fragment or credentials.');
  }
  if (!allowedUrl(url, url)) throw new SetupInputError('--url-origin must use https (http only for a loopback host).');
  return new URL(url.origin);
}

/** Whether a URL the server sent may be used: https, or http to a loopback
 * host when the registration itself went to one (Bastion's must-have 5; the
 * loopback exception exists for the tests). Credentials in a URL are refused. */
export function allowedUrl(u: URL, origin: URL): boolean {
  if (u.username || u.password) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && isLoopback(u) && origin.protocol === 'http:' && isLoopback(origin);
}

// ---------------------------------------------------------------------------
// The pending registration file: ~/.config/tilori/pending/<handle>.json

export interface PendingRegistration {
  /** The registration id Tilori gave, for telling one apart from a re-run. */
  id: string;
  /** The handle as registered; the claim page may give the agent another. */
  handle: string;
  api_key: string;
  /** Absolute, on the registration's origin. */
  status_url: string;
  expires_at: string;
  poll_after_seconds: number;
  /** The origin register was sent to; decides whether http loopback URLs are allowed. */
  origin: string;
  created_at: string;
}

export function pendingDir(): string {
  return join(tiloriHome(), 'pending');
}

export function pendingPath(handle: string): string {
  return join(pendingDir(), `${validateHandle(handle)}.json`);
}

export function writePending(p: PendingRegistration): string {
  ensurePrivateDir(tiloriHome());
  ensurePrivateDir(pendingDir());
  return writePrivateFile(pendingPath(p.handle), JSON.stringify(p) + '\n');
}

/** The pending registration for a handle, or null when there is none. Like
 * readKey, it fails closed on a symlink, a wide mode or another owner, and a
 * malformed file is reported without its contents. */
export function readPending(handle: string): PendingRegistration | null {
  const path = pendingPath(handle);
  if (!existsSync(path)) return null;
  assertPrivate(tiloriHome(), true);
  assertPrivate(pendingDir(), true);
  assertPrivate(path);
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${path} is not valid JSON; remove it and run setup again.`);
  }
  const s = (k: string) => (typeof parsed?.[k] === 'string' && parsed[k].trim() ? (parsed[k] as string) : null);
  const id = s('id');
  const key = s('api_key');
  const status = s('status_url');
  const origin = s('origin');
  if (!id || !key || /\s/.test(key) || !status || !origin || s('handle') !== validateHandle(handle)) {
    throw new Error(`${path} is malformed; remove it and run setup again.`);
  }
  let originUrl: URL;
  let statusUrl: URL;
  try {
    originUrl = new URL(origin);
    statusUrl = new URL(status);
  } catch {
    throw new Error(`${path} is malformed; remove it and run setup again.`);
  }
  // The key goes only to the status URL, which must be on the origin the
  // registration went to, over https (or http loopback, as that origin was).
  if (statusUrl.origin !== originUrl.origin || !allowedUrl(statusUrl, originUrl) || !allowedUrl(originUrl, originUrl)) {
    throw new Error(`${path} names a status URL off its origin; remove it and run setup again.`);
  }
  const poll = parsed.poll_after_seconds;
  return {
    id,
    handle: validateHandle(handle),
    api_key: key,
    status_url: statusUrl.href,
    expires_at: s('expires_at') ?? '',
    poll_after_seconds: Number.isInteger(poll) && poll >= 1 && poll <= MAX_POLL_S ? poll : DEFAULT_POLL_S,
    origin: originUrl.origin,
    created_at: s('created_at') ?? '',
  };
}

export function deletePending(handle: string): void {
  try {
    unlinkSync(pendingPath(handle));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
  }
}

/** Handles with a pending registration file, newest first. */
export function listPending(): string[] {
  const dir = pendingDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .filter((h) => {
      try {
        validateHandle(h);
        return true;
      } catch {
        return false;
      }
    })
    .map((h) => {
      let at = 0;
      try {
        at = Date.parse(readPending(h)?.created_at ?? '') || 0;
      } catch {
        // Unreadable: sorts last, and the poller reports it when asked.
      }
      return { h, at };
    })
    .sort((a, b) => b.at - a.at)
    .map((x) => x.h);
}

// ---------------------------------------------------------------------------
// HTTP

interface HttpOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** One request, no redirects (a redirect could carry the key elsewhere), one
 * timeout. The body is read at most MAX_BODY bytes and parsed as JSON; a
 * failure to parse is reported without the text. */
async function request(
  url: URL,
  init: RequestInit,
  o: HttpOptions,
): Promise<{ status: number; json: unknown; parsed: boolean; headers: Headers }> {
  const signals = [AbortSignal.timeout(o.timeoutMs ?? SETUP_HTTP_TIMEOUT_MS)];
  if (o.signal) signals.push(o.signal);
  const res = await (o.fetch ?? fetch)(url, { ...init, redirect: 'error', signal: AbortSignal.any(signals) });
  let text = '';
  try {
    text = (await res.text()).slice(0, MAX_BODY);
  } catch {
    // An unreadable body is the same as an unparsable one.
  }
  try {
    return { status: res.status, json: JSON.parse(text), parsed: true, headers: res.headers };
  } catch {
    return { status: res.status, json: undefined, parsed: false, headers: res.headers };
  }
}

/** A server error code from a JSON error body, if it has one and it is a constant. */
function errorCode(json: unknown): string {
  const j = json as any;
  const code = j?.error?.code ?? j?.code;
  return typeof code === 'string' && CODE_RE.test(code) ? ` ${code}` : '';
}

/** Fixed words for a failed register (Bastion's must-have 1: the body is
 * never echoed). */
export function registerRefusal(status: number, code = ''): string {
  if (status === 400) return `Tilori refused the registration (HTTP 400${code}): check the handle and display name.`;
  if (status === 403) return `Tilori refused that handle or name as reserved (HTTP 403${code}); pick another.`;
  if (status === 429) return 'Tilori is rate-limiting registrations (HTTP 429); try again in a few minutes.';
  if (status >= 500) return `Tilori had a server error (HTTP ${status}); try again in a minute.`;
  return `Tilori refused the registration (HTTP ${status}${code}).`;
}

function transportFailure(cause: unknown, what: string, host: string, timeoutMs: number): Error {
  const name = (cause as Error)?.name;
  if (name === 'TimeoutError') return new Error(`Tilori did not answer ${what} within ${Math.round(timeoutMs / 1000)} s; try again.`);
  if (name === 'AbortError') return new Error(`${what} was stopped before Tilori answered.`);
  const msg = cause instanceof Error ? cause.message : '';
  if (/redirect/i.test(msg)) return new Error(`Tilori answered ${what} with a redirect, which is not followed.`);
  return new Error(`Could not reach ${host} for ${what}; check the network and the URL.`);
}

export interface RegisterOptions extends HttpOptions {
  origin: URL;
  handle: string;
  displayName: string;
  now?: () => number;
}

/** POST register. Returns the pending registration to store, plus the claim
 * link to show. Throws fixed-text errors; never the response body. */
export async function register(o: RegisterOptions): Promise<{ pending: PendingRegistration; claimUrl: string }> {
  const url = new URL(REGISTER_PATH, o.origin);
  let res: Awaited<ReturnType<typeof request>>;
  try {
    res = await request(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ handle: o.handle, display_name: o.displayName }),
      },
      o,
    );
  } catch (cause) {
    throw transportFailure(cause, 'the registration', o.origin.host, o.timeoutMs ?? SETUP_HTTP_TIMEOUT_MS);
  }
  if (res.status < 200 || res.status >= 300) throw new Error(registerRefusal(res.status, errorCode(res.json)));
  if (!res.parsed) throw new Error(`Tilori answered the registration with something that is not JSON (HTTP ${res.status}); try again.`);
  const j = res.json as any;
  const unusable = (why: string) => new Error(`Tilori's registration answer could not be used (${why}); try again.`);
  const key = j?.api_key;
  if (typeof key !== 'string' || !key.trim() || /\s/.test(key.trim()) || key.length > 200) throw unusable('no usable api_key');
  let claim: URL;
  try {
    claim = new URL(String(j?.claim_url ?? ''));
  } catch {
    throw unusable('no claim link');
  }
  // The link is shown to the user and opened in a browser: it must be on
  // the origin the registration went to, over https (or http loopback).
  if (claim.origin !== o.origin.origin || !allowedUrl(claim, o.origin)) throw unusable('the claim link is not on the Tilori origin');
  let status: URL;
  try {
    status = new URL(typeof j?.status_url === 'string' ? j.status_url : STATUS_PATH, o.origin);
  } catch {
    throw unusable('no status URL');
  }
  if (status.origin !== o.origin.origin || !allowedUrl(status, o.origin)) throw unusable('the status URL is not on the Tilori origin');
  const now = o.now?.() ?? Date.now();
  const expires = typeof j?.expires_at === 'string' ? Date.parse(j.expires_at) : NaN;
  const poll = j?.poll_after_seconds;
  const id = typeof j?.id === 'string' && j.id.trim() && j.id.length <= 64 ? j.id : `local-${now}`;
  return {
    pending: {
      id,
      handle: o.handle,
      api_key: key.trim(),
      status_url: status.href,
      expires_at: new Date(Number.isFinite(expires) ? expires : now + 24 * 3600_000).toISOString(),
      poll_after_seconds: Number.isInteger(poll) && poll >= 1 && poll <= MAX_POLL_S ? poll : DEFAULT_POLL_S,
      origin: o.origin.origin,
      created_at: new Date(now).toISOString(),
    },
    claimUrl: claim.href,
  };
}

export type StatusAnswer =
  | { kind: 'pending'; pollAfterMs: number | null }
  | { kind: 'claimed'; handle: string; tilori: URL; market: URL }
  /** The registration is gone: expired, used up, or unknown to the server. */
  | { kind: 'gone' }
  /** A claimed answer that can't be used (bad handle, non-https URLs). Fixed words. */
  | { kind: 'unusable'; why: string }
  /** A failure that may pass: no answer, a 5xx, a non-JSON body, rate limiting. */
  | { kind: 'retry'; why: string; pollAfterMs: number | null };

/** One GET status with the registration's key. Never throws. */
export async function checkStatus(p: PendingRegistration, o: HttpOptions = {}): Promise<StatusAnswer> {
  let res: Awaited<ReturnType<typeof request>>;
  try {
    res = await request(new URL(p.status_url), { method: 'GET', headers: { authorization: `Bearer ${p.api_key}`, accept: 'application/json' } }, o);
  } catch (cause) {
    const name = (cause as Error)?.name;
    return { kind: 'retry', why: name === 'TimeoutError' ? 'no answer in time' : name === 'AbortError' ? 'stopped' : 'unreachable', pollAfterMs: null };
  }
  if (res.status === 400 || res.status === 401 || res.status === 404) return { kind: 'gone' };
  if (res.status === 429) {
    const after = Number(res.headers.get('retry-after'));
    return { kind: 'retry', why: 'rate limited', pollAfterMs: Number.isFinite(after) && after > 0 ? Math.min(after, MAX_POLL_S) * 1000 : 30_000 };
  }
  if (res.status < 200 || res.status >= 300) return { kind: 'retry', why: `HTTP ${res.status}`, pollAfterMs: null };
  if (!res.parsed) return { kind: 'retry', why: 'not JSON', pollAfterMs: null };
  const j = res.json as any;
  const poll = j?.poll_after_seconds;
  const pollAfterMs = Number.isInteger(poll) && poll >= 1 && poll <= MAX_POLL_S ? poll * 1000 : null;
  if (j?.status === 'pending') return { kind: 'pending', pollAfterMs };
  if (j?.status !== 'claimed') return { kind: 'retry', why: 'unexpected answer', pollAfterMs };
  let handle: string;
  try {
    handle = setupHandle(String(j?.handle ?? ''));
  } catch {
    return { kind: 'unusable', why: 'the handle in it is invalid' };
  }
  const origin = new URL(p.origin);
  let rawTilori: URL;
  let rawMarket: URL;
  try {
    rawTilori = new URL(String(j?.urls?.tilori ?? ''));
    rawMarket = new URL(String(j?.urls?.market ?? ''));
  } catch {
    return { kind: 'unusable', why: 'its server URLs are missing' };
  }
  // https first (must-have 5): these become the hosts the key is sent to.
  if (!allowedUrl(rawTilori, origin) || !allowedUrl(rawMarket, origin)) return { kind: 'unusable', why: 'its server URLs are not https' };
  let tilori: URL;
  let market: URL;
  try {
    tilori = buildMcpUrl(rawTilori.href);
    market = buildMarketUrl(rawMarket.href);
  } catch {
    return { kind: 'unusable', why: 'its server URLs are not MCP endpoints' };
  }
  return { kind: 'claimed', handle, tilori, market };
}

// ---------------------------------------------------------------------------
// Lines. Fixed words; the only variable parts are a handle and a username,
// both checked against their rules.

export const LINES = {
  creating: (handle: string) => `Creating @${handle}…`,
  link: (handle: string) => `Open this link to connect @${handle} to your account:`,
  wait: "Waiting for your approval in the browser. You can keep working; I'll tell you when it's done.",
  reuse: (handle: string) =>
    `@${handle} is already set up here, so I'm using it. To add another agent, run /tilori:setup <new-handle>.`,
  live: (owner: string, handle: string) =>
    `You're live as @${owner}.${handle} on Tilori and Universal Market. Owned by ${owner}. ` +
    'Not you? Disconnect it under Account → Agents and run /tilori:setup again. Paid Market actions are off.',
  /** The claim went through but get_my_profile didn't answer or named no owner. */
  connected: (handle: string) =>
    `@${handle} is connected on Tilori and Universal Market, but its owner couldn't be read yet. ` +
    "Check it under Account → Agents; if it isn't yours, disconnect it there and run /tilori:setup again. Paid Market actions are off.",
  /** Appended when config.json already named another Tilori server. */
  otherServer:
    " This machine's Tilori config points at another server, so url and market_url in config.json were left as they were; edit them by hand to use this agent.",
  timeout: "Didn't see an approval in 15 minutes. Run /tilori:setup again.",
  expired: (handle: string) => `The sign-in link for @${handle} expired or was already used. Run /tilori:setup again.`,
  unusable: (handle: string, why: string) => `Tilori's answer for @${handle} couldn't be used (${why}). Run /tilori:setup again.`,
} as const;

// ---------------------------------------------------------------------------
// setup

export interface SetupOptions extends HttpOptions {
  handle?: string;
  name?: string;
  origin?: string;
  noBrowser?: boolean;
  /** The account name a handle is derived from (default: the OS user). */
  user?: string;
  /** Lines for the user (stdout). */
  out: (line: string) => void;
  /** Diagnostics (stderr). */
  log: (m: string) => void;
  platform?: NodeJS.Platform;
}

/** Opens a URL with the desktop's opener, no shell involved, and never
 * fails the command: the link is printed anyway. */
export function openBrowser(url: string, log: (m: string) => void, platform: NodeJS.Platform = process.platform): void {
  const cmd = platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    const child = spawn(cmd, [url], { stdio: 'ignore', detached: true });
    child.once('error', () => log(`could not open a browser (${cmd} is not available); open the link yourself`));
    child.unref();
  } catch {
    log(`could not open a browser; open the link yourself`);
  }
}

/** `tilori-agent setup [handle]`. Exit 0 with the link (or the reuse line);
 * throws SetupInputError for bad input and Error for a server or network
 * failure. Prints the handle, the claim link and fixed lines; never the key. */
export async function runSetup(o: SetupOptions): Promise<number> {
  const origin = setupOrigin(o.origin);
  const config = loadConfig();
  let handle: string;
  let derived = false;
  if (o.handle !== undefined) {
    handle = setupHandle(o.handle);
  } else {
    // No handle: the agent already here is the one meant (Juniper's 3).
    if (config.default_agent && existsSync(keyPath(config.default_agent))) {
      o.out(LINES.reuse(validateHandle(config.default_agent)));
      return 0;
    }
    const fromUser = handleFromUser(o.user ?? safeUserName());
    if (!fromUser) throw new SetupInputError(`Pass a handle: tilori-agent setup <handle>. ${HANDLE_RULE}`);
    handle = fromUser;
    derived = true;
  }
  if (existsSync(keyPath(handle))) {
    o.out(LINES.reuse(handle));
    return 0;
  }
  const displayName = o.name === undefined ? handle : setupDisplayName(o.name);
  // Shown before registering: the claim page can't rename a surprise (Juniper).
  if (derived) o.out(LINES.creating(handle));
  const { pending, claimUrl } = await register({ ...o, origin, handle, displayName });
  writePending(pending);
  o.out(LINES.link(handle));
  // Its own line, never wrapped, so it stays clickable (Juniper).
  o.out(claimUrl);
  if (!o.noBrowser) openBrowser(claimUrl, o.log, o.platform);
  o.out(LINES.wait);
  return 0;
}

function safeUserName(): string | undefined {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER;
  }
}

// ---------------------------------------------------------------------------
// The claim poller (watch)

export interface PollClaimOptions extends HttpOptions {
  /** The pending file's handle. */
  handle: string;
  /** One wake line (no newline) for the session's stdout. */
  write: (line: string) => void | Promise<void>;
  log: (m: string) => void;
  /** How long to keep polling (default 15 min); the registration's expiry caps it. */
  deadlineMs?: number;
  /** Test seam: poll this often instead of the server's poll_after_seconds. */
  pollIntervalMs?: number;
  ownerTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export type PollClaimOutcome =
  | { result: 'claimed'; handle: string }
  | { result: 'timeout' | 'expired' | 'unusable' | 'cancelled' | 'no-file' };

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Polls one pending registration until it is claimed, gone, or out of time,
 * then finishes the claim (key, config, owner line) or emits the fixed line
 * for the outcome. The pending file is deleted on every outcome but a
 * cancel. It is re-read before each poll, so a `setup` re-run that replaced
 * it is followed, and a file removed by hand stops the poll quietly.
 */
export async function pollClaim(o: PollClaimOptions): Promise<PollClaimOutcome> {
  const now = o.now ?? Date.now;
  const wait = o.sleep ?? sleep;
  const secrets: string[] = [];
  const log = (m: string) => o.log(redact(m, secrets));
  let p: PendingRegistration | null;
  try {
    p = readPending(o.handle);
  } catch (cause) {
    o.log(cause instanceof Error ? cause.message : String(cause));
    return { result: 'no-file' };
  }
  if (!p) return { result: 'no-file' };
  secrets.push(p.api_key);
  let deadline = deadlineFor(p, now(), o.deadlineMs);
  let intervalMs = o.pollIntervalMs ?? p.poll_after_seconds * 1000;
  log(`waiting for @${p.handle} to be approved in the browser`);
  while (!o.signal?.aborted) {
    const ans = await checkStatus(p, o);
    if (o.signal?.aborted) break;
    if (ans.kind === 'claimed') {
      const line = await finishClaim(p, ans, { ...o, log });
      deletePending(p.handle);
      await o.write(line);
      return { result: 'claimed', handle: ans.handle };
    }
    if (ans.kind === 'gone') {
      deletePending(p.handle);
      await o.write(LINES.expired(p.handle));
      return { result: 'expired' };
    }
    if (ans.kind === 'unusable') {
      deletePending(p.handle);
      await o.write(LINES.unusable(p.handle, ans.why));
      return { result: 'unusable' };
    }
    if (ans.kind === 'retry') log(`status check for @${p.handle} failed (${ans.why}); trying again`);
    if (ans.pollAfterMs && o.pollIntervalMs === undefined) intervalMs = ans.pollAfterMs;
    if (now() >= deadline) {
      deletePending(p.handle);
      await o.write(LINES.timeout);
      return { result: 'timeout' };
    }
    await wait(Math.max(0, Math.min(intervalMs, deadline - now())), o.signal);
    // Follow a replaced registration; stop on a removed file.
    let cur: PendingRegistration | null;
    try {
      cur = readPending(o.handle);
    } catch (cause) {
      log(cause instanceof Error ? cause.message : String(cause));
      return { result: 'no-file' };
    }
    if (!cur) return { result: 'no-file' };
    if (cur.id !== p.id || cur.api_key !== p.api_key) {
      p = cur;
      secrets.push(p.api_key);
      deadline = deadlineFor(p, now(), o.deadlineMs);
      intervalMs = o.pollIntervalMs ?? p.poll_after_seconds * 1000;
      log(`a new registration for @${p.handle} replaced the one being watched`);
    }
  }
  return { result: 'cancelled' };
}

function deadlineFor(p: PendingRegistration, now: number, deadlineMs = CLAIM_WAIT_MS): number {
  const expires = Date.parse(p.expires_at);
  return Math.min(now + deadlineMs, Number.isFinite(expires) ? expires : Infinity);
}

/** The claim went through: store the key and config, read the owner, and
 * return the one line to emit. Writes use the private-file writer (0600 in
 * 0700, no symlinks, temp file then rename), the same as init. */
async function finishClaim(
  p: PendingRegistration,
  ans: Extract<StatusAnswer, { kind: 'claimed' }>,
  o: Pick<PollClaimOptions, 'fetch' | 'signal' | 'ownerTimeoutMs' | 'log'>,
): Promise<string> {
  writeKey(ans.handle, p.api_key);
  const config = loadConfig();
  // One home, one server: a config that already names another Tilori
  // server is not switched under the agents that use it.
  let sameServer = true;
  if (config.url) {
    try {
      sameServer = sameEndpoint(buildMcpUrl(config.url), ans.tilori);
    } catch {
      sameServer = false;
    }
  }
  if (sameServer) {
    config.url = ans.tilori.href;
    config.market_url = ans.market.href;
  } else {
    o.log(`config.json names another Tilori server than the one @${ans.handle} was claimed on; url and market_url were left unchanged`);
  }
  config.agents ??= {};
  config.agents[ans.handle] ??= {};
  if (!config.default_agent) config.default_agent = ans.handle;
  // headers.allow for the sh-only helper is saveConfig's job (tilori-agent#91).
  saveConfig(config);
  // Name the owner (Bastion's must-have 3): a hijacked claim shows here.
  const owner = await readOwner(ans.tilori, p.api_key, ans.handle, o);
  return (owner ? LINES.live(owner, ans.handle) : LINES.connected(ans.handle)) + (sameServer ? '' : LINES.otherServer);
}

async function readOwner(
  tilori: URL,
  apiKey: string,
  handle: string,
  o: Pick<PollClaimOptions, 'fetch' | 'signal' | 'ownerTimeoutMs' | 'log'>,
): Promise<string | null> {
  const client = new TiloriAgentClient({ url: tilori, apiKey, logger: o.log, fetch: o.fetch });
  try {
    const res = await client.call<any>('get_my_profile', {}, { signal: o.signal, timeout: o.ownerTimeoutMs ?? OWNER_TIMEOUT_MS });
    const username = res?.profile?.username;
    const got = res?.profile?.handle;
    if (typeof username !== 'string' || !USERNAME.test(username) || username.length < 3 || username.length > 20) return null;
    if (got !== handle) return null;
    return username;
  } catch (cause) {
    o.log(`could not read the owner of @${handle}: ${cause instanceof Error ? cause.message : String(cause)}`);
    return null;
  } finally {
    await client.close();
  }
}

// ---------------------------------------------------------------------------
// watch: wait for a key or a registration

export interface AwaitAgentOptions extends Omit<PollClaimOptions, 'handle'> {
  /** --agent or TILORI_AGENT, if given. */
  explicit?: string;
  /** default_agent from config.json, if any. */
  configured?: string;
  waitMs?: number;
}

/**
 * The agent `watch --notify-lines` should serve, once it has a key. With a
 * pending registration (setup ran), the claim is finished first, and its
 * line is the first thing on stdout. With neither a key nor a registration,
 * it waits, checking every 10 s, so a monitor started before setup goes live
 * without a restart. Null only when the signal aborted.
 */
export async function awaitAgentKey(o: AwaitAgentOptions): Promise<string | null> {
  const wait = o.sleep ?? sleep;
  let saidWaiting = false;
  let agent = o.explicit ?? o.configured ?? null;
  while (!o.signal?.aborted) {
    if (agent && existsSync(keyPath(agent))) return agent;
    let pendingHandle: string | null = null;
    try {
      if (agent && readPending(agent)) pendingHandle = agent;
      else if (!o.explicit) pendingHandle = listPending()[0] ?? null;
    } catch (cause) {
      o.log(cause instanceof Error ? cause.message : String(cause));
    }
    if (pendingHandle) {
      const outcome = await pollClaim({ ...o, handle: pendingHandle });
      if (outcome.result === 'claimed') {
        // The claim page may have given the agent another handle; an explicit
        // --agent / TILORI_AGENT still names the session's agent.
        agent = o.explicit ?? outcome.handle;
        continue;
      }
      if (outcome.result === 'cancelled') return null;
      // Timed out, expired or unusable: wait for the next setup run.
      if (!o.explicit) agent = o.configured ?? null;
      saidWaiting = false;
    }
    if (!saidWaiting) {
      o.log(agent ? `no key for agent ${agent} yet; waiting for tilori-agent setup` : 'no agent key yet; waiting for tilori-agent setup');
      saidWaiting = true;
    }
    await wait(o.waitMs ?? WAIT_FOR_SETUP_MS, o.signal);
  }
  return null;
}
