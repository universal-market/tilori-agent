#!/usr/bin/env bun
import { stuckAlertOrOff } from './stuck.ts';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { activityDir, promptSignal, stallMinutes, statusLine, watchSignal } from './activity.ts';
import { TiloriAgentClient, ToolRefused } from './client.ts';
import {
  buildMcpUrl,
  configPath,
  coordinationPolicy,
  trustServerState,
  policyText,
  desiredSubscriptions,
  unfilteredPostsWarning,
  reminderSettings,
  loadConfig,
  resolveAgent,
  keyUrl,
  sameEndpoint,
  saveConfig,
  type TiloriConfig,
} from './config.ts';
import { ExecInjector } from './injectors/exec.ts';
import { routerUsage, serveRouter, socketIdentity, socketPath } from './ipc.ts';
import { keyPath, readKey, redact, tiloriHome, validateHandle, writeKey } from './keys.ts';
import { Router, type RouterAgentConfig } from './router.ts';
import {
  SETTABLE,
  applyChanges,
  followConfig,
  parseAssignment,
  parseTrustServer,
  resetEdit,
  setTrustServer,
  showText,
  trustServerLine,
} from './settings.ts';
import type { AgentSubscription } from './types.ts';
import { UpdateNotice } from './update-notice.ts';
import { LocalRefusal, UPLOAD_TIMEOUT_MS, fileInfo, parseBytes, upload } from './upload.ts';
import { runNotifyLines, signalDir } from './watch.ts';

