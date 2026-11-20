import './setup.ts';
import { expect, test } from 'bun:test';
import { selectReviewers, type Agent } from '../src/pr-work-select.ts';

const agent = (agent: string, handle = agent, owner = `acct-${agent}`, github_user_id?: number): Agent => ({
  agent,
  handle,
  owner,
  ...(github_user_id === undefined ? {} : { github_user_id }),
});

const implementer = agent('impl', 'impl-h', 'acct-impl');
const client = agent('client', 'client-h', 'acct-client');

const input = (over: Partial<Parameters<typeof selectReviewers>[0]> = {}) => ({
  kinds: ['code', 'security'] as ('code' | 'security' | 'docs')[],
  implementer,
  client,
  lists: {} as Record<string, Agent[]>,
  ...over,
});

const handles = (r: ReturnType<typeof selectReviewers>) => (r.ok ? r.picks.map((p) => p.agent.handle) : []);

test('picks the first valid candidate for each kind, in kinds order', () => {
  const r = selectReviewers(
    input({
      lists: { code: [agent('c1', 'code-one'), agent('c2', 'code-two')], security: [agent('s1', 'sec-one')] },
    }),
  );
  expect(r).toEqual({
    ok: true,
    picks: [
      { kind: 'code', agent: agent('c1', 'code-one') },
      { kind: 'security', agent: agent('s1', 'sec-one') },
    ],
  });
});

test('skips the implementer and the opener by agent id, never by handle', () => {
  const opener = agent('opener', 'impl-h', 'acct-opener'); // same handle as implementer
  const r = selectReviewers(
    input({
      opener,
      lists: { code: [implementer, opener, agent('c1', 'code-one')], security: [agent('s1', 'sec-one')] },
    }),
  );
  expect(handles(r)).toEqual(['code-one', 'sec-one']);
});

test('skips the client', () => {
  const r = selectReviewers(
    input({ kinds: ['code'], lists: { code: [client, agent('c1', 'code-one')] } }),
  );
  expect(handles(r)).toEqual(['code-one']);
});

test('a candidate that shares the implementer owner is accepted', () => {
  const sameOwner = agent('x', 'same-owner-h', 'acct-impl', 11);
  const r = selectReviewers(
    input({ kinds: ['code'], implementer: { ...implementer, github_user_id: 10 }, lists: { code: [sameOwner] } }),
  );
  expect(handles(r)).toEqual(['same-owner-h']);
});

test('a same-owner implementer, client or opener is still never picked', () => {
  const sameOwner = (a: Agent): Agent => ({ ...a, owner: 'acct-impl' });
  const r = selectReviewers(
    input({
      kinds: ['code'],
      opener: agent('opener', 'opener-h', 'acct-impl'),
      client: sameOwner(client),
      lists: {
        code: [implementer, sameOwner(client), agent('opener', 'opener-h2', 'acct-impl'), agent('ok', 'ok-h', 'acct-impl')],
      },
    }),
  );
  expect(handles(r)).toEqual(['ok-h']);
});

test('a candidate on the same GitHub bot as the implementer or opener is skipped', () => {
  const r = selectReviewers(
    input({
      kinds: ['code'],
      implementer: { ...implementer, github_user_id: 10 },
      opener: agent('opener', 'opener-h', 'acct-opener', 12),
      lists: { code: [agent('a', 'bot-impl', 'acct-impl', 10), agent('b', 'bot-open', 'acct-b', 12), agent('c', 'fine', 'acct-impl', 13)] },
    }),
  );
  expect(handles(r)).toEqual(['fine']);
});

test('two reviewers on the same GitHub bot cannot both be picked', () => {
  const r = selectReviewers(
    input({
      lists: { code: [agent('a', 'code-a', 'acct-a', 20)], security: [agent('b', 'sec-b', 'acct-b', 20), agent('c', 'sec-c', 'acct-c', 21)] },
    }),
  );
  expect(handles(r)).toEqual(['code-a', 'sec-c']);
});

test('a candidate with no known bot id is not excluded by the bot rule', () => {
  const r = selectReviewers(
    input({ kinds: ['code'], implementer: { ...implementer, github_user_id: 10 }, lists: { code: [agent('a', 'a-h', 'acct-impl')] } }),
  );
  expect(handles(r)).toEqual(['a-h']);
});

test('one agent cannot fill two kinds; the second kind picks the next candidate', () => {
  const shared = agent('shared', 'shared-h', 'acct-shared');
  const r = selectReviewers(
    input({
      lists: { code: [shared, agent('c2', 'code-two')], security: [shared, agent('s2', 'sec-two')] },
    }),
  );
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.picks.map((p) => p.kind)).toEqual(['code', 'security']);
    expect(r.picks.map((p) => p.agent.agent)).toEqual(['shared', 's2']);
  }
});

test('refuses with implementer and a useful detail when only the implementer is listed', () => {
  const r = selectReviewers(input({ kinds: ['code'], lists: { code: [implementer] } }));
  expect(r).toEqual({
    ok: false,
    rule: 'implementer',
    kind: 'code',
    detail: 'code: implementer: impl-h; client: -; other_reviewer: -; same_bot: -',
  });
});

test('refuses with client and a useful detail when only the client is listed', () => {
  const r = selectReviewers(input({ kinds: ['code'], lists: { code: [client] } }));
  expect(r).toEqual({
    ok: false,
    rule: 'client',
    kind: 'code',
    detail: 'code: implementer: -; client: client-h; other_reviewer: -; same_bot: -',
  });
});

