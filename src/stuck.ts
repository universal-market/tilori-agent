/**
 * UNI-694: tell someone when an agent has been stuck on a prompt.
 *
 * The plugin's prompt-signal hook touches `blocked-<agent>` when Claude Code
 * shows a permission or elicitation prompt and `activity-<agent>` after each
 * tool call (activity.ts). An agent is stuck from the blocked file's time
 * while no activity is newer. After `stuck_alert.minutes` of that, the router
 * alerts once per episode (one episode = one blocked time):
 *
 * - always, one line in `<run dir>/alerts.log` (0600, never through a
 *   symlink), and the optional `stuck_alert.exec` argv, run without a shell
 *   with only TILORI_STUCK_AGENT, TILORI_STUCK_SINCE and TILORI_STUCK_MINUTES
 *   in its environment and a timeout;
 * - when `stuck_alert.parent_post_id` is set, one Tilori reply under it,
 *   posted as the stuck agent with its own key, mentioning
 *   `stuck_alert.mention`. Its idempotency key is `stuck-<agent>-<since>`, so
 *   a restart doesn't post the same episode twice. A failed post is logged
 *   once and not retried.
 *
 * At most MAX_ALERTS_PER_DAY alerts per agent per rolling day (posts share
 * the account's daily post budget). The text is fixed apart from the handle
 * and times: the hook never reads the prompt, so there is nothing else to
 * leak. Settings come from config.json only (edited by hand), never from
 * Tilori content.
 */
import { execFile } from 'node:child_process';
import { closeSync, constants, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { clock, promptSignal } from './activity.ts';

export const DEFAULT_STUCK_MINUTES = 30;
export const MIN_STUCK_MINUTES = 5;
export const MAX_STUCK_MINUTES = 1440;
export const MAX_ALERTS_PER_DAY = 6;
export const EXEC_TIMEOUT_MS = 10_000;
const DAY_MS = 24 * 3600_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `@user.agent` or `@user`, the same name rules as Tilori handles. */
const MENTION_RE = /^@[a-z0-9][a-z0-9_-]{0,63}(\.[a-z0-9][a-z0-9_-]{0,63})?$/i;

/** `stuck_alert` in config.json (top level: one setting for every agent). */
export interface StuckAlertSettings {
  minutes?: number;
  parent_post_id?: string;
  mention?: string;
  /** argv; the first entry an absolute path. Run without a shell. */
  exec?: string[];
}

/** Validated settings, as the router uses them. */
export interface StuckAlert {
  minutes: number;
  parentPostId: string | null;
  mention: string | null;
  exec: string[] | null;
}

/** null when `stuck_alert` is unset (off). Throws on a bad value. */
export function stuckAlertSettings(value: unknown): StuckAlert | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('stuck_alert must be an object.');
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (!['minutes', 'parent_post_id', 'mention', 'exec'].includes(key)) throw new Error(`stuck_alert has an unknown key: ${key}.`);
  }
  const minutes = v.minutes ?? DEFAULT_STUCK_MINUTES;
  if (!Number.isInteger(minutes) || (minutes as number) < MIN_STUCK_MINUTES || (minutes as number) > MAX_STUCK_MINUTES) {
    throw new Error(`stuck_alert.minutes must be an integer from ${MIN_STUCK_MINUTES} to ${MAX_STUCK_MINUTES}.`);
  }
  const parent = v.parent_post_id ?? null;
  if (parent !== null && (typeof parent !== 'string' || !UUID_RE.test(parent))) {
    throw new Error('stuck_alert.parent_post_id must be a full post UUID.');
  }
  const mention = v.mention ?? null;
  if (mention !== null && (typeof mention !== 'string' || !MENTION_RE.test(mention))) {
    throw new Error('stuck_alert.mention must be one @user.agent or @user.');
  }
  const exec = v.exec ?? null;
  if (
    exec !== null &&
    (!Array.isArray(exec) ||
      !exec.length ||
      exec.length > 16 ||
      !exec.every((a) => typeof a === 'string' && a.length > 0 && a.length <= 4096 && !a.includes('\0')) ||
      !(exec[0] as string).startsWith('/'))
  ) {
    throw new Error('stuck_alert.exec must be an argv array whose first entry is an absolute path.');
  }
  return {
    minutes: minutes as number,
    parentPostId: parent as string | null,
    mention: mention as string | null,
    exec: exec as string[] | null,
  };
}

/** For the router and watchers: a bad `stuck_alert` is logged and turns the
 * alert off, so a typo there never stops wakes. */
export function stuckAlertOrOff(value: unknown, log: (m: string) => void): StuckAlert | null {
  try {
    return stuckAlertSettings(value);
  } catch (cause) {
    log(`stuck_alert is off: ${cause instanceof Error ? cause.message : String(cause)}`);
    return null;
  }
}

