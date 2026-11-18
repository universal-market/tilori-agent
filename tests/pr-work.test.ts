import './setup.ts';
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../src/cli.ts';
import { parseAgents } from '../src/pr-work.ts';

const REPO = 'acme/widget';
const DEFAULT_ACCEPTANCE = 'All required CI passes at the reviewed head and every linked review approves it.';
const cli = join(import.meta.dir, '../src/cli.ts');
const root = mkdtempSync(join(tmpdir(), 'ta-pr-work-'));
const checkout = join(root, 'checkout');
const scripts = join(checkout, 'scripts');
const defaultsPath = join(scripts, 'merge-check-defaults.json');
const env = { ...process.env, TILORI_HOME: join(root, 'unconfigured-home') };
const agent = (id: string, handle: string, owner: string) => ({ agent: id, handle, owner });
const agents = {
  client: agent('client-agent', 'client-h', 'acct-client'),
  implementer: agent('impl-agent', 'impl-h', 'acct-impl'),
  opener: agent('opener-agent', 'opener-h', 'acct-opener'),
  lists: {
    code: [agent('code-agent', 'code-h', 'acct-code')],
    security: [agent('security-agent', 'security-h', 'acct-security')],
    docs: [agent('docs-agent', 'docs-h', 'acct-docs')],
  },
};
const agentsPath = join(root, 'agents.json');
let fileNumber = 0;

const jsonFile = (name: string, value: unknown): string => {
  const path = join(root, `${fileNumber++}-${name}`);
  writeFileSync(path, JSON.stringify(value));
  return path;
};

writeFileSync(agentsPath, JSON.stringify(agents));
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

const listing = (...extra: string[]) =>
  run('listing', '--repo', REPO, '--pr', '123', '--agents', agentsPath, '--repo-dir', checkout, ...extra);

const expectedDefault = {
  listing: {
    kind: 'request',
    title: 'PR work: acme/widget#123',
    description: 'Review of acme/widget#123 under the pinned pr-work terms.',
    contract_template_id: 'universal-market/pr-work-r2',
    contract_template_version: '2.0.0',
    contract_inputs: {
      client: { principal: 'um:agent:client-agent' },
      repo: REPO,
      acceptance: DEFAULT_ACCEPTANCE,
      base: 'main',
      kind_1: 'code',
      kind_2: 'security',
      required_ci: ['CI', 'Security'],
      confirm_paths: ['.github/workflows/**', 'src/**', 'docs/**'],
      objections: 'block',
      publish_terms: true,
      review_owner: 'client',
    },
  },
  reviewers: [
    { kind: 'code', agent: 'code-agent', handle: 'code-h' },
    { kind: 'security', agent: 'security-agent', handle: 'security-h' },
  ],
};

test('default kinds produce the exact r2 listing payload and reviewers on one JSON line', async () => {
  const r = await listing();
  expect(r.exitCode).toBe(0);
  expect(r.stderr).toBe('');
  expect(r.stdout).toBe(JSON.stringify(expectedDefault) + '\n');
  expect(JSON.parse(r.stdout)).toEqual(expectedDefault);
});

test('--docs-only produces an r1 listing with kind_1 docs and its reviewer', async () => {
  const r = await listing('--docs-only');
  expect(r.exitCode).toBe(0);
  expect(r.stderr).toBe('');
  expect(JSON.parse(r.stdout)).toEqual({
    listing: {
      ...expectedDefault.listing,
      contract_template_id: 'universal-market/pr-work-r1',
      contract_inputs: {
        client: { principal: 'um:agent:client-agent' },
        repo: REPO,
        acceptance: DEFAULT_ACCEPTANCE,
        base: 'main',
        kind_1: 'docs',
        required_ci: ['CI', 'Security'],
        confirm_paths: ['.github/workflows/**', 'src/**', 'docs/**'],
        objections: 'block',
        publish_terms: true,
        review_owner: 'client',
      },
    },
    reviewers: [{ kind: 'docs', agent: 'docs-agent', handle: 'docs-h' }],
  });
});

test('--acceptance overrides the default acceptance text', async () => {
  const acceptance = 'Build is green and both reviewers approve the same reviewed head.';
  const r = await listing('--acceptance', acceptance);
  expect(r.exitCode).toBe(0);
  expect(JSON.parse(r.stdout).listing.contract_inputs.acceptance).toBe(acceptance);
});

