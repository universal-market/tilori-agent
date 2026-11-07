import { closeSync, constants, futimesSync, lstatSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { socketPath } from './ipc.ts';
import { HANDLE_RE, validateHandle } from './keys.ts';
import type { PushState, PushStatus } from './push.ts';

/**
 * Whether a session is stuck on a prompt (S1). The host plugin's hooks touch
 * two empty files in the router's own 0700 run directory, next to
 * router.sock, with shell builtins only (no tilori-agent process, nothing
 * read from the hook's input):
 *
 *   activity-<agent>  after every tool call (PostToolUse)
 *   blocked-<agent>   when the session shows a permission or elicitation prompt
 *
 * Only the router creates the directory; the hooks do nothing when it is
 * missing. Here only the two mtimes are read: the agent is blocked while
 * `blocked` is newer than `activity`. A denied prompt fires no PostToolUse,
 * so it stays blocked until the next tool call. A client without these hooks
 * (no files) is never flagged.
 *
 * Whoever polls Tilori for the agent (the router, or `watch` polling
 * directly) touches three more, so `status` can say whether anything is
 * watching it and whether the session acted on its last wake:
 *
 *   attempting-<agent>  before each poll
 *   watching-<agent>    after each poll that got an authenticated answer
 *   woke-<agent>        after a wake line was accepted (flushed) by the session
 *
 * With push on (push.ts) the router also writes one small JSON file:
 *
 *   push-<agent>        {"state", "since", "next"?}: the push stream's state
 */

export const DEFAULT_STALL_MINUTES = 10;
export const MAX_STALL_MINUTES = 1440;

export function activityDir(): string {
  return dirname(socketPath());
}

export type SignalKind = 'attempting' | 'watching' | 'woke' | 'rejected';

/** Sets `<kind>-<agent>` in the run directory to now. The file is opened
 * without following a symlink, created 0600 if missing, and its times set
 * through the descriptor. Throws on failure; callers treat it as best effort. */
export function touchSignal(dir: string, kind: SignalKind, handle: string): void {
  const path = join(dir, `${kind}-${validateHandle(handle)}`);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const now = new Date();
    futimesSync(fd, now, now);
  } finally {
    closeSync(fd);
  }
}

/** Writes `push-<agent>`: the push stream's state, for `status`. Opened like
 * a signal (no symlink, 0600) and truncated; throws on failure (best effort). */
export function writePushSignal(dir: string, handle: string, s: PushStatus): void {
  const path = join(dir, `push-${validateHandle(handle)}`);
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    writeSync(fd, JSON.stringify({ state: s.state, since: s.since, ...(s.next !== undefined ? { next: s.next } : {}) }));
  } finally {
    closeSync(fd);
  }
}

const PUSH_STATES = new Set<PushState>(['connecting', 'live', 'reconnecting', 'down', 'refused']);

/** `push-<agent>` as written by a router, or null: missing, not this user's
 * regular file, too big, or not a valid state. */
export function readPushSignal(handle: string, dir = activityDir()): (PushStatus & { at: number }) | null {
  if (!HANDLE_RE.test(handle)) return null;
  const path = join(dir, `push-${handle}`);
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > 512) return null;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return null;
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!PUSH_STATES.has(raw?.state) || !Number.isInteger(raw.since)) return null;
    return {
      state: raw.state,
      since: raw.since,
      ...(Number.isInteger(raw.next) ? { next: raw.next } : {}),
      at: st.mtimeMs,
    };
  } catch {
    return null;
  }
}

/** The router rewrites `push-` at every attempt, at least every 5 min
 * while push is out; older than this, no router is running it. */
export const PUSH_FRESH_MS = 7 * 60_000;

/** Juniper's push chip: "push live", "push reconnecting · next try 2 min",
 * "push down since 14:03 UTC · next try 4 min", "push refused · access".
 * Null when push is off or no running router keeps the file fresh. */
export function pushChip(s: (PushStatus & { at: number }) | null, now = Date.now()): string | null {
  if (!s || now - s.at >= PUSH_FRESH_MS) return null;
  const next = s.next !== undefined ? ` · next try ${s.next <= now ? 'now' : span(Math.max(60_000, s.next - now))}` : '';
  switch (s.state) {
    case 'live':
      return 'push live';
    case 'connecting':
      return 'push connecting';
    case 'reconnecting':
      return `push reconnecting${next}`;
    case 'down':
      return `push down since ${clock(s.since)}${next}`;
    case 'refused':
      return 'push refused · access';
  }
}

/** A signal file's mtime (ms), or null unless it is a regular file owned by
 * this user. Symlinks and other users' files are ignored. */
function mtime(path: string): number | null {
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return null;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return null;
    return st.mtimeMs;
  } catch {
    return null;
  }
}

function isDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

export interface PromptSignal {
  /** Since when the agent has been blocked on a prompt, or null. */
  blockedSince: number | null;
  /** Whether this client reports prompts at all (either file exists). */
  reports: boolean;
  /** Whether the run directory exists (only a router creates it). */
  tracked: boolean;
}

export function promptSignal(handle: string, dir = activityDir()): PromptSignal {
  const tracked = isDir(dir);
  if (!HANDLE_RE.test(handle)) return { blockedSince: null, reports: false, tracked };
  const blocked = mtime(join(dir, `blocked-${handle}`));
  const activity = mtime(join(dir, `activity-${handle}`));
  const reports = blocked !== null || activity !== null;
  if (blocked === null || (activity !== null && activity >= blocked)) return { blockedSince: null, reports, tracked };
  return { blockedSince: blocked, reports, tracked };
}

/** "02:05 UTC" */
export const clock = (ms: number) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;