export interface StuckPost {
  parent_post_id: string;
  title: string;
  body: string;
  idempotency_key: string;
}

/** The fixed alert text: handle, times and the configured mention only. */
export function stuckPost(handle: string, since: number, now: number, alert: StuckAlert): StuckPost {
  const minutes = Math.floor((now - since) / 60_000);
  const who = alert.mention ? `${alert.mention} ` : '';
  return {
    parent_post_id: alert.parentPostId!,
    title: `Stuck: ${handle} blocked on a prompt since ${clock(since)}`,
    body:
      `${who}${handle} has been blocked on a prompt since ${clock(since)} (${minutes} min) and has made no tool call since. ` +
      'Nothing else is known: the plugin never reads the prompt. Someone needs to answer it in that session. ' +
      '(tilori-agent stuck_alert)',
    idempotency_key: `stuck-${handle}-${since}`,
  };
}

/** Appends one line to `<dir>/alerts.log`: created 0600, never through a
 * symlink (O_NOFOLLOW). The run directory itself is created 0700 by the
 * router. Throws on failure. */
export function appendAlert(dir: string, line: string): void {
  const fd = openSync(
    join(dir, 'alerts.log'),
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    writeSync(fd, line.endsWith('\n') ? line : line + '\n');
  } finally {
    closeSync(fd);
  }
}

export type ExecRunner = (argv: string[], env: Record<string, string>, timeoutMs: number) => Promise<void>;

/** execFile, never a shell; only `env` is passed (nothing inherited). */
export const runExec: ExecRunner = (argv, env, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(argv[0], argv.slice(1), { env, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 }, (err) =>
      err ? reject(err) : resolve(),
    );
  });

export interface StuckWatchOptions {
  handle: string;
  alert: StuckAlert;
  /** The run directory: where prompt-signal writes and alerts.log goes. */
  dir: string;
  /** Posts as this agent (its own key). */
  post: (post: StuckPost) => Promise<void>;
  log: (m: string) => void;
  now?: () => number;
  exec?: ExecRunner;
}

/** One agent's stuck-prompt watch. `check()` is called on a timer. */
export class StuckWatch {
  readonly #o: StuckWatchOptions;
  #alertedSince = 0;
  readonly #sent: number[] = [];
  #busy = false;

  constructor(options: StuckWatchOptions) {
    this.#o = options;
  }

  /** Alerts at most once per blocked episode. Returns whether it alerted. */
  async check(): Promise<boolean> {
    if (this.#busy) return false;
    const { handle, alert, dir, log } = this.#o;
    const now = (this.#o.now ?? Date.now)();
    const { blockedSince } = promptSignal(handle, dir);
    if (blockedSince === null || blockedSince === this.#alertedSince) return false;
    if (now - blockedSince < alert.minutes * 60_000) return false;
    // This episode is decided now, alerted or capped: never again.
    this.#alertedSince = blockedSince;
    while (this.#sent.length && now - this.#sent[0] >= DAY_MS) this.#sent.shift();
    if (this.#sent.length >= MAX_ALERTS_PER_DAY) {
      log(`[${handle}] stuck on a prompt since ${clock(blockedSince)}; not alerting (${MAX_ALERTS_PER_DAY} alerts in the last day)`);
      return false;
    }
    this.#sent.push(now);
    this.#busy = true;
    try {
      const minutes = Math.floor((now - blockedSince) / 60_000);
      const since = new Date(blockedSince).toISOString();
      log(`[${handle}] stuck on a prompt since ${clock(blockedSince)} (${minutes} min); alerting`);
      try {
        appendAlert(dir, `${new Date(now).toISOString()} ${handle} blocked on a prompt since ${since} (${minutes} min)`);
      } catch (cause) {
        log(`[${handle}] could not write alerts.log: ${errText(cause)}`);
      }
      if (alert.exec) {
        const env = { TILORI_STUCK_AGENT: handle, TILORI_STUCK_SINCE: since, TILORI_STUCK_MINUTES: String(minutes) };
        try {
          await (this.#o.exec ?? runExec)(alert.exec, env, EXEC_TIMEOUT_MS);
        } catch (cause) {
          log(`[${handle}] stuck_alert.exec failed: ${errText(cause)}`);
        }
      }
      if (alert.parentPostId) {
        try {
          await this.#o.post(stuckPost(handle, blockedSince, now, alert));
          log(`[${handle}] stuck alert posted on Tilori`);
        } catch (cause) {
          log(`[${handle}] stuck alert not posted on Tilori (not retried): ${errText(cause)}`);
        }
      }
      return true;
    } finally {
      this.#busy = false;
    }
  }
}

function errText(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.length > 200 ? text.slice(0, 200) + '…' : text;
}
