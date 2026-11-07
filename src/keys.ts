import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Key and config files live under `~/.config/tilori/` (override with
 * TILORI_HOME, used by tests and for a second instance). The directory must
 * be 0700 and every key file 0600, owned by the current user. Anything wider
 * fails closed: a key that other users could read is treated as missing.
 *
 * Layout:
 *   ~/.config/tilori/            0700
 *     config.json                0600  url, default agent, per-agent settings (no secrets)
 *     agents/                    0700
 *       <handle>.key             0600  that agent's shared Tilori key
 */

export const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** The home used when TILORI_HOME is unset or empty. */
export function defaultTiloriHome(): string {
  return join(homedir(), '.config', 'tilori');
}

export function tiloriHome(): string {
  return process.env.TILORI_HOME || defaultTiloriHome();
}

/**
 * Whether TILORI_HOME names a home other than the default one, for example a
 * second instance's config set for one session (UNI-751). Compared as real
 * paths, so a TILORI_HOME that only spells the default home differently is
 * the default home; a path that doesn't resolve is compared as written.
 */
export function isOtherHome(): boolean {
  const set = process.env.TILORI_HOME;
  if (!set) return false;
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return real(set) !== real(defaultTiloriHome());
}

export function validateHandle(handle: string): string {
  const h = handle.trim().toLowerCase();
  if (!HANDLE_RE.test(h)) {
    throw new Error(
      'Agent handle must be 1-64 lowercase letters, digits, "_" or "-", starting with a letter or digit.',
    );
  }
  return h;
}

export function keyPath(handle: string): string {
  return join(tiloriHome(), 'agents', `${validateHandle(handle)}.key`);
}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

/** Throws unless `path` is a regular file (or directory when `dir`) owned by
 * this user with no group/other permission bits. Symlinks are refused. */
export function assertPrivate(path: string, dir = false): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new Error(`${path} must not be a symlink.`);
  if (dir ? !st.isDirectory() : !st.isFile()) {
    throw new Error(`${path} must be a ${dir ? 'directory' : 'regular file'}.`);
  }
  const uid = currentUid();
  if (uid !== undefined && st.uid !== uid) {
    throw new Error(`${path} must be owned by the current user.`);
  }
  if ((st.mode & 0o077) !== 0) {
    const want = dir ? '0700' : '0600';
    throw new Error(
      `${path} is readable by other users (mode ${(st.mode & 0o777).toString(8)}); run chmod ${want} on it.`,
    );
  }
}

export function ensurePrivateDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  assertPrivate(path, true);
}

/** Reads an agent's key. Fails closed on missing files or wide modes. The
 * error never contains key material. */
export function readKey(handle: string): string {
  const home = tiloriHome();
  const path = keyPath(handle);
  if (!existsSync(path)) {
    throw new Error(
      `No key for agent "${validateHandle(handle)}". Run: tilori-agent init --agent ${validateHandle(handle)}`,
    );
  }
  assertPrivate(home, true);
  assertPrivate(join(home, 'agents'), true);
  assertPrivate(path);
  const key = readFileSync(path, 'utf8').trim();
  if (!key || /\s/.test(key)) throw new Error(`Key file ${path} is malformed.`);
  return key;
}

/** Atomically writes a key with mode 0600. */
export function writeKey(handle: string, key: string): string {
  const trimmed = key.trim();
  if (!trimmed || /\s/.test(trimmed)) throw new Error('Key is empty or contains whitespace.');
  ensurePrivateDir(tiloriHome());
  ensurePrivateDir(join(tiloriHome(), 'agents'));
  const path = keyPath(handle);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, trimmed + '\n', { mode: 0o600, flag: 'wx' });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return path;
}

const TOKEN_PATTERNS = [
  /mcp_sk_[A-Za-z0-9_-]+/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];

/** Removes known secrets and key-shaped tokens from text bound for logs. */
export function redact(text: string, secrets: Iterable<string> = []): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join('[REDACTED]');
    const enc = encodeURIComponent(secret);
    if (enc !== secret) out = out.split(enc).join('[REDACTED]');
  }
  for (const re of TOKEN_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}
