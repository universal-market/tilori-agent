import './setup.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configurePluginWithClaude, readPluginConfigFromClaude, setPluginIO, syncPlugin, SYNC_LINES } from '../src/plugin-sync.ts';
import { expectSnapshot, normalise, renderCases, tempDir } from './s0-util.ts';

// UNI-1178 S0: characterization, at v0.3.18, of exactly what tilori-agent asks
// Claude Code to do with `claude plugin configure`: the argv, the stdin, the
// working directory, and the lines printed around it. The real `claude` is
// never run: a fake `claude` shell script in a temp directory (put first on an
// absolute PATH) records what it was given.
//
// Normalisations (the only ones):
//   - the temp directory holding the fake claude becomes <FAKE> (it differs per run)
// Nothing else varies: URLs are fixed example.test hosts.

const URL_T = 'https://tilori.example.test/mcp/tilori/v1';
const URL_M = 'https://market.example.test/mcp/v1';

const FAKE = `#!/bin/sh
{
  echo "argv:"
  for a in "$@"; do echo "  [$a]"; done
  echo "cwd: $PWD"
  printf 'stdin: '
  cat
  echo
  echo "--"
} >> "$FAKE_CLAUDE_LOG"
case "$FAKE_CLAUDE_MODE" in
  fail) exit 3 ;;
  garbage) echo 'not json'; exit 0 ;;
  json) cat "$FAKE_CLAUDE_JSON"; exit 0 ;;
  *) exit 0 ;;
esac
`;

let dir: string;
let log: string;
const saved: Record<string, string | undefined> = {};
const ENV = ['PATH', 'FAKE_CLAUDE_LOG', 'FAKE_CLAUDE_MODE', 'FAKE_CLAUDE_JSON'];
let prevIO: ReturnType<typeof setPluginIO>;

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  dir = tempDir();
  const bin = join(dir, 'bin');
  Bun.spawnSync(['mkdir', bin]);
  writeFileSync(join(bin, 'claude'), FAKE);
  chmodSync(join(bin, 'claude'), 0o755);
  log = join(dir, 'log.txt');
  writeFileSync(log, '');
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  process.env.FAKE_CLAUDE_LOG = log;
  process.env.FAKE_CLAUDE_MODE = 'ok';
  process.env.FAKE_CLAUDE_JSON = join(dir, 'plugin.json');
  // Use the real plugin access (setup.ts installs a no-op) for the sync cases.
  prevIO = setPluginIO({ read: readPluginConfigFromClaude, configure: configurePluginWithClaude });
});

afterEach(() => {
  setPluginIO(prevIO);
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const seen = () => normalise(readFileSync(log, 'utf8'), [[dir, '<FAKE>']]);
const setJson = (inputs: object, schema: object = {}) => writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ inputs, schema }));

describe('S0 claude plugin configure', () => {
  test('plugin-configure.txt', async () => {
    const cases: Array<[string, string]> = [];
    const step = async (name: string, fn: () => Promise<unknown>, mode = 'ok') => {
      process.env.FAKE_CLAUDE_MODE = mode;
      writeFileSync(log, '');
      const result = await fn();
      cases.push([name, `result: ${JSON.stringify(result)}\n${seen().trimEnd()}`]);
    };
    const prodSchema = { tilori_url: { default: 'https://prod.example.test/mcp/tilori/v1' }, market_url: { default: 'https://prod.example.test/mcp/v1' } };

    setJson({ tilori_url: URL_T, market_url: URL_M }, prodSchema);
    await step('read: argv, stdin empty, cwd /', () => readPluginConfigFromClaude(), 'json');
    setJson({}, prodSchema);
    await step('read: nothing set, defaults from the schema', () => readPluginConfigFromClaude(), 'json');
    await step('read: not JSON gives null', () => readPluginConfigFromClaude(), 'garbage');
    await step('read: claude exits 3 gives null', () => readPluginConfigFromClaude(), 'fail');
    await step('configure both: stdin is the JSON of the values', () => configurePluginWithClaude({ tilori_url: URL_T, market_url: URL_M }));
    await step('configure one option', () => configurePluginWithClaude({ market_url: URL_M }));
    await step('configure: claude exits 3 gives "failed"', () => configurePluginWithClaude({ tilori_url: URL_T }), 'fail');

    setJson({ tilori_url: 'https://old.example.test/mcp/tilori/v1', market_url: 'https://old.example.test/mcp/v1' }, prodSchema);
    await step('sync: both drifted, one read then one configure with both', () => syncPlugin({ url: URL_T, market_url: URL_M }), 'json');
    setJson({ tilori_url: URL_T, market_url: URL_M }, prodSchema);
    await step('sync: already in step, read only, no configure', () => syncPlugin({ url: URL_T, market_url: URL_M }), 'json');
    setJson({ tilori_url: URL_T }, prodSchema);
    await step('sync: only market_url drifted, configure sends only that option', () => syncPlugin({ url: URL_T, market_url: URL_M }), 'json');
    await step('sync: config has no market_url, option left alone', () => syncPlugin({ url: URL_T }), 'json');
    await step('sync: config has no url, claude never run', () => syncPlugin({ market_url: URL_M }));
    await step('sync: claude cannot be read', () => syncPlugin({ url: URL_T, market_url: URL_M }), 'garbage');
    await step('sync: configure refused, by-hand line', async () => {
      setJson({}, prodSchema);
      // read works (json), configure fails: switch the mode per call with a counting wrapper
      const real = { read: readPluginConfigFromClaude, configure: configurePluginWithClaude };
      setPluginIO({
        read: async () => {
          process.env.FAKE_CLAUDE_MODE = 'json';
          return real.read();
        },
        configure: async (v) => {
          process.env.FAKE_CLAUDE_MODE = 'fail';
          return real.configure(v);
        },
      });
      return syncPlugin({ url: URL_T, market_url: URL_M });
    });
    expectSnapshot('plugin-configure.txt', renderCases(cases));
  }, 60_000);

  test('claude is found only on an absolute PATH entry, and never from a relative one', async () => {
    process.env.PATH = `bin:.::${join(dir, 'nowhere')}:/usr/bin:/bin`;
    process.env.FAKE_CLAUDE_MODE = 'ok';
    expect(await configurePluginWithClaude({ tilori_url: URL_T })).toBe('failed');
    expect(readFileSync(log, 'utf8')).toBe('');
  });

  test('sync-plugin text lines', () => {
    const cases: Array<[string, string]> = [
      ['otherHome', SYNC_LINES.otherHome('/home/example/.config/tilori-other')],
      ['unread', SYNC_LINES.unread],
      ['byHand', SYNC_LINES.byHand({ tilori_url: URL_T, market_url: URL_M })],
      ['byHand with a quote', SYNC_LINES.byHand({ tilori_url: "https://x.example.test/it's" })],
      ['same', SYNC_LINES.same],
      ['changed', SYNC_LINES.changed('tilori_url', 'https://old.example.test/mcp/tilori/v1', URL_T)],
      ['unchanged', SYNC_LINES.unchanged('market_url')],
      ['noMarket', SYNC_LINES.noMarket],
      ['restart', SYNC_LINES.restart],
    ];
    expectSnapshot('sync-plugin-lines.txt', renderCases(cases));
  });
});
