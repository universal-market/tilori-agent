import './setup.ts';
// Shared helpers for the S0 characterization tests (UNI-1178). Not a test
// file itself. Every S0 test file imports ./setup.ts first, like all tests.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect } from 'bun:test';

const DIR = join(import.meta.dir, 'snapshots', 's0');
const UPDATE = process.env.UPDATE_S0 === '1';

/**
 * Compares `actual` with the committed file tests/snapshots/s0/<name> byte
 * for byte. With UPDATE_S0=1 the file is rewritten instead (review the diff:
 * a changed snapshot is a changed host-visible string). A missing file fails.
 */
export function expectSnapshot(name: string, actual: string): void {
  const path = join(DIR, name);
  if (UPDATE) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, actual);
    return;
  }
  if (!existsSync(path)) throw new Error(`missing snapshot ${name}; run with UPDATE_S0=1 to create it`);
  expect(actual).toBe(readFileSync(path, 'utf8'));
}

/** Renders named cases as `### name` then the value, blank line between. */
export function renderCases(cases: Array<[string, string]>): string {
  return cases.map(([n, v]) => `### ${n}\n${v}\n`).join('\n');
}

/** A fresh private temp dir (real path, so normalising is exact). */
export function tempDir(prefix = 's0-'): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** Replaces every occurrence of each (path -> label) pair, longest first. */
export function normalise(text: string, pairs: Array<[string, string]>): string {
  let out = text;
  for (const [from, to] of [...pairs].sort((a, b) => b[0].length - a[0].length)) out = out.split(from).join(to);
  return out;
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs `bun src/cli.ts <argv>` as a subprocess under the given HOME (a temp
 * dir: the guard in setup.ts has already refused anything else) with a
 * minimal environment: no TILORI_* variables, no claude on PATH, stdin
 * closed. Never touches the real ~/.config.
 */
export async function runCli(
  argv: string[],
  o: { home: string; stdin?: string; env?: Record<string, string>; cwd?: string },
): Promise<CliResult> {
  // S0_CLI / S0_RUNTIME let scripts/bundle-check.sh run these same subprocess
  // cases against the built bundle (bun or node) instead of src/cli.ts.
  const cli = process.env.S0_CLI ?? join(import.meta.dir, '..', 'src', 'cli.ts');
  const proc = Bun.spawn([process.env.S0_RUNTIME ?? process.execPath, cli, ...argv], {
    cwd: o.cwd ?? o.home,
    env: { HOME: o.home, PATH: '/usr/bin:/bin', ...o.env },
    stdin: o.stdin === undefined ? 'ignore' : new Blob([o.stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout, stderr };
}
