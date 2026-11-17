import { spawn } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { writePrivateFile } from './keys.ts';
import type { EventRef, ThreadLabel } from './types.ts';

/**
 * `wake_filter` (UNI-1029): an opt-in, operator-configured command that the
 * router asks, per batch, whether each event should wake the agent now, wait
 * for a digest wake, or be dropped. The filter sees kinds and ids only, as the
 * wake line does; whatever it reads beyond that it fetches itself.
 *
 * Safety (Bastion 10ebe17a): the command comes from local config.json only;
 * it runs with a minimal environment (no TILORI_*, no keys), from a fixed cwd,
 * in its own process group that is killed whole on timeout; its output is
 * bounded and matched to the batch; and any failure wakes as if there were no
 * filter (fail open). Floors the router enforces after the filter are in
 * router.ts.
 */

export const FILTER_ACTIONS = ['wake', 'digest', 'drop'] as const;
export type FilterAction = (typeof FILTER_ACTIONS)[number];

/** Why a filter held or dropped an item: a fixed list, so the wake line never
 * carries filter-chosen text (Juniper f843e173 3). Anything else is `other`. */
export const FILTER_REASONS = ['claim', 'joined', 'ack', 'fyi', 'progress', 'verdict_other', 'other'] as const;
export type FilterReason = (typeof FILTER_REASONS)[number];

/** Most waking first: when two decisions name one key, the earlier wins. */
const ACTION_RANK: Record<FilterAction, number> = { wake: 2, digest: 1, drop: 0 };

export const DEFAULT_FILTER_TIMEOUT_SECONDS = 30;
export const MAX_FILTER_TIMEOUT_SECONDS = 60;
export const DEFAULT_DIGEST_MINUTES = 30;
export const MIN_DIGEST_MINUTES = 5;
export const MAX_DIGEST_MINUTES = 240;
/** Most bytes read from the filter's stdout; more is a failure. */
export const MAX_FILTER_OUTPUT = 64 * 1024;
/** Most events handed to one filter run; a larger batch skips the filter. */
export const MAX_FILTER_EVENTS = 200;
/** The filter's whole environment, besides HOME and LANG. */
export const FILTER_PATH = '/usr/local/bin:/usr/bin:/bin';
/** The filter's working directory: outside any checkout. */
export const FILTER_CWD = '/';

export interface WakeFilterSettings {
  /** argv, no shell. The first entry is an absolute path to an executable. */
  command: string[];
  timeout_seconds?: number;
  digest_minutes?: number;
}

/** A validated filter, as the router uses it. */
export interface WakeFilter {
  /** argv with the program resolved by realpath at load. */
  argv: string[];
  timeoutMs: number;
  digestMs: number;
}

function wholeIn(name: string, value: unknown, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    throw new Error(`wake_filter.${name} must be a whole number from ${min} to ${max}.`);
  return value;
}

const worldWritable = (mode: number) => (mode & 0o002) !== 0;

/**
 * Validates `wake_filter` from config.json; undefined when unset. Throws on
 * anything doubtful, so a typo never runs the wrong program and never
 * silently turns the filter off. `stat` is a test seam.
 */
export function wakeFilterSettings(
  value: unknown,
  stat: (path: string) => { isFile(): boolean; mode: number } = statSync,
  realpath: (path: string) => string = (p) => realpathSync.native(p),
): WakeFilter | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('wake_filter must be an object.');
  const s = value as Record<string, unknown>;
  for (const key of Object.keys(s))
    if (!['command', 'timeout_seconds', 'digest_minutes'].includes(key)) throw new Error(`wake_filter.${key} is not a setting.`);
  const command = s.command;
  if (
    !Array.isArray(command) ||
    command.length < 1 ||
    command.length > 32 ||
    !command.every((a) => typeof a === 'string' && a.length > 0 && a.length <= 1024 && !a.includes('\0'))
  )
    throw new Error('wake_filter.command must be a list of 1 to 32 non-empty strings (argv, no shell).');
  const program = command[0] as string;
  if (!isAbsolute(program)) throw new Error('wake_filter.command[0] must be an absolute path.');
  let resolved: string;
  try {
    resolved = realpath(program);
  } catch {
    throw new Error('wake_filter.command[0] does not exist.');
  }
  const file = stat(resolved);
  if (!file.isFile()) throw new Error('wake_filter.command[0] must be a file.');
  if ((file.mode & 0o111) === 0) throw new Error('wake_filter.command[0] is not executable.');
  if (worldWritable(file.mode)) throw new Error('wake_filter.command[0] is world-writable.');
  // Every directory up to the root: a writable one lets anyone swap the file.
  for (let dir = dirname(resolved); ; dir = dirname(dir)) {
    const d = stat(dir);
    // The sticky bit (/tmp) still lets anyone add a file, so it doesn't help.
    if (worldWritable(d.mode)) throw new Error(`wake_filter.command[0] is in a world-writable directory (${dir}).`);
    if (dir === dirname(dir)) break;
  }
  return {
    argv: [resolved, ...(command.slice(1) as string[])],
    timeoutMs: wholeIn('timeout_seconds', s.timeout_seconds, 1, MAX_FILTER_TIMEOUT_SECONDS, DEFAULT_FILTER_TIMEOUT_SECONDS) * 1000,
    digestMs: wholeIn('digest_minutes', s.digest_minutes, MIN_DIGEST_MINUTES, MAX_DIGEST_MINUTES, DEFAULT_DIGEST_MINUTES) * 60_000,
  };
}