test('more than 16 workflows is refused', async () => {
  const path = jsonFile('many-workflows.json', {
    [REPO]: { workflows: Array.from({ length: 17 }, (_, i) => `CI ${i}`), protected_paths: [] },
  });
  const r = await listing('--defaults', path);
  expect(r.exitCode).toBe(1);
  expect(r.stdout).toBe('');
  expect(r.stderr).toContain('pr-work listing: required_ci has more than 16 items.');
});

test('acceptance over 4096 UTF-8 bytes is refused', async () => {
  const r = await listing('--acceptance', 'a'.repeat(4097));
  expect(r.exitCode).toBe(1);
  expect(r.stdout).toBe('');
  expect(r.stderr).toContain('pr-work listing: acceptance must be at most 4096 UTF-8 bytes.');
});

test('a confirm path over 256 UTF-8 bytes is refused', async () => {
  const path = jsonFile('long-path.json', { [REPO]: { workflows: ['CI'], protected_paths: ['p'.repeat(257)] } });
  const r = await listing('--defaults', path);
  expect(r.exitCode).toBe(1);
  expect(r.stdout).toBe('');
  expect(r.stderr).toContain('pr-work listing: confirm_paths items must be at most 256 UTF-8 bytes.');
});

test('more than 16 confirm paths is refused', async () => {
  const path = jsonFile('many-paths.json', {
    [REPO]: { workflows: ['CI'], protected_paths: Array.from({ length: 16 }, (_, i) => `src/${i}/**`) },
  });
  const r = await listing('--defaults', path);
  expect(r.exitCode).toBe(1);
  expect(r.stdout).toBe('');
  expect(r.stderr).toContain('pr-work listing: confirm_paths has more than 16 items.');
});

test('missing or empty agent identity fields fail closed in the CLI and parseAgents', async () => {
  const missingAgent = structuredClone(agents);
  delete (missingAgent.client as { agent?: string }).agent;
  const emptyAgent = structuredClone(agents);
  emptyAgent.implementer.agent = '';
  const missingOwner = structuredClone(agents);
  delete (missingOwner.lists.code[0] as { owner?: string }).owner;
  const emptyOwner = structuredClone(agents);
  emptyOwner.lists.security[0].owner = '';
  const emptyHandle = structuredClone(agents);
  emptyHandle.lists.docs[0].handle = '';

  const cases = [
    { value: missingAgent, handle: 'client-h' },
    { value: emptyAgent, handle: 'impl-h' },
    { value: missingOwner, handle: 'code-h' },
    { value: emptyOwner, handle: 'security-h' },
    { value: emptyHandle, handle: '?' },
  ];
  for (const { value, handle } of cases) {
    const message = `pr-work listing: agent "${handle}" needs a non-empty agent, handle and owner`;
    expect(() => parseAgents(value)).toThrow(message);
    const r = await listing('--agents', jsonFile('invalid-agents.json', value));
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain(message);
  }
});

test('client and implementer are required and lists must contain arrays', () => {
  const withoutClient = structuredClone(agents) as Partial<typeof agents>;
  delete withoutClient.client;
  expect(() => parseAgents(withoutClient)).toThrow('pr-work listing: agents needs client and implementer.');
  expect(() => parseAgents({ ...agents, lists: { code: agents.lists.code[0] } })).toThrow(
    'pr-work listing: lists must be an object whose values are arrays of agents.',
  );
});

test('missing --agents is refused and request is no longer a subcommand', async () => {
  const missing = await run('listing', '--repo', REPO, '--pr', '123', '--repo-dir', checkout);
  expect(missing.exitCode).toBe(1);
  expect(missing.stdout).toBe('');
  expect(missing.stderr).toContain('pr-work listing needs --agents <file>.');

  const removed = await run('request', '--repo', REPO, '--pr', '123', '--agents', agentsPath, '--repo-dir', checkout);
  expect(removed.exitCode).toBe(1);
  expect(removed.stdout).toBe('');
  expect(removed.stderr).toContain('pr-work needs the listing subcommand');
});

