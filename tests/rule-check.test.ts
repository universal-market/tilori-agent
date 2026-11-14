import './setup.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.ts';
import { configPath } from '../src/config.ts';
import {
  PAIRED_HIDDEN_TOOLS,
  covers,
  readCapped,
  readRules,
  ruleWarning,
  settingsFiles,
  uncoveredTools,
} from '../src/rule-check.ts';
import { allowHome } from './allow-home.ts';

// UNI-865 phase 0 (Bastion 56d30062, 47ba6d6e): a deny/ask rule left on a
// Market tool the paired Market server no longer lists.

const M = 'mcp__plugin_universal-market_market';
const T = 'mcp__plugin_universal-market_tilori';

let dir: string;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tilori-agent-rules-'));
  for (const k of ['TILORI_HOME', 'TILORI_SOCKET', 'TILORI_AGENT', 'CLAUDE_CONFIG_DIR', 'CLAUDE_PROJECT_DIR'])
    saved[k] = process.env[k];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function settings(path: string, permissions: Record<string, string[]>) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({ permissions }));
}
const hits = (p: { deny?: string[]; ask?: string[] }) => uncoveredTools({ deny: p.deny ?? [], ask: p.ask ?? [] });

describe('uncoveredTools', () => {
  test('an ask on the Market propose_contract with nothing on Tilori is a hit', () => {
    expect(hits({ ask: [`${M}__propose_contract`] })).toEqual(['propose_contract']);
  });

  test('the same rule on the Tilori copy, its server or its wildcard covers it', () => {
    for (const tilori of [`${T}__propose_contract`, T, `${T}__*`])
      expect(hits({ ask: [`${M}__propose_contract`, tilori] })).toEqual([]);
  });

  test('a Tilori deny covers a Market ask; a Tilori ask does not cover a Market deny', () => {
    expect(hits({ ask: [`${M}__create_key`], deny: [`${T}__create_key`] })).toEqual([]);
    expect(hits({ deny: [`${M}__create_key`], ask: [`${T}__create_key`] })).toEqual(['create_key']);
  });

  test('a server-wide or wildcard Market rule hits all 15 (Bastion 47ba6d6e)', () => {
    for (const rule of [M, `${M}__*`]) {
      expect(hits({ ask: [rule] })).toEqual([...PAIRED_HIDDEN_TOOLS]);
      expect(hits({ deny: [rule] })).toEqual([...PAIRED_HIDDEN_TOOLS]);
      expect(hits({ ask: [rule], deny: [T] })).toEqual([]);
    }
  });

  test('rules on tools that stay listed, or on other servers, are no hit', () => {
    expect(
      hits({
        ask: [
          `${M}__accept_contract`,
          `${M}__get_my_profile`,
          `${M}__subscribe_to_events`,
          `${M}__get_attachment`,
          'mcp__other_server__propose_contract',
          `${M}__propose_contract_extra`,
          `${M}_`,
        ],
      }),
    ).toEqual([]);
  });

  test('covers names only exact forms', () => {
    expect(covers(`${M}__get_agent`, 'market', 'get_agent')).toBe(true);
    expect(covers(`${M}__get_agent `, 'market', 'get_agent')).toBe(false);
    expect(covers(`${M}__get_*`, 'market', 'get_agent')).toBe(false);
    expect(covers(`${T}__get_agent`, 'market', 'get_agent')).toBe(false);
  });

  test('the 15 match the Market server list (universal_market UNI-865 phase 0)', () => {
    expect(PAIRED_HIDDEN_TOOLS.length).toBe(15);
  });
});

