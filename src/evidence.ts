import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';

/**
 * Where `market-evidence` may write (UNI-1028 step 3, Bastion's build
 * conditions 8dd99af1). merge-check refuses evidence files inside a checkout,
 * so this refuses them first, with the same advice. Each refusal is an Error
 * whose message names the problem in fixed words.
 */
export const OUT_ADVICE = 'Use a path outside any checkout, such as ~/agents/shared/pr-work/<pr>-evidence.json.';

/** The directory (after realpath) holding `.git` at or above `dir`, or null. */
export function gitWorkTree(dir: string): string | null {
  for (let d = dir; ; ) {
    if (existsSync(join(d, '.git'))) return d;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/** Checks `out` and returns the real path to write to. Refuses a relative
 * path, a missing parent, a parent inside any git work tree (after resolving
 * symlinks in every ancestor), and a target that exists as anything but a
 * regular file (a symlink above all). */
export function checkOut(out: string): string {
  if (!out || !isAbsolute(out) || out.endsWith('/')) throw new Error(`--out must be an absolute file path. ${OUT_ADVICE}`);
  let parent: string;
  try {
    parent = realpathSync(dirname(out));
  } catch {
    throw new Error("--out: the parent directory doesn't exist.");
  }
  if (gitWorkTree(parent)) throw new Error(`--out is inside a git work tree. ${OUT_ADVICE}`);
  const target = join(parent, basename(out));
  let st;
  try {
    st = lstatSync(target);
  } catch {
    return target;
  }
  if (st.isSymbolicLink()) throw new Error('--out is a symlink; refusing to write through it.');
  if (!st.isFile()) throw new Error('--out exists and is not a regular file.');
  return target;
}

/** Writes `body` to `target` through a new temp file in the same directory
 * (created exclusively, mode 0644 before the umask), then renames it over
 * the target. rename replaces a symlink planted after checkOut rather than
 * following it. */
export function writeAtomically(target: string, body: string): void {
  const tmp = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  const fd = openSync(tmp, 'wx', 0o644);
  try {
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, target);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // already renamed or never written
    }
    throw e;
  }
}
