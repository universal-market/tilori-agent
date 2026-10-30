import { closeSync, constants, futimesSync, lstatSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { socketPath } from './ipc.ts';
import { HANDLE_RE, validateHandle } from './keys.ts';

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
 */

export const DEFAULT_STALL_MINUTES = 10;
export const MAX_STALL_MINUTES = 1440;

export function activityDir(): string {
  return dirname(socketPath());
}

export type SignalKind = 'attempting' | 'watching' | 'woke';

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
    activity,
    reports: activity !== null || at('blocked') !== null,
    router,
  };
}

/** "12 min ago (00:40 UTC)", with the date when it isn't today (UTC). */
export function ago(ms: number, now = Date.now()): string {
  const mins = Math.max(0, Math.floor((now - ms) / 60_000));
  const rel = mins < 1 ? 'just now' : mins < 120 ? `${mins} min ago` : `${Math.floor(mins / 60)} h ago`;
  const iso = new Date(ms).toISOString();
  const day = iso.slice(0, 10) === new Date(now).toISOString().slice(0, 10) ? '' : `${iso.slice(0, 10)} `;
  return `${rel} (${day}${iso.slice(11, 16)} UTC)`;
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
  opts: { now?: number; stallMinutes?: number } = {},
): string {
  const now = opts.now ?? Date.now();
  if (signal.blockedSince !== null) return `${handle}: blocked on a prompt since ${clock(signal.blockedSince)}`;
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
    return `${handle}: not watched since ${ago(watch.watching, now)}: ${why}`;
  }
  let wake = 'no wakes yet';
  if (watch.woke !== null) {
    wake = `last wake ${ago(watch.woke, now)}`;
    const stallMs = (opts.stallMinutes || DEFAULT_STALL_MINUTES) * 60_000;
    if (watch.activity !== null && watch.activity >= watch.woke) wake += ', acted since';
    else if (watch.reports)
      wake += now - watch.woke < stallMs ? ', no action yet' : `, no action for ${Math.floor((now - watch.woke) / 60_000)} min`;
  }
  return `${handle}: watched; ${wake} (${watch.router ? 'router' : 'direct'})`;
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