describe('settings files', () => {
  test('user, project and project local, merged; CLAUDE_CONFIG_DIR replaces ~/.claude', () => {
    expect(settingsFiles({ HOME: '/h', CLAUDE_PROJECT_DIR: '/p' })).toEqual([
      '/h/.claude/settings.json',
      '/p/.claude/settings.json',
      '/p/.claude/settings.local.json',
    ]);
    expect(settingsFiles({ HOME: '/h', CLAUDE_CONFIG_DIR: '/c' })).toEqual(['/c/settings.json']);
    expect(settingsFiles({ HOME: 'rel', CLAUDE_PROJECT_DIR: 'also-rel' })).toEqual([]);
  });

  test('rules merge across files; bad, huge or missing files are skipped', () => {
    const user = join(dir, 'user', 'settings.json');
    const local = join(dir, 'proj', '.claude', 'settings.local.json');
    const broken = join(dir, 'proj', '.claude', 'settings.json');
    settings(user, { ask: [`${M}__propose_contract`] });
    settings(local, { ask: [`${T}__propose_contract`], deny: [`${M}__revoke_key`] });
    writeFileSync(broken, '{ not json');
    const huge = join(dir, 'huge.json');
    writeFileSync(huge, JSON.stringify({ permissions: { ask: [M] }, pad: 'x'.repeat(1_100_000) }));
    const rules = readRules([user, local, broken, huge, join(dir, 'missing.json')]);
    expect(uncoveredTools(rules)).toEqual(['revoke_key']);
  });

  test('/dev/zero, a link to it and a FIFO are skipped at once (Bastion 1aef6448)', () => {
    const zero = join(dir, 'zero.json');
    symlinkSync('/dev/zero', zero);
    const fifo = join(dir, 'fifo.json');
    expect(Bun.spawnSync(['mkfifo', fifo]).exitCode).toBe(0);
    const linked = join(dir, 'linked.json');
    const real = join(dir, 'real.json');
    settings(real, { ask: [`${M}__get_agent`] });
    symlinkSync(real, linked);
    const started = Date.now();
    expect(readCapped('/dev/zero')).toBeNull();
    expect(readCapped(zero)).toBeNull();
    expect(readCapped(fifo)).toBeNull();
    expect(readCapped(dir)).toBeNull();
    // A link to a regular file is still read (dotfile managers).
    expect(uncoveredTools(readRules([zero, fifo, linked]))).toEqual(['get_agent']);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('a non-array or non-string entry is ignored', () => {
    const f = join(dir, 'odd.json');
    writeFileSync(f, JSON.stringify({ permissions: { ask: M, deny: [42, { rule: M }] } }));
    expect(uncoveredTools(readRules([f]))).toEqual([]);
  });
});

describe('the warning', () => {
  test('one fixed line, naming only tools from the fixed list', () => {
    expect(ruleWarning([])).toBeNull();
    const line = ruleWarning(['propose_contract', 'create_key'])!;
    expect(line).not.toContain('\n');
    expect(line).toContain('propose_contract, create_key');
    expect(line).toContain(`${T}__<tool>`);
    expect(line).toContain('Nothing was changed in your settings.');
  });

  test('policy --hook shows it to the user and the session, and only when there is a hit', async () => {
    process.env.TILORI_HOME = join(dir, 'tilori');
    allowHome(process.env.TILORI_HOME);
    process.env.TILORI_SOCKET = join(dir, 'none.sock');
    delete process.env.TILORI_AGENT;
    mkdirSync(process.env.TILORI_HOME, { recursive: true, mode: 0o700 });
    chmodSync(process.env.TILORI_HOME, 0o700);
    writeFileSync(
      configPath(),
      JSON.stringify({ url: 'https://internal.example/mcp/tilori/v1', default_agent: 'wren' }) + '\n',
      { mode: 0o600 },
    );
    process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude');
    process.env.CLAUDE_PROJECT_DIR = join(dir, 'project');
    const run = async () => {
      const out: string[] = [];
      const write = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
      try {
        expect(await main(['policy', '--hook'])).toBe(0);
      } finally {
        process.stdout.write = write;
      }
      return JSON.parse(out.join(''));
    };
    const quiet = await run();
    expect(quiet.systemMessage).toBeUndefined();
    expect(quiet.hookSpecificOutput.additionalContext).not.toContain('deny or ask rule');

    settings(join(dir, 'project', '.claude', 'settings.json'), { ask: [`${M}__propose_contract`] });
    const warned = await run();
    expect(warned.systemMessage).toBe(ruleWarning(['propose_contract']));
    expect(warned.hookSpecificOutput.additionalContext).toContain(ruleWarning(['propose_contract'])!);

    // A hostile project: its settings files are a FIFO and a link to
    // /dev/zero. The hook still returns, with its policy text.
    rmSync(join(dir, 'project', '.claude'), { recursive: true, force: true });
    mkdirSync(join(dir, 'project', '.claude'), { recursive: true });
    expect(Bun.spawnSync(['mkfifo', join(dir, 'project', '.claude', 'settings.json')]).exitCode).toBe(0);
    symlinkSync('/dev/zero', join(dir, 'project', '.claude', 'settings.local.json'));
    const hostile = await run();
    expect(hostile.systemMessage).toBeUndefined();
    expect(hostile.hookSpecificOutput.additionalContext).toBe(quiet.hookSpecificOutput.additionalContext);
  });
});
