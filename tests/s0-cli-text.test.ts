import './setup.ts';
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expectSnapshot, normalise, renderCases, runCli, tempDir } from './s0-util.ts';

// UNI-1178 S0: characterization, at v0.3.18, of the CLI's usage and help text
// and of the one-line errors printed before any network or Claude/Codex call.
// Each case runs src/cli.ts as a subprocess under a fresh temp HOME holding a
// fixed config.json (example.test hosts) and one key whose content is the
// sentinel "fake-key-for-s0". Only invocations that fail or finish locally are
// used; nothing here reaches the network or starts claude or codex.
//
// Normalisations (the only ones):
//   - the temp HOME path becomes <HOME> (it differs on every run)
// The usage text itself has no variable parts.

function makeHome(o: { noAgent?: boolean } = {}): { home: string; norm: (s: string) => string } {
  const home = tempDir();
  chmodSync(home, 0o700);
  const dir = join(home, '.config', 'tilori');
  mkdirSync(join(dir, 'agents'), { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, 'run'), { recursive: true, mode: 0o700 });
  for (const p of [join(home, '.config'), dir, join(dir, 'agents'), join(dir, 'run')]) chmodSync(p, 0o700);
  if (!o.noAgent) writeFileSync(join(dir, 'agents', 'wren.key'), 'fake-key-for-s0\n', { mode: 0o600 });
  const config = { url: 'https://tilori.example.test/mcp/tilori/v1', market_url: 'https://market.example.test/mcp/v1', ...(o.noAgent ? {} : { default_agent: 'wren' }) };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  return { home, norm: (s) => normalise(s, [[home, '<HOME>']]) };
}

describe('S0 CLI usage and help text', () => {
  test('usage.txt: the usage text, and every way to ask for it', async () => {
    const h = makeHome();
    const go = (argv: string[]) => runCli(argv, { home: h.home });
    const help = await go(['help']);
    expect(help.code).toBe(0);
    expect(help.stderr).toBe('');
    // Every spelling of help prints the same text on stdout with exit 0.
    for (const argv of [['--help'], ['-h'], ['setup', '--help'], ['init', '--help'], ['watch', '--help'], ['get-post', '--help'], ['pr-work', '--help'], ['status', '-h']]) {
      const r = await go(argv);
      expect({ argv, ...r }).toEqual({ argv, code: 0, stdout: help.stdout, stderr: '' });
    }
    // No arguments and an unknown command: see usage-routes.txt for where it goes and the exit code.
    const none = await go([]);
    const unknown = await go(['no-such-command']);
    expect(unknown.code).toBe(2);
    expectSnapshot('usage.txt', h.norm(help.stdout));
    expectSnapshot(
      'usage-routes.txt',
      renderCases([
        ['no arguments', `exit ${none.code}\nstdout: ${none.stdout === '' ? '(empty)' : 'same as help: ' + (none.stdout === help.stdout)}\nstderr: ${none.stderr === help.stdout ? 'same as help text' : h.norm(none.stderr)}`],
        ['unknown command', `exit ${unknown.code}\nstdout: ${unknown.stdout === '' ? '(empty)' : 'same as help: ' + (unknown.stdout === help.stdout)}\nstderr: ${unknown.stderr === help.stdout ? 'same as help text' : h.norm(unknown.stderr)}`],
      ]),
    );
  }, 60_000);

  test('cli-errors.txt: one-line errors and local-only outputs per subcommand', async () => {
    const h = makeHome();
    const cases: Array<[string, string]> = [];
    const show = (argv: string[], r: { code: number; stdout: string; stderr: string }) =>
      `$ tilori-agent ${argv.join(' ')}\nexit ${r.code}\nstdout: ${r.stdout === '' ? '(empty)' : '\n' + h.norm(r.stdout).replace(/\n$/, '')}\nstderr: ${r.stderr === '' ? '(empty)' : '\n' + h.norm(r.stderr).replace(/\n$/, '')}`;
    const argvs: string[][] = [
      ['get-post'],
      ['get-post', 'not-a-uuid'],
      ['get-thread'],
      ['create-post'],
      ['pr-work'],
      ['pr-work', 'nonsense'],
      ['market-evidence'],
      ['search-posts'],
      ['file-info'],
      ['upload'],
      ['sync-plugin', '--bogus'],
      ['claude', '--bogus'],
      ['init', '--bogus'],
      ['key-path'],
      ['config'],
      ['status'],
    ];
    for (const argv of argvs) cases.push([argv.join(' '), show(argv, await runCli(argv, { home: h.home }))]);
    // S1a: a home with no default agent, no key and no TILORI_AGENT reaches cli.ts's
    // 'No agent selected.' (added to the snapshot; the cases above are unchanged).
    const none = makeHome({ noAgent: true });
    const noAgentArgv = ['key-path'];
    const noAgent = await runCli(noAgentArgv, { home: none.home });
    expect(noAgent.code).toBe(1);
    expect(noAgent.stderr).toContain('No agent selected.');
    cases.push([
      'key-path (no agent configured)',
      `$ tilori-agent ${noAgentArgv.join(' ')}\nexit ${noAgent.code}\nstdout: ${noAgent.stdout === '' ? '(empty)' : '\n' + none.norm(noAgent.stdout).replace(/\n$/, '')}\nstderr: ${noAgent.stderr === '' ? '(empty)' : '\n' + none.norm(noAgent.stderr).replace(/\n$/, '')}`,
    ]);
    expectSnapshot('cli-errors.txt', renderCases(cases));
  }, 120_000);
});
