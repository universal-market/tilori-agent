import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePrivateDir } from './keys.ts';
import type { EventRef } from './types.ts';

/**
 * Opt-in recorder of the router's wake decisions (UNI-1097 slice 4).
 *
 * Off unless `record_decisions: true` is hand-edited into the agent's
 * config.json (like `wake_filter`; nothing from Tilori can turn it on). Each
 * decision is one JSON line in `<tilori home>/recordings/<handle>.jsonl`,
 * a 0700 directory and a 0600 file, and carries only fixed-vocabulary fields:
 * the time, the recipient handle, the decision, the lane, and per event its
 * kind, entity type and UUID. No titles, text, names or counts of anything an
 * author wrote. A line is for replaying the policy offline, never for prod
 * data: nothing is read back by the router.
 *
 * The recorder never breaks the router. Any failure is reported once through
 * `onError`, and recording stops for the rest of the run.
 */

export type RecordedDecision = 'wake' | 'hold' | 'digest' | 'drop';
export type RecordedLane = 'normal' | 'direct';

export interface RecorderOptions {
  /** Largest file size in bytes; the oldest half of the lines goes first. */
  maxBytes?: number;
  /** Lines older than this are dropped when the file is pruned. */
  maxAgeMs?: number;
  now?: () => number;
  onError?: (message: string) => void;
}

export const RECORDER_MAX_BYTES = 1024 * 1024;
export const RECORDER_MAX_AGE_MS = 7 * 24 * 3600_000;
/** Events kept per line; the rest are counted, never listed. */
export const RECORDER_MAX_EVENTS = 20;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WORD_RE = /^[a-z][a-z._-]{0,39}$/;
const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DECISIONS = new Set<string>(['wake', 'hold', 'digest', 'drop']);

export interface RecordedEvent {
  kind: string;
  entity_type: string;
  id: string;
}

export interface RecordInput {
  decision: RecordedDecision;
  lane: RecordedLane | null;
  events: readonly Pick<EventRef, 'kind' | 'entity_type' | 'entity_id'>[];
}

export type RecordedPolicyOutcome = { lane: RecordedLane } | { waitMs: number };

export interface ShadowDiffInput {
  method: 'decide';
  builtin: RecordedPolicyOutcome;
  wakewise: RecordedPolicyOutcome;
  lane: RecordedLane | null;
}

const sanitizeOutcome = (d: RecordedPolicyOutcome): RecordedPolicyOutcome =>
  'lane' in d && (d.lane === 'normal' || d.lane === 'direct')
    ? { lane: d.lane }
    : { waitMs: 'waitMs' in d && typeof d.waitMs === 'number' ? d.waitMs : -1 };

const word = (value: unknown): string => (typeof value === 'string' && WORD_RE.test(value) ? value : 'other');
const uuid = (value: unknown): string =>
  typeof value === 'string' && UUID_RE.test(value.toLowerCase()) ? value.toLowerCase() : 'invalid-id';

export class DecisionRecorder {
  readonly #dir: string;
  readonly #path: string;
  readonly #handle: string;
  readonly #maxBytes: number;
  readonly #maxAgeMs: number;
  readonly #now: () => number;
  readonly #onError: (message: string) => void;
  #fd: number | null = null;
  #size = 0;
  #off = false;

  constructor(dir: string, handle: string, options: RecorderOptions = {}) {
    if (!HANDLE_RE.test(handle)) throw new Error('recorder: bad handle');
    this.#dir = dir;
    this.#handle = handle;
    this.#path = join(dir, `${handle}.jsonl`);
    this.#maxBytes = options.maxBytes ?? RECORDER_MAX_BYTES;
    this.#maxAgeMs = options.maxAgeMs ?? RECORDER_MAX_AGE_MS;
    this.#now = options.now ?? Date.now;
    this.#onError = options.onError ?? (() => {});
  }

  get path(): string {
    return this.#path;
  }

