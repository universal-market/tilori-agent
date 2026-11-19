import './setup.ts';
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../src/cli.ts';

const cli = join(import.meta.dir, '../src/cli.ts');
const root = mkdtempSync(join(tmpdir(), 'ta-pr-work-open-'));
const env = { ...process.env, TILORI_HOME: join(root, 'unconfigured-home') };
let fileNumber = 0;

const bodyFile = (name: string, content: string): string => {
  const path = join(root, `${fileNumber++}-${name}`);
  writeFileSync(path, content, 'utf8');
  return path;
};

afterAll(() => rmSync(root, { recursive: true, force: true }));

const run = async (...args: string[]) => {
  const p = Bun.spawn(['bun', cli, 'pr-work', ...args], { env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { stdout, stderr, exitCode };
};

const BUILDING = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_BUILDING = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TXN = '11111111-1111-4111-8111-111111111111';
const OTHER_TXN = '22222222-2222-4222-8222-222222222222';
const LISTING = '33333333-3333-4333-8333-333333333333';

test('pr-work open prints exact header on one JSON line without body', async () => {
  const r = await run('open', '--building', BUILDING, '--txn', TXN);
  expect(r.exitCode).toBe(0);
  expect(r.stderr).toBe('');
  const expected = { header: `Building: ${BUILDING}\nMarket: ${TXN}\n` };
  expect(r.stdout).toBe(JSON.stringify(expected) + '\n');
  expect(JSON.parse(r.stdout)).toEqual(expected);
  expect(Object.hasOwn(JSON.parse(r.stdout), 'body')).toBe(false);
});

test('pr-work open with --body inserts header and blank line after header', async () => {
  const path = bodyFile('plain.md', '## Summary\nFixes the bug.\n');
  const r = await run('open', '--building', BUILDING, '--txn', TXN, '--body', path);
  expect(r.exitCode).toBe(0);
  expect(r.stderr).toBe('');
  const header = `Building: ${BUILDING}\nMarket: ${TXN}\n`;
  expect(JSON.parse(r.stdout)).toEqual({
    header,
    body: `${header}\n## Summary\nFixes the bug.\n`,
  });
});

test('pr-work open with --body collapses duplicate identical Building: and Market: lines', async () => {
  const path = bodyFile(
    'dups.md',
    `Building: ${BUILDING}\nMarket: ${TXN}\n\n## Summary\nBuilding: ${BUILDING}\nDetails\n`,
  );
  const r = await run('open', '--building', BUILDING, '--txn', TXN, '--body', path);
  expect(r.exitCode).toBe(0);
  expect(r.stderr).toBe('');
  const header = `Building: ${BUILDING}\nMarket: ${TXN}\n`;
  expect(JSON.parse(r.stdout)).toEqual({
    header,
    body: `${header}\n## Summary\nDetails\n`,
  });
});

test('pr-work open with --body handles CRLF line endings', async () => {
  const path = bodyFile('crlf.md', `Building: ${BUILDING}\r\nMarket: ${TXN}\r\n\r\n## Summary\r\nLine 2\r\n`);
  const r = await run('open', '--building', BUILDING, '--txn', TXN, '--body', path);
  expect(r.exitCode).toBe(0);
  expect(r.stderr).toBe('');
  const header = `Building: ${BUILDING}\nMarket: ${TXN}\n`;
  expect(JSON.parse(r.stdout)).toEqual({
    header,
    body: `${header}\n## Summary\nLine 2\n`,
  });
});

test('pr-work open refuses conflicting Market: line, two Market: lines, and different first Building: line', async () => {
  const conflictMarket = bodyFile('conflict-market.md', `## Summary\nMarket: ${OTHER_TXN}\n`);
  const r1 = await run('open', '--building', BUILDING, '--txn', TXN, '--body', conflictMarket);
  expect(r1.exitCode).toBe(1);
  expect(r1.stdout).toBe('');
  expect(r1.stderr).toContain('pr-work open:');

  const twoMarkets = bodyFile('two-markets.md', `Market: ${TXN}\n## Summary\nMarket: ${TXN}\n`);
  const r2 = await run('open', '--building', BUILDING, '--txn', TXN, '--body', twoMarkets);
  expect(r2.exitCode).toBe(1);
  expect(r2.stdout).toBe('');
  expect(r2.stderr).toContain('pr-work open:');

  const diffBuilding = bodyFile('diff-building.md', `Building: ${OTHER_BUILDING}\n## Summary\n`);
  const r3 = await run('open', '--building', BUILDING, '--txn', TXN, '--body', diffBuilding);
  expect(r3.exitCode).toBe(1);
  expect(r3.stdout).toBe('');
  expect(r3.stderr).toContain('pr-work open:');
});

test('pr-work open matches Market: and Building: case-sensitively at line start', async () => {
  const path = bodyFile('case.md', `building: ${OTHER_BUILDING}\nmarket: ${OTHER_TXN}\n  Market: ${OTHER_TXN}\n`);
  const r = await run('open', '--building', BUILDING, '--txn', TXN, '--body', path);
  expect(r.exitCode).toBe(0);
  const header = `Building: ${BUILDING}\nMarket: ${TXN}\n`;
  expect(JSON.parse(r.stdout).body).toBe(`${header}\nbuilding: ${OTHER_BUILDING}\nmarket: ${OTHER_TXN}\n  Market: ${OTHER_TXN}\n`);
});

test('pr-work open reports unreadable body path without OS error details', async () => {
  const missing = join(root, 'does-not-exist.md');
  const r = await run('open', '--building', BUILDING, '--txn', TXN, '--body', missing);
  expect(r.exitCode).toBe(1);
  expect(r.stdout).toBe('');
  expect(r.stderr).toContain(`pr-work open: could not read body file ${missing}.`);
  expect(r.stderr).not.toContain('ENOENT');
});

test('pr-work open refuses bad UUIDs and missing flags', async () => {
  for (const args of [
    ['open', '--building', 'not-a-uuid', '--txn', TXN],
    ['open', '--building', BUILDING, '--txn', '11111111-1111-0111-8111-111111111111'],
    ['open', '--building', BUILDING, '--txn', '11111111-1111-4111-0111-111111111111'],
    ['open', '--txn', TXN],
    ['open', '--building', BUILDING],
  ]) {
    const r = await run(...args);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('pr-work open:');
  }
});

test('pr-work take prints exact steps for implementer and reviewer', async () => {
  for (const role of ['implementer', 'reviewer']) {
    const r = await run('take', '--role', role, '--listing', LISTING);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    const expected = {
      role,
      steps: [
        { tool: 'respond_to_listing', args: { listing_id: LISTING } },
        { tool: 'tilori.create_post', note: 'post the full transaction id in the review thread' },
        { tool: 'accept_contract', note: 'after the proposer posts the contract id' },
      ],
    };
    expect(r.stdout).toBe(JSON.stringify(expected) + '\n');
    expect(JSON.parse(r.stdout)).toEqual(expected);
  }
});

test('pr-work take with --txn uses join_transaction instead of respond_to_listing', async () => {
  const r = await run('take', '--role', 'reviewer', '--listing', LISTING, '--txn', TXN);
  expect(r.exitCode).toBe(0);
  expect(r.stderr).toBe('');
  const expected = {
    role: 'reviewer',
    steps: [
      { tool: 'join_transaction', args: { transaction_id: TXN } },
      { tool: 'tilori.create_post', note: 'post the full transaction id in the review thread' },
      { tool: 'accept_contract', note: 'after the proposer posts the contract id' },
    ],
  };
  expect(r.stdout).toBe(JSON.stringify(expected) + '\n');
  expect(JSON.parse(r.stdout)).toEqual(expected);
});

test('pr-work take refuses unknown role, bad UUIDs, and missing flags', async () => {
  for (const args of [
    ['take', '--role', 'client', '--listing', LISTING],
    ['take', '--listing', LISTING],
    ['take', '--role', 'implementer'],
    ['take', '--role', 'implementer', '--listing', 'not-a-uuid'],
    ['take', '--role', 'reviewer', '--listing', LISTING, '--txn', 'not-a-uuid'],
  ]) {
    const r = await run(...args);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('pr-work take:');
  }
});

test('pr-work open and take flags are accepted on pr-work and refused on other commands', () => {
  expect(() =>
    parseArgs(['pr-work', 'open', `--building=${BUILDING}`, `--txn=${TXN}`, '--body=pr.md']),
  ).not.toThrow();
  expect(() =>
    parseArgs(['pr-work', 'take', '--role=implementer', `--listing=${LISTING}`, `--txn=${TXN}`]),
  ).not.toThrow();
  for (const flag of ['building', 'txn', 'body', 'role', 'listing'])
    expect(() => parseArgs(['status', `--${flag}=value`])).toThrow(`--${flag} is only for pr-work.`);
});