/** Only these kinds can be held or dropped; anything else (a mention, an
 * unknown kind) always wakes. Mentions always wake in v1 (Juniper f843e173 1,
 * Keel 119c821c); the filter still sees them, marked `forced`, so its log can
 * show what it would have done. */
export const FILTERABLE_KINDS: ReadonlySet<string> = new Set(['post.created', 'post.edited']);
/** Most get_post author checks per filter run; past it, every demoted post wakes. */
export const MAX_FLOOR_READS = 20;
/** Most posts held for one digest; past it, a post the filter would hold wakes instead. */
export const MAX_DIGEST_ITEMS = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** A post held for the next digest wake: ids, a fixed kind and reason. */
export interface DigestItem {
  event_id: string;
  kind: 'post.created' | 'post.edited';
  entity_id: string;
  parent?: string;
  reason: FilterReason;
  /** When it was held, epoch ms. */
  at: number;
  to_you?: true;
  thread?: ThreadLabel;
}

export function digestItem(ref: EventRef, reason: FilterReason, parent: unknown, at: number): DigestItem | null {
  if (!FILTERABLE_KINDS.has(ref.kind) || !isUuid(ref.id) || !isUuid(ref.entity_id)) return null;
  return {
    event_id: ref.id,
    kind: ref.kind as DigestItem['kind'],
    entity_id: ref.entity_id,
    ...(isUuid(parent) ? { parent } : {}),
    reason,
    at,
    ...(ref.to_you ? { to_you: true as const } : {}),
    ...(ref.thread ? { thread: ref.thread } : {}),
  };
}

export function digestRef(item: DigestItem): EventRef {
  return {
    id: item.event_id,
    kind: item.kind,
    entity_type: 'post',
    entity_id: item.entity_id,
    held: item.reason,
    ...(item.to_you ? { to_you: true as const } : {}),
    ...(item.thread && !item.to_you ? { thread: item.thread } : {}),
  };
}

const digestPath = (dir: string, handle: string) => join(dir, `digest-${handle}.json`);
const THREADS: ReadonlySet<string> = new Set(['started', 'claimed', 'handoff']);

/** The held digest from the run directory, re-validated item by item: a
 * restart still delivers what was held (its batches were acknowledged). Any
 * problem reads as empty. */
