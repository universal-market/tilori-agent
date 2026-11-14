import { existsSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { isUnauthorized, KeyRejected, TiloriAgentClient } from './client.ts';
import { buildMarketUrl, buildMcpUrl, configPath, coordinationPolicy, loadConfig, sameEndpoint, saveConfig } from './config.ts';
import { tiloriHome, validateHandle, writeKey } from './keys.ts';
import { LAUNCHER, PLUGIN_ID, type PluginConfig } from './plugin-sync.ts';

export { configurePluginWithClaude, LAUNCHER, PLUGIN_ID, readPluginConfigFromClaude, type PluginConfig } from './plugin-sync.ts';

/**
 * `connect` (UNI-818): sets this machine up for one agent on a given
 * deployment, such as a workspace, from that agent's key, so plain `claude`
 * with the Universal Market plugin reaches it. Design 6f1f7b12; Bastion's conditions
 * 6b60e223 and 3a28226a; Juniper's copy d58ee772, cdc55f38 and 31f9eb9b.
 *
 * - The key comes only from stdin (the caller passes what it read), never
 *   from argv and never from a key file already here, so a later session
 *   can't point a stored key at another host.
 * - Both addresses are checked (HTTPS, or HTTP for loopback only) and the
 *   key is tried on both, with redirects refused, before anything is
 *   written. A failure names the host and what happened, never a response
 *   body or header.
 * - A home already set up for another deployment is refused unless
 *   --replace (terminal only: the plugin's slash command never passes it).
 *   Another deployment means another Tilori address or another Market
 *   address (including a Market where none was set): the header helper
 *   releases every agent's key here to both, so either is a trust anchor
 *   (Bastion e10827a7).
 *   On --replace, the other agents' key files are moved aside, not deleted,
 *   so neither the router nor the header helper sends them to the new host.
 * - The plugin is told only the two addresses, through
 *   `claude plugin configure … --values-stdin`.
 */

export interface ConnectOptions {
  url: string | undefined;
  marketUrl?: string;
  replace?: boolean;
  /** The agent key, as read from stdin by the caller. */
  key: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Reads the plugin's options; null when Claude Code or the plugin isn't there. */
  readPluginConfig?: () => Promise<PluginConfig | null>;
  /** Sets the plugin's two addresses; resolves to an error line, or null on success. */
  configurePlugin?: (values: { tilori_url: string; market_url: string }) => Promise<string | null>;
  now?: () => number;
  out: (line: string) => void;
}

/** One shell word: bare when it's plain URL characters, else single-quoted
 * (Pax 79689db1: the printed lines are pasted into a shell). */
export function shellWord(v: string): string {
  return /^[A-Za-z0-9._~:/%@+=,-]+$/.test(v) ? v : `'${v.replaceAll("'", `'\\''`)}'`;
}

export const CONNECT_LINES = {
  noKey:
    'No agent key on stdin. Export TILORI_API_KEY in your terminal (the first line in the Connect panel), then start Claude Code again.',
  noMarket:
    "Run step 1 in the workspace's Connect panel first (the line with `claude plugin configure`), then try again.",
  refuseOther: (current: string, wanted: string, url: string, market: string, old: string | undefined) =>
    `This computer is set up for ${current}. To switch it to ${wanted}, run this in a terminal: ` +
    `${LAUNCHER} connect --url ${shellWord(url)} --market-url ${shellWord(market)} --replace` +
    (old ? `. @${old} will stop getting events here.` : '.'),
  connected: (tag: string, where: string) => `✓ Connected ${tag} to ${where}.`,
  trustedCarried: (names: string[], host: string, path: string) =>
    `Trusted owners carried over: ${names.join(', ')}. They may be different people on ${host}; edit trusted_owners in ${path} if not.`,
  restart: ['Quit Claude Code, then start it again without the key:', '  unset TILORI_API_KEY', '  claude'],
  configureByHand: (values: { tilori_url: string; market_url: string }) =>
    `Couldn't set the plugin's addresses. Run this in a terminal, then start Claude Code again:\n  echo ${shellWord(JSON.stringify(values))} | claude plugin configure ${PLUGIN_ID} --values-stdin`,
};

/** Why a key check failed, naming only the host and the kind of failure. */
function checkFailed(cause: unknown, host: string): string {
  if (cause instanceof KeyRejected || isUnauthorized(cause)) {
    return `${host} refused this key (HTTP 401); nothing was saved. Check that you copied the whole key for this agent.`;
  }
  return `Couldn't check the key with ${host}; nothing was saved.`;
}

export async function runConnect(o: ConnectOptions): Promise<number> {
  const key = o.key.trim();
  if (!key) {
    o.out(CONNECT_LINES.noKey);
    return 2;
  }
  let url: URL;
  try {
    url = buildMcpUrl(o.url);
  } catch (cause) {
    o.out(cause instanceof Error ? cause.message : String(cause));
    return 2;
  }
  // The Market address: --market-url, else the plugin's configured one when
  // it isn't the production default (it can't be derived from the Tilori
  // address: a public Tilori origin differs from the deployment's).
  let market: URL;
  try {
    let raw = o.marketUrl;
    if (raw === undefined) {
      const plugin = (await o.readPluginConfig?.()) ?? null;
      const set = plugin?.market_url?.trim();
      if (set && set !== plugin?.market_default) raw = set;
    }
    if (raw === undefined) {
      o.out(CONNECT_LINES.noMarket);
      return 2;
    }
    market = buildMarketUrl(raw);
  } catch (cause) {
    o.out(cause instanceof Error ? cause.message : String(cause));
    return 2;
  }
  if (sameEndpoint(market, url)) {
    o.out('The Market address must differ from the Tilori address.');
    return 2;
  }

  // One home, one deployment: never switch another deployment's agents
  // over without --replace.
  const config = loadConfig();
  let moving = false;
  if (config.url) {
    let current: URL | null = null;
    try {
      current = buildMcpUrl(config.url);
    } catch {}
    let currentMarket: URL | null = null;
    try {
      if (config.market_url) currentMarket = buildMarketUrl(config.market_url);
    } catch {}
    let from: string | null = null;
    let to = '';
    if (!current || !sameEndpoint(current, url)) {
      from = current?.host ?? config.url;
      to = url.host;
    } else if (!currentMarket || !sameEndpoint(currentMarket, market)) {
      from = `${url.host} with ${currentMarket ? `Market at ${currentMarket.host}` : 'no Market'}`;
      to = `Market at ${market.host}`;
    }
    if (from !== null) {
      if (!o.replace) {
        o.out(CONNECT_LINES.refuseOther(from, to, url.href, market.href, config.default_agent));
        return 1;
      }
      moving = true;
    }
  }

  // The key, tried on both servers before anything is written. The client
  // refuses redirects, so no server can send the key on elsewhere.
  let username = '';
  let handle: string;
  const tilori = new TiloriAgentClient({ url, apiKey: key, fetch: o.fetch });
  try {
    await tilori.listSubscriptions(o.signal);
    const me = await tilori.call<any>('get_my_profile', {}, { signal: o.signal, timeout: 10_000 });
    const p = me?.profile ?? me?.result?.profile;
    handle = validateHandle(typeof p?.handle === 'string' ? p.handle : '');
    if (typeof p?.username === 'string' && /^[a-z0-9-]{1,64}$/.test(p.username)) username = p.username;
  } catch (cause) {
    o.out(cause instanceof Error && /Agent handle must be/.test(cause.message) ? `${url.host} didn't name a usable agent; nothing was saved.` : checkFailed(cause, url.host));
    return 1;
  } finally {
    await tilori.close();
  }
  const m = new TiloriAgentClient({ url: market, apiKey: key, fetch: o.fetch });
  try {
    await m.connect();
  } catch (cause) {
    o.out(checkFailed(cause, market.host));
    return 1;
  } finally {
    await m.close();
  }

  // Store. On a switch, the other agents' keys are moved aside first, so
  // nothing sends them to the new deployment.
  if (moving) {
    const dir = join(tiloriHome(), 'agents');
    const stamp = new Date(o.now?.() ?? Date.now()).toISOString().replace(/[:.]/g, '-');
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.key')) : [];
    for (const f of files) renameSync(join(dir, f), join(dir, `${f}.replaced-${stamp}`));
    config.agents = {};
    delete config.default_agent;
  }
  writeKey(handle, key);
  config.url = url.href;
  config.market_url = market.href;
  config.agents ??= {};
  config.agents[handle] ??= {};
  config.default_agent = handle;
  saveConfig(config);

  const values = { tilori_url: url.href, market_url: market.href };
  const problem = o.configurePlugin ? await o.configurePlugin(values) : null;
  o.out(CONNECT_LINES.connected(username ? `@${username}.${handle}` : `@${handle}`, url.host));
  // A switch keeps trusted_owners; usernames are per instance, so say so
  // (Bastion a14a227d). Clearing them would be a trust-rule change (Don).
  const trusted = coordinationPolicy(config, null).trusted_owners;
  if (moving && trusted.length) o.out(CONNECT_LINES.trustedCarried(trusted, url.host, configPath()));
  if (problem) o.out(CONNECT_LINES.configureByHand(values));
  for (const line of CONNECT_LINES.restart) o.out(line);
  return 0;
}
