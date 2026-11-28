import './setup.ts';
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeCapsSignal } from '../src/activity.ts';
import { VERSION } from '../src/version.ts';
import { expectSnapshot, normalise, renderCases, runCli, tempDir, type CliResult } from './s0-util.ts';

// UNI-1178 S0: characterization of the JSON and text the host plugin's hooks
// read from tilori-agent at v0.3.18: `policy --hook` (SessionStart),
// `stop-check --hook` (Stop), `stop-check --asked` (PostToolUse) and
// `headers` (the MCP headersHelper). Each is run as a subprocess of
// src/cli.ts under a fresh temp HOME with a fixed config.json.
//
// Normalisations (the only ones):
//   - the temp HOME path becomes <HOME> (it differs on every run)
//   - the version string "0.3.18" in the policy text becomes <VERSION>
//     (read from src/version.ts, so a plain version bump keeps S0 green)
// The key file holds the sentinel "fake-key-for-s0", never a real key.

const URL_T = 'https://tilori.example.test/mcp/tilori/v1';
const URL_M = 'https://market.example.test/mcp/v1';
const CONFIG = { url: URL_T, market_url: URL_M, default_agent: 'wren', agents: { wren: { owner_decision_check: true } } };

interface Home {
  home: string;
  run: (argv: string[], o?: { stdin?: string; env?: Record<string, string> }) => Promise<CliResult>;
  show: (r: CliResult) => string;
  norm: (s: string) => string;
}

/** A fresh private HOME with ~/.config/tilori/config.json, one key and the
 * run directory (0700) the router would make. */
function makeHome(config: unknown = CONFIG): Home {
  const home = tempDir();
  chmodSync(home, 0o700);
  const dir = join(home, '.config', 'tilori');
  mkdirSync(join(dir, 'agents'), { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, 'run'), { recursive: true, mode: 0o700 });
  for (const p of [join(home, '.config'), dir, join(dir, 'agents'), join(dir, 'run')]) chmodSync(p, 0o700);
  writeFileSync(join(dir, 'agents', 'wren.key'), 'fake-key-for-s0\n', { mode: 0o600 });
  if (config !== null) writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  const norm = (s: string) =>
    normalise(s, [
      [home, '<HOME>'],
      [VERSION, '<VERSION>'],
    ]);
  return {
    home,
    norm,
    run: (argv, o = {}) => runCli(argv, { home, ...o }),
    show: (r) =>
      `exit ${r.code}\nstdout: ${r.stdout === '' ? '(empty)' : '\n' + norm(r.stdout).replace(/\n$/, '')}\nstderr: ${r.stderr === '' ? '(empty)' : '\n' + norm(r.stderr).replace(/\n$/, '')}`,
  };
}

/** Pretty form of a hook's JSON line, so the snapshot diff is readable; the
 * raw line is asserted (compact, one line, trailing newline) separately. */
function pretty(h: Home, r: CliResult): string {
  expect(r.stdout.endsWith('\n') && r.stdout.indexOf('\n') === r.stdout.length - 1).toBe(true);
  const raw = `exit ${r.code}\nstderr: ${r.stderr === '' ? '(empty)' : '\n' + h.norm(r.stderr).replace(/\n$/, '')}`;
  const obj = JSON.parse(r.stdout);
  return `${raw}\nkeys: ${JSON.stringify(Object.keys(obj))}; one compact line: ${r.stdout === JSON.stringify(obj) + '\n'}\nparsed:\n${h.norm(JSON.stringify(obj, null, 2))}`;
}

describe('S0 hook output: SessionStart (policy --hook)', () => {
  test('policy-hook.txt', async () => {
    const cases: Array<[string, string]> = [];
    const run = async (name: string, config: unknown, argv: string[], o: { env?: Record<string, string>; settings?: unknown } = {}) => {
      const h = makeHome(config);
      if (o.settings !== undefined) {
        mkdirSync(join(h.home, '.claude'), { recursive: true });
        writeFileSync(join(h.home, '.claude', 'settings.json'), JSON.stringify(o.settings));
      }
      const r = await h.run(argv, { env: o.env });
      cases.push([name, argv.includes('--hook') && r.stdout ? pretty(h, r) : h.show(r)]);
    };
    await run('hook, default config', CONFIG, ['policy', '--hook']);
    await run('hook, --agent given', CONFIG, ['policy', '--hook', '--agent', 'wren']);
    await run('plain text (no --hook)', CONFIG, ['policy']);
    await run(
      'hook, trusted owners, community and wake filter',
      { ...CONFIG, trusted_owners: ['alice', 'bob'], coordination_community: '00000000-0000-4000-8000-0000000000aa', agents: { wren: { wake_filter: { rules: [] } } } },
      ['policy', '--hook'],
    );
    await run('hook, trust_server on', { ...CONFIG, trust_server: { origin: 'https://tilori.example.test', set_at: '2026-11-28T00:00:00.000Z' } }, ['policy', '--hook']);
    await run('hook, trust_server inert (logged to stderr)', { ...CONFIG, trust_server: { origin: 'https://other.example.test' } }, ['policy', '--hook']);
    await run('hook, environment names the session', CONFIG, ['policy', '--hook'], {
      env: { TILORI_AGENT: 'wren', TILORI_MCP_URL: URL_T, TILORI_MARKET_URL: 'https://elsewhere.example.test/mcp/v1' },
    });
    await run('hook, empty TILORI_MCP_URL', CONFIG, ['policy', '--hook'], { env: { TILORI_MCP_URL: '' } });
    await run('hook, deny rule on a hidden Market tool (systemMessage)', CONFIG, ['policy', '--hook'], {
      settings: { permissions: { deny: ['mcp__plugin_universal-market_market__get_agent'], ask: ['mcp__plugin_universal-market_market'] } },
    });
    await run('hook, no config at all (prints nothing)', null, ['policy', '--hook']);
    await run('hook, no agent configured (prints nothing)', { url: URL_T }, ['policy', '--hook']);
    expectSnapshot('policy-hook.txt', renderCases(cases));
  }, 60_000);
});