export function loadDigest(dir: string, handle: string): DigestItem[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(digestPath(dir, handle), 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: DigestItem[] = [];
  for (const r of raw.slice(0, MAX_DIGEST_ITEMS) as any[]) {
    if (!r || !isUuid(r.event_id) || !isUuid(r.entity_id) || !FILTERABLE_KINDS.has(r.kind)) continue;
    if (!(FILTER_REASONS as readonly unknown[]).includes(r.reason) || !Number.isInteger(r.at)) continue;
    out.push({
      event_id: r.event_id,
      kind: r.kind,
      entity_id: r.entity_id,
      ...(isUuid(r.parent) ? { parent: r.parent } : {}),
      reason: r.reason,
      at: r.at,
      ...(r.to_you === true ? { to_you: true as const } : {}),
      ...(THREADS.has(r.thread) ? { thread: r.thread } : {}),
    });
  }
  return out;
}

/** Writes the held digest (0600, atomic). Returns false on failure: the
 * digest still goes out from memory, only a restart would lose it. */
export function saveDigest(dir: string, handle: string, items: DigestItem[]): boolean {
  try {
    writePrivateFile(digestPath(dir, handle), JSON.stringify(items) + '\n');
    return true;
  } catch {
    return false;
  }
}

/** One event as the filter sees it: ids, kind and where it came from. */
export interface FilterEvent {
  key: string;
  kind: string;
  entity_type: string;
  entity_id: string;
  parent_post_id?: string;
  created_at: string;
  /** Came in on the agent's own inbox or mentions subscription. */
  direct: boolean;
  /** The router wakes for this event whatever the filter says. */
  forced: boolean;
}

export interface FilterInput {
  v: 1;
  agent: { id?: string; handle: string };
  wake_id: string;
  events: FilterEvent[];
}

export interface FilterDecision {
  action: FilterAction;
  reason?: FilterReason;
}

/** Why a run gave no decisions: a class only, never the filter's own text. */
export type FilterFailure = 'spawn' | 'timeout' | 'exit' | 'output' | 'too_large' | 'stopped';

export type FilterResult = { ok: true; decisions: Map<string, FilterDecision> } | { ok: false; why: FilterFailure };

/**
 * Parses the filter's stdout against the batch's keys. Keys not in the batch
 * are ignored; an unknown action means `wake`; an unknown reason is `other`;
 * when a key appears twice, the more waking action stands. Keys the filter
 * leaves out are absent (the router treats them as `wake`).
 */
export function parseDecisions(stdout: string, keys: ReadonlySet<string>): Map<string, FilterDecision> | null {
  let raw: any;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || raw.v !== 1 || !Array.isArray(raw.decisions)) return null;
  const out = new Map<string, FilterDecision>();
  for (const d of raw.decisions.slice(0, MAX_FILTER_EVENTS * 4)) {
    if (!d || typeof d !== 'object' || typeof d.key !== 'string' || !keys.has(d.key)) continue;
    const action: FilterAction = (FILTER_ACTIONS as readonly unknown[]).includes(d.action) ? d.action : 'wake';
    const decision: FilterDecision = { action };
    if (action !== 'wake')
      decision.reason = (FILTER_REASONS as readonly unknown[]).includes(d.reason) ? (d.reason as FilterReason) : 'other';
    const prev = out.get(d.key);
    if (!prev || ACTION_RANK[action] > ACTION_RANK[prev.action]) out.set(d.key, decision);
  }
  return out;
}

/** The filter's whole environment (Bastion 10ebe17a 1): nothing inherited
 * besides HOME and LANG, so no key, token or TILORI_* setting reaches it. */
export function filterEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = { PATH: FILTER_PATH };
  if (source.HOME) env.HOME = source.HOME;
  env.LANG = source.LANG || 'C.UTF-8';
  return env;
}

/**
 * Runs the filter once on a batch. Resolves with decisions, or with a failure
 * class; never rejects. On timeout, oversized output or a stop, the filter's
 * whole process group is killed (Bastion 10ebe17a 2).
 */
export function runFilter(filter: WakeFilter, input: FilterInput, signal?: AbortSignal): Promise<FilterResult> {
  if (input.events.length > MAX_FILTER_EVENTS) return Promise.resolve({ ok: false, why: 'too_large' });
  if (signal?.aborted) return Promise.resolve({ ok: false, why: 'stopped' });
  const keys = new Set(input.events.map((e) => e.key));
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(filter.argv[0], filter.argv.slice(1), {
        stdio: ['pipe', 'pipe', 'ignore'],
        env: filterEnv(),
        cwd: FILTER_CWD,
        detached: true,
        shell: false,
      });
    } catch {
      resolve({ ok: false, why: 'spawn' });
      return;
    }
    let done = false;
    let out = '';
    let bytes = 0;
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    };
    const finish = (r: FilterResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onStop);
      // Always kill the group, also after a clean exit: a child the filter
      // forked may outlive it with stdout closed (Bastion 10ebe17a 2). The
      // group id can't be reused while any member lives; once none does, the
      // kill finds no group (Pax f7590420 4: reuse in that gap is
      // theoretical, and leaving a forked `claude -p` running is not).
      killGroup();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, why: 'timeout' }), filter.timeoutMs);
    const onStop = () => finish({ ok: false, why: 'stopped' });
    signal?.addEventListener('abort', onStop, { once: true });
    child.on('error', () => finish({ ok: false, why: 'spawn' }));
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_FILTER_OUTPUT) return finish({ ok: false, why: 'output' });
      out += chunk;
    });
    let exitCode: number | null | undefined;
    const settle = () => {
      if (exitCode === undefined) return;
      if (exitCode !== 0) return finish({ ok: false, why: 'exit' });
      const decisions = parseDecisions(out, keys);
      finish(decisions ? { ok: true, decisions } : { ok: false, why: 'output' });
    };
    let ended = false;
    child.stdout!.on('end', () => {
      ended = true;
      settle();
    });
    child.on('exit', (code) => {
      exitCode = code;
      if (code !== 0 || ended) return settle();
      // Normally stdout ends with the filter. A child it forked may hold
      // stdout open: then parse what arrived after a short grace, and the
      // group kill in finish() ends that child.
      setTimeout(settle, 1000);
    });
    child.stdin!.on('error', () => {});
    child.stdin!.end(JSON.stringify(input) + '\n');
  });
}
