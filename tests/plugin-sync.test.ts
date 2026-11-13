import './setup.ts';
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveConfig, type TiloriConfig } from '../src/config.ts';
import { main } from '../src/cli.ts';
import {
  claudeBinary,
  setPluginIO,
  SYNC_LINES,
  syncPlugin,
  syncPluginAfterSave,
  wantedValues,
  type PluginConfig,
  type PluginValues,
} from '../src/plugin-sync.ts';
import { allowHome } from './allow-home.ts';

// UNI-882 (design fb13dbe9; Bastion e7060719, Juniper 794a2c07): tilori-agent
// is the only writer of the plugin's tilori_url and market_url options.

const TILORI = 'https://ws.example.test/mcp/tilori/v1';
const MARKET = 'https://ws-market.example.test/mcp/v1';
const PROD_T = 'https://tilori.ai/mcp/tilori/v1';
const PROD_M = 'https://prod-market.example.test/mcp/v1';
const KEY = 'tlr_secret_key_never_shown';
const cfg = (extra: Partial<TiloriConfig> = {}): TiloriConfig => ({ url: TILORI, market_url: MARKET, default_agent: 'wren', ...extra });

/** A fake Claude Code: the plugin's current options, and every configure call. */
function fake(current: PluginConfig | null, fail = false) {
  const calls: PluginValues[] = [];
  setPluginIO({
    read: async () => current,
    configure: async (v) => {
      calls.push(v);
      return fail ? 'failed' : null;
    },
  });
  return calls;
}
const prodDefaults = { tilori_default: PROD_T, market_default: PROD_M };

afterEach(() => {
  setPluginIO({ read: async () => null, configure: async () => 'not in tests' });
  delete process.env.TILORI_HOME;
});

describe('wantedValues: config.json only', () => {
  test('both URLs, normalised', () => {
    expect(wantedValues(cfg())).toEqual({ tilori_url: TILORI, market_url: MARKET });
    expect(wantedValues(cfg({ url: 'https://ws.example.test', market_url: 'https://ws-market.example.test' }))).toEqual({ tilori_url: TILORI, market_url: MARKET });
  });
  test('no market_url: only tilori_url', () => {
    expect(wantedValues(cfg({ market_url: undefined }))).toEqual({ tilori_url: TILORI });
  });
  test('the header helper refuses these shapes, so they are never written (Bastion e7060719 1)', () => {
    for (const bad of [
      { url: `${TILORI}?x=1` },
      { url: `${TILORI}#frag` },
      { url: 'https://user:pw@ws.example.test/mcp/tilori/v1' },
      { url: 'https://ws.example.test/mcp/\ttilori/v1' },
      { url: 'https://ws.example.test/mcp/tilori/v1\n' + 'x' },
      { market_url: `${MARKET}#x` },
      { url: 'http://ws.example.test/mcp/tilori/v1' },
    ])
      expect(() => wantedValues(cfg(bad))).toThrow();
    expect(() => wantedValues({})).toThrow('No "url" in config.json');
  });
});

describe('syncPlugin', () => {
  test('options already match (a Connect-panel user): nothing written, says so', async () => {
    const calls = fake({ tilori_url: TILORI, market_url: `${MARKET}/`, ...prodDefaults });
    const r = await syncPlugin(cfg());
    expect(r).toEqual({ code: 0, lines: [SYNC_LINES.same], changed: false });
    expect(calls).toEqual([]);
  });

  test('a drifted market_url: only that option is written, and the output says what changed and to restart', async () => {
    const calls = fake({ tilori_url: TILORI, ...prodDefaults });
    const r = await syncPlugin(cfg());
    expect(calls).toEqual([{ market_url: MARKET }]);
    expect(r.code).toBe(0);
    expect(r.changed).toBe(true);
    expect(r.lines).toEqual(['tilori_url unchanged', `market_url: ${PROD_M} → ${MARKET}`, SYNC_LINES.restart]);
  });

  test('both at the production defaults: both written', async () => {
    const calls = fake({ ...prodDefaults });
    const r = await syncPlugin(cfg());
    expect(calls).toEqual([{ tilori_url: TILORI, market_url: MARKET }]);
    expect(r.lines).toEqual([`tilori_url: ${PROD_T} → ${TILORI}`, `market_url: ${PROD_M} → ${MARKET}`, SYNC_LINES.restart]);
  });

  test("an old option's query, fragment or credentials are never shown", async () => {
    fake({ tilori_url: TILORI, market_url: 'https://u:p@old.example.test/mcp/v1?token=secretish#f', ...prodDefaults });
    const r = await syncPlugin(cfg());
    const all = r.lines.join('\n');
    expect(all).toContain(`market_url: https://old.example.test/mcp/v1 → ${MARKET}`);
    for (const s of ['secretish', 'u:p', '#f']) expect(all).not.toContain(s);
  });

  test('an option equal but for a query still counts as drift', async () => {
    const calls = fake({ tilori_url: `${TILORI}?agent=x`, market_url: MARKET, ...prodDefaults });
    await syncPlugin(cfg());
    expect(calls).toEqual([{ tilori_url: TILORI }]);
  });

  test('no market_url in config.json: the market option is left alone and the output says so', async () => {
    const calls = fake({ ...prodDefaults });
    const r = await syncPlugin(cfg({ market_url: undefined }));
    expect(calls).toEqual([{ tilori_url: TILORI }]);
    expect(r.lines).toContain(SYNC_LINES.noMarket);
  });

  test("Claude Code or the plugin can't be read: exit 1 with one line, nothing written", async () => {
    const calls = fake(null);
    expect(await syncPlugin(cfg())).toEqual({ code: 1, lines: [SYNC_LINES.unread], changed: false });
    expect(calls).toEqual([]);
  });

  test('configure fails: exit 1 and the exact command to run by hand, URLs only', async () => {
    fake({ ...prodDefaults }, true);
    const r = await syncPlugin(cfg());
    expect(r.code).toBe(1);
    expect(r.lines).toEqual([SYNC_LINES.byHand({ tilori_url: TILORI, market_url: MARKET })]);
    expect(r.lines[0]).toContain(`echo '{"tilori_url":"${TILORI}","market_url":"${MARKET}"}' | claude plugin configure tilori@tilori-claude --values-stdin`);
  });

  test('only the two URLs ever reach configure, never the key or a path (Bastion e7060719 3)', async () => {
    const calls = fake({ ...prodDefaults });
    const r = await syncPlugin({ ...cfg(), agents: { wren: {} } });
    for (const c of calls) expect(Object.keys(c).sort()).toEqual(['market_url', 'tilori_url']);
    expect(JSON.stringify([calls, r.lines])).not.toContain(KEY);
    expect(JSON.stringify(calls)).not.toContain('.key');
  });

  test('another home: refused, with that home\'s launcher command; the plugin is not read', async () => {
    const h = mkdtempSync(join(tmpdir(), 'sync-other-'));
    chmodSync(h, 0o700);
    allowHome(h);
    process.env.TILORI_HOME = h;
    let read = false;
    setPluginIO({ read: async () => ((read = true), null), configure: async () => null });
    const r = await syncPlugin(cfg());
    expect(r.code).toBe(2);
    expect(r.lines[0]).toContain(`tilori-agent claude --home ${h}`);
    expect(read).toBe(false);
  });
});

