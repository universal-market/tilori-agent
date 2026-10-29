import './setup.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.ts';
import { configPath, desiredSubscriptions, type TiloriConfig } from '../src/config.ts';
import { Router } from '../src/router.ts';
import { SETTABLE, applyChanges, followConfig, liveSettings, parseAssignment, resetEdit, showText } from '../src/settings.ts';
import { FakeTilori, until } from './fake-tilori.ts';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tilori-agent-test-'));
  process.env.TILORI_HOME = join(home, 'tilori');
  // No router in tests: show must not find a real one.
  process.env.TILORI_SOCKET = join(home, 'none.sock');
  delete process.env.TILORI_AGENT;
  delete process.env.TILORI_URL;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.TILORI_HOME;
  delete process.env.TILORI_SOCKET;
});

/** A config holding every kind of key a `set` must leave alone. */
const FULL: TiloriConfig = {
  url: 'https://example.convex.site/mcp/tilori/v1',
  default_agent: 'wren',
  trusted_owners: ['adrian', '5f940e57-64fd-48e9-a805-fb6a968ab1a8'],
  coordination_community: '28defeb4-406d-4f18-98f6-3250fd6a5194',
  agents: {
    wren: {
      injector: 'exec',
      exec: 'claude -p "$TILORI_WAKE_TEXT"',
      exec_timeout_ms: 600000,
      wakes_per_hour: 20,
      inbox: false,
      direct_messages: false,
      subscriptions: [{ scope: { type: 'posts' } }],
      reminder: { every_minutes: 60, prompt: 'Check the review queue.', only_when_idle: true },
    },
    pax: { wakes_per_hour: 35 },
  },
};

/** Written the way saveConfig and init write it. */
const text = (c: TiloriConfig) => JSON.stringify(c, null, 2) + '\n';

function writeConfig(c: TiloriConfig): string {
  const dir = process.env.TILORI_HOME!;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(configPath(), text(c), { mode: 0o600 });
  return readFileSync(configPath(), 'utf8');
}

async function cli(...argv: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => lines.push(a.join(' '));
  try {
    return { code: await main(argv), out: lines.join('\n') };
  } finally {
    console.log = log;
  }
}

