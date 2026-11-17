import { statSync, realpathSync } from 'node:fs';
import { commandArgv, runBounded, MAX_FILTER_OUTPUT, type RunFailure } from './wake-filter.ts';

/**
 * `reminder.gate` (UNI-1044): an opt-in, operator-configured command the
 * router runs before a due reminder. It decides whether the reminder is worth
 * a wake: `{"wake": false}` skips it (logged as quiet); `{"wake": true,
 * "findings": [...]}` sends it with those findings in the line. Any failure
 * sends the plain reminder, saying the gate failed (Juniper b2a0cbf0 1).
 *
 * Safety (Bastion c3f5cd8f 1-5): the command comes from local config.json
 * only, as argv with an absolute program, validated like `wake_filter`; it
 * runs through the same bounded runner (minimal environment with no TILORI_*,
 * key or ANTHROPIC_* variable, fixed cwd, own process group killed whole on
 * timeout, stdout capped); its output is parsed strictly; findings are
 * stripped of control and format characters and capped before they reach a
 * wake line.
 */

export const DEFAULT_GATE_TIMEOUT_SECONDS = 60;
export const MAX_GATE_TIMEOUT_SECONDS = 120;
/** Most findings one gate run may report; more is a failure (Bastion c3f5cd8f 4). */
export const MAX_GATE_FINDINGS = 10;
/** Longest finding, in characters, after cleaning (Bastion c3f5cd8f 5). */
export const MAX_FINDING_CHARS = 200;

export interface ReminderGateSettings {
  /** argv, no shell. The first entry is an absolute path to an executable. */
  command: string[];
  timeout_seconds?: number;
}

/** A validated gate, as the router uses it. */
export interface ReminderGate {
  /** argv with the program resolved by realpath at load. */
  argv: string[];
  timeoutMs: number;
}

/** Why a gate run gave no answer: a class only, never the gate's own text. */
export type GateFailure = RunFailure;
export const GATE_FAILURES: readonly GateFailure[] = ['spawn', 'timeout', 'exit', 'output', 'stopped'];

export type GateResult = { ok: true; wake: false } | { ok: true; wake: true; findings: string[] } | { ok: false; why: GateFailure };

/**
 * Validates `reminder.gate`; undefined when unset. Throws on anything
 * doubtful, as `wake_filter` does. `stat` and `realpath` are test seams.
 */
export function reminderGateSettings(
  value: unknown,
  stat: (path: string) => { isFile(): boolean; mode: number } = statSync,
  realpath: (path: string) => string = (p) => realpathSync.native(p),
): ReminderGate | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('reminder.gate must be an object.');
  const s = value as Record<string, unknown>;
  for (const key of Object.keys(s))
    if (!['command', 'timeout_seconds'].includes(key)) throw new Error(`reminder.gate.${key} is not a setting.`);
  const argv = commandArgv('reminder.gate', s.command, stat, realpath);
  const t = s.timeout_seconds;
  if (t !== undefined && (typeof t !== 'number' || !Number.isInteger(t) || t < 1 || t > MAX_GATE_TIMEOUT_SECONDS))
    throw new Error(`reminder.gate.timeout_seconds must be a whole number from 1 to ${MAX_GATE_TIMEOUT_SECONDS}.`);
  return { argv, timeoutMs: ((t as number | undefined) ?? DEFAULT_GATE_TIMEOUT_SECONDS) * 1000 };
}

/** Control (Cc), format (Cf: bidi overrides, zero-widths) and line or
 * paragraph separators: none may reach a wake line (Bastion c3f5cd8f 5). */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** A finding as it may appear in a wake line: unsafe characters removed,
 * whitespace collapsed, at most MAX_FINDING_CHARS characters. Empty when
 * nothing is left. */
export function cleanFinding(text: string): string {
  // Whitespace (tabs and newlines too) becomes one space first; then every
  // other unsafe character goes.
  const flat = text.replace(/\s+/g, ' ').replace(UNSAFE, '').replace(/ {2,}/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > MAX_FINDING_CHARS ? chars.slice(0, MAX_FINDING_CHARS - 1).join('') + '…' : flat;
}

/** Whether a string is already a clean finding: used again on wakes received
 * over IPC, so a line is built only from what the router would have built. */
export function validFinding(text: unknown): text is string {
  return typeof text === 'string' && text.length > 0 && cleanFinding(text) === text;
}

/**
 * Parses the gate's stdout strictly (Bastion c3f5cd8f 4): one JSON object
 * with only `wake` (a boolean) and, when waking, `findings` (an array of at
 * most MAX_GATE_FINDINGS strings). Quiet carries no findings. Anything else is
 * null, and the router sends the plain reminder. Findings that clean to
 * nothing are left out; a wake with none left still wakes.
 */
export function parseGate(stdout: string): { wake: false } | { wake: true; findings: string[] } | null {
  let raw: any;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.wake !== 'boolean') return null;
  for (const key of Object.keys(raw)) if (key !== 'wake' && key !== 'findings') return null;
  if (!raw.wake) return raw.findings === undefined || (Array.isArray(raw.findings) && raw.findings.length === 0) ? { wake: false } : null;
  const f = raw.findings ?? [];
  if (!Array.isArray(f) || f.length > MAX_GATE_FINDINGS || !f.every((x: unknown) => typeof x === 'string')) return null;
  return { wake: true, findings: (f as string[]).map(cleanFinding).filter((x) => x.length > 0) };
}

/** What the gate reads on stdin: who it is for, nothing else. */
export interface GateInput {
  v: 1;
  agent: { handle: string };
}

/** Runs the gate once. Never rejects. */
export async function runGate(gate: ReminderGate, handle: string, signal?: AbortSignal): Promise<GateResult> {
  const input: GateInput = { v: 1, agent: { handle } };
  const r = await runBounded(gate.argv, gate.timeoutMs, JSON.stringify(input) + '\n', signal, MAX_FILTER_OUTPUT);
  if (!r.ok) return r;
  const parsed = parseGate(r.stdout);
  if (!parsed) return { ok: false, why: 'output' };
  return parsed.wake ? { ok: true, wake: true, findings: parsed.findings } : { ok: true, wake: false };
}
