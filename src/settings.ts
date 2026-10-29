import { watch } from 'node:fs';
import { basename, dirname } from 'node:path';
import { DEFAULT_STALL_MINUTES, MAX_STALL_MINUTES, stallMinutes } from './activity.ts';
import {
  DEFAULT_DIRECT_WAKES_PER_HOUR,
  DEFAULT_WAKES_PER_HOUR,
  MIN_REMINDER_MINUTES,
  configPath,
  loadConfig,
  reminderSettings,
  saveConfig,
  type AgentSettings,
  type TiloriConfig,
} from './config.ts';
import type { AgentUsage, Router } from './router.ts';

/**
 * `tilori-agent config` (UNI-480): the few per-agent settings an owner may
 * change from the CLI or `/tilori:config`, and live reload of exactly those.
 *
 * Everything else in config.json (url, exec, injector, inbox,
 * direct_messages, subscriptions, trusted_owners, the agent binding) stays
 * hand-edit-only and still needs a restart: those decide where a key goes,
 * what runs and what can wake an agent. A `set` or `reset` changes one field
 * and writes every other key back as it was.
 */

export interface Settable {
  key: string;
  /** Lowest and highest value `set` accepts. Hand edits may go further where
   * the router allows it; these bound what the CLI (and so an agent) writes. */
  min: number;
  max: number;
  /** The value when unset, or null when unsetting is not allowed. */
  fallback: number | null;
  note: string;
  get(s: AgentSettings): number | undefined;
  put(s: AgentSettings, value: number | undefined): void;
}

const MAX_SET_WAKES = 60;
const MAX_SET_DIRECT = 30;
const MAX_REMINDER_MINUTES = 1440;

export const SETTABLE: readonly Settable[] = [
  {
    key: 'wakes_per_hour',
    min: 1,
    max: MAX_SET_WAKES,
    fallback: DEFAULT_WAKES_PER_HOUR,
    note: 'wakes per rolling hour',
    get: (s) => s.wakes_per_hour,
    put: (s, v) => (v === undefined ? delete s.wakes_per_hour : (s.wakes_per_hour = v)),
  },
  {
    key: 'direct_wakes_per_hour',
    min: 0,
    max: MAX_SET_DIRECT,
    fallback: DEFAULT_DIRECT_WAKES_PER_HOUR,
    note: 'extra wakes for mentions and DMs past the cap; 0 = off',
    get: (s) => s.direct_wakes_per_hour,
    put: (s, v) => (v === undefined ? delete s.direct_wakes_per_hour : (s.direct_wakes_per_hour = v)),
  },
  {
    key: 'reminder.every_minutes',
    min: MIN_REMINDER_MINUTES,
    max: MAX_REMINDER_MINUTES,
    // A reminder needs its text, which only a hand edit sets; so does turning it off.
    fallback: null,
    note: 'minutes between reminders; the reminder itself is set up by hand',
    get: (s) => s.reminder?.every_minutes,
    put: (s, v) => {
      if (!s.reminder || v === undefined) throw new Error('reminder.every_minutes needs a reminder set up by hand in config.json.');
      s.reminder.every_minutes = v;
    },
  },
  {
    key: 'stall_minutes',
    min: 0,
    max: MAX_STALL_MINUTES,
    fallback: DEFAULT_STALL_MINUTES,
    note: 'minutes blocked on a prompt before the router logs it; 0 = off',
    get: (s) => s.stall_minutes,
    put: (s, v) => (v === undefined ? delete s.stall_minutes : (s.stall_minutes = v)),
  },
];

function settable(key: string): Settable {
  const k = SETTABLE.find((x) => x.key === key);
  if (!k) throw new Error(`${key} can't be set here. Settable: ${SETTABLE.map((x) => x.key).join(', ')}.`);
  return k;
}

/** `key=value` with a decimal integer value, checked against the key's bounds. */
export function parseAssignment(arg: string): { key: Settable; value: number } {
  const m = /^([a-z_.]{1,40})=(\d{1,5})$/.exec(arg);
  if (!m) throw new Error(`Expected key=<whole number>, got: ${arg.slice(0, 60)}`);
  const key = settable(m[1]);
  const value = Number(m[2]);
  if (value < key.min || value > key.max) throw new Error(`${key.key} must be from ${key.min} to ${key.max}.`);
  return { key, value };
}

/** The agent's own entry. `--agent` may only name an agent already in
 * config.json: this never creates one. */
function entry(config: TiloriConfig, agent: string): AgentSettings {
  const s = config.agents?.[agent];
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error(`No agent "${agent}" in config.json.`);
  return s;
}

export interface Change {
  key: string;
  from: number | undefined;
  to: number | undefined;
}

/** Applies the changes to one agent's entry, all or none, and writes the file
 * (atomic, 0600). Every other key, trust settings included, is written back
 * as it was read. Returns what changed. */
