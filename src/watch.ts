import { TiloriAgentClient } from './client.ts';
import { desiredSubscriptions, resolveUrl, type TiloriConfig } from './config.ts';
import { NotifyLinesInjector } from './injectors/notify-lines.ts';
import { attachToRouter, routerAvailable, socketPath } from './ipc.ts';
import { readKey } from './keys.ts';
import { Router } from './router.ts';
import type { Injector } from './types.ts';

export interface NotifyLinesOptions {
  agent: string;
  config: TiloriConfig;
  url?: string;
  signal?: AbortSignal;
  logger?: (m: string) => void;
  injector?: Injector;
  waitMs?: number;
}

/** Builds a one-agent router that talks to Tilori directly with the agent's key. */
export function directRouter(opts: NotifyLinesOptions): Router {
  const settings = opts.config.agents?.[opts.agent] ?? {};
  const client = new TiloriAgentClient({
    url: resolveUrl(opts.config, opts.url),
    apiKey: readKey(opts.agent),
    logger: opts.logger,
  });
  return new Router({
    agents: [
      {
        handle: opts.agent,
        client,
        subscriptions: desiredSubscriptions(settings),
        wakesPerHour: settings.wakes_per_hour,
      },
    ],
    logger: opts.logger,
    waitMs: opts.waitMs,
  });
}

/**
 * `tilori-agent watch --notify-lines`: the Claude Code monitor entry point.
 * Prints one fixed wake line per wake on stdout and nothing else (logs go to
 * stderr). Attaches to the machine's router when one is running and serves
 * this agent; otherwise runs a one-agent router in this process.
 */
export async function runNotifyLines(opts: NotifyLinesOptions): Promise<void> {
  const log = opts.logger ?? (() => {});
  // A monitor must not outlive its Claude Code session: stop when re-parented
  // (the session died) so an orphan never keeps long-polls open.
  const parent = process.ppid;
  const orphanCheck = setInterval(() => {
    if (process.ppid !== parent) {
      log('parent session ended; exiting');
      process.exit(0);
    }
  }, 5_000);
  orphanCheck.unref();
  const injector =
    opts.injector ??
    new NotifyLinesInjector(process.stdout, () => {
      // stdout closed: the session that read our lines is gone. Exit without
      // acknowledging, so the held batch is re-served to the next session.
      log('stdout closed; exiting');
      process.exit(0);
    });
  const path = socketPath();

  while (!opts.signal?.aborted && routerAvailable(path)) {
    try {
      await attachToRouter(opts.agent, injector, path, () => log(`attached to router for ${opts.agent}`));
      log('router connection closed; reconnecting');
      await new Promise((r) => setTimeout(r, 2000));
    } catch (cause) {
      log(`router unavailable (${cause instanceof Error ? cause.message : cause}); running directly`);
      break;
    }
  }
  if (opts.signal?.aborted) return;

  const router = directRouter(opts);
  router.register(opts.agent, injector);
  log(`watching Tilori directly for ${opts.agent}`);
  await router.run(opts.signal);
}