describe('S0 hook output: Stop and PostToolUse (stop-check)', () => {
  const ASK = 'I opened the PR.\n\nDecision for you: merge it now, or wait for the rerun?';
  const transcript = (h: Home, text: string) => {
    const p = join(h.home, 'transcript.jsonl');
    const rows = [
      { type: 'user', message: { role: 'user', content: 'go' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } },
    ];
    writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return p;
  };
  const caps = (h: Home, on: boolean) => writeCapsSignal(join(h.home, '.config', 'tilori', 'run'), 'wren', on);

  test('stop-check.txt', async () => {
    const cases: Array<[string, string]> = [];
    const stop = async (name: string, fn: (h: Home) => Promise<CliResult>, o: { config?: unknown; caps?: boolean | null } = {}) => {
      const h = makeHome(o.config === undefined ? CONFIG : o.config);
      if (o.caps !== null) caps(h, o.caps ?? true);
      const r = await fn(h);
      cases.push([name, r.stdout.startsWith('{') ? pretty(h, r) : h.show(r)]);
    };
    await stop('Stop hook, last_assistant_message asks: block', (h) => h.run(['stop-check', '--hook'], { stdin: JSON.stringify({ stop_hook_active: false, last_assistant_message: ASK }) }));
    await stop('Stop hook, message read from the transcript: block', (h) => h.run(['stop-check', '--hook'], { stdin: JSON.stringify({ transcript_path: transcript(h, ASK) }) }));
    await stop('Stop hook, message does not ask: nothing', (h) => h.run(['stop-check', '--hook'], { stdin: JSON.stringify({ last_assistant_message: 'Merged. Nothing needs you.' }) }));
    await stop('Stop hook, stop_hook_active: nothing', (h) => h.run(['stop-check', '--hook'], { stdin: JSON.stringify({ stop_hook_active: true, last_assistant_message: ASK }) }));
    await stop('Stop hook, owner_decision_check off: nothing', (h) => h.run(['stop-check', '--hook'], { stdin: JSON.stringify({ last_assistant_message: ASK }) }), {
      config: { ...CONFIG, agents: { wren: { owner_decision_check: false } } },
    });
    await stop('Stop hook, agent cannot ask_owner: nothing', (h) => h.run(['stop-check', '--hook'], { stdin: JSON.stringify({ last_assistant_message: ASK }) }), { caps: false });
    await stop('Stop hook, no caps file: nothing', (h) => h.run(['stop-check', '--hook'], { stdin: JSON.stringify({ last_assistant_message: ASK }) }), { caps: null });
    await stop('Stop hook, stdin is not JSON: nothing, exit 0', (h) => h.run(['stop-check', '--hook'], { stdin: 'not json' }));
    await stop('Stop hook, no flag: nothing, exit 0', (h) => h.run(['stop-check'], { stdin: '{}' }));
    await stop('Stop hook, bad flag: nothing, exit 0', (h) => h.run(['stop-check', '--hook', '--no-such-flag'], { stdin: '{}' }));
    await stop('second block inside the cooldown: nothing', async (h) => {
      const input = JSON.stringify({ last_assistant_message: ASK });
      await h.run(['stop-check', '--hook'], { stdin: input });
      return h.run(['stop-check', '--hook'], { stdin: input });
    });
    await stop('PostToolUse ask_owner, then Stop: --asked prints nothing and the turn is not blocked', async (h) => {
      const a = await h.run(['stop-check', '--asked'], { stdin: JSON.stringify({ tool_name: 'mcp__plugin_universal-market_tilori__ask_owner', tool_response: { content: [] } }) });
      expect(a.code).toBe(0);
      expect(a.stdout + a.stderr).toBe('');
      return h.run(['stop-check', '--hook'], { stdin: JSON.stringify({ last_assistant_message: ASK }) });
    });
    expectSnapshot('stop-check.txt', renderCases(cases));
  }, 60_000);
});

describe('S0 hook output: headersHelper (headers)', () => {
  test('headers.txt', async () => {
    const cases: Array<[string, string]> = [];
    const h = makeHome();
    for (const [name, argv, env] of [
      ['Tilori server', ['headers', '--server-url', URL_T], {}],
      ['Market server', ['headers', '--server-url', URL_M], {}],
      ['server from CLAUDE_CODE_MCP_SERVER_URL', ['headers'], { CLAUDE_CODE_MCP_SERVER_URL: URL_T }],
      ['a server config.json does not name: refused', ['headers', '--server-url', 'https://evil.example.test/mcp/v1'], {}],
      ['no server url: refused', ['headers'], {}],
    ] as Array<[string, string[], Record<string, string>]>) {
      cases.push([name, h.show(await h.run(argv, { env }))]);
    }
    expectSnapshot('headers.txt', renderCases(cases));
  }, 60_000);
});
