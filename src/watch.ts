import { TiloriAgentClient } from './client.ts';
import { desiredSubscriptions, keyUrl, reminderSettings, type TiloriConfig } from './config.ts';
import { NotifyLinesInjector } from './injectors/notify-lines.ts';
import { attachToRouter, probeRouter, socketIdentity, socketPath } from './ipc.ts';
import { readKey } from './keys.ts';
import { Router } from './router.ts';
import type { Injector } from './types.ts';
import type { UpdateNotice } from './update-notice.ts';

export interface NotifyLinesOptions {
  agent: string;
  config: TiloriConfig;
  url?: string;
  signal?: AbortSignal;
  logger?: (m: string) => void;
  injector?: Injector;
  waitMs?: number;
  /** How often direct mode checks for a router to attach to (default 15 s). */
  routerCheckMs?: number;
  /** Says once when a newer plugin is installed than this session runs. */
  update?: UpdateNotice;
}

/** Builds a one-agent router that talks to Tilori directly with the agent's key. */
export function directRouter(opts: NotifyLinesOptions): Router {
  const settings = opts.config.agents?.[opts.agent] ?? {};
  // Checked before the key is read.
  const url = keyUrl(opts.config, opts.url);
  const client = new TiloriAgentClient({
    url,
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
        directWakesPerHour: settings.direct_wakes_per_hour,
        reminder: reminderSettings(settings),
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
    }, opts.update);
  const path = socketPath();
  // A router that refused this agent (it doesn't serve it) is not retried
  // until the socket is replaced.
  let refused: string | null = null;
  const usable = async () => {
    const id = socketIdentity(path);
    return id !== null && id !== refused && (await probeRouter(path));
  };

  while (!opts.signal?.aborted) {
    if (await usable()) {
      try {
        await attachToRouter(opts.agent, injector, path, () => log(`attached to router for ${opts.agent}`));
        log('router connection closed; reconnecting');
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        if (/refused/i.test(msg)) refused = socketIdentity(path);
        log(`router unavailable (${msg}); running directly`);
      }
    }
    if (opts.signal?.aborted) return;

    // Direct mode, until a router that serves this agent appears. Stopping
    // lets an in-flight handoff finish and acknowledge first, so the switch
    // does not wake the session twice for one batch.
    const stop = new AbortController();
    const onAbort = () => stop.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const router = directRouter(opts);
    router.register(opts.agent, injector);
    log(`watching Tilori directly for ${opts.agent}`);
    const check = setInterval(async () => {
      if (!stop.signal.aborted && (await usable())) {
        log('a router appeared; switching to it');
        stop.abort();
      }
    }, opts.routerCheckMs ?? (Number(process.env.TILORI_ROUTER_CHECK_MS) || 15_000));
    try {
      await router.run(stop.signal);
    } finally {
      clearInterval(check);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }
}