export function applyChanges(
  agent: string,
  edits: Array<{ key: Settable; value: number | undefined }>,
  path = configPath(),
): Change[] {
  const config = loadConfig(path);
  const s = entry(config, agent);
  const changes: Change[] = [];
  for (const { key, value } of edits) {
    if (value === undefined && key.fallback === null) throw new Error(`${key.key} can't be reset; edit config.json by hand to turn it off.`);
    const from = key.get(s);
    key.put(s, value);
    changes.push({ key: key.key, from, to: value });
  }
  // The router must accept the result, or a running one would keep its old
  // values and a restart would fail.
  liveSettings(s);
  saveConfig(config, path);
  return changes;
}

export const resetEdit = (key: string) => ({ key: settable(key), value: undefined });

/** The values a running router reloads, validated as at start. Throws on a
 * bad value. */
export interface LiveSettings {
  wakesPerHour: number;
  directWakesPerHour: number;
  /** Undefined without a reminder: reload never adds or removes one. */
  reminderEveryMs?: number;
  stallMinutes: number;
}

export function liveSettings(s: AgentSettings = {}): LiveSettings {
  const wakes = s.wakes_per_hour ?? DEFAULT_WAKES_PER_HOUR;
  if (!Number.isInteger(wakes) || wakes < 1) throw new Error('wakes_per_hour must be a positive integer.');
  const direct = s.direct_wakes_per_hour ?? DEFAULT_DIRECT_WAKES_PER_HOUR;
  if (!Number.isInteger(direct) || direct < 0) throw new Error('direct_wakes_per_hour must be a non-negative integer.');
  return {
    wakesPerHour: wakes,
    directWakesPerHour: direct,
    reminderEveryMs: reminderSettings(s)?.everyMs,
    stallMinutes: stallMinutes(s.stall_minutes),
  };
}

/** Live reload takes no value above what `set` may write, so the CLI bounds
 * are a ceiling for a running router whatever writes the file. A hand edit
 * above them still applies at the next start. */
export function withinReloadCeiling(s: AgentSettings = {}): void {
  for (const k of SETTABLE) {
    const v = k.get(s);
    if (typeof v === 'number' && v > k.max) {
      throw new Error(`${k.key} ${v} is above ${k.max}, the most a running router takes; restart to apply it.`);
    }
  }
}

/**
 * Re-reads config.json when it changes and hands each served agent's
 * settable values to the router. Nothing else is taken from the new file. A
 * file that fails to load or validate leaves every agent as it was and is
 * logged once per distinct error.
 */
export function followConfig(
  router: Router,
  log: (m: string) => void,
  signal?: AbortSignal,
  path = configPath(),
  debounceMs = 500,
): void {
  if (signal?.aborted) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastError = '';
  const reload = () => {
    let next: Map<string, LiveSettings>;
    try {
      const config = loadConfig(path);
      next = new Map(
        router.agents.map((h) => {
          withinReloadCeiling(config.agents?.[h]);
          return [h, liveSettings(config.agents?.[h])];
        }),
      );
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      if (msg !== lastError) log(`config.json not reloaded, keeping current settings: ${msg}`);
      lastError = msg;
      return;
    }
    lastError = '';
    for (const [handle, live] of next) {
      const changed = router.reload(handle, live);
      if (changed.length) log(`[${handle}] settings reloaded: ${changed.join(', ')}`);
    }
  };
  let watcher: ReturnType<typeof watch>;
  try {
    // The directory, not the file: saveConfig replaces the file by rename.
    watcher = watch(dirname(path), (_event, name) => {
      if (name && name !== basename(path)) return;
      clearTimeout(timer);
      timer = setTimeout(reload, debounceMs);
    });
  } catch (cause) {
    log(`config.json changes need a restart (can't watch it: ${cause instanceof Error ? cause.message : String(cause)})`);
    return;
  }
  watcher.on('error', () => {});
  signal?.addEventListener(
    'abort',
    () => {
      clearTimeout(timer);
      watcher.close();
    },
    { once: true },
  );
}

/** `config show`: each settable value, its default and bounds, and this
 * hour's usage when a router reports it (counts only). */
export function showText(agent: string, s: AgentSettings, usage: AgentUsage | null): string {
  const lines = [`${agent}:`];
  for (const k of SETTABLE) {
    const v = k.get(s);
    const value =
      v !== undefined ? String(v) : k.fallback === null ? 'off' : `${k.fallback} (default)`;
    lines.push(`  ${k.key} = ${value}    [${k.min}-${k.max}] ${k.note}`);
  }
  if (!usage) lines.push('  this hour: not reported (no router running)');
  else {
    const direct = usage.direct ? `, direct ${usage.direct.used} of ${usage.direct.limit}` : '';
    const held = usage.held ? `, ${usage.held} event${usage.held === 1 ? '' : 's'} held` : '';
    lines.push(`  this hour: wakes ${usage.wakes.used} of ${usage.wakes.limit} used${held}${direct}`);
  }
  return lines.join('\n');
}
