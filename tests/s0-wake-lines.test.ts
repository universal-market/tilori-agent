import './setup.ts';
import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { NotifyLinesInjector } from '../src/injectors/notify-lines.ts';
import { buildWake, marketRefs } from '../src/wake.ts';
import type { AgentDelivery, DeliveredEvent, EventRef, Wake } from '../src/types.ts';
import { UpdateNotice } from '../src/update-notice.ts';
import { expectSnapshot, renderCases } from './s0-util.ts';

// UNI-1178 S0: characterization of the wake lines at v0.3.18. Every line is
// what NotifyLinesInjector writes to stdout for one wake (the host-visible
// text), compared byte for byte with tests/snapshots/s0/wake-*.txt. Rewrite
// them on purpose with UPDATE_S0=1 and review the diff.
//
// Inputs are fixed: ids are counter UUIDs, times are fixed epoch ms. Nothing
// is normalised; the lines contain no paths, pids or versions of this repo.

const AGENT = 'wren';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T = Date.UTC(2026, 10, 28, 14, 5); // 2026-11-28 14:05 UTC

const event = (n: number, kind: string, entity_type: DeliveredEvent['entity_type'], extra: Partial<DeliveredEvent> & Record<string, unknown> = {}): DeliveredEvent => ({
  id: id(1000 + n),
  cursor: `c${n}`,
  kind,
  entity_type,
  entity_id: id(n),
  parents: {},
  created_at: '2026-11-28T14:00:00.000Z',
  data: {},
  ...extra,
});
const delivery = (events: DeliveredEvent[], sub = 'sub-a', resync = false): AgentDelivery => ({
  subscription_id: sub,
  delivery_id: `d-${sub}`,
  events,
  resync_required: resync,
});
const DIRECT = new Set(['inbox']);
/** A wake as the router builds it from deliveries. */
const wakeOf = (events: DeliveredEvent[], o: { direct?: boolean; resync?: boolean } = {}): Wake =>
  buildWake(AGENT, [delivery(events, o.direct ? 'inbox' : 'sub-a', o.resync)], 'w-1', DIRECT);
const ref = (n: number, extra: Partial<EventRef> = {}): EventRef => ({ id: id(1000 + n), kind: 'post.created', entity_type: 'post', entity_id: id(n), ...extra });
const bare = (extra: Partial<Wake> = {}): Wake => ({ wake_id: 'w-1', agent: AGENT, events: [], resync_required: false, ...extra });

/** One wake through the real injector: the exact bytes written to stdout. */
async function line(wake: Wake, o: { update?: UpdateNotice } = {}): Promise<string> {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on('data', (c) => chunks.push(c));
  const r = await new NotifyLinesInjector(out, () => {}, o.update).deliver(wake);
  expect(r).toBe('accepted');
  const s = Buffer.concat(chunks).toString('utf8');
  expect(s.endsWith('\n') && s.indexOf('\n') === s.length - 1).toBe(true); // exactly one line
  return s.slice(0, -1);
}
const lines = async (cases: Array<[string, Wake]>) => renderCases(await Promise.all(cases.map(async ([n, w]) => [n, await line(w)] as [string, string])));

const mk = (n: number, kind: string, type: 'transaction' | 'execution' | 'pr_work_offer' = 'transaction') => event(n, kind, type as DeliveredEvent['entity_type']);
const marketWake = (events: DeliveredEvent[], o: { resync?: boolean } = {}): Wake => ({
  ...bare(),
  market: { events: marketRefs([delivery(events)]), ...(o.resync ? { resync: true as const } : {}) },
});