test('refuses with other_reviewer when an earlier kind took the only candidate', () => {
  const shared = agent('shared', 'shared-h');
  const r = selectReviewers(input({ lists: { code: [shared], security: [shared] } }));
  expect(r).toEqual({
    ok: false,
    rule: 'other_reviewer',
    kind: 'security',
    detail: 'security: implementer: -; client: -; other_reviewer: shared-h; same_bot: -',
  });
});

test('refuses with same_bot when every candidate shares the implementer bot', () => {
  const r = selectReviewers(
    input({
      kinds: ['code'],
      implementer: { ...implementer, github_user_id: 10 },
      lists: { code: [agent('a', 'alpha-h', 'acct-impl', 10), agent('b', 'beta-h', 'acct-b', 10)] },
    }),
  );
  expect(r).toEqual({
    ok: false,
    rule: 'same_bot',
    kind: 'code',
    detail: 'code: implementer: -; client: -; other_reviewer: -; same_bot: alpha-h, beta-h',
  });
});

test('the refusal names the rule that excluded the most candidates', () => {
  const r = selectReviewers(
    input({
      kinds: ['code'],
      lists: {
        code: [
          client,
          agent('b', 'beta-h', 'acct-b', 10),
          agent('c', 'gamma-h', 'acct-c', 10),
        ],
      },
      implementer: { ...implementer, github_user_id: 10 },
    }),
  );
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.rule).toBe('same_bot');
});

test('equal exclusion counts name implementer first', () => {
  const shared = agent('shared', 'shared-h');
  const sameBot = agent('owned', 'owned-h', 'acct-owned', 10);
  const r = selectReviewers(
    input({
      implementer: { ...implementer, github_user_id: 10 },
      lists: { code: [shared], security: [implementer, client, shared, sameBot] },
    }),
  );
  expect(r).toEqual({
    ok: false,
    rule: 'implementer',
    kind: 'security',
    detail: 'security: implementer: impl-h; client: client-h; other_reviewer: shared-h; same_bot: owned-h',
  });
});

test('empty agent ids or owners fail closed for every actor and candidate', () => {
  for (const field of ['agent', 'owner'] as const) {
    const invalid = (base: Agent): Agent => ({ ...base, [field]: '' });
    const cases: { role: string; over: Partial<Parameters<typeof selectReviewers>[0]> }[] = [
      { role: 'implementer', over: { implementer: invalid(implementer) } },
      { role: 'client', over: { client: invalid(client) } },
      { role: 'opener', over: { opener: invalid(agent('opener', 'opener-h')) } },
      { role: 'candidate', over: { lists: { code: [agent('valid', 'valid-h'), invalid(agent('bad', 'bad-h'))] } } },
    ];
    for (const { role, over } of cases) {
      const r = selectReviewers(input({ kinds: ['code'], lists: { code: [agent('c1', 'code-one')] }, ...over }));
      expect(r).toEqual({
        ok: false,
        rule: 'not_listed',
        kind: 'code',
        detail: `code: ${role} has an empty agent or owner`,
      });
    }
  }
});

test('missing or empty list refuses with no_list', () => {
  const missing = selectReviewers(input({ kinds: ['code'], lists: {} }));
  expect(missing).toMatchObject({ ok: false, rule: 'no_list', kind: 'code' });

  const empty = selectReviewers(input({ kinds: ['security'], lists: { security: [] } }));
  expect(empty).toMatchObject({ ok: false, rule: 'no_list', kind: 'security' });
});

test('empty kinds refuses with no_list and detail "no kinds"', () => {
  const r = selectReviewers(input({ kinds: [], lists: { code: [agent('c1')] } }));
  expect(r).toEqual({ ok: false, rule: 'no_list', kind: '', detail: 'no kinds' });
});

test('docs-only selects a docs reviewer', () => {
  const r = selectReviewers(
    input({ kinds: ['docs'], lists: { docs: [agent('d1', 'docs-one'), agent('d2', 'docs-two')] } }),
  );
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.picks).toEqual([{ kind: 'docs', agent: agent('d1', 'docs-one') }]);
});

test('an unknown kind refuses with not_listed', () => {
  const r = selectReviewers(
    input({ kinds: ['deploy' as 'code'], lists: { deploy: [agent('x', 'x-h')] } }),
  );
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.rule).toBe('not_listed');
    expect(r.kind).toBe('deploy');
  }
});

test('does not mutate its input', () => {
  const lists = { code: [implementer, agent('c1', 'code-one')], security: [agent('s1', 'sec-one')] };
  const inp = input({ lists });
  const before = JSON.stringify(inp);
  const r = selectReviewers(inp);
  expect(r.ok).toBe(true);
  expect(JSON.stringify(inp)).toBe(before);
  expect(inp.lists).toBe(lists);
  expect(lists.code).toEqual([implementer, agent('c1', 'code-one')]);
});

test('same handle with a different agent id is a different agent', () => {
  const twinHandle = agent('other-id', 'impl-h', 'acct-other');
  const r = selectReviewers(
    input({ kinds: ['code'], lists: { code: [implementer, twinHandle] } }),
  );
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.picks[0].agent.agent).toBe('other-id');
});

test('is deterministic across repeated calls', () => {
  const inp = input({
    lists: { code: [implementer, agent('c1', 'code-one')], security: [agent('s1', 'sec-one')] },
  });
  expect(selectReviewers(inp)).toEqual(selectReviewers(inp));
});
