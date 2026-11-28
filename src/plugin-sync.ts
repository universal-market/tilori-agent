import { buildMarketUrl, buildMcpUrl, sameEndpoint, type TiloriConfig } from './config.ts';
import { isOtherHome, tiloriHome } from './keys.ts';
import { host, type OptionName, type PluginConfig, type PluginIO, type PluginValues } from './host.ts';
import { hostText } from './host-text.ts';

/**
 * The Universal Market plugin's two address options, `tilori_url` and `market_url`
 * (UNI-882, design fb13dbe9). Claude Code's `.mcp.json` can only take a server
 * URL from the environment or a plugin option, so a plain `claude` session
 * reaches whatever the options say. tilori-agent is their only writer: every
 * command that records `url` or `market_url` in config.json sets them too,
 * and `sync-plugin` repairs drift.
 *
 * Bastion e7060719:
 * - One way, no input: the values come only from config.json. No argument,
 *   environment variable or repo file chooses them. Each passes the same
 *   shape checks as the plugin's header helper (no credentials, query,
 *   fragment, whitespace or control characters) before it is written.
 * - `claude` is resolved from absolute PATH directories only and run with
 *   cwd `/`, so a repo can't supply it (tilori-agent#98). That code moved to
 *   src/hosts/claude/plugin-io.ts (UNI-1178 S1b), unchanged.
 * - Only the two URLs go to `claude plugin configure`, never a key or a key
 *   path, and nothing else from config.json is printed.
 * The key gate is unchanged: a key is released only on an exact match with
 * config.json (UNI-748), so a drifted option means a 401, never a leak.
 */

export type { OptionName, PluginConfig, PluginValues };

/** What tests swap: just the two operations. Defaults to the host's pluginIO. */
type PluginAccess = Pick<PluginIO, 'read' | 'configure'>;
let io: PluginAccess | null = null;

/** Swaps the host's plugin access, for tests (tests/setup.ts sets a fake for
 * every test, so no test runs the real `claude`). Returns the previous one. */
export function setPluginIO(next: PluginAccess): PluginAccess {
  const prev = io ?? host().pluginIO;
  io = next;
  return prev;
}

/** A URL fit to hand to the plugin: what the header helper would accept
 * (UNI-860/867), as one line. Throws otherwise. */
function plain(raw: string, url: URL, what: string): string {
  if (/[\s\x00-\x1f\x7f]/.test(raw.trim()) || url.search || url.hash || url.username || url.password) {
    throw new Error(`The ${what} URL in config.json has a query, fragment, credentials, whitespace or control characters; fix it with tilori-agent init.`);
  }
  return url.href;
}

/** The option values config.json implies: always tilori_url, and market_url
 * when config.json has one. Throws on an unusable URL. */
export function wantedValues(config: TiloriConfig): PluginValues {
  if (!config.url) throw new Error('No "url" in config.json; run tilori-agent init --url <tilori-mcp-url> first.');
  const values: PluginValues = { tilori_url: plain(config.url, buildMcpUrl(config.url), 'Tilori') };
  if (config.market_url) values.market_url = plain(config.market_url, buildMarketUrl(config.market_url), 'Market');
  return values;
}

/** An option value as it may be shown: origin and path of a parsable URL,
 * never its query, fragment or credentials (a stray value may carry them). */
function shown(v: string | undefined): string {
  if (!v?.trim()) return '(unset)';
  try {
    const u = new URL(v.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '(not a URL)';
    return `${u.origin}${u.pathname}`;
  } catch {
    return '(not a URL)';
  }
}

function matches(current: string | undefined, wanted: string): boolean {
  if (!current?.trim()) return false;
  try {
    return sameEndpoint(buildMcpUrl(current), new URL(wanted)) && !new URL(current.trim()).search;
  } catch {
    return false;
  }
}

export const SYNC_LINES = {
  otherHome: (home: string) => hostText().syncOtherHome(home, host().pluginIO.launcher),
  // Getters: the host's words are read when a line is used, not at import.
  get unread() {
    return hostText().syncUnread;
  },
  byHand: (values: PluginValues) => hostText().syncByHand(JSON.stringify(values).replaceAll("'", `'\\''`), host().pluginIO.pluginId),
  same: 'The Universal Market plugin already uses the URLs in config.json; nothing to change.',
  changed: (name: OptionName, from: string, to: string) => `${name}: ${from} → ${to}`,
  unchanged: (name: OptionName) => `${name} unchanged`,
  noMarket: 'market_url: config.json has none, so the option was left as it is.',
  get restart() {
    return hostText().syncRestart;
  },
};

/**
 * Sets the plugin's options to config.json's URLs. Returns the lines to show
 * and an exit code: 0 done or nothing to do, 1 Claude Code or the plugin
 * couldn't be read or written, 2 this isn't the default home or config.json
 * has no usable URL.
 */
export async function syncPlugin(config: TiloriConfig): Promise<{ code: number; lines: string[]; changed: boolean }> {
  if (isOtherHome()) return { code: 2, lines: [SYNC_LINES.otherHome(tiloriHome())], changed: false };
  let wanted: PluginValues;
  try {
    wanted = wantedValues(config);
  } catch (cause) {
    return { code: 2, lines: [cause instanceof Error ? cause.message : String(cause)], changed: false };
  }
  const current = await (io ?? host().pluginIO).read();
  if (!current) return { code: 1, lines: [SYNC_LINES.unread], changed: false };
  const now: Record<OptionName, string | undefined> = {
    tilori_url: current.tilori_url ?? current.tilori_default,
    market_url: current.market_url ?? current.market_default,
  };
  const change: PluginValues = {};
  const lines: string[] = [];
  for (const name of ['tilori_url', 'market_url'] as const) {
    const want = wanted[name];
    if (want === undefined) lines.push(SYNC_LINES.noMarket);
    else if (matches(now[name], want)) lines.push(SYNC_LINES.unchanged(name));
    else {
      change[name] = want;
      lines.push(SYNC_LINES.changed(name, shown(now[name]), want));
    }
  }
  if (!Object.keys(change).length) return { code: 0, lines: [SYNC_LINES.same], changed: false };
  if (await (io ?? host().pluginIO).configure(change)) return { code: 1, lines: [SYNC_LINES.byHand(change)], changed: false };
  return { code: 0, lines: [...lines, SYNC_LINES.restart], changed: true };
}

/**
 * After a command recorded URLs in config.json (init, setup): set the
 * plugin's options to match, when this is the default home and Claude Code
 * with the plugin is there. Quiet when nothing changed or the plugin isn't
 * installed (a Codex-only machine); otherwise the lines to show.
 */
export async function syncPluginAfterSave(config: TiloriConfig): Promise<string[]> {
  if (isOtherHome()) return [];
  const r = await syncPlugin(config);
  if (r.changed) return ['The Universal Market plugin now uses these URLs:', ...r.lines];
  if (r.code === 1 && r.lines[0] !== SYNC_LINES.unread) return r.lines; // the plugin is there but refused
  return [];
}
