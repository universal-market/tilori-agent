import { lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { socketPath } from './ipc.ts';
import { HANDLE_RE } from './keys.ts';

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
 */

export const DEFAULT_STALL_MINUTES = 10;
export const MAX_STALL_MINUTES = 1440;

export function activityDir(): string {
  return dirname(socketPath());
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

/** One `status` line for an agent. */
export function statusLine(handle: string, signal: PromptSignal): string {
  if (signal.blockedSince !== null) return `${handle}: blocked on a prompt since ${clock(signal.blockedSince)}`;
  if (signal.reports) return `${handle}: ok`;
  // Without a router (watch mode polling directly) nothing creates the run
  // directory, so the hooks can't report anything: say so, not "the client".
  if (!signal.tracked) return `${handle}: ok (prompts not tracked: no router running)`;
  return `${handle}: ok (this client can't report prompts)`;
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