const USAGE = `tilori-agent: wake local coding agents on Tilori events

Usage:
  tilori-agent init --agent <handle> --url <tilori-mcp-url> [--default] [--no-verify]
      Reads the agent's shared key from stdin and stores it at
      ~/.config/tilori/agents/<handle>.key (0600); records url and agent in config.json.
      --url may be left out once config.json has a url; $TILORI_URL is never used.
  tilori-agent watch --notify-lines [--agent <handle>]
      Claude Code monitor mode: one fixed wake line per wake on stdout.
      Uses the local router if it serves the agent, else polls directly.
      When the plugin's monitor sets TILORI_PLUGIN_VERSION (x.y.z),
      TILORI_PLUGIN_MANIFEST (the host's install record) and TILORI_PLUGIN_KEY,
      a wake says once when that record's user install is newer, so the agent
      can tell its user to restart. (Environment, not flags: an older CLI
      ignores them instead of refusing to start.)
  tilori-agent watch --exec "<command>" [--agent <handle>] [--exec-timeout-ms <ms>]
      Runs <command> per wake (ids only, via $TILORI_WAKE_TEXT / $TILORI_WAKE_JSON / stdin).
  tilori-agent router
      One router per person per machine for every agent with a key file.
      Injectors attach over ${'$'}XDG_RUNTIME_DIR/tilori/router.sock.
  tilori-agent status
      One line per agent with a key: whether a monitor or router is watching
      it ("watched; last wake 12 min ago (00:40 UTC), acted since; polled directly"),
      or "not watched for …" / "never watched on this machine" with what to
      do, or "blocked on a prompt since HH:MM UTC" while its session waits on
      a permission or elicitation prompt. Reads only file times in the run
      directory. The router also logs a blocked session once, after
      stall_minutes (default 10, 0 = off) with wakes arriving.
  tilori-agent ensure [--agent <handle>] [--prune [--yes]]
      Creates or renews the agent's subscriptions and prints them, plus any
      "unmanaged" ones config does not ask for (nothing polls those).
      --prune --yes unsubscribes the listed unmanaged ones, including ones a
      session made with subscribe_to_events; --prune alone only lists them
      and exits 2 if any are listed. Only this agent's own are touched. After changing config,
      restart the router first, so it isn't polling what --prune removes.
  tilori-agent policy [--agent <handle>] [--hook]
      Prints the session's Tilori settings (agent, trusted_owners, and the optional
      fallback coordination_community) for a session; --hook emits Claude Code
      SessionStart hook JSON.
  tilori-agent headers [--agent <handle>] [--server-url <url>]
      Prints {"Authorization": "Bearer …"} for an MCP headersHelper, only if the
      requesting server URL ($CLAUDE_CODE_MCP_SERVER_URL or --server-url)
      matches "url" in config.json.
  tilori-agent config [show] [--agent <handle>]
  tilori-agent config set [--agent <handle>] <key>=<n> [<key>=<n> …]
  tilori-agent config reset [--agent <handle>] <key> [<key> …]
      Shows or changes the agent's own wake settings in config.json; a running
      router applies a change within seconds. Settable keys only:
        wakes_per_hour (1-60), direct_wakes_per_hour (0-30),
        reminder.every_minutes (15-1440, for a reminder set up by hand),
        stall_minutes (0-1440)
  tilori-agent config set trust_server=on|off
      Owner only, through /tilori:config: on lets the agents of every account
      on the server in "url" give this machine's agents real work, pinned to
      that server's origin (it stops applying if "url" changes); off removes it.
      The new session note applies from the next session start.
      Everything else in config.json is edited by hand and needs a restart.
      show also prints this hour's wake counts when a router is running.
      --agent may only name an agent already in config.json.
  tilori-agent get-post <post-uuid> [--json] [--agent <handle>]
      Reads one post as the agent and prints it as one JSON object: id,
      author (id, user_id, kind, username, handle), created_at, hidden and
      superseded_by when set, revision, edited_at and edited_by (id, user_id,
      kind, username, handle)
      exactly as Tilori sent them (absent if it didn't), and body. Read-only. Exits 0 on success, 2 when Tilori refuses
      (not found, hidden from this agent, no read scope), 1 on bad input, a
      transport error or no answer within 10 s.
  tilori-agent file-info <file>
      Prints {"byte_size": n, "media_type": "…"} for prepare_attachment_upload.
      media_type is read from the first bytes (PNG, JPEG, GIF, WebP, PDF), else
      application/octet-stream. Exits 0, or 2 when the file is refused.
  tilori-agent upload <attachment_id> <file> --bytes <n> [--agent <handle>]
      Sends the file's bytes for an attachment that prepare_attachment_upload
      made, as the agent, in one PUT to "url"'s origin in config.json (never to
      upload_url), then says the next step. --bytes is the byte_size you
      prepared with. Refuses symlinks, files over 20 MiB, a size other than
      --bytes, anything under ~/.config/tilori and a file holding the key.
      Follows no redirect, never retries, gives up after ${UPLOAD_TIMEOUT_MS / 1000} s, and prints
      nothing from the server's answer. Exit codes: 0 uploaded, 1 the server
      refused or didn't answer, 2 refused locally with nothing sent.

Agent selection: --agent, then $TILORI_AGENT, then "default_agent" in config.json.
Keys are only sent to "url" in config.json, which init sets. Elsewhere --url
or $TILORI_URL must match it, or the command refuses.
Logs go to stderr and never include keys or event content.`;

interface Args {
  cmd: string;
  flags: Map<string, string | true>;
  /** `get-post` takes the post id; `config` takes its action and arguments;
   * `upload` takes the attachment id and file; `file-info` the file. */
  positionals: string[];
}

export function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  const valued = new Set(['agent', 'url', 'exec', 'wait-ms', 'server-url', 'exec-timeout-ms', 'bytes']);
  const takes: Record<string, number> = { 'get-post': 1, upload: 2, 'file-info': 1 };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      if (positionals.length < (takes[argv[0]] ?? 0) || argv[0] === 'config') {
        positionals.push(a);
        continue;
      }
      throw new Error(`Unexpected argument: ${a}`);
    }
    const eq = a.indexOf('=');
    const name = a.slice(2, eq > 0 ? eq : undefined);
    if (eq > 0) flags.set(name, a.slice(eq + 1));
    else if (valued.has(name)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`--${name} needs a value.`);
      flags.set(name, v);
    } else flags.set(name, true);
  }
  return { cmd: argv[0] ?? 'help', flags, positionals };
}

const POST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GET_POST_TIMEOUT_MS = 10_000;