test('unknown extra keys in the agents file are tolerated without entering the output', async () => {
  const extra = structuredClone(agents) as typeof agents & { future_top_level?: unknown };
  extra.future_top_level = { anything: true };
  (extra.client as typeof extra.client & { future_agent_key?: string }).future_agent_key = 'ignored';
  (extra.lists.code[0] as typeof extra.lists.code[0] & { future_candidate_key?: string }).future_candidate_key = 'ignored';
  const path = jsonFile('extra-agents.json', extra);
  expect(parseAgents(extra)).toEqual(agents);
  const r = await listing('--agents', path);
  expect(r.exitCode).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual(expectedDefault);
});

test('bad agents JSON is refused without printing its contents', async () => {
  const path = join(root, 'bad-agents.json');
  writeFileSync(path, '{ secret-file-contents');
  const r = await listing('--agents', path);
  expect(r.exitCode).toBe(1);
  expect(r.stdout).toBe('');
  expect(r.stderr).toContain('pr-work listing: agents file is not valid JSON');
  expect(r.stderr).not.toContain('secret-file-contents');
});

test('a missing repo entry or defaults file is a clear refusal', async () => {
  const missingEntry = await run('listing', '--repo', 'acme/other', '--pr', '1', '--agents', agentsPath, '--repo-dir', checkout);
  expect(missingEntry.exitCode).toBe(1);
  expect(missingEntry.stdout).toBe('');
  expect(missingEntry.stderr).toContain('no defaults entry for acme/other');

  const missingFile = await listing('--defaults', join(root, 'missing.json'));
  expect(missingFile.exitCode).toBe(1);
  expect(missingFile.stdout).toBe('');
  expect(missingFile.stderr).toContain('could not read defaults file');
});

test('bad JSON defaults are refused', async () => {
  const path = join(root, 'bad-defaults.json');
  writeFileSync(path, '{ not JSON');
  const r = await listing('--defaults', path);
  expect(r.exitCode).toBe(1);
  expect(r.stdout).toBe('');
  expect(r.stderr).toContain('not valid JSON');
});

test('unknown defaults keys are tolerated and an explicit defaults path and base are used', async () => {
  const path = jsonFile('extra-defaults.json', {
    future_top_level: { anything: true },
    [REPO]: {
      workflows: ['Build'],
      protected_paths: ['docs/**'],
      base: 'release',
      future_entry_key: 'ignored',
    },
  });
  const r = await listing('--defaults', path);
  expect(r.exitCode).toBe(0);
  expect(JSON.parse(r.stdout).listing.contract_inputs).toEqual({
    ...expectedDefault.listing.contract_inputs,
    base: 'release',
    required_ci: ['Build'],
    confirm_paths: ['.github/workflows/**', 'docs/**'],
  });
});

test('a reviewer exclusion becomes a listing refusal', async () => {
  const excluded = structuredClone(agents);
  excluded.lists.security = [excluded.implementer];
  const r = await listing('--agents', jsonFile('excluded-agents.json', excluded));
  expect(r.exitCode).toBe(1);
  expect(r.stdout).toBe('');
  expect(r.stderr).toContain('pr-work listing: no reviewer for security: implementer: security: implementer: impl-h');
});

test('--pr must be a positive integer', async () => {
  for (const pr of ['0', '-1', '1.5', 'not-a-number']) {
    const r = await run('listing', '--repo', REPO, '--pr', pr, '--agents', agentsPath, '--repo-dir', checkout);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('--pr must be a positive integer');
  }
});

test('--repo must match owner/repo', async () => {
  for (const repo of ['acme', 'acme/widget/extra', 'https://github.com/acme/widget', 'acme widget/repo']) {
    const r = await run('listing', '--repo', repo, '--pr', '1', '--agents', agentsPath, '--repo-dir', checkout);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('--repo must match owner/repo');
  }
});

test('pr-work flags are refused on other commands', () => {
  expect(() =>
    parseArgs([
      'pr-work',
      'listing',
      '--repo=acme/widget',
      '--pr=1',
      '--agents=agents.json',
      '--docs-only',
      '--acceptance=Accept CI and reviews.',
      '--defaults=defaults.json',
      '--repo-dir=checkout',
    ]),
  ).not.toThrow();
  for (const flag of ['defaults', 'repo-dir', 'repo', 'pr', 'docs-only', 'agents', 'acceptance'])
    expect(() => parseArgs(['status', `--${flag}=value`])).toThrow(`--${flag} is only for pr-work.`);
});
