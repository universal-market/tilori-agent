import './setup.ts';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { reminderSettings } from '../src/config.ts';
import {
  cleanFinding,
  MAX_FINDING_CHARS,
  parseGate,
  reminderGateSettings,
  runGate,
  validFinding,
  type ReminderGate,
} from '../src/reminder-gate.ts';
import { Router } from '../src/router.ts';
import type { DeliverResult, Injector, Wake } from '../src/types.ts';
import { sanitizeWake, wakeText } from '../src/wake.ts';
import { FakeTilori, mention, until } from './fake-tilori.ts';

class Recorder implements Injector {
  readonly kind = 'test';
  wakes: Wake[] = [];
  async deliver(wake: Wake): Promise<DeliverResult> {
    this.wakes.push(wake);
    return 'accepted';
  }
}

/** A private scratch directory under the test HOME. */
function scratch(): string {
  const dir = mkdtempSync(join(process.env.HOME!, 'rg-'));
  chmodSync(dir, 0o700);
  return dir;
}

/** A gate script: `body` is POSIX sh; stdin is the gate input. */
function script(body: string): string {
  const path = join(scratch(), 'gate');
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const gateOf = (body: string, timeoutMs = 5_000): ReminderGate => ({ argv: [script(body)], timeoutMs });
const printing = (json: unknown) => gateOf(`cat >/dev/null\necho '${JSON.stringify(json)}'`);

function setup(gate: ReminderGate, onlyWhenIdle = true) {
  const fake = new FakeTilori();
  const logs: string[] = [];
  const router = new Router({
    agents: [
      {
        handle: 'wren',
        client: fake.client(),
        subscriptions: [{ scope: { type: 'inbox' } }],
        reminder: { everyMs: 100, prompt: 'Run the check-in.', onlyWhenIdle, gate },
      },
    ],
    logger: (m) => logs.push(m),
    waitMs: 10,
    retryMs: 10,
    coalesceMs: 0,
    plainHoldMs: 0,
    directPauseMs: 0,
    broadPauseMs: 0,
  });
  const inj = new Recorder();
  router.register('wren', inj);
  const ac = new AbortController();
  const done = router.run(ac.signal);
  return { fake, router, logs, ac, done, inj };
}

describe('reminderGateSettings', () => {
  const file = (mode: number) => ({ isFile: () => true, mode }) as any;
  const dir = (mode: number) => ({ isFile: () => false, mode }) as any;
  const stat = (fileMode: number, dirMode = 0o755) => ((p: string) => (p === '/opt/g/gate' ? file(fileMode) : dir(dirMode))) as any;
  const real = (p: string) => p;
  test('unset is off; the default timeout applies', () => {
    expect(reminderGateSettings(undefined)).toBeUndefined();
    expect(reminderGateSettings({ command: ['/opt/g/gate', '--agent', 'keel'] }, stat(0o755), real)).toEqual({
      argv: ['/opt/g/gate', '--agent', 'keel'],
      timeoutMs: 60_000,
    });
  });
  test('refuses a relative path, a shell string, unknown keys and an out-of-range timeout (Bastion c3f5cd8f 1)', () => {
    expect(() => reminderGateSettings({ command: ['gate'] }, stat(0o755), real)).toThrow('reminder.gate.command[0] must be an absolute path');
    expect(() => reminderGateSettings({ command: '/opt/g/gate' }, stat(0o755), real)).toThrow('argv');
    expect(() => reminderGateSettings({ command: ['/opt/g/gate'], shell: true }, stat(0o755), real)).toThrow('not a setting');
    expect(() => reminderGateSettings({ command: ['/opt/g/gate'], timeout_seconds: 121 }, stat(0o755), real)).toThrow('1 to 120');
    expect(() => reminderGateSettings({ command: ['/opt/g/gate'], timeout_seconds: 0 }, stat(0o755), real)).toThrow('1 to 120');
  });
  test('refuses a world-writable or non-executable program, and a world-writable directory', () => {
    expect(() => reminderGateSettings({ command: ['/opt/g/gate'] }, stat(0o757), real)).toThrow('world-writable');
    expect(() => reminderGateSettings({ command: ['/opt/g/gate'] }, stat(0o644), real)).toThrow('not executable');
    expect(() => reminderGateSettings({ command: ['/opt/g/gate'] }, stat(0o755, 0o1777), real)).toThrow('world-writable directory');
  });
  test('a bad gate makes the whole reminder setting fail, never a silent plain reminder', () => {
    expect(() => reminderSettings({ reminder: { every_minutes: 30, prompt: 'Check in.', gate: { command: ['gate'] } } } as any)).toThrow(
      'absolute path',
    );
  });
});

describe('parseGate', () => {
  test('quiet and wake', () => {
    expect(parseGate('{"wake":false}')).toEqual({ wake: false });
    expect(parseGate('{"wake":false,"findings":[]}')).toEqual({ wake: false });
    expect(parseGate('{"wake":true,"findings":["READY: #1249. Merge it."]}')).toEqual({ wake: true, findings: ['READY: #1249. Merge it.'] });
    expect(parseGate('{"wake":true}')).toEqual({ wake: true, findings: [] });
  });
  test('strict: anything else is a failure (Bastion c3f5cd8f 4)', () => {
    for (const bad of [
      'not json',
      '[]',
      'null',
      '{"wake":"yes"}',
      '{"wake":1}',
      '{"findings":["x"]}',
      '{"wake":false,"findings":["x"]}',
      '{"wake":true,"findings":"x"}',
      '{"wake":true,"findings":[1]}',
      '{"wake":true,"findings":["x"],"extra":1}',
      JSON.stringify({ wake: true, findings: Array.from({ length: 11 }, (_, i) => `f${i}`) }),
    ])
      expect(parseGate(bad)).toBeNull();
  });
  test('findings are cleaned; ones that clean to nothing are left out', () => {
    expect(parseGate(JSON.stringify({ wake: true, findings: ['  a\n\tb  ', '\u0007'] }))).toEqual({ wake: true, findings: ['a b'] });
  });
});

describe('cleanFinding (Bastion c3f5cd8f 5)', () => {
  test('a right-to-left override, a zero-width space, a line separator and control characters are stripped', () => {
    const rlo = String.fromCodePoint(0x202e);
    const zwsp = String.fromCodePoint(0x200b);
    const ls = String.fromCodePoint(0x2028);
    const nul = String.fromCodePoint(0);
    const esc = String.fromCodePoint(0x1b);
    expect(cleanFinding(`agent-lark${rlo}: no action${zwsp} for 52 min${ls}.${nul}${esc}[31m`)).toBe('agent-lark: no action for 52 min .[31m');
  });
  test('capped at the limit, by characters', () => {
    const long = 'é'.repeat(500);
    const out = cleanFinding(long);
    expect(Array.from(out)).toHaveLength(MAX_FINDING_CHARS);
    expect(out.endsWith('…')).toBe(true);
    expect(validFinding(out)).toBe(true);
    expect(validFinding(long)).toBe(false);
    expect(validFinding('')).toBe(false);
  });
});

describe('runGate', () => {
  test('the gate gets no TILORI_*, key or ANTHROPIC_* variable, only PATH, HOME and LANG (Bastion c3f5cd8f 2)', async () => {
    const out = join(scratch(), 'env');
    const saved = { ...process.env };
    process.env.TILORI_HOME = '/secret/home';
    process.env.TILORI_AGENT = 'keel';
    process.env.TILORI_KEY_FILE = '/secret/home/agents/keel.key';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    process.env.ANTHROPIC_BASE_URL = 'https://example.invalid';
    try {
      const r = await runGate(gateOf(`env > '${out}'; pwd >> '${out}'; cat >/dev/null; echo '{"wake":false}'`), 'keel');
      expect(r).toEqual({ ok: true, wake: false });
    } finally {
      process.env = saved;
    }
    const text = readFileSync(out, 'utf8');
    expect(text).not.toMatch(/TILORI_|ANTHROPIC|\.key|sk-test/);
    const names = text
      .trim()
      .split('\n')
      .slice(0, -1)
      .map((l) => l.split('=')[0])
      .filter((n) => n !== 'PWD' && n !== 'SHLVL' && n !== '_');
    expect(names.sort()).toEqual(['HOME', 'LANG', 'PATH']);
    expect(text.trim().split('\n').at(-1)).toBe('/');
  });

  test('the gate reads who it is for on stdin, and nothing else', async () => {
    const out = join(scratch(), 'stdin');
    await runGate(gateOf(`cat > '${out}'; echo '{"wake":false}'`), 'keel');
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({ v: 1, agent: { handle: 'keel' } });
  });

  test('a timeout kills the whole process group, forked children included (Bastion c3f5cd8f 3)', async () => {
    const pidFile = join(scratch(), 'pid');
    const r = await runGate(gateOf(`sleep 30 & echo $! > '${pidFile}'; sleep 30`, 300), 'keel');
    expect(r).toEqual({ ok: false, why: 'timeout' });
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
  });

  test('failures are classes only: exit, bad output, output over 64 KB (Bastion c3f5cd8f 4)', async () => {
    expect(await runGate(gateOf('cat >/dev/null; exit 3'), 'keel')).toEqual({ ok: false, why: 'exit' });
    expect(await runGate(gateOf('cat >/dev/null; echo "{\\"wake\\":\\"yes\\"}"'), 'keel')).toEqual({ ok: false, why: 'output' });
    expect(await runGate(gateOf('cat >/dev/null; head -c 70000 /dev/zero | tr "\\0" a'), 'keel')).toEqual({ ok: false, why: 'output' });
  });
});

describe('router with a reminder gate', () => {
  test('quiet skips the reminder: no wake, one log line', async () => {
    const { router, logs, ac, done, inj } = setup(printing({ wake: false }));
    await until(() => logs.filter((l) => l.includes('reminder gated: quiet')).length >= 2);
    expect(inj.wakes).toHaveLength(0);
    expect(router.stats('wren')).toMatchObject({ wakes: 0, reminders: 0 });
    ac.abort();
    await done;
  });

  test('findings wake with the reminder, counted first in the line (Juniper b2a0cbf0 1)', async () => {
    const { ac, done, inj } = setup(printing({ wake: true, findings: ['agent-lark: no action for 52 min. Look at the pane.', 'READY: #1249. Merge it.'] }));
    await until(() => inj.wakes.length >= 1);
    const w = inj.wakes[0];
    expect(w).toMatchObject({ events: [], reminder: 'Run the check-in.', gate: { findings: ['agent-lark: no action for 52 min. Look at the pane.', 'READY: #1249. Merge it.'] } });
    const line = wakeText(w);
    expect(line).toStartWith('Check-in gate for agent wren: 2 findings: (1) agent-lark: no action for 52 min. Look at the pane. (2) READY: #1249. Merge it. Tilori reminder for agent wren');
    expect(line).not.toContain('\n');
    ac.abort();
    await done;
  });

  test('a failed gate sends the plain reminder and says why', async () => {
    const { logs, ac, done, inj } = setup(gateOf('cat >/dev/null; exit 2'));
    await until(() => inj.wakes.length >= 1);
    expect(inj.wakes[0].gate).toEqual({ failed: 'exit' });
    expect(wakeText(inj.wakes[0])).toStartWith('Reminder (gate failed: exit). Tilori reminder for agent wren');
    expect(logs.some((l) => l.includes('reminder gate failed (exit); sending the plain reminder'))).toBe(true);
    ac.abort();
    await done;
  });

  test('events arriving while the gate runs stop it and wake at once', async () => {
    const pidFile = join(scratch(), 'pid');
    const { fake, logs, ac, done, inj } = setup(gateOf(`echo $$ > '${pidFile}'; sleep 30`, 60_000));
    await until(() => {
      try {
        return readFileSync(pidFile, 'utf8').length > 0;
      } catch {
        return false;
      }
    });
    const started = Date.now();
    fake.push('inbox', [mention()]);
    await until(() => inj.wakes.some((w) => w.events.length === 1));
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(logs.some((l) => l.includes('reminder gate stopped: events arrived'))).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    ac.abort();
    await done;
  });
});

describe('a gated reminder over IPC', () => {
  const base = { wake_id: 'w1', agent: 'wren', events: [], resync_required: false, reminder: 'Run the check-in.' };
  test('keeps clean findings and known failure classes', () => {
    expect(sanitizeWake({ ...base, gate: { findings: ['READY: #1249. Merge it.'] } }, 'wren')?.gate).toEqual({ findings: ['READY: #1249. Merge it.'] });
    expect(sanitizeWake({ ...base, gate: { failed: 'timeout' } }, 'wren')?.gate).toEqual({ failed: 'timeout' });
  });
  test('drops a wake whose gate part the router would never have built', () => {
    const rlo = String.fromCodePoint(0x202e);
    for (const gate of [
      { findings: [`READY${rlo}`] },
      { findings: ['a\nb'] },
      { findings: Array.from({ length: 11 }, () => 'x') },
      { failed: 'because I said so' },
      { findings: ['x'], failed: 'exit' },
      'x',
    ])
      expect(sanitizeWake({ ...base, gate }, 'wren')).toBeNull();
  });
});
