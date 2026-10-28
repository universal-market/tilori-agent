import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/** Versions are only ever compared or shown when they look like this. */
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
/** Claude Code's plugin manifest is small; anything bigger is not read. */
const MAX_MANIFEST_BYTES = 1_000_000;
/** How often the manifest is re-read at most. */
const RECHECK_MS = 60_000;

export interface PluginUpdate {
  installed: string;
  running: string;
}

export interface UpdateNoticeOptions {
  /** The plugin version this session was started with (from the plugin's
   * own plugin.json, set by its monitor script). */
  running: string;
  /** The host's install record, e.g. ~/.claude/plugins/installed_plugins.json. */
  manifest: string;
  /** This plugin's key in it, e.g. tilori@tilori-claude. */
  key: string;
  now?: () => number;
  /** Reads the manifest; tests replace it. Returns null when unreadable. */
  read?: (path: string) => string | null;
}

/** Compares two x.y.z versions as numbers (0.1.10 is newer than 0.1.9). */
export function newerVersion(a: string, b: string): boolean {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** The newest valid version among the user-scope installs of `key`, or null.
 * The file belongs to the host and its shape may change, so anything
 * unexpected means null, never a throw. */
export function installedVersion(text: string, key: string): string | null {
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const entries = data?.plugins?.[key];
  if (!Array.isArray(entries)) return null;
  let best: string | null = null;
  for (const e of entries.slice(0, 50)) {
    // Project-scope installs belong to other projects' sessions.
    if (e?.scope !== 'user' || typeof e?.version !== 'string' || !VERSION.test(e.version)) continue;
    if (!best || newerVersion(e.version, best)) best = e.version;
  }
  return best;
}

function readBounded(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    if (size > MAX_MANIFEST_BYTES) return null;
    const buf = Buffer.alloc(size);
    const n = readSync(fd, buf, 0, size, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Tells a session, once per version, that a newer plugin is installed than
 * the one it runs, so the agent can tell its user a restart picks it up. It
 * reads only the local install record, at most once a minute, and only two
 * x.y.z strings ever reach a wake line.
 *
 * What has been said is kept in memory for this `watch` process only: a
 * restart forgets it, and that is fine, because the restart itself is what
 * ends the mismatch. Don't add a state file.
 */
export class UpdateNotice {
  readonly #running: string | null;
  readonly #manifest: string;
  readonly #key: string;
  readonly #now: () => number;
  readonly #read: (path: string) => string | null;
  #checkedAt = -Infinity;
  #installed: string | null = null;
  #said = new Set<string>();

  constructor(opts: UpdateNoticeOptions) {
    this.#running = VERSION.test(opts.running) ? opts.running : null;
    this.#manifest = opts.manifest;
    this.#key = opts.key;
    this.#now = opts.now ?? Date.now;
    this.#read = opts.read ?? readBounded;
  }

  /** The update to mention in the next wake, if there is one not yet said. */
  pending(): PluginUpdate | null {
    if (!this.#running) return null;
    const now = this.#now();
    if (now - this.#checkedAt >= RECHECK_MS) {
      this.#checkedAt = now;
      const text = this.#read(this.#manifest);
      this.#installed = text === null ? null : installedVersion(text, this.#key);
    }
    const installed = this.#installed;
    if (!installed || this.#said.has(installed) || !newerVersion(installed, this.#running)) return null;
    return { installed, running: this.#running };
  }

  /** Call once a wake carrying `update` was accepted. */
  said(update: PluginUpdate): void {
    this.#said.add(update.installed);
  }
}
