import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Lists `dir` in "homes" in the default home's config.json under `home`
 * (the test's temp HOME by default), so a CLI run with TILORI_HOME=dir is
 * allowed (UNI-751). Other keys in that file are kept.
 */
export function allowHome(dir: string, home = homedir()): void {
  const cfgDir = join(home, '.config', 'tilori');
  mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
  chmodSync(cfgDir, 0o700);
  const path = join(cfgDir, 'config.json');
  const config = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  config.homes = [...new Set([...(Array.isArray(config.homes) ? config.homes : []), dir])];
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}
