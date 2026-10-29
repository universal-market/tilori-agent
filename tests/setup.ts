// Imported first by every test file, and preloaded by bunfig.toml (which Bun
// reads only from the current directory). keys.ts falls back to
// ~/.config/tilori when TILORI_HOME is unset, so a test that forgets to set it
// would overwrite the user's real key and config. Bun reads the home dir once
// at startup, so this can't be fixed from here: refuse instead, unless both
// the home dir and any TILORI_HOME are inside the system temp dir and the
// config dir isn't the user's real one. scripts/test.sh runs the tests under
// a fresh temp HOME.
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

/** realpath of p, or of its nearest existing ancestor plus the rest, so a
 * symlinked parent of a path that doesn't exist yet is still followed, even
 * a dangling one. */
const real = (p: string, hops = 0): string => {
  try {
    return realpathSync(p);
  } catch {}
  if (hops > 40) return p;
  try {
    if (lstatSync(p).isSymbolicLink()) return real(resolve(dirname(p), readlinkSync(p)), hops + 1);
  } catch {}
  const parent = dirname(p);
  return parent === p ? p : join(real(parent, hops + 1), basename(p));
};
const tmp = real(tmpdir());
const inTmp = (p: string) => real(p).startsWith(tmp + sep);
const bad: string[] = [];
if (!inTmp(homedir())) bad.push(`home dir ${homedir()} is not inside ${tmp}`);
const th = process.env.TILORI_HOME;
if (th && !inTmp(th)) bad.push(`TILORI_HOME ${th} is not inside ${tmp}`);
// The home dir from the password database, so faking $HOME or $TMPDIR can't
// hide the real config dir. Bun's os.userInfo().homedir follows $HOME, so ask
// getent (Linux) or dscl (macOS) directly.
const passwdHome = (): string | undefined => {
  const ask = (argv: string[]) => {
    try {
      const r = Bun.spawnSync(argv, { env: { PATH: '/usr/bin:/bin' }, stderr: 'ignore' });
      return r.exitCode === 0 ? r.stdout.toString() : '';
    } catch {
      return '';
    }
  };
  const uid = process.getuid?.();
  const home =
    (uid === undefined ? '' : ask(['getent', 'passwd', String(uid)]).split(':')[5]?.trim()) ||
    ask(['dscl', '.', '-read', `/Users/${userInfo().username}`, 'NFSHomeDirectory']).replace(/^NFSHomeDirectory:\s*/, '').trim();
  return home?.startsWith('/') ? home : undefined;
};
const pw = passwdHome();
const realDir = pw && join(pw, '.config', 'tilori');
const dir = th || join(homedir(), '.config', 'tilori');
if (realDir && real(dir) === real(realDir)) bad.push(`the config dir ${dir} is your real one`);
if (bad.length) {
  throw new Error(
    `Refusing to run tests: ${bad.join('; ')}, so a test could overwrite your real Tilori config and keys. Run \`bun run test\` (or sh scripts/check.sh), which uses a temp HOME.`,
  );
}
