import './setup.ts';
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../src/cli.ts';

const REPO = 'acme/widget';
const cli = join(import.meta.dir, '../src/cli.ts');
const root = mkdtempSync(join(tmpdir(), 'ta-pr-work-'));
const checkout = join(root, 'checkout');
const scripts = join(checkout, 'scripts');
const defaultsPath = join(scripts, 'merge-check-defaults.json');
const env = { ...process.env, TILORI_HOME: join(root, 'unconfigured-home') };
const terms = {
  base: 'main',
  required_ci: ['CI', 'Security'],
  confirm_paths: ['.github/workflows/**', 'src/**', 'docs/**'],
  objections: 'block',
  publish_terms: true,
  end: 'merge',
  review_at: 'head',
};

mkdirSync(scripts, { recursive: true });
writeFileSync(
  defaultsPath,
  JSON.stringify({
    [REPO]: {
      workflows: ['CI', 'Security'],
      protected_paths: ['src/**', '.github/workflows/**', 'src/**', 'docs/**'],
    },
  }),
);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const run = async (...args: string[]) => {
  const p = Bun.spawn(['bun', cli, 'pr-work', ...args], { env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { stdout, stderr, exitCode };
};

const request = (...extra: string[]) => run('request', '--repo', REPO, '--pr', '123', '--repo-dir', checkout, ...extra);

test('default kinds are code and security, with deduped confirm_paths', async () => {
  const r = await request();
  expect(r.exitCode).toBe(0);
  expect(r.stderr).toBe('');
  expect(JSON.parse(r.stdout)).toEqual({ kinds: ['code', 'security'], terms });
});

test('--docs-only explicitly selects docs', async () => {
  const r = await request('--docs-only');
  expect(r.exitCode).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual({ kinds: ['docs'], terms });
});

test('a missing repo entry or defaults file is a clear refusal', async () => {
  const missingEntry = await run('request', '--repo', 'acme/other', '--pr', '1', '--repo-dir', checkout);
  expect(missingEntry.exitCode).toBe(1);
  expect(missingEntry.stdout).toBe('');
  expect(missingEntry.stderr).toContain('no defaults entry for acme/other');

  const missingFile = await request('--defaults', join(root, 'missing.json'));
  expect(missingFile.exitCode).toBe(1);
  expect(missingFile.stdout).toBe('');
  expect(missingFile.stderr).toContain('could not read defaults file');
});

test('bad JSON is refused', async () => {
  const path = join(root, 'bad.json');
  writeFileSync(path, '{ not JSON');
  const r = await request('--defaults', path);
  expect(r.exitCode).toBe(1);
  expect(r.stdout).toBe('');
  expect(r.stderr).toContain('not valid JSON');
});

test('unknown extra keys are tolerated and an explicit defaults path and base are used', async () => {
  const path = join(root, 'extra.json');
  writeFileSync(
    path,
    JSON.stringify({
      future_top_level: { anything: true },
      [REPO]: {
        workflows: ['Build'],
        protected_paths: ['docs/**'],
        base: 'release',
        future_entry_key: 'ignored',
      },
    }),
  );
  const r = await request('--defaults', path);
  expect(r.exitCode).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual({
    kinds: ['code', 'security'],
    terms: { ...terms, base: 'release', required_ci: ['Build'], confirm_paths: ['.github/workflows/**', 'docs/**'] },
  });
});

test('--pr must be a positive integer', async () => {
  for (const pr of ['0', '-1', '1.5', 'not-a-number']) {
    const r = await run('request', '--repo', REPO, '--pr', pr, '--repo-dir', checkout);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('--pr must be a positive integer');
  }
});

test('--repo must match owner/repo', async () => {
  for (const repo of ['acme', 'acme/widget/extra', 'https://github.com/acme/widget', 'acme widget/repo']) {
    const r = await run('request', '--repo', repo, '--pr', '1', '--repo-dir', checkout);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('--repo must match owner/repo');
  }
});

test('pr-work flags are refused on other commands', () => {
  expect(() =>
    parseArgs([
      'pr-work',
      'request',
      '--repo=acme/widget',
      '--pr=1',
      '--docs-only',
      '--defaults=defaults.json',
      '--repo-dir=checkout',
    ]),
  ).not.toThrow();
  for (const flag of ['defaults', 'repo-dir', 'repo', 'pr', 'docs-only'])
    expect(() => parseArgs(['status', `--${flag}=value`])).toThrow(`--${flag} is only for pr-work.`);
});
