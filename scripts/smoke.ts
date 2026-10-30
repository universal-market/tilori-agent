/**
 * Local smoke test of the real CLI, for before a release (round 3 item 2,
 * design b28ec468 → 7bb6716f). It drives `bin/tilori-agent`, or the bundle a
 * plugin ships with `--bin <path>/vendor/tilori-agent.js`, as separate
 * processes and checks that:
 *
 *   1. `router` starts and serves its socket;
 *   2. `config set` is reloaded live by that router and `config show` reports
 *      the new limit;
 *   3. `status` reports a session blocked on a prompt, and clears it after
 *      the next tool call.
 *
 *   bun scripts/smoke.ts [--bin <path>]
 *
 * Nothing here reads or writes the real ~/.config/tilori: every process gets
 * a fresh 0700 temp HOME, TILORI_HOME and TILORI_SOCKET, a minimal config for
 * a made-up agent, and a placeholder key that only ever goes to a loopback
 * port this script holds and that drops every connection. No network, no Tilori post budget. The temp
 * directory and the router are removed on PASS, FAIL, timeout and Ctrl-C.
 *
 * The edit-wake check against Internal Tilori waits for server-side post
 * editing (um#364); `router.test.ts` covers it against the fake server.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const WAIT_MS = 10_000;

const argv = process.argv.slice(2);
const at = argv.indexOf('--bin');
const extra = argv.filter((_, i) => at === -1 || (i !== at && i !== at + 1));
if ((at !== -1 && !argv[at + 1]) || extra.length) {
  console.error('usage: bun scripts/smoke.ts [--bin <path to bin/tilori-agent or vendor/tilori-agent.js>]');
  process.exit(2);
}
const bin = resolve(at === -1 ? join(import.meta.dir, '..', 'bin', 'tilori-agent') : argv[at + 1]);
if (!existsSync(bin)) {
  console.error(`smoke: ${bin} not found`);
  process.exit(2);
}
// A bundle runs under this Bun; the launcher script runs as is.
const command = bin.endsWith('.js') ? [process.execPath, bin] : [bin];

const root = mkdtempSync(join(tmpdir(), 'tilori-smoke-'));
chmodSync(root, 0o700);
const home = join(root, 'tilori');
const sock = join(root, 'run', 'router.sock');
const handle = `smoke-${randomBytes(4).toString('hex')}`;

/** Only what the CLI needs: nothing inherited can point it at a real home,
 * agent or Tilori URL. */
const env: Record<string, string> = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: root,
  TILORI_HOME: home,
  TILORI_SOCKET: sock,
};

// The router's Tilori URL: a loopback port this script holds and that drops
// every connection, so the placeholder key reaches nothing else (Pax
// b954d21f).
const sink = createServer((c) => c.destroy());
sink.listen(0, '127.0.0.1');
await once(sink, 'listening');
const port = (sink.address() as AddressInfo).port;

let router: ChildProcess | undefined;
let routerLog = '';
let cleaned = false;
/** Stops the router's process group, SIGKILL if it hasn't exited 2 s after SIGTERM, then
 * removes the temp directory (Pax b954d21f). */
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (router && router.exitCode === null && router.signalCode === null) {
    const exited = once(router, 'exit');
    // The router runs in its own process group: signal all of it, so nothing
    // it started outlives the run.
    const group = (sig: NodeJS.Signals) => {
      try {
        process.kill(-router!.pid!, sig);
      } catch {}
    };
    group('SIGTERM');
    const timer = setTimeout(() => group('SIGKILL'), 2000);
    await exited;
    clearTimeout(timer);
  }
  sink.close();
  rmSync(root, { recursive: true, force: true });
}
for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, async () => {
    await cleanup();
    console.log(`smoke: interrupted (${sig}); temp files removed`);
    process.exit(130);
  });

function cli(...args: string[]): { code: number; out: string } {
  const r = spawnSync(command[0], [...command.slice(1), ...args], { env, encoding: 'utf8', timeout: WAIT_MS });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

async function until(cond: () => boolean, ms = WAIT_MS): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return cond();
}

