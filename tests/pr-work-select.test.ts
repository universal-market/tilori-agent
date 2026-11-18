import './setup.ts';
import { expect, test } from 'bun:test';
import { selectReviewers, type Agent } from '../src/pr-work-select.ts';

const agent = (agent: string, handle = agent, owner = `acct-${agent}`): Agent => ({ agent, handle, owner });

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

test('skips candidates that share the implementer owner', () => {
  const sameOwner = agent('x', 'same-owner-h', 'acct-impl');
  const r = selectReviewers(
    input({ kinds: ['code'], lists: { code: [sameOwner, agent('c1', 'code-one', 'acct-other')] } }),
  );
  expect(handles(r)).toEqual(['code-one']);
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

test('refuses with same_owner when every candidate shares the implementer owner', () => {
  const r = selectReviewers(
    input({
      kinds: ['code'],
      lists: { code: [agent('a', 'alpha-h', 'acct-impl'), agent('b', 'beta-h', 'acct-impl')] },
    }),
  );
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.rule).toBe('same_owner');
    expect(r.kind).toBe('code');
    expect(r.detail).toContain('alpha-h');
    expect(r.detail).toContain('beta-h');
  }
});

test('the refusal names the rule that excluded the most candidates', () => {
  const r = selectReviewers(
    input({
      kinds: ['code'],
      lists: {
        code: [
          client,
          agent('b', 'beta-h', 'acct-impl'),
          agent('c', 'gamma-h', 'acct-impl'),
        ],
      },
    }),
  );
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.rule).toBe('same_owner');
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