describe('S0 wake lines: Tilori lane', () => {
  test('wake-tilori.txt', async () => {
    const many = Array.from({ length: 12 }, (_, i) => event(20 + i, 'post.created', 'post'));
    const eleven = Array.from({ length: 11 }, (_, i) => event(40 + i, 'post.created', 'post'));
    const cases: Array<[string, Wake]> = [
      ['mention', wakeOf([event(1, 'mention', 'post', { data: { revision: 2 } })])],
      ['post.created (not addressed)', wakeOf([event(2, 'post.created', 'post')])],
      ['post.edited', wakeOf([event(3, 'post.edited', 'post', { data: { revision: 3 } })])],
      ['reply to you (inbox copy)', wakeOf([event(4, 'post.created', 'post')], { direct: true })],
      ['thread started', wakeOf([event(5, 'post.created', 'post', { reason: 'thread_started' })], { direct: true })],
      ['thread claimed', wakeOf([event(6, 'post.created', 'post', { reason: 'thread_claimed' })], { direct: true })],
      ['thread handoff', wakeOf([event(7, 'post.created', 'post', { reason: 'thread_handoff' })], { direct: true })],
      ['dm.request', wakeOf([event(8, 'dm.request', 'conversation', { data: { conversation_id: id(80) } })])],
      ['dm.message', wakeOf([event(9, 'dm.message', 'conversation', { data: { conversation_id: id(90) } })])],
      ['dm.accepted', wakeOf([event(10, 'dm.accepted', 'conversation')])],
      ['owner answer, one', wakeOf([event(11, 'request.answered', 'request' as DeliveredEvent['entity_type'])])],
      ['owner answers, two', wakeOf([event(12, 'request.answered', 'request' as DeliveredEvent['entity_type']), event(13, 'request.answered', 'request' as DeliveredEvent['entity_type'])])],
      ['unknown kind and entity', wakeOf([event(14, 'something.new', 'listing'), { ...event(15, 'post.created', 'post'), entity_id: 'not-a-uuid' }])],
      ['mixed order (addressed first)', wakeOf([event(16, 'post.created', 'post'), event(17, 'mention', 'post'), event(18, 'dm.message', 'conversation')])],
      ['eleven events (one not listed)', wakeOf(eleven)],
      ['twelve events (two not listed)', wakeOf(many)],
      ['resync_required, no events', bare({ resync_required: true })],
      ['resync_required with an event', wakeOf([event(19, 'mention', 'post')], { resync: true })],
      ['quiet +3', { ...wakeOf([event(1, 'mention', 'post')]), quiet: 3 }],
      ['quiet 10+', { ...wakeOf([event(1, 'mention', 'post')]), quiet: 10 }],
      ['held_back 1', { ...wakeOf([event(1, 'mention', 'post')]), held_back: 1 }],
      ['held_back 4', { ...wakeOf([event(1, 'mention', 'post')]), held_back: 4 }],
      ['already_delivered 1', { ...wakeOf([event(1, 'mention', 'post')]), already_delivered: 1 }],
      ['already_delivered 2', { ...wakeOf([event(1, 'mention', 'post')]), already_delivered: 2 }],
      ['still_held 1', { ...wakeOf([event(1, 'mention', 'post')]), still_held: 1 }],
      ['still_held 3', { ...wakeOf([event(1, 'mention', 'post')]), still_held: 3 }],
      ['wakes_resume_at', { ...wakeOf([event(1, 'mention', 'post')]), wakes_resume_at: T }],
      ['posts_left 0 with reset', { ...wakeOf([event(1, 'mention', 'post')]), posts_left: 0, posts_reset_at: T }],
      ['posts_left 1', { ...wakeOf([event(1, 'mention', 'post')]), posts_left: 1 }],
      ['posts_left 7 with reset', { ...wakeOf([event(1, 'mention', 'post')]), posts_left: 7, posts_reset_at: T }],
      ['plugin_update', { ...wakeOf([event(1, 'mention', 'post')]), plugin_update: { installed: '0.1.31', running: '0.1.30' } }],
      ['tools_changed', { ...wakeOf([event(1, 'mention', 'post')]), tools_changed: true }],
    ];
    // Held for a digest: one ref per filter reason.
    for (const reason of ['claim', 'joined', 'ack', 'fyi', 'progress', 'verdict_other', 'other'] as const) {
      cases.push([`digest held: ${reason}`, bare({ events: [ref(30, { held: reason })] })]);
    }
    cases.push(['digest held and reply to you', bare({ events: [ref(31, { to_you: true, held: 'fyi' })] })]);
    // Dropped by the wake filter.
    cases.push(
      ['filter_dropped one', { ...wakeOf([event(1, 'mention', 'post')]), filter_dropped: { count: 1, reasons: { ack: 1 }, ids: [id(50)] } }],
      [
        'filter_dropped many',
        { ...wakeOf([event(1, 'mention', 'post')]), filter_dropped: { count: 14, reasons: { ack: 9, fyi: 3, other: 2 }, ids: [id(50), id(51), id(52)], more: 11 } },
      ],
      ['filter_dropped no ids', { ...wakeOf([event(1, 'mention', 'post')]), filter_dropped: { count: 2, reasons: {}, ids: [] } }],
    );
    // Day-old backlog.
    const d1 = Date.UTC(2026, 10, 20, 3);
    const d2 = Date.UTC(2026, 10, 22, 9);
    cases.push(
      ['backlog one day', { ...wakeOf([event(1, 'mention', 'post')]), backlog: { count: 1, from: d1, to: d1 } }],
      ['backlog range', { ...wakeOf([event(1, 'mention', 'post')]), backlog: { count: 8, from: d1, to: d2 } }],
      ['backlog addressed to you', { ...wakeOf([event(1, 'mention', 'post')]), backlog: { count: 5, from: d1, to: d2, to_you: [id(60)] } }],
      ['backlog addressed to you, more', { ...wakeOf([event(1, 'mention', 'post')]), backlog: { count: 30, from: d1, to: d2, to_you: [id(60), id(61)], to_you_more: 6 } }],
    );
    expectSnapshot('wake-tilori.txt', await lines(cases));
  });

  test('wake-reminder-and-monitor.txt', async () => {
    const rem = (extra: Partial<Wake> = {}) => bare({ reminder: '  Check the board.  ', ...extra });
    const cases: Array<[string, Wake]> = [
      ['reminder', rem()],
      ['reminder, multi-line text is flattened to one line', rem({ reminder: 'First line\nSecond line\r\nThird' })],
      ['reminder with gate findings', rem({ gate: { findings: ['PR 12 waits on you', 'CI red on main'] } })],
      ['reminder with one gate finding', rem({ gate: { findings: ['PR 12 waits on you'] } })],
      ['reminder with gate naming no finding', rem({ gate: { findings: [] } })],
      ['reminder gate failed: timeout', rem({ gate: { failed: 'timeout' } })],
      ['reminder gate ceiling', rem({ gate: { ceiling: 6 } })],
      ['reminder with every note', rem({ posts_left: 3, posts_reset_at: T, wakes_resume_at: T, plugin_update: { installed: '0.2.0', running: '0.1.9' }, tools_changed: true, filter_dropped: { count: 2, reasons: { fyi: 2 }, ids: [id(50), id(51)] }, backlog: { count: 2, from: T, to: T } })],
      ['push down, polling', bare({ push: { state: 'down', since: T, polling: true } })],
      ['push down', bare({ push: { state: 'down', since: T } })],
      ['push back, 1 caught', bare({ push: { state: 'back', caught: 1 } })],
      ['push back, 3 caught', bare({ push: { state: 'back', caught: 3 } })],
      ['push down with plugin_update', bare({ push: { state: 'down', since: T }, plugin_update: { installed: '0.2.0', running: '0.1.9' } })],
      ['polls ok', bare({ polls: { state: 'ok' } })],
      ['polls failing: key refused', bare({ polls: { state: 'failing', since: T, reason: 'auth', key_refused: true } })],
    ];
    for (const reason of ['auth', 'access', 'refused', 'timeout', 'network', 'other'] as const) {
      cases.push([`polls failing: ${reason}`, bare({ polls: { state: 'failing', since: T, reason } })]);
    }
    for (const reason of ['not_authorized', 'unreachable', 'subscription_refused', 'other'] as const) {
      cases.push([`market off: ${reason}`, bare({ market_off: reason })]);
    }
    expectSnapshot('wake-reminder-and-monitor.txt', await lines(cases));
  });

  test('plugin_update and tools_changed notes are added by the injector, once', async () => {
    // The injector, not the router, adds these: drive its own state across
    // three wakes (an update notice that is said once; a tools hash that
    // differs from the first one this session saw, said once per hash).
    const manifest = JSON.stringify({ plugins: { 'universal-market@tilori-claude': [{ scope: 'user', version: '0.1.31' }] } });
    const update = new UpdateNotice({ running: '0.1.30', manifest: '/unused', key: 'universal-market@tilori-claude', now: () => 0, read: () => manifest });
    const out = new PassThrough();
    const got: string[] = [];
    out.on('data', (c) => got.push(String(c)));
    const inj = new NotifyLinesInjector(out, () => {}, update);
    const w = (hash: string) => ({ ...wakeOf([event(1, 'mention', 'post')]), tools_hash: hash });
    for (const h of ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'bbbbbbbbbbbbbbbb']) await inj.deliver(w(h));
    const text = renderCases(got.map((s, i) => [`wake ${i + 1}`, s.slice(0, -1)] as [string, string]));
    expectSnapshot('wake-injector-notes.txt', text);
  });
});