type Result = { name: string; ok: boolean; why?: string };
class Skip extends Error {}
const results: Result[] = [];
const pass = (name: string) => results.push({ name, ok: true });
const fail = (name: string, why: string) => results.push({ name, ok: false, why });

try {
  mkdirSync(join(home, 'agents'), { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({ url: `http://127.0.0.1:${port}/mcp/tilori/v1`, agents: { [handle]: {} } }, null, 2) + '\n',
    { mode: 0o600 },
  );
  writeFileSync(join(home, 'agents', `${handle}.key`), 'smoke-placeholder-not-a-key\n', { mode: 0o600 });

  // 1. The router starts and serves.
  router = spawn(command[0], [...command.slice(1), 'router'], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  router.stdout?.on('data', (d) => (routerLog += d));
  router.stderr?.on('data', (d) => (routerLog += d));
  const serving = await until(() => routerLog.includes(`router serving ${handle}`) && existsSync(sock));
  if (serving) pass('router starts and serves');
  else
    fail(
      'router starts and serves',
      `no "router serving" within ${WAIT_MS / 1000} s; run \`${command.join(' ')} router\` by hand with TILORI_HOME set to see why`,
    );
  // Checks 2 and 3 need a running router: without one, say so once.
  if (!serving) throw new Skip();

  // 2. config set is reloaded live.
  const set = cli('config', 'set', 'wakes_per_hour=7', '--agent', handle);
  if (set.code !== 0) fail('config set reloads live', `config set exited ${set.code}: ${set.out.trim().slice(0, 200)}`);
  else if (!(await until(() => /settings reloaded: .*wakes_per_hour/.test(routerLog))))
    fail(
      'config set reloads live',
      `the router didn't log "settings reloaded" within ${WAIT_MS / 1000} s; check followConfig in src/settings.ts`,
    );
  else {
    const show = cli('config', 'show', '--agent', handle);
    if (show.code === 0 && /wakes_per_hour = 7\b/.test(show.out) && /this hour: wakes \d+ of 7 used/.test(show.out))
      pass('config set reloads live');
    else
      fail(
        'config set reloads live',
        `config show doesn't report the router's new limit of 7; got: ${show.out.trim().split('\n').slice(-1)[0]?.slice(0, 160)}`,
      );
  }

  // 3. status reports a blocked session, as the plugin's hooks signal it:
  // blocked-<agent> newer than activity-<agent> in the router's run directory.
  const run = dirname(sock);
  const now = Date.now() / 1000;
  writeFileSync(join(run, `activity-${handle}`), '');
  utimesSync(join(run, `activity-${handle}`), now - 120, now - 120);
  writeFileSync(join(run, `blocked-${handle}`), '');
  utimesSync(join(run, `blocked-${handle}`), now - 60, now - 60);
  const STATUS_HINT =
    "check that the hooks write blocked-<agent> and activity-<agent> in the router's run directory, and statusLine in src/activity.ts";
  const blocked = cli('status');
  if (!blocked.out.includes(`${handle}: blocked on a prompt since`))
    fail('status reports a blocked session', `status didn't say blocked; got: ${blocked.out.trim().slice(0, 160)}; ${STATUS_HINT}`);
  else {
    utimesSync(join(run, `activity-${handle}`), now, now);
    const clear = cli('status');
    if (clear.out.includes(`${handle}: ok`)) pass('status reports a blocked session');
    else fail('status reports a blocked session', `status still blocked after a tool call; got: ${clear.out.trim().slice(0, 160)}; ${STATUS_HINT}`);
  }
} catch (e) {
  if (e instanceof Skip)
    for (const name of ['config set reloads live', 'status reports a blocked session'])
      fail(name, 'not run: needs the router from the first check');
  else fail('setup', e instanceof Error ? e.message : String(e));
} finally {
  await cleanup();
}

for (const r of results) console.log(r.ok ? `PASS ${r.name}` : `FAIL ${r.name}: ${r.why}`);
const passed = results.filter((r) => r.ok).length;
console.log(`smoke: ${passed} of ${results.length} PASS (local; the network edit-wake check waits for server-side post editing)`);
process.exit(passed === results.length && results.length === 3 ? 0 : 1);
