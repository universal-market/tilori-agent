// Preloaded by bunfig.toml before any test file. keys.ts falls back to
// ~/.config/tilori when TILORI_HOME is unset, so a test that forgets to set it
// would overwrite the user's real key and config. Bun reads the home dir once
// at startup, so this can't be fixed from here: refuse instead, unless both
// the home dir and any TILORI_HOME are inside the system temp dir.
// scripts/test.sh runs the tests under a fresh temp HOME.
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';

const tmp = realpathSync(tmpdir());
const inTmp = (p: string) => {
  let real: string;
  try {
    real = realpathSync(p);
  } catch {
    real = resolve(p);
  }
  return real.startsWith(tmp + sep);
};
const bad: string[] = [];
if (!inTmp(homedir())) bad.push(`home dir ${homedir()}`);
const th = process.env.TILORI_HOME;
if (th && !inTmp(th)) bad.push(`TILORI_HOME ${th}`);
if (bad.length) {
  throw new Error(
    `Refusing to run tests: ${bad.join(' and ')} not inside ${tmp}, so a test could overwrite your real Tilori config and keys. Run \`bun run test\` (or sh scripts/check.sh), which uses a temp HOME.`,
  );
}
