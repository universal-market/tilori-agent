#!/usr/bin/env bun
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { TiloriAgentClient } from './client.ts';
import {
  configPath,
  desiredSubscriptions,
  loadConfig,
  resolveAgent,
  resolveUrl,
  saveConfig,
  type TiloriConfig,
} from './config.ts';
import { ExecInjector } from './injectors/exec.ts';
import { serveRouter, socketPath } from './ipc.ts';
import { keyPath, readKey, redact, tiloriHome, validateHandle, writeKey } from './keys.ts';
import { Router, type RouterAgentConfig } from './router.ts';
import { runNotifyLines } from './watch.ts';

const USAGE = `tilori-agent: wake local coding agents on Tilori events

Usage:
  tilori-agent init --agent <handle> --url <tilori-mcp-url> [--default] [--no-verify]
      Reads the agent's shared key from stdin and stores it at
      ~/.config/tilori/agents/<handle>.key (0600); records url and agent in config.json.
  tilori-agent watch --notify-lines [--agent <handle>]
      Claude Code monitor mode: one fixed wake line per wake on stdout.
      Uses the local router if it serves the agent, else polls directly.
  tilori-agent watch --exec "<command>" [--agent <handle>]
      Runs <command> per wake (ids only, via $TILORI_WAKE_TEXT / $TILORI_WAKE_JSON / stdin).
  tilori-agent router
      One router per person per machine for every agent with a key file.
      Injectors attach over ${'$'}XDG_RUNTIME_DIR/tilori/router.sock.
  tilori-agent ensure [--agent <handle>]
      Creates or renews the agent's subscriptions and prints them.
  tilori-agent headers [--agent <handle>]
      Prints {"Authorization": "Bearer …"} for an MCP headersHelper.

Agent selection: --agent, then $TILORI_AGENT, then "default_agent" in config.json.
URL selection:   --url, then $TILORI_URL, then "url" in config.json.
Logs go to stderr and never include keys or event content.`;

interface Args {
  cmd: string;
  flags: Map<string, string | true>;
}

export function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | true>();
  const valued = new Set(['agent', 'url', 'exec', 'wait-ms']);
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`Unexpected argument: ${a}`);
    const eq = a.indexOf('=');
    const name = a.slice(2, eq > 0 ? eq : undefined);
    if (eq > 0) flags.set(name, a.slice(eq + 1));
    else if (valued.has(name)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`--${name} needs a value.`);
      flags.set(name, v);
    } else flags.set(name, true);
  }
  return { cmd: argv[0] ?? 'help', flags };
}

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
    return 2;
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
        const url = resolveUrl(config, str(args, 'url')).href;
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
        const config = loadConfig();
        const agent = requireAgent(config, args);
        process.stdout.write(JSON.stringify({ Authorization: `Bearer ${readKey(agent)}` }) + '\n');
        return 0;
      }
      case 'ensure': {
        const config = loadConfig();
        const agent = requireAgent(config, args);
        const client = new TiloriAgentClient({ url: resolveUrl(config, str(args, 'url')), apiKey: readKey(agent), logger: log });
        try {
          const subs = await client.ensureSubscriptions(desiredSubscriptions(config.agents?.[agent]), { signal });
          console.log(
            JSON.stringify(
              { agent, endpoint: client.endpoint.href, subscriptions: subs.map((s) => ({ id: s.id, scope: s.scope, expires_at: s.expires_at })) },
              null,
              2,
            ),
          );
        } finally {
          await client.close();
        }
        return 0;
      }
      case 'watch': {
        const config = loadConfig();
        const agent = requireAgent(config, args);
        const waitMs = str(args, 'wait-ms') ? Number(str(args, 'wait-ms')) : undefined;
        if (args.flags.has('notify-lines')) {
          await runNotifyLines({ agent, config, url: str(args, 'url'), signal, logger: log, waitMs });
          return 0;
        }
        const exec = str(args, 'exec');
        if (!exec) throw new Error('watch needs --notify-lines or --exec "<command>".');
        const settings = config.agents?.[agent] ?? {};
        const client = new TiloriAgentClient({ url: resolveUrl(config, str(args, 'url')), apiKey: readKey(agent), logger: log });
        const router = new Router({
          agents: [{ handle: agent, client, subscriptions: desiredSubscriptions(settings), wakesPerHour: settings.wakes_per_hour }],
          logger: log,
          waitMs,
        });
        router.register(agent, new ExecInjector(exec, log));
        await router.run(signal);
        return 0;
      }
      case 'router': {
        const config = loadConfig();
        const url = resolveUrl(config, str(args, 'url'));
        const handles = agentsWithKeys();
        if (!handles.length) throw new Error(`No agent keys in ${join(tiloriHome(), 'agents')}. Run tilori-agent init first.`);
        const agents: RouterAgentConfig[] = handles.map((handle) => {
          const s = config.agents?.[handle] ?? {};
          return {
            handle,
            client: new TiloriAgentClient({ url, apiKey: readKey(handle), logger: log }),
            subscriptions: desiredSubscriptions(s),
            wakesPerHour: s.wakes_per_hour,
          };
        });
        const router = new Router({ agents, logger: log });
        for (const handle of handles) {
          const s = config.agents?.[handle];
          if (s?.injector === 'exec' && s.exec) router.register(handle, new ExecInjector(s.exec, log));
        }
        const server = await serveRouter(router, socketPath(), log);
        log(`router serving ${handles.join(', ')} on ${socketPath()}`);
        signal.addEventListener('abort', () => server.close(), { once: true });
        await router.run(signal);
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
