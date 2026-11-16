import './setup.ts';
import { mkdtempSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'bun:test';
import { writeCapsSignal } from '../src/activity.ts';
import { main } from '../src/cli.ts';
import {
  BLOCK_REASON,
  STOP_BLOCK_COOLDOWN_MS,
  asksOwner,
  lastAssistantText,
  readCanAsk,
  readHookInput,
  stopCheck,
  type StopCheckEnv,
} from '../src/stop-check.ts';

// UNI-956: the end-of-turn owner-decision check. Fixtures are paraphrased
// from the 24 h replay in the design (ad78d60f §0), with names removed.

describe('asksOwner', () => {
  const asks = [
    'Decision for you: merge #12 now, or wait for the rerun?',
    '**Your call:** keep the old endpoint for one more release.',
    'This needs your OK before I push.',
    'I am blocked on your approval for the staging deploy.',
    'Say go and I will tag it.',
    'Please confirm the new limit of 20 is right.',
    'Let me know which of the two names you prefer.',
    'Do you want me to remove the stale worktrees as well?',
    'Should I open the follow-up PR now or after the restart?',
    'OK to delete the old branch?',
    // The last-sentence rule: plain questions the patterns missed.
    'I checked the invoices.\n\nWhich service are those invoices from?',
    'Done with the setup. Have you switched billing to the org account?',
  ];
  for (const message of asks) test(`asks: ${message.slice(0, 50)}`, () => expect(asksOwner(message)).toBe(true));

  const notAsks = [
    'Merged #12 and tagged v0.3.7. Nothing needs you.',
    'Waiting on your decision, filed as owner request 1a2b3c4d.',
    'That is in your inbox already.',
    'You approved it earlier, so I merged it.',
    'Reviews are in. CI is green.',
    // Code and quotes are not the agent asking.
    'The test checks this:\n```\nshould I retry?\n```\nIt passes.',
    'Pax wrote:\n> Do you want me to rebase?\nI rebased.',
    'The `should I?` string is in the fixture.',
    // Third person: the hook can't know the owner's name (design §2).
    "Making the repo public is still Don's call.",
    '',
  ];
  for (const message of notAsks)
    test(`does not ask: ${message.slice(0, 50) || '(empty)'}`, () => expect(asksOwner(message)).toBe(false));

  test('only the last 4 KB is matched', () => {
    const ask = 'Do you want me to merge it?\n';
    expect(asksOwner(ask + 'Status line.\n'.repeat(400))).toBe(false);
    expect(asksOwner('Status line.\n'.repeat(400) + ask)).toBe(true);
  });
});

let dir = '';
const env = (over: Partial<StopCheckEnv> = {}): StopCheckEnv => ({
  enabled: true,
  handle: 'wren',
  dir,
  now: 10_000_000_000,
  ...over,
});
const ASK = { last_assistant_message: 'Decision for you: ship it today?' };
const BLOCK = JSON.stringify({ decision: 'block', reason: BLOCK_REASON });
function stamp(name: string, ms: number) {
  const p = join(dir, `${name}-wren`);
  writeFileSync(p, '');
  utimesSync(p, ms / 1000, ms / 1000);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tilori-stopcheck-'));
  writeCapsSignal(dir, 'wren', true);
});