  get disabled(): boolean {
    return this.#off;
  }

  /** Appends one line. Never throws. */
  record(input: RecordInput): void {
    if (this.#off) return;
    try {
      if (!DECISIONS.has(input.decision)) return;
      const events = input.events.slice(0, RECORDER_MAX_EVENTS).map(
        (e): RecordedEvent => ({ kind: word(e.kind), entity_type: word(e.entity_type), id: uuid(e.entity_id) }),
      );
      const line = JSON.stringify({
        at: new Date(this.#now()).toISOString(),
        recipient: this.#handle,
        decision: input.decision,
        lane: input.lane === 'normal' || input.lane === 'direct' ? input.lane : null,
        events,
        ...(input.events.length > events.length ? { more: input.events.length - events.length } : {}),
      });
      this.#writeLine(line);
    } catch (e) {
      this.#fail(e);
    }
  }

  /** Appends one shadow_diff metadata line. Never throws. */
  recordShadowDiff(input: ShadowDiffInput): void {
    if (this.#off) return;
    try {
      const line = JSON.stringify({
        at: new Date(this.#now()).toISOString(),
        recipient: this.#handle,
        type: 'shadow_diff',
        method: input.method,
        builtin: sanitizeOutcome(input.builtin),
        wakewise: sanitizeOutcome(input.wakewise),
        lane: input.lane === 'normal' || input.lane === 'direct' ? input.lane : null,
      });
      this.#writeLine(line);
    } catch (e) {
      this.#fail(e);
    }
  }

  #writeLine(line: string): void {
    const fd = this.#open();
    if (this.#size + line.length + 1 > this.#maxBytes) this.#prune(line.length + 1);
    writeSync(this.#fd ?? fd, `${line}\n`);
    this.#size += line.length + 1;
  }

  close(): void {
    if (this.#fd === null) return;
    try {
      closeSync(this.#fd);
    } catch {
      // nothing to do
    }
    this.#fd = null;
  }

  #fail(e: unknown): void {
    this.#off = true;
    this.close();
    this.#onError(`decision recording stopped: ${e instanceof Error ? e.message : 'unknown error'}`);
  }

  /** Opens the file without following a symlink and checks what was opened. */
  #open(): number {
    if (this.#fd !== null) return this.#fd;
    ensurePrivateDir(this.#dir);
    const fd = openSync(
      this.#path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      const st = fstatSync(fd);
      const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
      if (!st.isFile()) throw new Error('recording file is not a regular file');
      if (uid !== undefined && st.uid !== uid) throw new Error('recording file is not owned by this user');
      if ((st.mode & 0o077) !== 0) throw new Error('recording file is readable by other users');
      if (st.nlink !== 1) throw new Error('recording file has more than one link');
      this.#size = st.size;
    } catch (e) {
      closeSync(fd);
      throw e;
    }
    this.#fd = fd;
    return fd;
  }

  /** Drops lines past the age cap and, if still too big, the oldest half, by
   * writing a private temporary file and renaming it over the recording. */
  #prune(incoming: number): void {
    const st = lstatSync(this.#path);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error('recording file changed');
    const cutoff = this.#now() - this.#maxAgeMs;
    let lines = readFileSync(this.#path, 'utf8')
      .split('\n')
      .filter((l) => {
        if (!l) return false;
        try {
          const at = Date.parse((JSON.parse(l) as { at?: unknown }).at as string);
          return Number.isFinite(at) && at >= cutoff;
        } catch {
          return false;
        }
      });
    const size = () => lines.reduce((n, l) => n + l.length + 1, 0) + incoming;
    while (lines.length && size() > this.#maxBytes) lines = lines.slice(Math.ceil(lines.length / 2));
    const tmp = join(this.#dir, `.${this.#handle}.jsonl.tmp`);
    const fd = openSync(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      writeFileSync(fd, lines.map((l) => `${l}\n`).join(''));
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.#path);
    this.close();
    this.#open();
  }
}