describe('syncPluginAfterSave (init, setup)', () => {
  test('quiet when the plugin is not installed or nothing changed', async () => {
    fake(null);
    expect(await syncPluginAfterSave(cfg())).toEqual([]);
    fake({ tilori_url: TILORI, market_url: MARKET });
    expect(await syncPluginAfterSave(cfg())).toEqual([]);
  });
  test('says what it changed', async () => {
    fake({ ...prodDefaults });
    const lines = await syncPluginAfterSave(cfg());
    expect(lines[0]).toBe('The tilori plugin now uses these URLs:');
    expect(lines).toContain(SYNC_LINES.restart);
  });
  test('the plugin is there but refuses: the by-hand line', async () => {
    fake({ ...prodDefaults }, true);
    expect((await syncPluginAfterSave(cfg()))[0]).toContain('claude plugin configure');
  });
});

describe('sync-plugin command', () => {
  test('takes no arguments: config.json is the only source (Bastion e7060719 1)', async () => {
    // A usable config.json in this (temp) default home, so only the argument
    // check stands between the call and a configure.
    saveConfig(cfg());
    const calls = fake({ ...prodDefaults });
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errs.push(a.join(' '));
    try {
      expect(await main(['sync-plugin', '--url', 'https://evil.example.test/mcp/tilori/v1'])).not.toBe(0);
      expect(await main(['sync-plugin', 'https://evil.example.test'])).not.toBe(0);
    } finally {
      console.error = orig;
    }
    expect(calls).toEqual([]);
    // And without arguments it does run.
    const out: string[] = [];
    const w = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string) => (out.push(String(c)), true)) as typeof process.stdout.write;
    try {
      expect(await main(['sync-plugin'])).toBe(0);
    } finally {
      process.stdout.write = w;
    }
    expect(calls).toEqual([{ tilori_url: TILORI, market_url: MARKET }]);
    expect(out.join('')).toContain(SYNC_LINES.restart);
  });
});

describe('claudeBinary (Bastion e7060719 2)', () => {
  test('skips relative and empty PATH entries; takes the first absolute one with an executable claude', () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-bin-'));
    const a = join(root, 'a');
    const b = join(root, 'b');
    mkdirSync(a);
    mkdirSync(b);
    writeFileSync(join(a, 'claude'), 'not executable');
    writeFileSync(join(b, 'claude'), '#!/bin/sh\n');
    chmodSync(join(b, 'claude'), 0o755);
    // A repo-relative entry that does hold an executable claude is skipped.
    const rel = join(root, 'rel');
    mkdirSync(rel);
    writeFileSync(join(rel, 'claude'), '#!/bin/sh\n');
    chmodSync(join(rel, 'claude'), 0o755);
    const cwd = process.cwd();
    process.chdir(root);
    try {
      expect(claudeBinary(['', '.', 'rel', a, b].join(':'))).toBe(join(b, 'claude'));
      expect(() => claudeBinary(['.', 'rel'].join(':'))).toThrow('no claude executable');
    } finally {
      process.chdir(cwd);
    }
  });
});