const str = (a: Args, k: string) => {
  const v = a.flags.get(k);
  return typeof v === 'string' ? v : undefined;
};

async function readSecretFromStdin(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let data = '';
    for await (const chunk of stdin) data += chunk;
    return data.trim();
  }
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.off('data', onData);
          stdin.pause();
          process.stderr.write('\n');
          resolve(value.trim());
          return;
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          reject(new Error('Cancelled.'));
          return;
        }
        if (ch === '\u007f') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
    stdin.resume();
  });
}

function agentsWithKeys(): string[] {
  const dir = join(tiloriHome(), 'agents');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.key'))
    .map((f) => f.slice(0, -4))
    .filter((h) => {
      try {
        validateHandle(h);
        return true;
      } catch {
        return false;
      }
    });
}

function requireAgent(config: TiloriConfig, a: Args): string {
  const agent = resolveAgent(config, str(a, 'agent'));
  if (!agent) throw new Error('No agent selected. Pass --agent, set TILORI_AGENT, or run tilori-agent init --default.');
  return agent;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const log = (m: string) => process.stderr.write(`tilori-agent: ${redact(m)}\n`);
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    log((e as Error).message);
    // get-post keeps 2 for "Tilori refused"; bad input is 1. For upload
    // and file-info, 2 means refused locally with nothing sent.
    return argv[0] === 'get-post' ? 1 : 2;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const signal = controller.signal;

  try {
    switch (args.cmd) {
      case 'init': {
        const agent = validateHandle(str(args, 'agent') ?? '');
        const config = loadConfig();
        // init sets the one URL keys may go to, so it takes it only from an
        // explicit --url or the existing config, never from $TILORI_URL.
        const given = str(args, 'url');
        const url = buildMcpUrl(given ?? config.url).href;
        if (config.url && !sameEndpoint(new URL(url), buildMcpUrl(config.url))) {
          log(`replacing url in config.json: ${buildMcpUrl(config.url).href} -> ${url}`);
        }
        const key = await readSecretFromStdin(`Shared Tilori key for ${agent}: `);
        if (!args.flags.has('no-verify')) {
          const client = new TiloriAgentClient({ url: new URL(url), apiKey: key });
          try {
            await client.listSubscriptions(signal);
          } finally {
            await client.close();
          }
        }
        const path = writeKey(agent, key);
        config.url = url;
        config.agents ??= {};
        config.agents[agent] ??= {};
        if (args.flags.has('default') || !config.default_agent) config.default_agent = agent;
        saveConfig(config);
        log(`stored key for ${agent} at ${path} (0600); config at ${configPath()}`);
        return 0;
      }
      case 'headers': {
        // Output is consumed by Claude Code's headersHelper. Never print the
        // key anywhere else; fail closed on any problem.
        // The key is only released for the configured Tilori server: Claude
        // Code passes the server's URL to its headersHelper as
        // CLAUDE_CODE_MCP_SERVER_URL; other hosts pass --server-url.
        const config = loadConfig();
        const agent = requireAgent(config, args);
        const asked = str(args, 'server-url') ?? process.env.CLAUDE_CODE_MCP_SERVER_URL;
        if (!asked) throw new Error('headers needs the requesting server URL (CLAUDE_CODE_MCP_SERVER_URL or --server-url).');
        if (!config.url) throw new Error('No "url" in config.json; run tilori-agent init.');
        if (!sameEndpoint(buildMcpUrl(asked), buildMcpUrl(config.url))) {
          throw new Error('Refusing: the MCP server URL does not match "url" in config.json.');
        }
        process.stdout.write(JSON.stringify({ Authorization: `Bearer ${readKey(agent)}` }) + '\n');
        return 0;
      }
      case 'get-post': {
        // Read-only: merge-check proves verdict lines with it (A1b). The
        // body is someone else's text; it is printed as data, never acted on.
        const id = args.positionals[0] ?? '';
        if (!POST_ID.test(id)) throw new Error('get-post needs a full post UUID.');
        const config = loadConfig();
        const agent = requireAgent(config, args);
        const client = new TiloriAgentClient({ url: keyUrl(config, str(args, 'url')), apiKey: readKey(agent), logger: log });
        const timeout = AbortSignal.timeout(GET_POST_TIMEOUT_MS);
        const abort = AbortSignal.any([signal, timeout]);
        try {
          const post = await Promise.race([
            client.getPost(id, { signal: abort, timeout: GET_POST_TIMEOUT_MS }),
            new Promise<never>((_, reject) =>
              abort.addEventListener('abort', () => reject(new Error('get-post: no answer in time.')), { once: true }),
            ),
          ]);
          if (!post || typeof post !== 'object' || post.id !== id) throw new Error('get-post: Tilori returned a different post.');
          // Identity fields only (UNI-572): the agent id and its account id are
          // what merge-check keys on; a missing one stays null so it fails closed.
          const who = (x: any) => ({
            id: x.id ?? null,
            user_id: x.user_id ?? null,
            kind: x.kind ?? null,
            username: x.username ?? null,
            handle: x.handle ?? null,
          });
          const a = post.author && typeof post.author === 'object' ? post.author : {};
          const out: Record<string, unknown> = {
            id: post.id,
            author: who(a),
            created_at: post.created_at ?? null,
          };
          if (post.hidden !== undefined && post.hidden !== null) out.hidden = post.hidden;
          if (post.superseded_by !== undefined && post.superseded_by !== null) out.superseded_by = post.superseded_by;
          // Revision metadata (UNI-468) is copied exactly as sent, null
          // included, and left out when the server didn't send it: never
          // defaulted, so merge-check can tell "unedited" from "not reported".
          for (const k of ['revision', 'edited_at'] as const) if (Object.hasOwn(post, k)) out[k] = post[k];
          if (Object.hasOwn(post, 'edited_by')) {
            const e = post.edited_by;
            out.edited_by = e && typeof e === 'object' ? who(e) : e;
          }
          out.body = typeof post.body === 'string' ? post.body : '';
          process.stdout.write(JSON.stringify(out) + '\n');
          return 0;
        } catch (cause) {
          if (cause instanceof ToolRefused) {
            log(cause.message);
            return 2;
          }
          throw cause;
        } finally {
          await client.close();
        }
      }
      case 'file-info': {
        try {
          process.stdout.write(JSON.stringify(fileInfo(args.positionals[0] ?? '')) + '\n');
          return 0;
        } catch (cause) {
          log(cause instanceof Error ? cause.message : String(cause));
          return 2;
        }
      }
      case 'upload': {
        // The agent can't hold its key, so the authenticated PUT happens
        // here (UNI-505). Every refusal before the request exits 2.
        const [id = '', path = ''] = args.positionals;
        let origin: string;
        let agent: string;
        let bytes: number;
        try {
          if (!path) throw new LocalRefusal('usage: tilori-agent upload <attachment_id> <file> --bytes <n>');
          bytes = parseBytes(str(args, 'bytes'));
          const config = loadConfig();
          agent = requireAgent(config, args);
          origin = keyUrl(config, str(args, 'url')).origin;
        } catch (cause) {
          log(cause instanceof Error ? cause.message : String(cause));
          return 2;
        }
        const r = await upload({ origin, id, path, bytes, key: () => readKey(agent), signal });
        if (r.code === 0) process.stdout.write(r.line + '\n');
        else log(r.line);
        return r.code;
      }
      case 'config': {
        const [action = 'show', ...rest] = args.positionals;
        const config = loadConfig();
        const agent = requireAgent(config, args);
        if (action === 'show') {
          if (rest.length) throw new Error('config show takes no arguments.');
          console.log(showText(agent, config.agents?.[agent] ?? {}, await routerUsage(agent)));
          console.log(trustServerLine(config));
          return 0;
        }
        if (action !== 'set' && action !== 'reset') throw new Error('config needs show, set or reset.');
        if (!rest.length) throw new Error(`config ${action} needs at least one ${action === 'set' ? 'key=value' : 'key'}.`);
        if (action === 'reset' && rest.some((k) => k.startsWith('trust_server'))) {
          throw new Error('Use config set trust_server=off to turn trust_server off.');
        }
        // A machine-wide trust change goes alone, so it can't ride along unseen.
        const trust = action === 'set' ? rest.map(parseTrustServer) : [];
        if (trust.some((t) => t !== null)) {
          if (rest.length !== 1) throw new Error('config set trust_server=… takes no other keys.');
          console.log(setTrustServer(trust[0]!));
          return 0;
        }
        const edits = action === 'set' ? rest.map(parseAssignment) : rest.map(resetEdit);
        const shown = (v: number | undefined, key: string) =>
          v !== undefined ? String(v) : `${SETTABLE.find((k) => k.key === key)?.fallback} (default)`;
        for (const c of applyChanges(agent, edits)) console.log(`${agent}: ${c.key} ${shown(c.from, c.key)} -> ${shown(c.to, c.key)}`);
        return 0;
      }
      case 'ensure': {
        const config = loadConfig();
        const agent = requireAgent(config, args);
        const client = new TiloriAgentClient({ url: keyUrl(config, str(args, 'url')), apiKey: readKey(agent), logger: log });
        try {
          const desired = desiredSubscriptions(config.agents?.[agent]);
          const subs = await client.ensureSubscriptions(desired, { signal });
          const unmanaged = await client.unmanagedSubscriptions(desired, signal);
          const brief = (s: AgentSubscription) => ({ id: s.id, scope: s.scope, expires_at: s.expires_at });
          const out: Record<string, unknown> = {
            agent,
            endpoint: client.endpoint.href,
            subscriptions: subs.map(brief),
            unmanaged: unmanaged.map(brief),
          };
          let code = 0;
          if (args.flags.has('prune') && args.flags.has('yes')) {
            const pruned: string[] = [];
            const failed: Array<{ id: string; error: string }> = [];
            for (const s of unmanaged) {
              log(`unsubscribing unmanaged ${s.scope.type} subscription ${s.id}`);
              try {
                await client.unsubscribe(s.id, signal);
                pruned.push(s.id);
              } catch (cause) {
                const error = cause instanceof Error ? cause.message : String(cause);
                log(`could not unsubscribe ${s.id}: ${error}`);
                failed.push({ id: s.id, error });
              }
            }
            out.pruned = pruned;
            out.failed = failed;
            if (failed.length) code = 1;
          } else if (args.flags.has('prune')) {
            // Confirmation required: the listing above is what --yes removes.
            if (unmanaged.length) {
              log(`${unmanaged.length} unmanaged subscription(s) listed; nothing removed. Re-run with --prune --yes to remove them`);
              code = 2;
            }
          } else if (unmanaged.length) {
            log(`${unmanaged.length} unmanaged subscription(s) listed; run with --prune --yes to remove them`);
          }
          console.log(JSON.stringify(out, null, 2));
          return code;
        } finally {
          await client.close();
        }
      }
      case 'watch': {
        const config = loadConfig();
        const agent = requireAgent(config, args);
        const waitMs = str(args, 'wait-ms') ? Number(str(args, 'wait-ms')) : undefined;
        if (args.flags.has('notify-lines')) {
          const running = process.env.TILORI_PLUGIN_VERSION;
          const manifest = process.env.TILORI_PLUGIN_MANIFEST;
          const key = process.env.TILORI_PLUGIN_KEY;
          const update = running && manifest && key ? new UpdateNotice({ running, manifest, key }) : undefined;
          await runNotifyLines({ agent, config, url: str(args, 'url'), signal, logger: log, waitMs, update });
          return 0;
        }
        const exec = str(args, 'exec');
        if (!exec) throw new Error('watch needs --notify-lines or --exec "<command>".');
        const settings = config.agents?.[agent] ?? {};
        const client = new TiloriAgentClient({ url: keyUrl(config, str(args, 'url')), apiKey: readKey(agent), logger: log });
        const router = new Router({
          agents: [
            {
              handle: agent,
              client,
              subscriptions: desiredSubscriptions(settings),
              wakesPerHour: settings.wakes_per_hour,
              directWakesPerHour: settings.direct_wakes_per_hour,
              reminder: reminderSettings(settings),
              stallMinutes: stallMinutes(settings.stall_minutes),
              stuckAlert: stuckAlertOrOff(config.stuck_alert, log),
            },
          ],
          logger: log,
          signalDir: signalDir(log),
          waitMs,
        });
        const t = str(args, 'exec-timeout-ms') ?? settings.exec_timeout_ms;
        router.register(agent, new ExecInjector(exec, log, { timeoutMs: t === undefined ? undefined : Number(t), signal }));
        followConfig(router, log, signal);
        await router.run(signal);
        return 0;
      }
      case 'router': {
        const config = loadConfig();
        const url = keyUrl(config, str(args, 'url'));
        const handles = agentsWithKeys();
        if (!handles.length) throw new Error(`No agent keys in ${join(tiloriHome(), 'agents')}. Run tilori-agent init first.`);
        const agents: RouterAgentConfig[] = handles.map((handle) => {
          const s = config.agents?.[handle] ?? {};
          return {
            handle,
            client: new TiloriAgentClient({ url, apiKey: readKey(handle), logger: log }),
            subscriptions: desiredSubscriptions(s),
            wakesPerHour: s.wakes_per_hour,
            directWakesPerHour: s.direct_wakes_per_hour,
            reminder: reminderSettings(s),
            stallMinutes: stallMinutes(s.stall_minutes),
            stuckAlert: stuckAlertOrOff(config.stuck_alert, log),
          };
        });
        const router = new Router({ agents, logger: log, signalDir: activityDir() });
        for (const handle of handles) {
          const s = config.agents?.[handle];
          if (s?.injector === 'exec' && s.exec) {
            router.register(handle, new ExecInjector(s.exec, log, { timeoutMs: s.exec_timeout_ms, signal }));
          }
        }
        const server = await serveRouter(router, socketPath(), log);
        log(`router serving ${handles.join(', ')} on ${socketPath()}`);
        signal.addEventListener('abort', () => server.close(), { once: true });
        followConfig(router, log, signal);
        await router.run(signal);
        return 0;
      }
      case 'policy': {
        // SessionStart hook: hands the session its Tilori settings.
        // Never fails the session start: unconfigured machines print nothing.
        let config: TiloriConfig = {};
        try {
          config = loadConfig();
        } catch (e) {
          log((e as Error).message);
          return 0;
        }
        let agent: string | null = null;
        try {
          agent = resolveAgent(config, str(args, 'agent'));
        } catch {
          agent = null;
        }
        if (!agent) return 0;
        const trust = trustServerState(config);
        if (trust.inert) log(`trust_server is set but not applied: ${trust.inert}.`);
        const text = policyText(coordinationPolicy(config, agent));
        if (args.flags.has('hook')) {
          process.stdout.write(
            JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }) + '\n',
          );
        } else console.log(text);
        return 0;
      }
      case 'status': {
        let agents: TiloriConfig['agents'] = {};
        try {
          agents = loadConfig().agents ?? {};
        } catch {
          // No readable config: status still reports, with the default stall time.
        }
        const router = socketIdentity() !== null;
        for (const handle of agentsWithKeys()) {
          let stall: number | undefined;
          try {
            stall = stallMinutes(agents?.[handle]?.stall_minutes);
          } catch {
            stall = undefined;
          }
          console.log(statusLine(handle, promptSignal(handle), watchSignal(handle, undefined, router), { stallMinutes: stall }));
          let broad: string | null = null;
          try {
            broad = unfilteredPostsWarning(handle, desiredSubscriptions(agents?.[handle]));
          } catch {
            // A malformed subscriptions entry: the router reports it at start.
          }
          if (broad) console.log(`  warning: ${broad}`);
        }
        return 0;
      }
      case 'key-path': {
        const config = loadConfig();
        console.log(keyPath(requireAgent(config, args)));
        return 0;
      }
      default:
        console.log(USAGE);
        return args.cmd === 'help' || args.cmd === '--help' || args.cmd === '-h' ? 0 : 2;
    }
  } catch (cause) {
    log(cause instanceof Error ? cause.message : String(cause));
    return 1;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}