describe('config set and reset', () => {
  test('a set changes one field and keeps every other key, trust keys included, byte for byte', () => {
    const before = writeConfig(FULL);
    applyChanges('wren', [parseAssignment('wakes_per_hour=35')]);
    const want = structuredClone(FULL);
    want.agents!.wren.wakes_per_hour = 35;
    expect(readFileSync(configPath(), 'utf8')).toBe(text(want));
    // A reset back and a set back both restore the original bytes.
    applyChanges('wren', [parseAssignment('wakes_per_hour=20')]);
    expect(readFileSync(configPath(), 'utf8')).toBe(before);
  });

  test('a reset removes only that key, and keeps everything else as it was', () => {
    writeConfig(FULL);
    applyChanges('wren', [resetEdit('wakes_per_hour')]);
    const want = structuredClone(FULL);
    delete want.agents!.wren.wakes_per_hour;
    expect(readFileSync(configPath(), 'utf8')).toBe(text(want));
    expect(JSON.parse(readFileSync(configPath(), 'utf8')).trusted_owners).toEqual(FULL.trusted_owners);
  });

  test('the file stays 0600', () => {
    writeConfig(FULL);
    applyChanges('wren', [parseAssignment('stall_minutes=30')]);
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
  });

  test('only allow-listed keys can be set', () => {
    for (const arg of [
      'url=1',
      'exec=1',
      'injector=1',
      'inbox=1',
      'direct_messages=1',
      'trusted_owners=1',
      'default_agent=1',
      'reminder.prompt=1',
      'reminder.only_when_idle=1',
      'subscriptions=1',
      'exec_timeout_ms=1',
    ]) {
      expect(() => parseAssignment(arg)).toThrow(/can't be set here/);
    }
    for (const key of ['url', 'exec', 'trusted_owners', 'inbox']) expect(() => resetEdit(key)).toThrow(/can't be set here/);
  });

  test('values must be whole numbers within the bounds', () => {
    for (const arg of [
      'wakes_per_hour=0',
      'wakes_per_hour=61',
      'direct_wakes_per_hour=31',
      'stall_minutes=1441',
      'reminder.every_minutes=14',
      'reminder.every_minutes=1441',
    ]) {
      expect(() => parseAssignment(arg)).toThrow(/must be from/);
    }
    for (const arg of ['wakes_per_hour=-1', 'wakes_per_hour=1e3', 'wakes_per_hour=3.5', 'wakes_per_hour= 35', 'wakes_per_hour=', 'wakes_per_hour', 'wakes_per_hour=35;x']) {
      expect(() => parseAssignment(arg)).toThrow(/Expected key=<whole number>/);
    }
    expect(parseAssignment('wakes_per_hour=60').value).toBe(60);
    expect(parseAssignment('direct_wakes_per_hour=0').value).toBe(0);
    expect(parseAssignment('stall_minutes=0').value).toBe(0);
  });

  test('an unknown agent is refused and nothing is written or created', () => {
    const before = writeConfig(FULL);
    expect(() => applyChanges('keel', [parseAssignment('wakes_per_hour=35')])).toThrow(/No agent "keel"/);
    expect(readFileSync(configPath(), 'utf8')).toBe(before);
  });

  test('edits apply all or none', () => {
    const noReminder = structuredClone(FULL);
    delete noReminder.agents!.wren.reminder;
    const before = writeConfig(noReminder);
    expect(() =>
      applyChanges('wren', [parseAssignment('wakes_per_hour=35'), parseAssignment('reminder.every_minutes=30')]),
    ).toThrow(/needs a reminder set up by hand/);
    expect(readFileSync(configPath(), 'utf8')).toBe(before);
  });

  test('the reminder interval can change but a reminder is never added or removed', () => {
    writeConfig(FULL);
    applyChanges('wren', [parseAssignment('reminder.every_minutes=30')]);
    const after = JSON.parse(readFileSync(configPath(), 'utf8'));
    expect(after.agents.wren.reminder).toEqual({ ...FULL.agents!.wren.reminder, every_minutes: 30 });
    expect(() => applyChanges('wren', [resetEdit('reminder.every_minutes')])).toThrow(/can't be reset/);
  });

  test('a symlinked or wide-open config is refused', () => {
    writeConfig(FULL);
    chmodSync(configPath(), 0o644);
    expect(() => applyChanges('wren', [parseAssignment('wakes_per_hour=35')])).toThrow(/readable by other users/);
    chmodSync(configPath(), 0o600);
    const real = join(home, 'elsewhere.json');
    writeFileSync(real, text(FULL), { mode: 0o600 });
    rmSync(configPath());
    symlinkSync(real, configPath());
    expect(() => applyChanges('wren', [parseAssignment('wakes_per_hour=35')])).toThrow(/symlink/);
    expect(readFileSync(real, 'utf8')).toBe(text(FULL));
  });

  test('a hand-edited value the router rejects stops the write', () => {
    const bad = structuredClone(FULL);
    bad.agents!.wren.stall_minutes = -5;
    const before = writeConfig(bad);
    expect(() => applyChanges('wren', [parseAssignment('wakes_per_hour=35')])).toThrow(/stall_minutes/);
    expect(readFileSync(configPath(), 'utf8')).toBe(before);
  });
});

describe('config command', () => {
  test('set prints old and new values, and reset names the default', async () => {
    writeConfig(FULL);
    let r = await cli('config', 'set', 'wakes_per_hour=35', 'stall_minutes=0');
    expect(r.code).toBe(0);
    expect(r.out).toBe('wren: wakes_per_hour 20 -> 35\nwren: stall_minutes 10 (default) -> 0');
    r = await cli('config', 'reset', 'stall_minutes');
    expect(r.out).toBe('wren: stall_minutes 0 -> 10 (default)');
  });

  test('--agent picks another existing agent; an unknown one fails', async () => {
    const before = writeConfig(FULL);
    expect((await cli('config', 'set', '--agent', 'pax', 'wakes_per_hour=40')).code).toBe(0);
    expect(JSON.parse(readFileSync(configPath(), 'utf8')).agents.pax).toEqual({ wakes_per_hour: 40 });
    const mid = readFileSync(configPath(), 'utf8');
    expect(mid).not.toBe(before);
    expect((await cli('config', 'set', '--agent', 'keel', 'wakes_per_hour=40')).code).toBe(1);
    expect(readFileSync(configPath(), 'utf8')).toBe(mid);
  });

  test('bad input fails without writing', async () => {
    const before = writeConfig(FULL);
    for (const argv of [
      ['config', 'set', 'url=1'],
      ['config', 'set', 'wakes_per_hour=999'],
      ['config', 'set'],
      ['config', 'frob'],
      ['config', 'show', 'extra'],
    ]) {
      expect((await cli(...argv)).code).toBe(1);
    }
    expect(readFileSync(configPath(), 'utf8')).toBe(before);
  });

  test('show prints every settable value, defaults, and says when no router reports usage', async () => {
    writeConfig(FULL);
    const r = await cli('config');
    expect(r.code).toBe(0);
    expect(r.out).toContain('wren:');
    expect(r.out).toContain('wakes_per_hour = 20 ');
    expect(r.out).toContain('direct_wakes_per_hour = 10 (default)');
    expect(r.out).toContain('reminder.every_minutes = 60');
    expect(r.out).toContain('stall_minutes = 10 (default)');
    expect(r.out).toContain('this hour: not reported (no router running)');
    // Never the url, exec, trust or key settings.
    for (const s of ['example.convex.site', 'claude -p', 'adrian', 'Check the review queue']) expect(r.out).not.toContain(s);
  });

  test('show formats usage counts', () => {
    expect(showText('wren', {}, { wakes: { used: 12, limit: 35 }, direct: { used: 2, limit: 10 }, held: 3 })).toContain(
      'this hour: wakes 12 of 35 used, 3 events held, direct 2 of 10',
    );
    expect(showText('wren', {}, { wakes: { used: 0, limit: 20 }, direct: null, held: 0 })).toContain(
      'this hour: wakes 0 of 20 used',
    );
  });

  test('the help text lists every settable key with its bounds', async () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => lines.push(a.join(' '));
    try {
      await main(['help']);
    } finally {
      console.log = log;
    }
    const help = lines.join('\n');
    for (const k of SETTABLE) expect(help).toContain(`${k.key} (${k.min}-${k.max}`);
  });
});

describe('live reload', () => {
  test('reloads only the settable values; a bad file keeps the current ones', async () => {
    writeConfig(FULL);
    const fake = new FakeTilori();
    const router = new Router({
      agents: [{ handle: 'wren', client: fake.client(), subscriptions: desiredSubscriptions(), wakesPerHour: 20, stallMinutes: 10 }],
      waitMs: 10,
      retryMs: 10,
      coalesceMs: 0,
    });
    const logs: string[] = [];
    const ac = new AbortController();
    followConfig(router, (m) => logs.push(m), ac.signal, configPath(), 20);
    try {
      const next = structuredClone(FULL);
      next.agents!.wren.wakes_per_hour = 35;
      next.agents!.wren.stall_minutes = 0;
      // Changes to keys outside the allow-list are not reloaded or logged.
      next.url = 'https://evil.example/mcp/tilori/v1';
      next.agents!.wren.exec = 'rm -rf /';
      next.trusted_owners = ['mallory'];
      writeFileSync(configPath(), text(next), { mode: 0o600 });
      await until(() => logs.some((l) => l.includes('settings reloaded')));
      expect(logs.filter((l) => l.includes('settings reloaded'))).toEqual([
        '[wren] settings reloaded: wakes_per_hour 20 -> 35, stall_minutes 10 -> 0',
      ]);
      expect(router.usage('wren')!.wakes.limit).toBe(35);

      next.agents!.wren.wakes_per_hour = 0;
      writeFileSync(configPath(), text(next), { mode: 0o600 });
      await until(() => logs.some((l) => l.includes('not reloaded')));
      expect(logs.at(-1)).toBe('config.json not reloaded, keeping current settings: [wren] wakes_per_hour must be a positive integer.');
      expect(router.usage('wren')!.wakes.limit).toBe(35);
    } finally {
      ac.abort();
    }
  });

  test('a hand edit above the set bounds is not taken live', async () => {
    writeConfig(FULL);
    const fake = new FakeTilori();
    const router = new Router({
      agents: [{ handle: 'wren', client: fake.client(), subscriptions: desiredSubscriptions(), wakesPerHour: 20, stallMinutes: 10 }],
      waitMs: 10,
      retryMs: 10,
      coalesceMs: 0,
    });
    const logs: string[] = [];
    const ac = new AbortController();
    followConfig(router, (m) => logs.push(m), ac.signal, configPath(), 20);
    try {
      const next = structuredClone(FULL);
      next.agents!.wren.wakes_per_hour = 500;
      writeFileSync(configPath(), text(next), { mode: 0o600 });
      await until(() => logs.some((l) => l.includes('not reloaded')));
      expect(logs.at(-1)).toBe(
        'config.json not reloaded, keeping current settings: [wren] wakes_per_hour 500 is above 60, the most a running router takes; restart to apply it.',
      );
      expect(router.usage('wren')!.wakes.limit).toBe(20);
      next.agents!.wren.wakes_per_hour = 60;
      writeFileSync(configPath(), text(next), { mode: 0o600 });
      await until(() => router.usage('wren')!.wakes.limit === 60);
    } finally {
      ac.abort();
    }
  });

  test('liveSettings validates as the router does at start', () => {
    expect(liveSettings({})).toEqual({ wakesPerHour: 20, directWakesPerHour: 10, reminderEveryMs: undefined, stallMinutes: 10 });
    expect(() => liveSettings({ wakes_per_hour: 0 })).toThrow();
    expect(() => liveSettings({ direct_wakes_per_hour: -1 })).toThrow();
    expect(() => liveSettings({ stall_minutes: 2000 })).toThrow();
    expect(() => liveSettings({ reminder: { every_minutes: 5, prompt: 'x' } })).toThrow();
  });
});