describe('S0 wake lines: Market lane', () => {
  test('wake-market.txt', async () => {
    const kinds = [
      'transaction.contract_proposed',
      'task.ready',
      'execution.changed',
      'transaction.contract_accepted',
      'transaction.contract_committed',
      'transaction.closed',
      'transaction.contract_acceptance_retracted',
      'execution.closed',
      'transaction.message',
    ];
    const cases: Array<[string, Wake]> = [];
    kinds.forEach((k, i) => {
      const type = k.startsWith('execution') || k === 'task.ready' ? 'execution' : 'transaction';
      cases.push([`alone: ${k}`, marketWake([mk(100 + i, k, type)])]);
    });
    cases.push(
      ['alone: unknown kind', marketWake([mk(120, 'transaction.surprise')])],
      ['alone: invalid id', marketWake([{ ...mk(121, 'task.ready', 'execution'), entity_id: 'nope' }])],
      ['alone: offer opened', marketWake([mk(122, 'pr_work_offer.opened', 'pr_work_offer')])],
      ['alone: offer closed', marketWake([mk(123, 'pr_work_offer.closed', 'pr_work_offer')])],
      ['alone: offer closed and execution closed', marketWake([mk(124, 'pr_work_offer.closed', 'pr_work_offer'), mk(125, 'execution.closed', 'execution')])],
      ['alone: two owed', marketWake([mk(126, 'transaction.contract_proposed'), mk(127, 'task.ready', 'execution')])],
      ['alone: owed and outcome', marketWake([mk(128, 'transaction.contract_accepted'), mk(129, 'transaction.closed')])],
      ['alone: only outcomes', marketWake([mk(130, 'transaction.closed'), mk(131, 'execution.closed', 'execution')])],
      ['alone: eleven items', marketWake(Array.from({ length: 11 }, (_, i) => mk(140 + i, 'transaction.message')))],
      ['alone: resync with an item', marketWake([mk(150, 'transaction.message')], { resync: true })],
      ['alone: resync, no items', marketWake([], { resync: true })],
      ['alone: entity type not passed on is dropped', marketWake([mk(151, 'listing.created', 'listing' as 'transaction')])],
    );
    // After a Tilori line.
    const t = [event(1, 'mention', 'post')];
    cases.push(
      ['with Tilori: owed', { ...wakeOf(t), market: { events: marketRefs([delivery([mk(160, 'task.ready', 'execution'), mk(161, 'task.ready', 'execution'), mk(162, 'transaction.message')])]) } }],
      ['with Tilori: outcome', { ...wakeOf(t), market: { events: marketRefs([delivery([mk(163, 'transaction.closed')])]) } }],
      ['with Tilori: owed and outcome and offer', { ...wakeOf(t), market: { events: marketRefs([delivery([mk(164, 'transaction.contract_proposed'), mk(165, 'execution.closed', 'execution'), mk(166, 'pr_work_offer.opened', 'pr_work_offer')])]) } }],
      ['with Tilori: resync only', { ...wakeOf(t), market: { events: [], resync: true } }],
      ['with Tilori: resync and owed', { ...wakeOf(t), market: { events: marketRefs([delivery([mk(167, 'task.ready', 'execution')])]), resync: true } }],
      ['Market alone with held_back and posts_left', { ...marketWake([mk(168, 'task.ready', 'execution')]), held_back: 2, posts_left: 4, posts_reset_at: T, plugin_update: { installed: '0.2.0', running: '0.1.9' }, tools_changed: true }],
    );
    expectSnapshot('wake-market.txt', await lines(cases));
  });
});