describe('stopCheck', () => {

  test('the reason is the approved text (Juniper bad34148)', () => {
    expect(BLOCK_REASON).toBe(
      'Your last message asks your owner for a decision, but no owner request was filed this turn. ' +
        'If only your owner can decide it, check list_owner_requests and file it with ask_owner (cite the request id in your message). ' +
        'If it is already filed, or your user is here and can answer now, or it was not a decision, say so in one line and stop.',
    );
  });

  test('blocks once with the fixed reason, and echoes nothing from the message', () => {
    const out = stopCheck({ last_assistant_message: 'Decision for you: rename it to zebra-77?' }, env());
    expect(out).toBe(BLOCK);
    expect(out).not.toContain('zebra');
    expect(statSync(join(dir, 'stopblock-wren')).mtimeMs).toBe(env().now);
  });

  test('off, already continued by a hook, or no ask: nothing', () => {
    expect(stopCheck(ASK, env({ enabled: false }))).toBeNull();
    expect(stopCheck({ ...ASK, stop_hook_active: true }, env())).toBeNull();
    expect(stopCheck({ last_assistant_message: 'Merged and tagged.' }, env())).toBeNull();
    expect(stopCheck({}, env())).toBeNull();
  });

  test('an agent that cannot file requests is never blocked', () => {
    writeCapsSignal(dir, 'wren', false);
    expect(stopCheck(ASK, env())).toBeNull();
    expect(stopCheck(ASK, env({ handle: 'iris' }))).toBeNull();
  });

  test('caps- must be exactly {"ask_owner":true} in this user\'s regular file', () => {
    expect(readCanAsk(dir, 'wren')).toBe(true);
    for (const bad of ['{"ask_owner":"true"}', '{"ask_owner":true,"x":1}', '[true]', 'true', '{']) {
      writeFileSync(join(dir, 'caps-wren'), bad);
      expect(readCanAsk(dir, 'wren')).toBe(false);
    }
    const other = mkdtempSync(join(tmpdir(), 'tilori-stopcheck-other-'));
    writeCapsSignal(other, 'iris', true);
    symlinkSync(join(other, 'caps-iris'), join(dir, 'caps-lark'));
    expect(readCanAsk(dir, 'lark')).toBe(false);
    expect(readCanAsk(dir, '../wren')).toBe(false);
  });

  test('an ask_owner since the last check means it was filed this turn', () => {
    const now = env().now;
    stamp('stopcheck', now - 60_000);
    stamp('asked', now - 30_000);
    expect(stopCheck(ASK, env())).toBeNull();
    // The next turn: that ask is older than this check, so a new ask blocks.
    expect(stopCheck(ASK, env({ now: now + 60_000 }))).toBe(BLOCK);
  });

  test('at most one block per 30 minutes', () => {
    const now = env().now;
    expect(stopCheck(ASK, env())).toBe(BLOCK);
    expect(stopCheck(ASK, env({ now: now + STOP_BLOCK_COOLDOWN_MS - 1 }))).toBeNull();
    expect(stopCheck(ASK, env({ now: now + STOP_BLOCK_COOLDOWN_MS }))).toBe(BLOCK);
  });

  test('without last_assistant_message it reads the transcript tail; a symlink or missing file is no block', () => {
    const transcript = join(dir, 't.jsonl');
    const row = (type: string, text: string) =>
      JSON.stringify({ type, message: { content: [{ type: 'text', text }] } });
    writeFileSync(transcript, [row('assistant', 'Earlier.'), row('user', 'ok'), row('assistant', 'Should I merge it now?')].join('\n') + '\n');
    expect(lastAssistantText(transcript)).toBe('Should I merge it now?');
    expect(stopCheck({ transcript_path: transcript }, env())).toBe(BLOCK);
    const link = join(dir, 'link.jsonl');
    symlinkSync(transcript, link);
    expect(lastAssistantText(link)).toBeNull();
    expect(lastAssistantText(join(dir, 'missing.jsonl'))).toBeNull();
  });
});

describe('the CLI', () => {
  test('readHookInput takes one JSON object and refuses anything else', async () => {
    const from = (...parts: string[]) =>
      (async function* () {
        for (const p of parts) yield new TextEncoder().encode(p);
      })();
    expect(await readHookInput(from('{"stop_hook_active":', 'false}'))).toEqual({ stop_hook_active: false });
    expect(await readHookInput(from('[1]'))).toBeNull();
    expect(await readHookInput(from('not json'))).toBeNull();
    expect(await readHookInput(from('x'.repeat((1 << 20) + 1)))).toBeNull();
  });

  test('stop-check exits 0 and prints nothing without --hook or on bad flags', async () => {
    const out: string[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((s: string) => (out.push(String(s)), true)) as any;
    try {
      expect(await main(['stop-check'])).toBe(0);
      expect(await main(['stop-check', '--no-such-flag'])).toBe(0);
    } finally {
      process.stdout.write = write;
    }
    expect(out).toEqual([]);
  });

  test('the block JSON is what a Claude Code Stop hook reads', () => {
    const got = JSON.parse(stopCheck(ASK, env())!);
    expect(Object.keys(got).sort()).toEqual(['decision', 'reason']);
    expect(got.decision).toBe('block');
    expect(readFileSync(join(dir, 'caps-wren'), 'utf8')).toBe('{"ask_owner":true}');
  });
});