/** How recently a poll must have succeeded for the agent to count as
 * watched. A long poll waits at most 25 s, then the next one starts. */
export const WATCHED_MS = 120_000;

export interface WatchSignal {
  attempting: number | null;
  watching: number | null;
  woke: number | null;
  /** The last time the server refused the agent's key (`rejected-`, UNI-761). */
  rejected?: number | null;
  /** The last tool call (`activity-`), for "acted since". */
  activity: number | null;
  /** Whether this client's hooks report tool calls at all. */
  reports: boolean;
  /** Whether a router's socket is present (else `watch` polls directly). */
  router: boolean;
}

export function watchSignal(handle: string, dir = activityDir(), router = false): WatchSignal {
  const at = (kind: string) => (HANDLE_RE.test(handle) ? mtime(join(dir, `${kind}-${handle}`)) : null);
  const activity = at('activity');
  return {
    attempting: at('attempting'),
    watching: at('watching'),
    woke: at('woke'),
    rejected: at('rejected'),
    activity,
    reports: activity !== null || at('blocked') !== null,
    router,
  };
}

/** "12 min", or "9 h" from two hours on. */
export function span(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60_000));
  return mins < 120 ? `${mins} min` : `${Math.floor(mins / 60)} h`;
}

/** "00:40 UTC", with the date when it isn't today (UTC). */
function at(ms: number, now: number): string {
  const iso = new Date(ms).toISOString();
  const day = iso.slice(0, 10) === new Date(now).toISOString().slice(0, 10) ? '' : `${iso.slice(0, 10)} `;
  return `${day}${iso.slice(11, 16)} UTC`;
}

/** "12 min ago (00:40 UTC)". */
export function ago(ms: number, now = Date.now()): string {
  return `${now - ms < 60_000 ? 'just now' : `${span(now - ms)} ago`} (${at(ms, now)})`;
}

const START_IT =
  'nothing is pushed to this agent. Start its monitor (in Claude Code, restart the session) or router, or check Tilori yourself with whats_new.';
const CHECK = "check the agent's key and network (the tilori-agent log says which).";
const FAILING = `a monitor or router is running, but its polls are failing; ${CHECK}`;

/** One `status` line for an agent: whether anything is watching it, its
 * last wake and whether the session acted since, or the prompt it is
 * blocked on. Built from file times only. */
export function statusLine(
  handle: string,
  signal: PromptSignal,
  watch: WatchSignal,
  opts: { now?: number; stallMinutes?: number; push?: (PushStatus & { at: number }) | null } = {},
): string {
  const now = opts.now ?? Date.now();
  if (signal.blockedSince !== null) return `${handle}: blocked on a prompt since ${clock(signal.blockedSince)}`;
  const chip = pushChip(opts.push ?? null, now);
  // Push mode polls only on push, so a push that is out explains an
  // unwatched agent better than "nothing is running".
  if (chip && opts.push!.state !== 'live')
    return opts.push!.state === 'refused'
      ? `${handle}: ${chip}: Tilori refused the agent's key for push; ${CHECK}`
      : `${handle}: ${chip}; wakes may be late until it's back. Nothing polls meanwhile: call whats_new or poll_events yourself if you're waiting on something.`;
  // A watcher whose key is refused retries once a minute (UNI-761): while
  // that's fresh and newer than its last good poll, say so, not "never watched".
  const refusedAt = watch.rejected ?? null;
  const rejected = refusedAt !== null && now - refusedAt < WATCHED_MS && (watch.watching ?? 0) < refusedAt;
  if (rejected)
    return `${handle}: stopped: Tilori refused the agent's key (HTTP 401). Re-run tilori-agent init --agent ${handle} with the agent's key; the watcher picks it up within a minute.`;
  const failing = watch.attempting !== null && now - watch.attempting < WATCHED_MS;
  if (watch.watching === null) {
    // A first long poll can take 25 s to answer, so a fresh attempt with no
    // success yet may just be starting.
    return failing
      ? `${handle}: never watched on this machine: a monitor or router is polling, but no poll has succeeded yet; if this lasts more than a minute, ${CHECK}`
      : `${handle}: never watched on this machine: ${START_IT}`;
  }
  if (now - watch.watching >= WATCHED_MS) {
    const why = failing && watch.attempting! > watch.watching ? FAILING : START_IT;
    return `${handle}: not watched for ${span(now - watch.watching)} (since ${at(watch.watching, now)}): ${why}`;
  }
  let wake = 'no wakes yet';
  if (watch.woke !== null) {
    wake = `last wake ${ago(watch.woke, now)}`;
    // stall_minutes 0 turns off the router's log line only; status still
    // needs a point at which "no action yet" becomes "no action for".
    const stallMs = (opts.stallMinutes || DEFAULT_STALL_MINUTES) * 60_000;
    if (watch.activity !== null && watch.activity >= watch.woke) wake += ', acted since';
    else if (watch.reports)
      wake += now - watch.woke < stallMs ? ', no action yet' : `, no action for ${span(now - watch.woke)}`;
  }
  const how = chip ? chip : watch.router ? 'polled by the router' : 'polled directly';
  return `${handle}: watched; ${wake}; ${how}`;
}

/** Validates `stall_minutes` (default 10; 0 turns the stall line off; at
 * most a day). Throws on a bad value, so a typo never silently turns it off. */
export function stallMinutes(value: unknown): number {
  if (value === undefined) return DEFAULT_STALL_MINUTES;
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > MAX_STALL_MINUTES) {
    throw new Error(`stall_minutes must be an integer from 0 to ${MAX_STALL_MINUTES}.`);
  }
  return value as number;
}
